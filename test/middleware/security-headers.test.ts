import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_STRICT_TRANSPORT_SECURITY,
  SECURITY_HEADERS,
  contentSecurityPolicyForFrames,
  frameAncestorsValue,
  frameableHeaders,
  securityHeaders,
} from "../../worker/src/platform/middleware/security-headers";

/**
 * Build a throwaway Hono app that mounts the middleware exactly the way the
 * real worker will (`app.use("*", securityHeaders())`) and exposes a couple of
 * representative routes:
 *   - GET /ok    -> 200 with a JSON body
 *   - GET /boom  -> 500 raised by a downstream handler
 *   - (anything else) -> the framework's 404, proving unmatched paths are
 *     covered too.
 */
function makeApp() {
  const app = new Hono();
  app.use("*", securityHeaders());

  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.onError((_err, c) => c.json({ ok: false }, 500));

  return app;
}

/**
 * Literal CSP/HSTS security-floor expectations.
 *
 * These are written out by hand instead of referencing the exported
 * `DEFAULT_*` constants on purpose: if someone relaxed the policy inside the
 * middleware (e.g. `default-src *`, a removed `frame-ancestors`, a shorter
 * HSTS max-age) the imported constant would move in lockstep with the source
 * and the test would keep passing. Hard-coded strings make the security
 * contract independently verifiable — a weakened policy fails here.
 */
const CSP_REQUIRES = [
  "default-src 'self'", // same-origin only; no `*`/`data:`/`http:` widening
  "frame-ancestors 'none'", // not embeddable in any frame/iframe
  "base-uri 'self'", // no <base> hijacking for relative URLs
] as const;

/** Directives/loosening tokens a secure CSP must NOT contain. */
const CSP_FORBIDS = [
  "default-src *",
  "default-src 'unsafe-inline'",
  "default-src 'unsafe-eval'",
  "frame-ancestors *",
] as const;

const HSTS_REQUIRES = ["max-age=31536000", "includeSubDomains"] as const;

const EXPECTED: Record<string, string> = {
  // Mixed literal + constant-by-name: the constants below pin the *literal*
  // values, while the constant import still guards the exact wire value.
  "Content-Security-Policy": DEFAULT_CONTENT_SECURITY_POLICY,
  "Strict-Transport-Security": DEFAULT_STRICT_TRANSPORT_SECURITY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/** Assert every managed header is present with the expected value. */
function assertAllHeaders(res: Response, label: string) {
  for (const [name, value] of Object.entries(EXPECTED)) {
    expect(res.headers.get(name), `${label}: ${name} missing`).not.toBeNull();
    expect(res.headers.get(name), `${label}: ${name} value`).toBe(value);
  }
}

describe("securityHeaders middleware", () => {
  it("the expected header set is exactly the 5 documented headers", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(
      [
        "Content-Security-Policy",
        "Strict-Transport-Security",
        "X-Content-Type-Options",
        "Referrer-Policy",
        "X-Frame-Options",
      ].sort(),
    );
  });

  it("sets all 5 headers on a 200 response", async () => {
    const res = await makeApp().request("/ok");
    expect(res.status).toBe(200);
    assertAllHeaders(res, "200 /ok");
  });

  it("sets all 5 headers on a 404 response", async () => {
    const res = await makeApp().request("/definitely-not-a-route");
    expect(res.status).toBe(404);
    assertAllHeaders(res, "404 unmatched");
  });

  it("sets all 5 headers on an error (500) response", async () => {
    const res = await makeApp().request("/boom");
    expect(res.status).toBe(500);
    assertAllHeaders(res, "500 /boom");
  });

  it("no response escapes without the headers (sweep of common paths/methods)", async () => {
    const app = makeApp();
    const probes: Array<[string, string]> = [
      ["GET", "/ok"],
      ["GET", "/missing"],
      ["GET", "/v1/nope?x=1"],
      ["POST", "/ok"],
      ["PUT", "/whatever"],
      ["DELETE", "/"],
      ["OPTIONS", "/ok"],
      ["HEAD", "/ok"],
      ["GET", "/boom"],
    ];

    for (const [method, path] of probes) {
      const res = await app.request(path, { method });
      const label = `${method} ${path} (${res.status})`;
      for (const [name, value] of Object.entries(EXPECTED)) {
        expect(res.headers.get(name), `${label}: ${name}`).toBe(value);
      }
    }
  });

  it("emits each header exactly once (no duplicates)", async () => {
    const res = await makeApp().request("/ok");
    const raw = Array.from(res.headers.entries()) as [string, string][];
    // `set` — not `append` — must be used, so each name appears once.
    for (const name of Object.keys(EXPECTED)) {
      const hits = raw.filter(([k]) => k.toLowerCase() === name.toLowerCase());
      expect(hits.length, `${name} count`).toBe(1);
    }
  });

  it("is idempotent when mounted twice", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.use("*", securityHeaders());
    app.get("/ok", (c) => c.json({ ok: true }));

    const res = await app.request("/ok");
    assertAllHeaders(res, "double-mounted");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
  });

  it("pins the exact CSP wire value to literal directives (no importing the source constant as truth)", async () => {
    const res = await makeApp().request("/ok");
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    // Exact literal match — deliberately NOT `expect(csp).toBe(DEFAULT_...)`
    // so a relaxed source constant cannot silently redefine the expectation.
    expect(csp).toBe(
      "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
  });

  it("CSP contains each concrete hardening directive", async () => {
    const res = await makeApp().request("/ok");
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    for (const directive of CSP_REQUIRES) {
      expect(csp, `CSP must contain "${directive}"`).toContain(directive);
    }
  });

  it("CSP forbids widening the policy (no unsafe/inline/eval/wildcard)", async () => {
    const res = await makeApp().request("/ok");
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    for (const forbidden of CSP_FORBIDS) {
      expect(csp, `CSP must not contain "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
    // The default source must be exactly same-origin, nothing broader.
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/default-src\s+(?![^;]*'self')/);
  });

  it("pins the exact HSTS wire value and its required tokens", async () => {
    const res = await makeApp().request("/ok");
    const hsts = res.headers.get("Strict-Transport-Security") ?? "";

    expect(hsts).toBe("max-age=31536000; includeSubDomains");
    for (const token of HSTS_REQUIRES) {
      expect(hsts, `HSTS must contain "${token}"`).toContain(token);
    }
  });

  it("literal CSP/HSTS floors hold on 404 and 500 responses too", async () => {
    const app = makeApp();

    for (const [label, path] of [
      ["404", "/definitely-not-a-route"],
      ["500", "/boom"],
    ] as const) {
      const res = await app.request(path);
      const csp = res.headers.get("Content-Security-Policy") ?? "";
      const hsts = res.headers.get("Strict-Transport-Security") ?? "";

      for (const directive of CSP_REQUIRES) {
        expect(csp, `${label}: CSP must contain "${directive}"`).toContain(
          directive,
        );
      }
      for (const forbidden of CSP_FORBIDS) {
        expect(csp, `${label}: CSP must not contain "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
      for (const token of HSTS_REQUIRES) {
        expect(hsts, `${label}: HSTS must contain "${token}"`).toContain(token);
      }
    }
  });

  it("honours a partial override without dropping the other headers", async () => {
    const app = new Hono();
    app.use("*", securityHeaders({ "Referrer-Policy": "strict-origin" }));
    app.get("/ok", (c) => c.text("hi"));

    const res = await app.request("/ok");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      DEFAULT_CONTENT_SECURITY_POLICY,
    );
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      DEFAULT_STRICT_TRANSPORT_SECURITY,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("preserves the original status and body", async () => {
    const res = await makeApp().request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// R-W3 — the /embed framing override, mutation-proof
// ---------------------------------------------------------------------------

/**
 * Build an app that wires the framing override EXACTLY as `createApp` does:
 * the narrow per-path middleware registered BEFORE the global
 * `securityHeaders()`, so it is the outer middleware for `/embed` and its
 * `set` wins on the unwind.
 *
 * The `withOverride` flag is the mutation seam: flipping it off mounts only
 * `securityHeaders()`, which is precisely "the override was removed" — and the
 * tests below must then fail (embed carries DENY again).
 */
function makeFrameableApp(
  ancestors: readonly string[],
  withOverride = true,
) {
  const app = new Hono();
  if (withOverride) {
    const frames = frameableHeaders({ ancestors });
    app.use("/embed", frames);
    app.use("/embed/*", frames);
  }
  app.use("*", securityHeaders());

  app.get("/embed/:token", (c) => c.text("<!doctype html><p>embed</p>", 200, {
    "Content-Type": "text/html; charset=utf-8",
  }));
  app.get("/ok", (c) => c.json({ ok: true }));
  return app;
}

describe("frameableHeaders — the /embed framing override", () => {
  it("default (no configured origins) makes /embed frameable by self, not DENY", async () => {
    const res = await makeFrameableApp([]).request("/embed/shr_abc");

    expect(res.status).toBe(200);
    // The acceptance criterion, by value: DENY must be GONE on /embed.
    expect(res.headers.get("X-Frame-Options")).not.toBe("DENY");
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it("a configured origin list widens frame-ancestors to exactly those origins", async () => {
    const res = await makeFrameableApp(["https://app.example.com", "https://ops.example.org"])
      .request("/embed/shr_abc");
    const csp = res.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("frame-ancestors https://app.example.com https://ops.example.org");
    // With a configured allow-list the legacy header is OMITTED entirely (it has
    // no origin-list form), so it can neither contradict the CSP nor falsely
    // signal a restriction the browser would enforce as DENY.
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    // The other directives survive untouched — framing is the ONLY relaxation.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("a normal app route STILL carries X-Frame-Options: DENY and frame-ancestors 'none'", async () => {
    const app = makeFrameableApp(["https://app.example.com"]);
    const res = await app.request("/ok");

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
    // And the rest of the baseline is intact, proving the override is scoped.
    expect(res.headers.get("Strict-Transport-Security")).toBe(
      DEFAULT_STRICT_TRANSPORT_SECURITY,
    );
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("the override is scoped to /embed — a sibling path is still DENY", async () => {
    const app = makeFrameableApp(["https://app.example.com"]);
    // A path that merely *starts* with the letters "embed" but is not the
    // subtree must not inherit the relaxation.
    app.get("/embeddable", (c) => c.text("x"));
    const res = await app.request("/embeddable");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  // --- MUTATION PROOF ------------------------------------------------------
  // With the override UNMOUNTED the embed must fall back to DENY. This is the
  // exact assertion that fails if someone deletes the `app.use` pair in
  // `createApp` — pinning the override's *presence*, not just its absence.
  it("MUTATION: without the override, /embed carries DENY again (unmount → this fails)", async () => {
    const res = await makeFrameableApp([], /* withOverride */ false).request("/embed/shr_abc");

    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("frameAncestorsValue never emits a fail-open empty list", () => {
    // An empty/blank list must collapse to 'self' (a real directive), never to
    // an empty string a browser would ignore.
    expect(frameAncestorsValue([])).toBe("'self'");
    expect(frameAncestorsValue(["  ", ""])).toBe("'self'");
    expect(frameAncestorsValue([" https://a.example "])).toBe("https://a.example");
  });

  it("contentSecurityPolicyForFrames keeps the other directives and replaces only frame-ancestors", () => {
    const csp = contentSecurityPolicyForFrames(["https://a.example"]);
    expect(csp).toBe(
      "default-src 'self'; frame-ancestors https://a.example; base-uri 'self'",
    );
    // No wildcard can ever appear from the seam.
    expect(csp).not.toContain("frame-ancestors *");
  });
});

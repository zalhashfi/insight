import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_CONTENT_SECURITY_POLICY,
  DEFAULT_STRICT_TRANSPORT_SECURITY,
  SECURITY_HEADERS,
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

const EXPECTED: Record<string, string> = {
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

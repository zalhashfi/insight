/**
 * Spec tests for A33 — the `/embed/:token` read-only embed landing (FR-DSH-05).
 *
 * The embed is an *adapter* over {@link PublicDashboardService}: it resolves a
 * share token, reads the resulting **allow-list-filtered** view, and renders it
 * as an HTML document. The public JSON surface is pinned by its own suite; this
 * one covers the wire that was missing — the route, its no-login read, the fact
 * that the allow-list still holds for a *rendered* payload, that an unusable
 * token is a uniform refusal (not a page), and the minimal SEO landing
 * (title/meta/robots).
 *
 * The load-bearing assertion is the same as ST-D2 / INV-D2: a project holds
 * `secret_token` alongside the public `temp`, the layout names only `temp`, and
 * the secret's variable *and value* never appear in the served bytes.
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createApp, type App, type AppDeps } from "../../worker/src/app";
import {
  EMBED_PATH,
  EMBED_ROBOTS,
  EMBED_STATUS_CODE,
  EmbedDashboardService,
  EmbedError,
  createEmbedRoute,
  embedDescription,
  embedTitle,
  escapeHtml,
  isEmbedError,
  renderEmbedPage,
  type EmbedLayout,
} from "../../worker/src/domains/dashboards/embed";
import {
  PublicDashboardService,
  type DashboardLayout,
  type LayoutLookup,
  type Point,
  type ProjectionSource,
  type Share,
  type ShareResolver,
  type TokenHasher,
} from "../../worker/src/domains/dashboards/public";

// ---------------------------------------------------------------------------
// Fixtures — one live share, one layout naming only `temp`, a seeded projection
// ---------------------------------------------------------------------------

const PROJECT = "prj_embed";
const SHARE_TOKEN = "shr_embed_abc";
const LAYOUT_ID = "layout_embed";

/** The secret that lives in the project but is NOT named by the layout. */
const SECRET_VARIABLE = "secret_token";
const SECRET_VALUE = 987_654;

/** A SHA-256 hex hasher, matching `platform/lib/tokens.ts` (WebCrypto). */
const sha256Hex: TokenHasher = async (plaintext) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

const SHARE_DIGEST = await sha256Hex(SHARE_TOKEN);
const NOW = 1_700_000_000_000;

/** A reading for `(variable, value)` with a caller-chosen `seq`. */
function point(variable: string, value: number, seq: number): Point {
  return { device: "dev_1", variable, value, ts: NOW - seq, seq };
}

/** The live share bound to {@link PROJECT} / {@link LAYOUT_ID}. */
function liveShare(overrides: Partial<Share> = {}): Share {
  return {
    id: "share_embed_1",
    tokenHash: SHARE_DIGEST,
    projectId: PROJECT,
    layoutId: LAYOUT_ID,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** The public layout: it exposes `temp` and NOTHING else. */
function publicLayout(overrides: Partial<EmbedLayout> = {}): EmbedLayout {
  return { id: LAYOUT_ID, variables: ["temp"], ...overrides };
}

/**
 * Build the three seams over in-memory fakes.
 *
 * The projection holds the whole projection — the public `temp` *and* the
 * private `secret_token` — so a leak shows up as the secret surviving into the
 * rendered HTML rather than being filtered by the service.
 */
function seams(options: { layout?: EmbedLayout | null; points?: Point[] } = {}) {
  const layout = options.layout === undefined ? publicLayout() : options.layout;
  const points = options.points ?? [point("temp", 21, 1), point(SECRET_VARIABLE, SECRET_VALUE, 2)];

  const shares: ShareResolver = async (presented) =>
    presented === SHARE_TOKEN ? liveShare() : null;
  const layouts: LayoutLookup = async (id) =>
    layout !== null && id === layout.id ? (layout as DashboardLayout) : null;
  const projection: ProjectionSource = { snapshot: async () => points };

  return { shares, layouts, projection, points, layout };
}

/** A service over fresh seams. */
function service(options: { layout?: EmbedLayout | null; points?: Point[]; allowsEmbed?: (l: EmbedLayout) => boolean } = {}) {
  const { shares, layouts, projection } = seams(options);
  return new EmbedDashboardService({
    publicDashboard: { shares, layouts, projection },
    ...(options.allowsEmbed !== undefined ? { allowsEmbed: options.allowsEmbed } : {}),
  });
}

/** The composed real app with the public-dashboard seams bound. */
function harness(options: { layout?: EmbedLayout | null; points?: Point[]; allowsEmbed?: (l: EmbedLayout) => boolean; frameAncestors?: readonly string[] } = {}): App {
  const { shares, layouts, projection } = seams(options);
  return createApp({
    deviceTokens: async () => null,
    sessions: async () => null,
    ingest: {
      verifyToken: async () => null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
    ...(options.frameAncestors !== undefined
      ? { embedFrameAncestors: options.frameAncestors }
      : {}),
    m3: {
      publicDashboard: {
        shares,
        layouts,
        projection,
      },
      ...(options.allowsEmbed !== undefined
        ? { embed: { allowsEmbed: options.allowsEmbed } }
        : {}),
    },
  } as AppDeps);
}

// ---------------------------------------------------------------------------
// 1. The route renders without login (no credential on the request)
// ---------------------------------------------------------------------------

describe("GET /embed/:token — read-only, no login", () => {
  it("renders the dashboard as HTML for an anonymous caller", async () => {
    const app = harness();
    // No Authorization header, no cookie: the token in the path is the whole
    // credential.
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    // The public reading is rendered.
    expect(html).toContain("temp");
    expect(html).toContain("21");
  });

  it("is not mounted without the public-dashboard seams (M1-only deploy)", async () => {
    const app = createApp({
      deviceTokens: async () => null,
      sessions: async () => null,
      ingest: {
        verifyToken: async () => null,
        sink: { record: async () => undefined },
        devices: { register: () => undefined, has: () => false },
      },
      query: {
        credentials: async () => null,
        projects: { state: async () => [] },
        shards: { ring: async () => [] },
      },
    } as AppDeps);
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 2. The allow-list still holds for a rendered payload (INV-D2 / D4.3)
// ---------------------------------------------------------------------------

describe("GET /embed/:token — the allow-list is enforced on the rendered bytes", () => {
  it("never exposes a variable the layout does not name", async () => {
    const app = harness();
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    const html = await res.text();

    // The public variable is present; the secret's variable AND value are not.
    expect(html).toContain("temp");
    expect(html).not.toContain(SECRET_VARIABLE);
    expect(html).not.toContain(String(SECRET_VALUE));
  });

  it("renders an empty dashboard when the layout names nothing (fail-closed)", async () => {
    const app = harness({ layout: { id: LAYOUT_ID, variables: [] } });
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).not.toContain(SECRET_VARIABLE);
    expect(html).not.toContain(String(SECRET_VALUE));
    // Not even the public `temp` reading survives — nothing is allow-listed.
    expect(html).not.toContain("<td>temp</td>");
  });

  it("filters through the same view as the JSON route (one resolution rule)", async () => {
    const { shares, layouts, projection } = seams();
    const view = await new PublicDashboardService({ shares, layouts, projection }).resolve(SHARE_TOKEN);
    const snapshot = await view.snapshot();
    expect(snapshot.map((p) => p.variable)).toEqual(["temp"]);
  });
});

// ---------------------------------------------------------------------------
// 3. An unusable token is refused — uniformly, and with no page rendered
// ---------------------------------------------------------------------------

describe("GET /embed/:token — an invalid/unknown token is refused (no leak)", () => {
  it("answers an unknown token with a uniform 404 JSON refusal", async () => {
    const app = harness();
    const res = await app.request(`${EMBED_PATH}/not_a_share`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body: { error: string; message: string } = await res.json();
    expect(body.error).toBe("not_found");
    // A refusal is not a page: nothing dashboard-shaped is rendered.
    expect(body.message).not.toContain("temp");
  });

  it("answers a blank token with the same 404 status as an unknown one (no oracle)", async () => {
    const app = harness();
    const blank = await app.request(`${EMBED_PATH}/%20`);
    const unknown = await app.request(`${EMBED_PATH}/nope`);
    // The *status* is the uniform answer a stranger sees; the code differs
    // (`invalid_input` vs `not_found`) exactly as the public surface documents,
    // and both map to 404 — so the endpoint confirms nothing about a guess.
    expect(blank.status).toBe(404);
    expect(unknown.status).toBe(404);
    const blankBody: { error: string; message: string } = await blank.json();
    const unknownBody: { error: string; message: string } = await unknown.json();
    expect(blankBody.error).toBe("invalid_input");
    expect(unknownBody.error).toBe("not_found");
    // The refusal carries nothing dashboard-shaped.
    expect(JSON.stringify(unknownBody)).not.toContain("temp");
  });

  it("refuses an expired share without rendering it", async () => {
    const service = new EmbedDashboardService({
      publicDashboard: {
        shares: async () => liveShare({ expiresAt: NOW - 1 }),
        layouts: async () => publicLayout(),
        projection: { snapshot: async () => [point("temp", 21, 1)] },
        now: () => NOW,
      },
    });
    const err: EmbedError | { code: string } = await service
      .render(SHARE_TOKEN)
      .then(() => {
        throw new Error("expected a refusal");
      })
      .catch((e: { code: string }) => e);
    // The public surface's uniform refusal, surfaced unchanged.
    expect(err.code).toBe("not_found");
  });

  it("refuses a revoked share without rendering it", async () => {
    const { shares, layouts, projection } = seams();
    const revoked: ShareResolver = async (presented) =>
      presented === SHARE_TOKEN ? liveShare({ revokedAt: NOW - 1 }) : null;
    const service = new EmbedDashboardService({
      publicDashboard: { shares: revoked, layouts, projection, now: () => NOW },
    });
    await expect(service.render(SHARE_TOKEN)).rejects.toMatchObject({ code: "not_found" });
    // Keep the unused binding meaningful: the live resolver resolves.
    expect(await shares(SHARE_TOKEN)).not.toBeNull();
  });

  it("refuses a share the deploy will not frame with a 403 (not a leak)", async () => {
    const app = harness({ allowsEmbed: () => false });
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.status).toBe(EMBED_STATUS_CODE.forbidden);
    const body: { error: string } = await res.json();
    expect(body.error).toBe("forbidden");
  });
});

// ---------------------------------------------------------------------------
// 4. The minimal SEO landing — title, meta, robots
// ---------------------------------------------------------------------------

describe("embed landing — title/meta present and explicitly unindexed", () => {
  it("carries a title, a description meta and a noindex robots directive", async () => {
    const app = harness({ layout: publicLayout({ title: "Boiler room", description: "Live boiler telemetry" }) });
    const html = await (await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`)).text();

    expect(html).toContain("<title>Boiler room</title>");
    expect(html).toContain('<meta name="description" content="Live boiler telemetry">');
    expect(html).toContain(`<meta name="robots" content="${EMBED_ROBOTS}">`);
  });

  it("sets the X-Robots-Tag header too (belt to the meta braces)", async () => {
    const res = await harness().request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    expect(res.headers.get("x-robots-tag")).toBe(EMBED_ROBOTS);
    // A token-specific body must never be cached by an intermediary.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("falls back to constants when the layout names no copy", () => {
    expect(embedTitle(null)).toBe("Shared dashboard");
    expect(embedDescription(null)).toBe("A read-only, shared Insight dashboard.");
    expect(embedTitle({ id: "x", title: "   " })).toBe("Shared dashboard");
  });

  it("escapes hostile layout copy so the head cannot be broken out of", () => {
    expect(escapeHtml('"><script>alert(1)</script>')).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    const page = renderEmbedPage({
      layout: { id: "x", variables: ["temp"], title: "</title><script>alert(1)</script>" },
      variables: ["temp"],
      points: [],
    });
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });
});

// ---------------------------------------------------------------------------
// 5. Read-only — the embed exposes no mutation
// ---------------------------------------------------------------------------

describe("embed — read-only by construction", () => {
  it("exposes no write route on the embed subtree", async () => {
    const app = new Hono();
    app.route(EMBED_PATH, createEmbedRoute({ publicDashboard: seams() as never }));
    // A share token is a read; a write verb is a framework 404, not a handler.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`, { method });
      expect(res.status).toBe(404);
    }
  });

  it("renders the resolved view's own read-only scope, never a mutable one", async () => {
    const { shares, layouts, projection } = seams();
    const view = await new PublicDashboardService({ shares, layouts, projection }).resolve(SHARE_TOKEN);
    expect(view.scope).toBe("read_only");
    expect(view.writable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5b. R-W3 — /embed is frameable through the COMPOSED app; other routes are not
// ---------------------------------------------------------------------------

describe("composed app — /embed framing override", () => {
  it("the embed response does NOT carry X-Frame-Options: DENY", async () => {
    const app = harness();
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).not.toBe("DENY");
    // Default deploy (no configured origins): frameable by self only.
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it("a configured ancestor list is honoured on the composed embed", async () => {
    const app = harness({ frameAncestors: ["https://dash.example.com"] });
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors https://dash.example.com",
    );
    // The legacy header is omitted for a configured allow-list (no origin-list
    // form); CSP is the control.
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  it("a normal composed app route STILL carries the DENY baseline", async () => {
    const app = harness({ frameAncestors: ["https://dash.example.com"] });
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  // MUTATION PROOF at the composition level: this pins that `createApp` mounts
  // the framing override on `/embed`. If that `app.use("/embed*", ...)` pair is
  // ever removed, `/embed` reverts to the global DENY and THIS test fails.
  it("MUTATION: the override lives in createApp — removing it would restore DENY", async () => {
    const embed = await harness().request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    const other = await harness().request("/healthz");
    // Same app, two paths: the framing headers MUST differ, which is only true
    // because createApp scoped the override to /embed.
    expect(embed.headers.get("X-Frame-Options")).not.toBe(other.headers.get("X-Frame-Options"));
    expect(other.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

// ---------------------------------------------------------------------------
// 6. Construction guard
// ---------------------------------------------------------------------------

describe("createEmbedRoute — construction", () => {
  it("throws when neither a service nor publicDashboard options are given", () => {
    // A route with no resolver could only 500; refusing at build time is louder.
    expect(() => createEmbedRoute({})).toThrow(TypeError);
  });

  it("accepts a ready service", async () => {
    const app = new Hono();
    app.route(EMBED_PATH, createEmbedRoute({ service: service() }));
    const res = await app.request(`${EMBED_PATH}/${SHARE_TOKEN}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 7. The refusal type is a stable, testable contract
// ---------------------------------------------------------------------------

describe("EmbedError", () => {
  it("maps codes onto statuses and renders the domain-wide body", () => {
    const forbidden = new EmbedError("forbidden", "nope");
    expect(isEmbedError(forbidden)).toBe(true);
    expect(forbidden.status).toBe(403);
    expect(forbidden.toBody()).toEqual({ error: "forbidden", message: "nope" });
    expect(new EmbedError("not_found", "gone").status).toBe(404);
  });

  it("is not raised for a resolvable share", async () => {
    const page = await service().render(SHARE_TOKEN);
    expect(page.variables).toEqual(["temp"]);
    expect(page.points.map((p) => p.variable)).toEqual(["temp"]);
  });
});

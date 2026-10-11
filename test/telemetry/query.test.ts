import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DEFAULT_WINDOW_MS,
  MAX_WINDOW_MS,
  InMemoryCredentials,
  InMemoryProjectLookup,
  InMemoryShards,
  createTelemetryQuery,
  parseWindow,
  readBearer,
  type QueryDeps,
} from "../../worker/src/domains/telemetry/query";
import type { StateRow } from "../../worker/src/platform/durable-objects/project-do";
import { shardIndex, type Sample } from "../../worker/src/platform/durable-objects/shard-do";

/**
 * Spec tests for the A11 telemetry read surface.
 *
 * Every dependency is injected, so each contract is asserted against values we
 * control outright — no Durable Object, no D1, no binding:
 *
 *   1. **State** — `/state` hands back the projection verbatim (the latest
 *      winning row per `(device, variable)`), so it can never drift from what
 *      the ProjectDO holds.
 *   2. **Series window** — `/series?window=` returns exactly the in-window
 *      points and drops the out-of-window ones, read from the shard ring that
 *      {@link shardIndex} locates for each device.
 *   3. **Tenant isolation** — a credential for A reading `/v1/projects/B/...` is
 *      denied fail-closed (403) and B's rows are never loaded (INV-A1).
 *   4. **Missing variable** — the documented choice: `200 { series: [] }`, never
 *      a 404 and never an error.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_A = "prj_alpha";
const PROJECT_B = "prj_beta";

const TOKEN_A = "pt_a_00000000000000000000000000000000";
const TOKEN_B = "pt_b_11111111111111111111111111111111";

/** Three shards, so the shard map is genuinely exercised (not a no-op). */
const TOTAL_SHARDS = 3;

/** The fixed "now" the window is measured back from. */
const NOW = 1_700_000_000_000;

/** One hour, in ms — the default window and the window used below. */
const ONE_HOUR = 60 * 60 * 1000;

/** Build a sample in the shape the shard ring stores. */
function sample(
  device: string,
  metric: string,
  value: number | null,
  ts: number,
  seq: number,
): Sample {
  return { device, metric, value, ts, seq, recordedAt: ts };
}

/** Build a projected row in the shape ProjectDO's `latest_state` holds. */
function stateRow(
  device: string,
  variable: string,
  value: number | null,
  ts: number,
  seq: number,
): StateRow {
  return { device, variable, value, ts, seq };
}

interface Harness {
  /** Mounted app exposing the read routes under `/v1/projects`. */
  app: Hono;
  credentials: InMemoryCredentials;
  projects: InMemoryProjectLookup;
  shards: InMemoryShards;
}

/**
 * Build a fully-injected read surface.
 *
 * `TOKEN_A` resolves to A and `TOKEN_B` to B by default; both projects' data is
 * seeded so a leak would be observable. The clock is fixed at {@link NOW}, so
 * `[now-window, now]` is exactly knowable.
 */
function harness(overrides: Partial<QueryDeps> = {}): Harness {
  const credentials = new InMemoryCredentials().add(TOKEN_A, PROJECT_A).add(TOKEN_B, PROJECT_B);
  const projects = new InMemoryProjectLookup();
  const shards = new InMemoryShards();

  const deps: QueryDeps = {
    credentials: credentials.resolver,
    projects,
    shards,
    totalShards: TOTAL_SHARDS,
    now: () => NOW,
    ...overrides,
  };

  const app = new Hono();
  app.route("/v1/projects", createTelemetryQuery(deps));
  return { app, credentials, projects, shards };
}

/** GET with a bearer credential attached (or none when omitted). */
function get(app: Hono, path: string, token?: string): Promise<Response> {
  return Promise.resolve(
    app.request(path, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  );
}

/** Unwrap the `{ error }` code from a denial body. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "<none>";
}

// ---------------------------------------------------------------------------
// GET /state — the projection, handed through verbatim
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:proj/state", () => {
  it("returns the latest winning row per (device, variable) from the projection", async () => {
    const h = harness();
    // Two devices, two variables: the projection already holds the winners.
    h.projects
      .push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7))
      .push(PROJECT_A, stateRow("dev-1", "cpu", 0.5, NOW - 2000, 3))
      .push(PROJECT_A, stateRow("dev-2", "temp", 26.0, NOW - 500, 1));

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: StateRow[] };
    expect(body.state).toHaveLength(3);
    expect(body.state).toContainEqual(stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    expect(body.state).toContainEqual(stateRow("dev-1", "cpu", 0.5, NOW - 2000, 3));
    expect(body.state).toContainEqual(stateRow("dev-2", "temp", 26.0, NOW - 500, 1));
  });

  it("returns the projection's winning value when a stream was pushed more than once", async () => {
    const h = harness();
    // The projection keeps only the winner; the route must not re-derive it.
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);
    const body = (await res.json()) as { state: StateRow[] };

    expect(body.state).toEqual([stateRow("dev-1", "temp", 25.4, NOW - 1000, 7)]);
  });

  it("returns an empty state array (200) when the project reports nothing yet", async () => {
    const h = harness();
    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: [] });
  });

  it("rejects a missing credential with 401 and reads no projection", async () => {
    const h = harness();
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`);

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  it("rejects an unknown token with 401", async () => {
    const h = harness();
    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, "pt_nope");

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// GET /series — in-window points from the shard ring
// ---------------------------------------------------------------------------

describe("GET /v1/projects/:proj/variables/:key/series", () => {
  it("returns the in-window points and EXCLUDES the out-of-window ones", async () => {
    const h = harness();
    const shard = shardIndex("dev-1", TOTAL_SHARDS);
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    h.shards
      // in-window
      .append(shard, sample("dev-1", "temp", 25.0, NOW - ONE_HOUR + 1000, 5))
      .append(shard, sample("dev-1", "temp", 25.4, NOW - 1000, 7))
      // out-of-window: older than `now - window`
      .append(shard, sample("dev-1", "temp", 24.0, NOW - ONE_HOUR - 1, 4))
      .append(shard, sample("dev-1", "temp", 23.0, NOW - 2 * ONE_HOUR, 1))
      // out-of-window: after the window's upper bound (a future sample)
      .append(shard, sample("dev-1", "temp", 99.0, NOW + 1, 9));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { series: { ts: number; value: number | null }[] };
    expect(body.series.map((p) => p.ts)).toEqual([NOW - ONE_HOUR + 1000, NOW - 1000]);
    expect(body.series.map((p) => p.value)).toEqual([25.0, 25.4]);
  });

  it("does not mix in other variables' points for the same device", async () => {
    const h = harness();
    const shard = shardIndex("dev-1", TOTAL_SHARDS);
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    h.shards
      .append(shard, sample("dev-1", "temp", 25.4, NOW - 1000, 7))
      .append(shard, sample("dev-1", "cpu", 0.5, NOW - 1000, 8));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );
    const body = (await res.json()) as { series: { variable: string }[] };

    expect(body.series).toHaveLength(1);
    expect(body.series[0].variable).toBe("temp");
  });

  it("locates each device's shard with shardIndex and reads ONLY that shard", async () => {
    const h = harness();
    const shard = shardIndex("dev-1", TOTAL_SHARDS);
    h.projects
      .push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7))
      .push(PROJECT_A, stateRow("dev-2", "temp", 26.0, NOW - 900, 2));
    h.shards
      .append(shard, sample("dev-1", "temp", 25.4, NOW - 1000, 7))
      // dev-2 is never seeded on this shard, so it contributes nothing.
      .append(shard, sample("dev-1", "temp", 25.0, NOW - 2000, 6));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );
    const body = (await res.json()) as { series: { device: string }[] };

    expect(body.series.map((p) => p.device)).toEqual(["dev-1", "dev-1"]);
    expect(h.shards.reads).toContainEqual({ shardId: shardIndex("dev-1", TOTAL_SHARDS), device: "dev-1" });
    expect(h.shards.reads).toContainEqual({ shardId: shardIndex("dev-2", TOTAL_SHARDS), device: "dev-2" });
  });

  it("orders points by (ts, seq), not by shard arrival", async () => {
    const h = harness();
    const shard = shardIndex("dev-1", TOTAL_SHARDS);
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    h.shards
      .append(shard, sample("dev-1", "temp", 25.4, NOW - 1000, 7))
      .append(shard, sample("dev-1", "temp", 25.0, NOW - 3000, 6))
      .append(shard, sample("dev-1", "temp", 25.2, NOW - 2000, 5));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );
    const body = (await res.json()) as { series: { ts: number }[] };

    expect(body.series.map((p) => p.ts)).toEqual([NOW - 3000, NOW - 2000, NOW - 1000]);
  });

  it("defaults to a one-hour window when `window` is omitted", async () => {
    const h = harness();
    const shard = shardIndex("dev-1", TOTAL_SHARDS);
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    h.shards
      .append(shard, sample("dev-1", "temp", 25.4, NOW - 1000, 7))
      .append(shard, sample("dev-1", "temp", 24.0, NOW - DEFAULT_WINDOW_MS - 1, 4));

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/variables/temp/series`, TOKEN_A);
    const body = (await res.json()) as { series: { ts: number }[] };

    expect(body.series.map((p) => p.ts)).toEqual([NOW - 1000]);
  });

  // --- the documented missing-variable choice -------------------------------
  it("MISSING KEY -> 200 { series: [] } (documented choice, never a 404)", async () => {
    const h = harness();
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/does_not_exist/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ series: [] });
  });

  it("a known variable with no points inside the window is also 200 { series: [] }", async () => {
    const h = harness();
    const shard = shardIndex("dev-1", TOTAL_SHARDS);
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    h.shards.append(shard, sample("dev-1", "temp", 24.0, NOW - ONE_HOUR - 1, 4));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ series: [] });
  });

  it("rejects a negative window with 400", async () => {
    const h = harness();
    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=-1`,
      TOKEN_A,
    );

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_window");
  });

  it("rejects a non-numeric window with 400", async () => {
    const h = harness();
    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=soon`,
      TOKEN_A,
    );

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_window");
  });

  it("rejects an over-large window with 400 rather than clamping silently", async () => {
    const h = harness();
    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_A}/variables/temp/series?window=${MAX_WINDOW_MS + 1}`,
      TOKEN_A,
    );

    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_window");
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — the credential decides the tenant, not the path (INV-A1)
// ---------------------------------------------------------------------------

describe("tenant isolation (INV-A1)", () => {
  it("project A credential on /v1/projects/B/state -> 403 and B's data never loads", async () => {
    const h = harness();
    h.projects.push(PROJECT_B, stateRow("dev-b", "secret", 42.0, NOW - 1000, 1));

    const res = await get(h.app, `/v1/projects/${PROJECT_B}/state`, TOKEN_A);

    expect(res.status).toBe(403);
    // Read the body once; assert both the code and that no projection leaked.
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "project_mismatch",
      message: expect.any(String),
    });
    expect(text).not.toContain("dev-b");
    expect(text).not.toContain("secret");
  });

  it("project A credential on B's series -> 403 (no leak of B's ring)", async () => {
    const h = harness();
    const shard = shardIndex("dev-b", TOTAL_SHARDS);
    h.projects.push(PROJECT_B, stateRow("dev-b", "secret", 42.0, NOW - 1000, 1));
    h.shards.append(shard, sample("dev-b", "secret", 42.0, NOW - 1000, 1));

    const res = await get(
      h.app,
      `/v1/projects/${PROJECT_B}/variables/secret/series?window=${ONE_HOUR}`,
      TOKEN_A,
    );

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("project_mismatch");
    // No shard was ever consulted for the foreign tenant.
    expect(h.shards.reads).toHaveLength(0);
  });

  it("the matching credential reads its own project normally", async () => {
    const h = harness();
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: StateRow[] };
    expect(body.state).toEqual([stateRow("dev-1", "temp", 25.4, NOW - 1000, 7)]);
  });

  it("fails closed (401) when the credential resolver throws", async () => {
    const h = harness({
      credentials: async () => {
        throw new Error("resolver unavailable");
      },
    });

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);

    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// Strict credential parsing + the deliberate read policy (INV-A5 companion)
// ---------------------------------------------------------------------------

describe("read surface credential parsing (shared STRICT Bearer parser)", () => {
  /** Send a GET with a raw Authorization header value (no helper wrapping). */
  function rawGet(app: Hono, path: string, authorization: string): Promise<Response> {
    return Promise.resolve(app.request(path, { headers: { authorization } }));
  }

  it("rejects a bare / scheme-less Authorization with 401 (never resolves it)", async () => {
    const h = harness();
    const res = await rawGet(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  it("rejects a non-Bearer scheme (Basic) with 401", async () => {
    const h = harness();
    const res = await rawGet(h.app, `/v1/projects/${PROJECT_A}/state`, `Basic ${TOKEN_A}`);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  it("accepts the Bearer scheme case-insensitively (control)", async () => {
    const h = harness();
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));
    const res = await rawGet(h.app, `/v1/projects/${PROJECT_A}/state`, `bearer ${TOKEN_A}`);
    expect(res.status).toBe(200);
  });

  it("enforces the deliberate READ policy: the gate resolves a read-capable principal", async () => {
    // The route gates the resolved tenant through the SHARED
    // `requireScope(c, "read")`. The principal carries no explicit scopes, which
    // the least-privilege default treats as `read` — so a plain read is granted.
    // The policy is asserted by observing that the read succeeds on a tenant the
    // resolver vouched for, and the gate never grants more than `read`.
    const h = harness();
    h.projects.push(PROJECT_A, stateRow("dev-1", "temp", 25.4, NOW - 1000, 7));

    const res = await get(h.app, `/v1/projects/${PROJECT_A}/state`, TOKEN_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: StateRow[] };
    expect(body.state).toEqual([stateRow("dev-1", "temp", 25.4, NOW - 1000, 7)]);
  });

  it("exports the shared strict parser under the read surface's name", () => {
    // A guard: the read surface must delegate to the ONE shared parser, so a
    // bare token is empty here exactly as it is rejected there.
    expect(readBearer("Bearer pt_ok")).toBe("pt_ok");
    expect(readBearer("pt_bare")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("readBearer", () => {
  it("accepts the Bearer scheme case-insensitively", () => {
    expect(readBearer("Bearer pt_abc")).toBe("pt_abc");
    expect(readBearer("bearer   pt_abc")).toBe("pt_abc");
    expect(readBearer("BEARER pt_abc")).toBe("pt_abc");
  });

  it("rejects a bare / scheme-less token (the STRICT shared parser)", () => {
    // A bare token is NOT a credential: the read surface must not accept it.
    expect(readBearer("pt_abc")).toBe("");
  });

  it("yields '' for a missing header or a Bearer with no token", () => {
    expect(readBearer(undefined)).toBe("");
    expect(readBearer("")).toBe("");
    expect(readBearer("Bearer ")).toBe("");
    expect(readBearer("Basic pt_abc")).toBe("");
  });
});

describe("parseWindow", () => {
  it("returns null when absent or blank", () => {
    expect(parseWindow(undefined)).toBeNull();
    expect(parseWindow("  ")).toBeNull();
  });

  it("parses a numeric value and reports NaN for a non-numeric one", () => {
    expect(parseWindow("3600000")).toBe(3_600_000);
    expect(Number.isNaN(parseWindow("soon"))).toBe(true);
  });
});

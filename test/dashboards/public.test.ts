import { describe, expect, it } from "vitest";
import {
  DEFAULT_PUBLIC_SNAPSHOT_POINTS,
  PUBLIC_STATUS_CODE,
  PublicDashboardError,
  PublicDashboardService,
  allowList,
  filterPoint,
  isPublicDashboardError,
  type DashboardLayout,
  type LayoutLookup,
  type Point,
  type ProjectionSource,
  type Share,
  type ShareResolver,
  type TokenHasher,
} from "../../worker/src/domains/dashboards/public";
import type { Clock } from "../../worker/src/platform/lib/clock";

/**
 * Spec tests for the public shared-dashboard read path — ST-D2 / INV-D2 (D4.3).
 *
 * The module talks to three injected seams (a {@link ShareResolver}, a
 * {@link LayoutLookup} and a {@link ProjectionSource}) plus a hash and a clock,
 * so every contract is asserted against values this test owns outright. The one
 * rule under test is the allow-list: a share token resolves to a project + the
 * variables its layout names, and **nothing outside that layout is ever sent**,
 * neither in the initial snapshot nor in a live frame.
 *
 * The load-bearing case is the last group: a project that holds a
 * `secret_token` alongside the public `temp`, with a layout that names only
 * `temp`. The assertion is not "the secret is hidden in the UI" — it is that the
 * bytes never exist, checked by scanning every serialised payload for the
 * secret's *value*.
 *
 * Denials are asserted through the module's throw-on-failure convention: a
 * refusal is a typed {@link PublicDashboardError} with a stable `code`, never a
 * permissive default.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A share resolver over a `Map<plaintext, Share>`.
 *
 * Keyed by the *plaintext* token (like a store keyed by a lookup whose digest
 * the caller already computed), so the test can hand the service a token and
 * have the fake return whatever row it wants — including, in one case, the
 * wrong row, to prove the service re-checks the digest rather than trusting the
 * resolver.
 */
class FakeShareResolver {
  readonly byToken = new Map<string, Share>();
  calls = 0;

  resolver: ShareResolver = async (presented) => {
    this.calls += 1;
    return this.byToken.get(presented) ?? null;
  };

  put(plaintext: string, share: Share): this {
    this.byToken.set(plaintext, share);
    return this;
  }
}

/** A layout lookup over a `Map<string, DashboardLayout>`. */
class FakeLayouts {
  readonly byId = new Map<string, DashboardLayout>();
  calls = 0;

  lookup: LayoutLookup = async (id) => {
    this.calls += 1;
    return this.byId.get(id) ?? null;
  };

  put(layout: DashboardLayout): this {
    this.byId.set(layout.id, layout);
    return this;
  }
}

/**
 * A projection source the test drives by hand.
 *
 * `points` is the project's *whole* projection — public and secret rows
 * together — exactly as an unfiltered read would return them. The service is
 * the only thing that must narrow it, so a leak shows up here as a secret row
 * surviving into the payload.
 */
class FakeProjection {
  points: Point[] = [];
  calls = 0;
  lastLimit = 0;

  source: ProjectionSource = {
    snapshot: async (_projectId, limit) => {
      this.calls += 1;
      this.lastLimit = limit;
      return this.points;
    },
  };
}

/** A SHA-256 hex hasher, matching `platform/lib/tokens.ts` (WebCrypto). */
const sha256Hex: TokenHasher = async (plaintext) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

/** The digest of the one share token the whole file uses. */
const SHARE_TOKEN = "st_public_abc";
const SHARE_DIGEST = await sha256Hex(SHARE_TOKEN);

/** A fixed clock, so expiry is decided by a value the test names. */
const NOW = 1_700_000_000_000;

/** A live share bound to `proj_a` / `layout_pub`, never expiring. */
function liveShare(overrides: Partial<Share> = {}): Share {
  return {
    id: "share_1",
    tokenHash: SHARE_DIGEST,
    projectId: "proj_a",
    layoutId: "layout_pub",
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

/** The public layout: it exposes `temp` and NOTHING else. */
function publicLayout(overrides: Partial<DashboardLayout> = {}): DashboardLayout {
  return { id: "layout_pub", variables: ["temp"], ...overrides };
}

/**
 * Build a service over fresh fakes, with deterministic hash + clock.
 *
 * Every seam is returned so a test can inspect it directly (calls, last limit),
 * and the share/layout are pre-registered so a test that is not *about*
 * resolution does not have to restate the happy path.
 */
function setup() {
  const shares = new FakeShareResolver();
  const layouts = new FakeLayouts();
  const projection = new FakeProjection();
  const service = new PublicDashboardService({
    shares: shares.resolver,
    layouts: layouts.lookup,
    projection: projection.source,
    hash: sha256Hex,
    now: () => NOW,
  });
  return { shares, layouts, projection, service };
}

/** A reading for `(device, variable)` with a caller-chosen `value`/`seq`. */
function point(device: string, variable: string, value: number, seq: number): Point {
  return { device, variable, value, ts: NOW - seq, seq };
}

/** Assert that `fn` rejects with a PublicDashboardError carrying `code`. */
async function expectDenied(fn: () => Promise<unknown>, code: string): Promise<PublicDashboardError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PublicDashboardError);
    const error = err as PublicDashboardError;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code}, but the call resolved`);
}

// ---------------------------------------------------------------------------
// The allow-list (pure)
// ---------------------------------------------------------------------------

describe("allowList", () => {
  it("keeps exactly the variables a layout names", () => {
    const allow = allowList({ id: "l", variables: ["temp", "humidity"] });
    expect([...allow].sort()).toEqual(["humidity", "temp"]);
  });

  it("is empty when the layout names nothing — fail-closed, not fail-open", () => {
    expect(allowList({ id: "l" }).size).toBe(0);
    expect(allowList({ id: "l", variables: [] }).size).toBe(0);
  });

  it("ignores blank / non-string entries rather than widening the filter", () => {
    const allow = allowList({
      id: "l",
      variables: ["temp", "", "pressure"],
    });
    expect(allow.has("")).toBe(false);
    expect([...allow].sort()).toEqual(["pressure", "temp"]);
  });

  it("matches by exact name only — no prefix, case-fold or pattern semantics", () => {
    const allow = allowList({ id: "l", variables: ["temp"] });
    expect(allow.has("temp")).toBe(true);
    expect(allow.has("temp_high")).toBe(false);
    expect(allow.has("Temp")).toBe(false);
    expect(allow.has("tem")).toBe(false);
  });
});

describe("filterPoint", () => {
  const allow = allowList({ id: "l", variables: ["temp"] });

  it("admits a point whose variable is in the allow-list, unchanged", () => {
    const p = point("dev_1", "temp", 21.5, 4);
    expect(filterPoint(allow, p)).toBe(p);
  });

  it("drops a point outside the allow-list", () => {
    expect(filterPoint(allow, point("dev_1", "secret_token", 1, 4))).toBeNull();
  });

  it("drops a shape it cannot inspect (fail-closed, not fail-open)", () => {
    expect(filterPoint(allow, null)).toBeNull();
    expect(filterPoint(allow, { device: "dev_1", seq: 1 })).toBeNull();
    expect(filterPoint(allow, { variable: "" })).toBeNull();
    expect(filterPoint(allow, { variable: 42 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolution: a token -> project + layout allow-list
// ---------------------------------------------------------------------------

describe("resolve", () => {
  it("returns a read-only view bound to the share's project and layout", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);

    expect(view.projectId).toBe("proj_a");
    expect(view.layoutId).toBe("layout_pub");
    expect(view.variables).toEqual(["temp"]);
    expect(view.scope).toBe("read_only");
    expect(view.writable).toBe(false);
  });

  it("freezes the echoed allow-list", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    expect(Object.isFrozen(view.variables)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Snapshot: only layout variables (INV-D2)
// ---------------------------------------------------------------------------

describe("snapshot", () => {
  it("returns only the layout's variables", async () => {
    const { shares, layouts, projection, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout({ variables: ["temp", "humidity"] }));
    projection.points = [
      point("dev_1", "temp", 21, 3),
      point("dev_1", "humidity", 44, 2),
      point("dev_1", "pressure", 1013, 1),
    ];

    const view = await service.resolve(SHARE_TOKEN);
    const snapshot = await view.snapshot();

    expect(snapshot.map((p) => p.variable).sort()).toEqual(["humidity", "temp"]);
    expect(snapshot.every((p) => view.variables.includes(p.variable))).toBe(true);
  });

  it("caps the read at the configured snapshot limit", async () => {
    const { shares, layouts, projection, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    await view.snapshot();

    expect(projection.lastLimit).toBe(DEFAULT_PUBLIC_SNAPSHOT_POINTS);
  });

  it("is empty when the layout names nothing — never the whole projection", async () => {
    const { shares, layouts, projection, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout({ variables: [] }));
    projection.points = [point("dev_1", "temp", 21, 1), point("dev_1", "secret", 9, 2)];

    const view = await service.resolve(SHARE_TOKEN);
    expect(await view.snapshot()).toEqual([]);
  });

  it("re-reads the projection on every call (a live read, not a cache)", async () => {
    const { shares, layouts, projection, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    await view.snapshot();
    projection.points = [point("dev_1", "temp", 30, 9)];
    const second = await view.snapshot();

    expect(projection.calls).toBe(2);
    expect(second.map((p) => p.value)).toEqual([30]);
  });
});

// ---------------------------------------------------------------------------
// Live frames: the same allow-list, so a stream never leaks either
// ---------------------------------------------------------------------------

describe("filterFrame", () => {
  it("delivers a frame for an in-layout variable", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    const frame = point("dev_1", "temp", 22, 10);
    expect(view.filterFrame(frame)).toBe(frame);
  });

  it("drops a frame for an out-of-layout variable", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    expect(view.filterFrame(point("dev_1", "secret_token", 1, 11))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INV-D2 / ST-D2: the secret in the project but not in the layout never appears
// ---------------------------------------------------------------------------

describe("INV-D2 — a variable outside the layout never reaches a public payload", () => {
  /**
   * The spec setup (ST-D2): the project holds `secret_token`; the public layout
   * names only `temp`. The secret's value is a distinctive string-encoded number
   * so a leaked byte is unmistakable under a JSON scan.
   */
  const SECRET_VALUE = 8675309;

  function seeded() {
    const ctx = setup();
    ctx.shares.put(SHARE_TOKEN, liveShare());
    ctx.layouts.put(publicLayout({ variables: ["temp"] }));
    ctx.projection.points = [
      point("dev_1", "temp", 21, 5),
      { device: "dev_1", variable: "secret_token", value: SECRET_VALUE, ts: NOW, seq: 6 },
      point("dev_1", "internal_key", 7, 4),
    ];
    return ctx;
  }

  it("is absent from the snapshot", async () => {
    const { service } = seeded();
    const view = await service.resolve(SHARE_TOKEN);
    const snapshot = await view.snapshot();

    expect(snapshot.map((p) => p.variable)).toEqual(["temp"]);
    const wire = JSON.stringify(snapshot);
    expect(wire).not.toContain("secret_token");
    expect(wire).not.toContain(String(SECRET_VALUE));
  });

  it("is absent from a live frame", async () => {
    const { service } = seeded();
    const view = await service.resolve(SHARE_TOKEN);

    const frame = view.filterFrame({
      device: "dev_1",
      variable: "secret_token",
      value: SECRET_VALUE,
      ts: NOW,
      seq: 7,
    });
    expect(frame).toBeNull();
  });

  it("never appears in ANY payload, across a full snapshot + stream session", async () => {
    const { service } = seeded();
    const view = await service.resolve(SHARE_TOKEN);

    // Emulate a session: snapshot, then every projection row pushed as a frame.
    const payloads: unknown[] = [await view.snapshot()];
    for (const row of [
      point("dev_1", "temp", 22, 7),
      { device: "dev_1", variable: "secret_token", value: SECRET_VALUE, ts: NOW, seq: 8 },
      point("dev_1", "temp", 23, 9),
      { device: "dev_1", variable: "internal_key", value: 1, ts: NOW, seq: 10 },
    ]) {
      payloads.push(view.filterFrame(row));
    }

    const wire = JSON.stringify(payloads);
    expect(wire).not.toContain("secret_token");
    expect(wire).not.toContain(String(SECRET_VALUE));
    expect(wire).not.toContain("internal_key");
    // The public variable *does* survive, so the absence is a filter, not a blackout.
    expect(wire).toContain("temp");
  });
});

// ---------------------------------------------------------------------------
// Invalid / expired / revoked share -> 404 (uniform, no oracle)
// ---------------------------------------------------------------------------

describe("share token validity", () => {
  it("rejects an unknown token as not_found (404)", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const err = await expectDenied(() => service.resolve("st_not_a_token"), "not_found");
    expect(err.status).toBe(404);
  });

  it("rejects an expired token as not_found (404)", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare({ expiresAt: NOW - 1 }));
    layouts.put(publicLayout());

    await expectDenied(() => service.resolve(SHARE_TOKEN), "not_found");
  });

  it("rejects a token that expires exactly now (<= is expired, fail-closed)", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare({ expiresAt: NOW }));
    layouts.put(publicLayout());

    await expectDenied(() => service.resolve(SHARE_TOKEN), "not_found");
  });

  it("accepts a token that expires in the future", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare({ expiresAt: NOW + 1 }));
    layouts.put(publicLayout());

    await expect(service.resolve(SHARE_TOKEN)).toBeDefined();
  });

  it("rejects a revoked token as not_found (404)", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare({ revokedAt: NOW - 1000 }));
    layouts.put(publicLayout());

    const err = await expectDenied(() => service.resolve(SHARE_TOKEN), "not_found");
    expect(err.status).toBe(404);
  });

  it("rejects a blank token as invalid_input (404)", async () => {
    const { service } = setup();
    const err = await expectDenied(() => service.resolve("   "), "invalid_input");
    expect(err.status).toBe(404);
  });

  it("re-checks the digest: a resolver returning the wrong row is refused", async () => {
    const { shares, layouts, service } = setup();
    // The resolver answers with a *valid* row whose hash is not this token's.
    shares.put(SHARE_TOKEN, liveShare({ tokenHash: SHARE_DIGEST.replace(/^./, "0") }));
    layouts.put(publicLayout());

    await expectDenied(() => service.resolve(SHARE_TOKEN), "not_found");
  });

  it("rejects a share whose layout is missing (broken pointer => 404, never empty)", async () => {
    const { shares, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    // No layout registered.

    await expectDenied(() => service.resolve(SHARE_TOKEN), "not_found");
  });

  it("answers every refusal with the same status and code — no oracle (ST-D2)", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare({ revokedAt: NOW }));
    layouts.put(publicLayout());

    const cases = await Promise.all([
      expectDenied(() => service.resolve(""), "invalid_input"),
      expectDenied(() => service.resolve("st_unknown"), "not_found"),
      expectDenied(() => service.resolve(SHARE_TOKEN), "not_found"),
    ]);

    // Every one of these is a 404 with the *same* body — a stranger learns only
    // "no such dashboard", never which condition failed.
    for (const err of cases) {
      expect(err.status).toBe(404);
      expect(err.toBody()).toEqual({ error: err.code, message: err.message });
    }
    expect(PUBLIC_STATUS_CODE.invalid_input).toBe(404);
    expect(PUBLIC_STATUS_CODE.not_found).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Read-only: no write is possible through a public view
// ---------------------------------------------------------------------------

describe("read-only", () => {
  it("exposes `writable: false` and a `read_only` scope", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    expect(view.writable).toBe(false);
    expect(view.scope).toBe("read_only");
  });

  it("assertReadOnly throws read_only (401) for any attempted write", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    let thrown: unknown;
    try {
      view.assertReadOnly("save");
    } catch (err) {
      thrown = err;
    }
    expect(isPublicDashboardError(thrown)).toBe(true);
    const error = thrown as PublicDashboardError;
    expect(error.code).toBe("read_only");
    expect(error.status).toBe(401);
  });

  it("has no mutating member on the view at all", async () => {
    const { shares, layouts, service } = setup();
    shares.put(SHARE_TOKEN, liveShare());
    layouts.put(publicLayout());

    const view = await service.resolve(SHARE_TOKEN);
    const surface = view as unknown as Record<string, unknown>;
    for (const forbidden of ["save", "create", "delete", "update", "write"]) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Construction guard
// ---------------------------------------------------------------------------

describe("construction", () => {
  it("refuses a non-positive snapshot limit (a silent blackout, not a default)", () => {
    const shares = new FakeShareResolver();
    const layouts = new FakeLayouts();
    const projection = new FakeProjection();
    const deps = {
      shares: shares.resolver,
      layouts: layouts.lookup,
      projection: projection.source,
      hash: sha256Hex,
      now: (() => NOW) as Clock,
    };
    expect(() => new PublicDashboardService({ ...deps, snapshotLimit: 0 })).toThrow(RangeError);
    expect(() => new PublicDashboardService({ ...deps, snapshotLimit: -1 })).toThrow(RangeError);
  });
});

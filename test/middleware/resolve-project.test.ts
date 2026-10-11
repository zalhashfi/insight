import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  hasScope,
  parseScopes,
  readBearerToken,
  requireScope,
  resolveAdminProject,
  resolveDeviceProject,
  resolveProject,
  type CredentialLookupResult,
  type DevicePrincipal,
  type Principal,
  type ResolveProjectOptions,
  type UserPrincipal,
} from "../../worker/src/platform/middleware/resolve-project";

/** The variables this middleware writes, for typing the harness app. */
type AppVars = { project: Principal; principal: Principal };

/** The route handler signature used by the harness. */
type RouteHandler = (c: Context<{ Variables: AppVars }>) => Response;

/**
 * Fail-closed project resolution (INV-A1 / INV-A5, ST-A1 / ST-A5).
 *
 * Every case here drives the middleware through a real Hono app with an
 * injected fake lookup — no bindings, no D1, no network. The fakes are honest:
 * the `deviceTokens` resolver knows only project tokens and the `sessions`
 * resolver knows only user sessions, so a credential of the wrong family
 * simply does not resolve in the other one (exactly like a D1 lookup by the
 * wrong `token_hash` column would not).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_A = "prj_alpha";
const PROJECT_B = "prj_beta";

/**
 * The fixture tokens, one per scope shape the middleware must distinguish:
 *
 *   * {@link TOKEN_A} — explicitly `read write` (the operational M1 token);
 *   * {@link TOKEN_A_SCOPELESS} — NO scope string: read-only under the
 *     least-privilege default, so it may read but never write;
 *   * {@link TOKEN_A_READONLY} — explicitly `read`; cannot write;
 *   * {@link TOKEN_A_WRITEONLY} — explicitly `write`; cannot even read.
 */
const DEVICE_TOKEN_A = "pt_device_a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_TOKEN_A_SCOPELESS = "pt_device_a_scopeless_ddddddddddddddddddd";
const DEVICE_TOKEN_A_READONLY = "pt_device_a_readonly_bbbbbbbbbbbbbbbbbbbbbb";
const DEVICE_TOKEN_A_WRITEONLY = "pt_device_a_writeonly_ccccccccccccccccccc";
const DEVICE_TOKEN_B = "pt_device_b_dddddddddddddddddddddddddddddd";

const SESSION_ALICE = "sess_alice_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const SESSION_BOB = "sess_bob_ffffffffffffffffffffffffffffffffff";

/** A member of A with read-only membership. */
const ALICE: UserPrincipal = {
  kind: "user",
  userId: "usr_alice",
  projectId: PROJECT_A,
  role: "member",
};

/** An owner of A, carrying an explicit permission set. */
const BOB: UserPrincipal = {
  kind: "user",
  userId: "usr_bob",
  projectId: PROJECT_A,
  role: "owner",
  permissions: ["project:read", "project:update", "member:invite"],
};

/** A project token for A carrying full `read write` capabilities. */
const TOKEN_A: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT_A,
  tokenId: "tok_a",
  scopes: "read write",
};

/** Same project, NO scope string — least-privilege default: read only. */
const TOKEN_A_SCOPELESS: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT_A,
  tokenId: "tok_a_none",
};

/** Same project, but scoped to reads only. */
const TOKEN_A_READONLY: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT_A,
  tokenId: "tok_a_ro",
  scopes: "read",
};

/** Same project, scoped to writes only — cannot even read. */
const TOKEN_A_WRITEONLY: DevicePrincipal = {
  kind: "device",
  projectId: PROJECT_A,
  tokenId: "tok_a_wo",
  scopes: "write",
};

const DEVICE_TOKENS: Record<string, CredentialLookupResult> = {
  [DEVICE_TOKEN_A]: TOKEN_A,
  [DEVICE_TOKEN_A_SCOPELESS]: TOKEN_A_SCOPELESS,
  [DEVICE_TOKEN_A_READONLY]: TOKEN_A_READONLY,
  [DEVICE_TOKEN_A_WRITEONLY]: TOKEN_A_WRITEONLY,
  [DEVICE_TOKEN_B]: { kind: "device", projectId: PROJECT_B, tokenId: "tok_b" },
};

const SESSIONS: Record<string, CredentialLookupResult> = {
  [SESSION_ALICE]: ALICE,
  [SESSION_BOB]: BOB,
};

const OPTIONS: ResolveProjectOptions = {
  deviceTokens: async (token) => DEVICE_TOKENS[token] ?? null,
  sessions: async (session) => SESSIONS[session] ?? null,
};

// ---------------------------------------------------------------------------
// App harness
// ---------------------------------------------------------------------------

/** GET/POST helper that attaches a Bearer credential. */
function bearer(token?: string): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/** A tiny mounted app exposing both surfaces behind the middleware. */
function makeApp(options: ResolveProjectOptions = OPTIONS) {
  const app = new Hono<{ Variables: AppVars }>();

  // Middleware is mounted via route-level chaining (not `app.use` + wildcard,
  // and not a mounted sub-app): only the route's own pattern binds `:proj`, so
  // this is the one arrangement in which a path claim is visible to the guard —
  // which is exactly what the fail-closed comparison needs to see.

  // Device ingress is a WRITE surface: the handler gates on requireScope, so a
  // `read`-scoped device token authenticates but is refused the write.
  const deviceGate = resolveDeviceProject(options);
  const ingest: RouteHandler = (c) => {
    const refused = requireScope(c, "write");
    if (refused) return refused;
    return c.json({ ok: true, project: c.get("project"), claimed: c.req.param("proj") }, 201);
  };
  app.post("/device/ingest", deviceGate, ingest);
  app.post("/device/:proj/ingest", deviceGate, ingest);

  const adminGate = resolveAdminProject(options);
  app.get("/admin/settings", adminGate, (c) => c.json({ ok: true, principal: c.get("principal") }));
  app.get("/admin/:proj/settings", adminGate, (c) =>
    c.json({ ok: true, claimed: c.req.param("proj") }),
  );
  app.get("/admin/:proj/members", adminGate, (c) =>
    c.json({ ok: true, claimed: c.req.param("proj") }),
  );

  return app;
}

/** Unwrap the `{ error }` code from a denial body. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string };
  return body.error ?? "<none>";
}

// ---------------------------------------------------------------------------
// INV-A1: the tenant comes from the credential, and a path claim must MATCH
// ---------------------------------------------------------------------------

describe("INV-A1 — project is derived from the credential, never the path", () => {
  it("project token for A hitting a path claiming B -> 403 (fail closed)", async () => {
    const res = await makeApp().request(`/device/${PROJECT_B}/ingest`, {
      method: "POST",
      headers: bearer(DEVICE_TOKEN_A),
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("project_mismatch");
  });

  it("a user session claiming a foreign project -> 403 (fail closed)", async () => {
    // Alice is a member of A only; the path claims B.
    const res = await makeApp().request(`/admin/${PROJECT_B}/settings`, {
      headers: bearer(SESSION_ALICE),
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("project_mismatch");
  });

  it("a matching path claim passes through (claim agrees with credential)", async () => {
    const res = await makeApp().request(`/device/${PROJECT_A}/ingest`, {
      method: "POST",
      headers: bearer(DEVICE_TOKEN_A),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { claimed: string; project: DevicePrincipal };
    expect(body.claimed).toBe(PROJECT_A);
    expect(body.project.projectId).toBe(PROJECT_A);
  });

  it("a path with NO project claim passes (nothing to contradict)", async () => {
    const res = await makeApp().request("/device/ingest", {
      method: "POST",
      headers: bearer(DEVICE_TOKEN_A),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: DevicePrincipal };
    expect(body.project.projectId).toBe(PROJECT_A);
  });

  it("a user session claiming its own project passes", async () => {
    const res = await makeApp().request(`/admin/${PROJECT_A}/settings`, {
      headers: bearer(SESSION_BOB),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, claimed: PROJECT_A });
  });

  it("the resolved principal — not the path — is what downstream sees", async () => {
    const res = await makeApp().request("/admin/settings", {
      headers: bearer(SESSION_ALICE),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: UserPrincipal };
    expect(body.principal).toMatchObject({
      kind: "user",
      userId: "usr_alice",
      projectId: PROJECT_A,
    });
  });
});

// ---------------------------------------------------------------------------
// Scope / authorization gate
// ---------------------------------------------------------------------------

describe("scope gate — a read-only credential cannot write", () => {
  it("a read-scope device token attempting device ingress (a write) -> 403", async () => {
    const res = await makeApp().request("/device/ingest", {
      method: "POST",
      headers: bearer(DEVICE_TOKEN_A_READONLY),
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("insufficient_scope");
  });

  it("a scope-less device token attempting device ingress (a write) -> 403", async () => {
    // The least-privilege default: no scope string means read-only, so this
    // credential authenticates but is refused the write.
    const res = await makeApp().request("/device/ingest", {
      method: "POST",
      headers: bearer(DEVICE_TOKEN_A_SCOPELESS),
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("insufficient_scope");
  });

  it("a read-scope user session is refused an admin write action -> 403", async () => {
    // Alice resolves fine (member can read), but the write gate refuses her.
    const app = new Hono<{ Variables: AppVars }>();
    app.post("/admin/update", resolveAdminProject(OPTIONS), (c) =>
      requireScope(c, "write") ?? c.json({ ok: true }),
    );

    const res = await app.request("/admin/update", {
      method: "POST",
      headers: bearer(SESSION_ALICE),
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("insufficient_scope");
  });

  it("an owner with write permission passes the same write gate", async () => {
    const app = new Hono<{ Variables: AppVars }>();
    app.post("/admin/update", resolveAdminProject(OPTIONS), (c) =>
      requireScope(c, "write") ?? c.json({ ok: true }),
    );

    const res = await app.request("/admin/update", {
      method: "POST",
      headers: bearer(SESSION_BOB),
    });
    expect(res.status).toBe(200);
  });

  it("a write-only device token cannot read — but may write", async () => {
    const app = makeApp();
    // The device ingress handler gates writes: a write-scope token is allowed.
    const write = await app.request("/device/ingest", {
      method: "POST",
      headers: bearer(DEVICE_TOKEN_A_WRITEONLY),
    });
    expect(write.status).toBe(201);

    // A read gate on the same principal is refused (the token has no `read`).
    const readOnly = new Hono<{ Variables: AppVars }>();
    readOnly.get("/device/state", resolveDeviceProject(OPTIONS), (c) =>
      requireScope(c, "read") ?? c.json({ ok: true }),
    );
    const read = await readOnly.request("/device/state", {
      headers: bearer(DEVICE_TOKEN_A_WRITEONLY),
    });
    expect(read.status).toBe(403);
    expect(await errorCode(read)).toBe("insufficient_scope");
  });
});

// ---------------------------------------------------------------------------
// INV-A5 / ST-A5: strict separation of credential kinds
// ---------------------------------------------------------------------------

describe("INV-A5 — device tokens and user sessions are not interchangeable", () => {
  it("a device token on an admin route -> 401", async () => {
    const res = await makeApp().request("/admin/settings", {
      headers: bearer(DEVICE_TOKEN_A),
    });
    // The session lookup does not know this token, so it is not a usable
    // session credential -> 401. It is emphatically NOT promoted to a session.
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("invalid_credential");
  });

  it("a user session on a device ingress route -> 401", async () => {
    const res = await makeApp().request("/device/ingest", {
      method: "POST",
      headers: bearer(SESSION_ALICE),
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("invalid_credential");
  });

  it("an unknown token on a device route -> 401 (not 404/500)", async () => {
    const res = await makeApp().request("/device/ingest", {
      method: "POST",
      headers: bearer("pt_not_a_real_token_zzzzzzzzzzzzzzzzzzzzzzzzz"),
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("invalid_credential");
  });

  it("an unknown session on an admin route -> 401", async () => {
    const res = await makeApp().request("/admin/settings", {
      headers: bearer("sess_nobody_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"),
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("invalid_credential");
  });

  it("no credential at all -> 401 on both surfaces (fail closed)", async () => {
    const app = makeApp();
    const device = await app.request("/device/ingest", { method: "POST" });
    const admin = await app.request("/admin/settings");
    expect(device.status).toBe(401);
    expect(admin.status).toBe(401);
    expect(await errorCode(device)).toBe("missing_credential");
    expect(await errorCode(admin)).toBe("missing_credential");
  });

  it("a non-Bearer Authorization header is rejected as missing", async () => {
    const res = await makeApp().request("/device/ingest", {
      method: "POST",
      headers: { authorization: `Basic ${DEVICE_TOKEN_A}` },
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("missing_credential");
  });

  it("a resolver that returns the wrong kind is refused (defence in depth)", async () => {
    // A buggy/forged resolver hands a user session to the DEVICE surface. The
    // middleware still fails closed rather than trusting the resolver.
    const sneaky: ResolveProjectOptions = {
      deviceTokens: async () => ALICE,
      sessions: async () => BOB,
    };
    const res = await makeApp(sneaky).request("/device/ingest", {
      method: "POST",
      headers: bearer(SESSION_ALICE),
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("wrong_credential_kind");
  });
});

// ---------------------------------------------------------------------------
// Unit-level contracts
// ---------------------------------------------------------------------------

describe("readBearerToken", () => {
  const probe = async (authorization?: string) => {
    const app = new Hono<{ Variables: AppVars }>();
    let seen: string | null = "<unset>";
    app.get("/probe", (c) => {
      seen = readBearerToken(c);
      return c.text("ok");
    });
    const headers: Record<string, string> = authorization === undefined ? {} : { authorization };
    await app.request("/probe", { headers });
    return seen;
  };

  it("parses a well-formed Bearer header case-insensitively", async () => {
    expect(await probe(`bearer ${DEVICE_TOKEN_A}`)).toBe(DEVICE_TOKEN_A);
  });

  it("returns null for Basic / empty / bare-scheme headers", async () => {
    expect(await probe("Basic abc")).toBeNull();
    expect(await probe("Bearer")).toBeNull();
    expect(await probe("")).toBeNull();
  });
});

describe("parseScopes / hasScope", () => {
  it("splits on spaces and commas", () => {
    expect([...parseScopes("read write")].sort()).toEqual(["read", "write"]);
    expect([...parseScopes("read,write")].sort()).toEqual(["read", "write"]);
    expect([...parseScopes("")].length).toBe(0);
  });

  it("device scopes: absent means read-only; explicit scope is honoured", () => {
    // Explicit full scope: both capabilities.
    expect(hasScope(TOKEN_A, "read")).toBe(true);
    expect(hasScope(TOKEN_A, "write")).toBe(true);
    // Absent scope string -> LEAST PRIVILEGE: read yes, write no.
    expect(hasScope(TOKEN_A_SCOPELESS, "read")).toBe(true);
    expect(hasScope(TOKEN_A_SCOPELESS, "write")).toBe(false);
    // Explicit read-only cannot write; explicit write-only cannot read.
    expect(hasScope(TOKEN_A_READONLY, "read")).toBe(true);
    expect(hasScope(TOKEN_A_READONLY, "write")).toBe(false);
    expect(hasScope(TOKEN_A_WRITEONLY, "write")).toBe(true);
    expect(hasScope(TOKEN_A_WRITEONLY, "read")).toBe(false);
  });

  it("user membership maps roles onto the shared permission table", () => {
    expect(hasScope(ALICE, "read")).toBe(true);
    expect(hasScope(ALICE, "write")).toBe(false);
    expect(hasScope(BOB, "read")).toBe(true);
    expect(hasScope(BOB, "write")).toBe(true);
  });

  it("an unstubbed (unknown) role gets read only — never write", () => {
    const ghost: Principal = { kind: "user", userId: "u", projectId: PROJECT_A };
    expect(hasScope(ghost, "read")).toBe(true);
    expect(hasScope(ghost, "write")).toBe(false);
  });
});

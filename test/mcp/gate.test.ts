import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  CAPABILITIES_BY_SCOPE,
  DEFAULT_ACCESS_TTL,
  InMemoryMcpTokenIssuer,
  InMemoryOAuthGrantStore,
  MANAGE_SCOPE,
  MCP_SCOPES,
  PKCE_METHOD,
  READ_SCOPE,
  TOKEN_PATH,
  createMcpGate,
  createMcpOAuth,
  isMcpScope,
  principalForScopes,
  verifyPkceS256,
  type AuthorizationCode,
  type McpCredential,
  type McpScope,
  type RefreshToken,
} from "../../worker/src/mcp/gate";
import { base64url } from "../../worker/src/platform/lib/tokens";
import {
  hasScope,
  type Principal,
} from "../../worker/src/platform/middleware/resolve-project";

/**
 * Spec tests for the MCP gate (the AI-bridge surface).
 *
 * The contracts that carry the security weight:
 *
 *   1. **Auth first** — no / malformed / unknown / tenant-less bearer → `401`.
 *   2. **Scope is a hard ceiling** — `mcp:read` may read but never write;
 *      `mcp:manage` may do both.
 *   3. **Two keys on the write path** — `mcp:manage` AND `mcp_write_enabled`;
 *      either missing → `403`, with the two conditions distinguishable.
 *   4. **No parallel lattice** — the decision is the SHARED `hasScope`; the MCP
 *      scopes project onto the one capability vocabulary (asserted directly).
 *   5. **Tenant binding** — the credential carries a `projectId`; the principal
 *      the gate mints is bound to it, and a tenant-less credential is refused.
 *   6. **OAuth 2.1** — discovery is an RFC 8414 document; a PKCE-bound
 *      authorization-code exchange returns an RFC 6749 §5.1 token bound to the
 *      grant's tenant, which the `/v1/mcp` gate then *accepts* (a proven-usable
 *      token, not a shape guess).
 */

// ---------------------------------------------------------------------------
// Fixtures & harness
// ---------------------------------------------------------------------------

/** Tokens the fake verifier recognises, mapped to their MCP scopes. */
const READ_TOKEN = "mcp_read_" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MANAGE_TOKEN = "mcp_manage_" + "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** The tenant every recognisable token is bound to (multi-tenant credentials). */
const GRANT_PROJECT = "proj_gate_test";
/** A *different* tenant, to prove the binding is not accidentally satisfied. */
const OTHER_PROJECT = "proj_gate_other";

const SCOPES_BY_TOKEN: Record<string, readonly McpScope[]> = {
  [READ_TOKEN]: ["mcp:read"],
  [MANAGE_TOKEN]: ["mcp:manage"],
};

/**
 * A verifier backed by {@link SCOPES_BY_TOKEN}; unknown tokens resolve to `null`.
 * A recognised token resolves to a {@link McpCredential} bound to
 * {@link GRANT_PROJECT} — the gate refuses a credential with no tenant, so the
 * stub binds one exactly as a real verifier does.
 */
const verifyToken = async (token: string): Promise<McpCredential | null> => {
  const scopes = SCOPES_BY_TOKEN[token];
  return scopes === undefined ? null : { scopes, projectId: GRANT_PROJECT };
};

/**
 * Mount the gate exactly as a deploy would (`/v1/mcp`), so every case drives
 * the real routes through a real Hono app — no bindings, no network.
 */
function gateApp(options: {
  readonly mcpWriteEnabled?: boolean;
  readonly readResult?: unknown;
  readonly writeResult?: unknown;
}): Hono {
  const app = new Hono();
  app.route(
    "/v1/mcp",
    createMcpGate({
      verifyToken,
      mcpWriteEnabled: options.mcpWriteEnabled,
      read: () => options.readResult ?? { handle: "read" },
      write: () => options.writeResult ?? { handle: "write" },
    }),
  );
  return app;
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/** PKCE: `code_challenge = BASE64URL(SHA-256(verifier))`, unpadded. */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

const BASE = "https://insight.test";
const CLIENT = "mcp_client_1";
const REDIRECT = "https://client.test/callback";
const VERIFIER = "verifier-" + "abc123".repeat(8);

/**
 * Build the OAuth surface over an in-memory store + the shared issuer.
 *
 * `issueAt` and `now` are separate so a test can mint a code at one instant and
 * verify the exchange at another (the clock-skew/expiry case).
 */
async function oauthHarness(options?: {
  readonly issueAt?: number;
  readonly now?: () => number;
}): Promise<{
  readonly app: Hono;
  readonly grants: InMemoryOAuthGrantStore;
  readonly issuer: InMemoryMcpTokenIssuer;
  readonly code: AuthorizationCode;
  readonly challenge: string;
}> {
  const now = options?.now ?? (() => 1_000);
  const issuedAt = options?.issueAt ?? now();
  const grants = new InMemoryOAuthGrantStore();
  const issuer = new InMemoryMcpTokenIssuer();
  const challenge = await pkceChallenge(VERIFIER);
  const code: AuthorizationCode = {
    code: "authcode_1",
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scopes: ["mcp:manage"],
    code_challenge: challenge,
    expires_at: issuedAt + 60_000,
    projectId: GRANT_PROJECT,
  };
  grants.putCode(code);
  const app = new Hono();
  app.route(
    "/v1/mcp/oauth",
    createMcpOAuth({
      grants,
      issueAccessToken: issuer.issueAccessToken,
      issuer: BASE,
      now,
    }),
  );
  return { app, grants, issuer, code, challenge };
}

/** POST an `application/x-www-form-urlencoded` token request. */
function tokenRequest(
  app: Hono,
  form: Record<string, string>,
  path = "/v1/mcp/oauth/token",
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. Bearer authentication
// ---------------------------------------------------------------------------

describe("mcp gate — authentication", () => {
  it("no bearer → 401 on both the read and the write path", async () => {
    const app = gateApp({ mcpWriteEnabled: true });

    const read = await app.request("/v1/mcp/read");
    expect(read.status).toBe(401);
    expect(await read.json()).toMatchObject({ error: "unauthorized" });

    const write = await app.request("/v1/mcp/write", { method: "POST" });
    expect(write.status).toBe(401);
    expect(await write.json()).toMatchObject({ error: "unauthorized" });
  });

  it("a bare or scheme-less Authorization header is NOT a credential (401)", async () => {
    const app = gateApp({ mcpWriteEnabled: true });

    const bare = await app.request("/v1/mcp/read", {
      headers: { Authorization: READ_TOKEN },
    });
    expect(bare.status).toBe(401);

    const wrongScheme = await app.request("/v1/mcp/read", {
      headers: { Authorization: `Basic ${READ_TOKEN}` },
    });
    expect(wrongScheme.status).toBe(401);
  });

  it("an unknown token → 401 (the same body as no token — no oracle)", async () => {
    const app = gateApp({ mcpWriteEnabled: true });

    const res = await app.request("/v1/mcp/read", { headers: bearer("mcp_unknown_token") });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("a verifier that throws is a refusal (401), never a 500", async () => {
    const app = new Hono();
    app.route(
      "/v1/mcp",
      createMcpGate({
        verifyToken: async () => {
          throw new Error("store exploded");
        },
      }),
    );

    const res = await app.request("/v1/mcp/read", { headers: bearer("anything") });
    expect(res.status).toBe(401);
  });

  it("a 401 challenges the caller with WWW-Authenticate", async () => {
    const app = gateApp({ mcpWriteEnabled: true });
    const res = await app.request("/v1/mcp/read");
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("a credential with NO tenant is refused (401) — a token that names no project acts for none", async () => {
    // The exact regression this closes: a verifier that authenticates scopes but
    // forgets the tenant. The key must never reach a handler that could then
    // touch any project, so the gate refuses it before authorization.
    const app = new Hono();
    app.route(
      "/v1/mcp",
      createMcpGate({
        verifyToken: async () => ({ scopes: ["mcp:manage"], projectId: "" }),
        mcpWriteEnabled: true,
      }),
    );

    const read = await app.request("/v1/mcp/read", { headers: bearer("tenantless") });
    expect(read.status).toBe(401);
    expect(await read.json()).toMatchObject({ error: "unauthorized" });

    const write = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer("tenantless"),
    });
    expect(write.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 2. Scope is a hard ceiling
// ---------------------------------------------------------------------------

describe("mcp gate — scope is a hard ceiling", () => {
  it("a valid read-scoped token may call read", async () => {
    const app = gateApp({ mcpWriteEnabled: true, readResult: { variables: 3 } });

    const res = await app.request("/v1/mcp/read", { headers: bearer(READ_TOKEN) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { variables: 3 } });
  });

  it("a read-scoped token is refused the write path → 403 insufficient_scope", async () => {
    const app = gateApp({ mcpWriteEnabled: true });

    const res = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(READ_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("a manage-scoped token may read AND write", async () => {
    const app = gateApp({ mcpWriteEnabled: true, writeResult: { applied: true } });

    const read = await app.request("/v1/mcp/read", { headers: bearer(MANAGE_TOKEN) });
    expect(read.status).toBe(200);

    const write = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(MANAGE_TOKEN),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ result: { applied: true } });
  });
});

// ---------------------------------------------------------------------------
// 3. The write path needs BOTH keys (scope AND flag)
// ---------------------------------------------------------------------------

describe("mcp gate — write needs `mcp:manage` AND the flag", () => {
  it("manage scope but flag OFF → 403 write_disabled (and the handler never runs)", async () => {
    let ran = false;
    const app = new Hono();
    app.route(
      "/v1/mcp",
      createMcpGate({
        verifyToken,
        mcpWriteEnabled: false,
        write: () => {
          ran = true;
          return { applied: true };
        },
      }),
    );

    const res = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(MANAGE_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "write_disabled" });
    expect(ran).toBe(false);
  });

  it("flag ON but scope absent → 403 insufficient_scope (distinguishable from write_disabled)", async () => {
    const app = gateApp({ mcpWriteEnabled: true });

    const res = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(READ_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("an OMITTED flag reads as off — the fail-closed default", async () => {
    const app = gateApp({}); // no mcpWriteEnabled

    const res = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(MANAGE_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "write_disabled" });
  });

  it("the flag is checked AFTER the scope — a read token can't probe the flag state", async () => {
    // With the flag off, a read-scoped token still gets `insufficient_scope`,
    // not `write_disabled`: the scope gate runs first, so the flag's state is
    // never revealed to a caller who is not even manage-capable.
    const app = gateApp({ mcpWriteEnabled: false });

    const res = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(READ_TOKEN),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "insufficient_scope" });
  });

  it("read scope does NOT require the write flag (reads work with it off)", async () => {
    const app = gateApp({ mcpWriteEnabled: false, readResult: { ok: 1 } });
    const res = await app.request("/v1/mcp/read", { headers: bearer(READ_TOKEN) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: 1 } });
  });
});

// ---------------------------------------------------------------------------
// 4. No parallel lattice — MCP scopes project onto the shared hasScope
// ---------------------------------------------------------------------------

describe("mcp gate — one authorization model, no parallel lattice", () => {
  it("the scope→capability projection is what the shared gate consumes", () => {
    // The projection IS the shared capability vocabulary.
    expect(CAPABILITIES_BY_SCOPE["mcp:read"]).toBe("read");
    expect(CAPABILITIES_BY_SCOPE["mcp:manage"]).toBe("read write");

    // And `principalForScopes` yields a principal the shared `hasScope` reads
    // exactly as the gate needs: read is read-only; manage is read+write.
    const read = principalForScopes(["mcp:read"]);
    expect(hasScope(read, "read")).toBe(true);
    expect(hasScope(read, "write")).toBe(false);

    const manage = principalForScopes(["mcp:manage"]);
    expect(hasScope(manage, "read")).toBe(true);
    expect(hasScope(manage, "write")).toBe(true);
  });

  it("the MCP scope list is exactly the shared two-valued read/manage split", () => {
    expect([...MCP_SCOPES]).toEqual(["mcp:read", "mcp:manage"]);
    expect(READ_SCOPE).toBe("mcp:read");
    expect(MANAGE_SCOPE).toBe("mcp:manage");
    expect(isMcpScope("mcp:read")).toBe(true);
    expect(isMcpScope("mcp:manage")).toBe(true);
    expect(isMcpScope("mcp:write")).toBe(false); // no write-only scope
    expect(isMcpScope("admin")).toBe(false); // never a bare lattice value
  });

  it("an empty capability set holds no read (least-privilege default, inherited)", () => {
    const empty: Principal = principalForScopes([]);
    expect(hasScope(empty, "read")).toBe(false);
    expect(hasScope(empty, "write")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The credential carries a tenant — the gate binds the principal to it
// ---------------------------------------------------------------------------

describe("mcp gate — the credential is tenant-bound", () => {
  it("principalForScopes binds the tenant onto the principal", () => {
    const bound: Principal = principalForScopes(["mcp:read"], GRANT_PROJECT);
    expect(bound.kind).toBe("device");
    expect(bound.projectId).toBe(GRANT_PROJECT);

    // A scope-projection caller with no tenant is the fail-closed default:
    // empty, which the tool layer refuses — never a wildcard.
    const unbound: Principal = principalForScopes(["mcp:read"]);
    expect(unbound.projectId).toBe("");
  });

  it("the gate hands the handler a principal bound to the credential's tenant", async () => {
    let seen: Principal | undefined;
    const app = new Hono();
    app.route(
      "/v1/mcp",
      createMcpGate({
        verifyToken: async () => ({ scopes: ["mcp:read"], projectId: OTHER_PROJECT }),
        read: (_c, principal) => {
          seen = principal;
          return { ok: true };
        },
      }),
    );

    const res = await app.request("/v1/mcp/read", { headers: bearer(READ_TOKEN) });
    expect(res.status).toBe(200);
    // The handler never sees the raw credential; it sees the tenant the gate
    // resolved — the value it enforces against the call's project argument.
    expect(seen?.projectId).toBe(OTHER_PROJECT);
  });
});

// ---------------------------------------------------------------------------
// 6. OAuth 2.1 — discovery, PKCE, and a proven-usable token
// ---------------------------------------------------------------------------

describe("mcp oauth — discovery (RFC 8414)", () => {
  it("advertises the token endpoint, PKCE S256, and the MCP scopes", async () => {
    const { app } = await oauthHarness();

    const res = await app.request("/v1/mcp/oauth/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.issuer).toBe(BASE);
    expect(body.token_endpoint).toBe(`${BASE}${TOKEN_PATH}`);
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:manage"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.code_challenge_methods_supported).toEqual([PKCE_METHOD]);
  });

  it("does NOT advertise an authorization_endpoint it does not serve", async () => {
    // The documented mismatch: the document used to point at `/authorize`,
    // which is not a route here (the consent step is upstream). A stock client
    // following it would 404, so the field must be absent — and the URL it used
    // to name must genuinely not exist.
    const { app } = await oauthHarness();

    const res = await app.request("/v1/mcp/oauth/.well-known/oauth-authorization-server");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("authorization_endpoint");

    // Belt-and-braces: the advertised-by-nonexistence URL really is a 404.
    const wouldBeAuthorize = await app.request("/v1/mcp/oauth/authorize");
    expect(wouldBeAuthorize.status).toBe(404);
  });

  it("documents refresh_token_expires_in as a non-standard extension", async () => {
    // RFC 8414 has no such field; it is carried so a client can learn the
    // refresh window without trial. Asserted on BOTH the discovery document and
    // the token response, where the docs say it lives.
    const { app } = await oauthHarness();

    const discovery = await app.request("/v1/mcp/oauth/.well-known/oauth-authorization-server");
    const doc = (await discovery.json()) as Record<string, unknown>;
    expect(typeof doc.refresh_token_expires_in).toBe("number");

    const token = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    const body = (await token.json()) as Record<string, unknown>;
    expect(typeof body.refresh_token_expires_in).toBe("number");
  });
});

describe("mcp oauth — authorization_code exchange (RFC 6749 §4.1.3)", () => {
  it("returns an RFC 6749 §5.1 token that the /v1/mcp gate then ACCEPTS", async () => {
    const { app, issuer } = await oauthHarness();

    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // RFC 6749 §5.1 shape.
    expect(typeof body.access_token).toBe("string");
    expect(body.token_type).toBe("bearer");
    expect(typeof body.expires_in).toBe("number");
    expect(body.expires_in).toBe(DEFAULT_ACCESS_TTL);
    expect(body.scope).toBe("mcp:manage");
    expect(typeof body.refresh_token).toBe("string");

    // THE POINT: the minted token authenticates at the gate and carries the
    // grant's scope — i.e. it is usable, not merely well-shaped.
    const gate = new Hono();
    gate.route("/v1/mcp", createMcpGate({ verifyToken: issuer.verifyToken, mcpWriteEnabled: true }));
    const write = await gate.request("/v1/mcp/write", {
      method: "POST",
      headers: bearer(body.access_token as string),
    });
    expect(write.status).toBe(200);
  });

  it("refuses a code exchange requesting a scope OUTSIDE the grant (RFC 6749 §4.1.3)", async () => {
    // The grant carries `mcp:manage`. Requesting `mcp:read` — a real scope the
    // grant does NOT carry — is refused rather than silently accepted/narrowed.
    const { app } = await oauthHarness();
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      scope: "mcp:read",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("refuses a code exchange requesting an UNKNOWN scope", async () => {
    const { app } = await oauthHarness();
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      scope: "mcp:admin-superuser",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("accepts a code exchange whose scope is a SUBSET of the grant", async () => {
    const { app } = await oauthHarness();
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      scope: "mcp:manage", // exactly the granted scope
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ scope: "mcp:manage" });
  });

  it("refuses an exchange with no code_verifier (OAuth 2.1 mandates PKCE)", async () => {
    const { app, grants } = await oauthHarness();

    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    // The code was NOT consumed by a malformed request.
    expect(grants.liveCodes()).toContain("authcode_1");
  });

  it("refuses a wrong code_verifier → invalid_grant", async () => {
    const { app } = await oauthHarness();

    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: "the-wrong-verifier",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("is single-use: replaying a consumed code is invalid_grant", async () => {
    const { app } = await oauthHarness();
    const form = {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    };

    expect((await tokenRequest(app, form)).status).toBe(200);
    const replay = await tokenRequest(app, form);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("binds the redirect_uri: a different one is invalid_grant", async () => {
    const { app } = await oauthHarness();

    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: "https://attacker.test/callback",
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an expired code → invalid_grant", async () => {
    // Minted at t=0 (expires t=60s), exchanged at t=1e15 — long expired.
    const { app } = await oauthHarness({ issueAt: 0, now: () => 10 ** 15 });
    const res = await tokenRequest(app, {
      grant_type: "authorization_code",
      code: "authcode_1",
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an unknown grant_type → unsupported_grant_type", async () => {
    const { app } = await oauthHarness();
    const res = await tokenRequest(app, { grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

describe("mcp oauth — refresh grant (RFC 6749 §6, no escalation)", () => {
  it("issues a fresh token and rotates the refresh token", async () => {
    const { app, grants } = await oauthHarness();
    grants.putRefresh({
      token: "refresh_1",
      client_id: CLIENT,
      scopes: ["mcp:read", "mcp:manage"],
      expires_at: 10 ** 12,
      projectId: GRANT_PROJECT,
    });

    const res = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: "refresh_1",
      client_id: CLIENT,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.scope).toBe("mcp:read mcp:manage");
    expect(typeof body.refresh_token).toBe("string");
    // The presented refresh token was rotated out.
    expect(await grants.findRefresh("refresh_1")).toBeNull();
  });

  it("a requested scope may NARROW the grant but never widen it", async () => {
    const { app, grants } = await oauthHarness();
    grants.putRefresh({
      token: "refresh_2",
      client_id: CLIENT,
      scopes: ["mcp:read", "mcp:manage"],
      expires_at: 10 ** 12,
      projectId: GRANT_PROJECT,
    });

    const narrowed = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: "refresh_2",
      client_id: CLIENT,
      scope: "mcp:read",
    });
    expect(narrowed.status).toBe(200);
    expect(((await narrowed.json()) as Record<string, unknown>).scope).toBe("mcp:read");

    // Widening beyond the grant is refused, and no token is issued.
    const widened = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: "refresh_2",
      client_id: CLIENT,
      scope: "mcp:manage",
    });
    expect(widened.status).toBe(400);
    expect(await widened.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("an unknown refresh token is invalid_grant", async () => {
    const { app } = await oauthHarness();
    const res = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: "nope",
      client_id: CLIENT,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });
});

// ---------------------------------------------------------------------------
// 7. PKCE primitive
// ---------------------------------------------------------------------------

describe("mcp oauth — PKCE S256", () => {
  it("accepts the matching verifier and rejects any other", async () => {
    const challenge = await pkceChallenge(VERIFIER);
    expect(await verifyPkceS256(VERIFIER, challenge)).toBe(true);
    expect(await verifyPkceS256("wrong", challenge)).toBe(false);
    expect(await verifyPkceS256(VERIFIER, "not-a-challenge")).toBe(false);
    expect(await verifyPkceS256("", challenge)).toBe(false);
  });

  it("tolerates padding on the stored challenge but not a wrong digest", async () => {
    const challenge = await pkceChallenge(VERIFIER);
    expect(await verifyPkceS256(VERIFIER, `${challenge}=`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Composition guards
// ---------------------------------------------------------------------------

describe("mcp gate — composition is fail-loud", () => {
  it("createMcpGate throws without a verifier", () => {
    expect(() => createMcpGate({} as never)).toThrow(/verifyToken/);
  });

  it("createMcpOAuth throws without a grant store / issuer", () => {
    expect(() =>
      createMcpOAuth({ grants: {} as never, issueAccessToken: (() => {}) as never, issuer: BASE }),
    ).toThrow(/grants\.consume/);
    expect(() => createMcpOAuth({} as never)).toThrow(/issuer/);
  });

  it("exposes the built-in echo action when no handler is supplied", async () => {
    const app = new Hono();
    app.route("/v1/mcp", createMcpGate({ verifyToken, mcpWriteEnabled: true }));

    const res = await app.request("/v1/mcp/read", { headers: bearer(READ_TOKEN) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: unknown };
    expect(body.result).toBeTruthy();
  });
});

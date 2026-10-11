/**
 * mcp/gate — the MCP (AI bridge) HTTP surface, expressed as a **pure factory
 * over injected seams**.
 *
 * Two mounts, one policy:
 *
 * ```
 *   /v1/mcp          bearer-authenticated MCP bridge
 *     → GET  /read    require `mcp:read`              → 200 { result }
 *     → POST /write   require `mcp:manage` AND the
 *                     `mcp_write_enabled` flag        → 200 { result }
 *                     (scope present but flag off)     → 403 write_disabled
 *                     (flag on but scope absent)       → 403 insufficient_scope
 *     → ?              no/!well-formed bearer          → 401 unauthorized
 *
 *   /v1/mcp/oauth    OAuth 2.1 authorization-server surface
 *     → GET  /.well-known/oauth-authorization-server  discovery metadata
 *     → POST /token   authorization_code (+ refresh_token) → access token
 * ```
 *
 * ## The gate reuses the shared scopes/permission semantics — no second lattice
 *
 * There is deliberately **no** MCP-local scope vocabulary, role table or
 * permission check here. The MCP scopes are a thin, total, two-valued
 * projection onto the capabilities the shared `hasScope` gate already
 * understands:
 *
 *   | MCP scope    | capability string | grants                                     |
 *   |--------------|-------------------|--------------------------------------------|
 *   | `mcp:read`   | `"read"`          | read-class actions                         |
 *   | `mcp:manage` | `"read write"`    | read **and** write-class actions           |
 *
 * Authenticating a token yields a shared {@link Principal}, and every decision
 * is then made by {@link hasScope} / {@link requireScope} — the *same* code
 * path the project middleware, the telemetry routes and user tokens use. A
 * parallel authorization model here would drift out of sync with them; a
 * projection that goes through the one gate cannot. In particular the
 * least-privilege default is inherited for free: a token with no explicit
 * capability list holds `read` only, so it can never reach the write path.
 *
 * ## The write path needs TWO independent keys
 *
 * Holding `mcp:manage` is necessary but not sufficient: the write path is
 * additionally behind an injected `mcp_write_enabled` **flag**, and both must
 * be true. The flag is the operator's kill switch — an MCP deployment can
 * grant manage-scoped credentials and still refuse every mutation by leaving
 * the flag off, without revoking tokens. The two refusals are kept
 * distinguishable on the wire because they are different conditions to fix:
 * an insufficient scope is `403 insufficient_scope`, a disabled write is
 * `403 write_disabled`. The order is fixed and security-relevant: the scope is
 * checked **first**, so a caller missing the capability can never learn the
 * flag's state — the flag's position is not an existence oracle.
 *
 * ## A scope is not a tenant — the credential carries a project
 *
 * A scope says *what* a credential may do; it says nothing about *which tenant*
 * it may do it in. So the credential a token resolves to is not a bare scope
 * list but an {@link McpCredential}: the scopes **and** the `projectId` the
 * token is bound to. The gate refuses a credential with no tenant (`401`,
 * fail-closed), and the tenant is projected onto the {@link Principal} so the
 * tool layer can refuse any call whose project argument is not that tenant —
 * for reads as well as writes. That is what keeps a manage-scoped bridge key
 * from being an all-tenant superuser.
 *
 * ## OAuth 2.1 (RFC 8414 + RFC 6749 §4.1/§6, PKCE mandated)
 *
 * `/v1/mcp/oauth` is a *token endpoint* (+ discovery document). It is not a
 * full authorization server: it consumes an authorization code the caller
 * already holds — one that an upstream consent screen issued — and exchanges it
 * for an MCP access token. The response shape is the RFC 6749 §5.1 set
 * (`access_token`, `token_type`, `expires_in`, `scope`, optional `refresh_token`
 * and `refresh_token_expires_in`), so a stock OAuth client parses it unchanged.
 *
 * The rules that carry the security weight are all fail-closed:
 *
 *   * **PKCE is mandatory** (OAuth 2.1): an authorization-code exchange without
 *     a verifier is refused. The code is presented with the S256 challenge
 *     `BASE64URL(SHA-256(verifier))`; a public client therefore never proves
 *     possession by a bare redirect.
 *   * **A code is single-use**: it is consumed on exchange, so a replayed code
 *     (the classic redirect interception) is a `400 invalid_grant`.
 *   * **Redirect-URI binding**: the `redirect_uri` presented at exchange must
 *     match the one the code was issued to, byte for byte.
 *   * **A refresh must not escalate**: refresh returns the *grant's* scope, and
 *     a requested subset is honoured by narrowing — never widening — it.
 *
 * Nothing here owns a store, a clock or a binding: the authorization-code
 * store, the token issuer and the flag are all injected, so the whole surface
 * can be pinned without a Worker runtime.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  hasScope,
  readBearerToken,
  type DevicePrincipal,
  type Principal,
} from "../platform/middleware/resolve-project";
import { base64url } from "../platform/lib/tokens";
import { defaultClock } from "../platform/lib/clock";

// ---------------------------------------------------------------------------
// Scope vocabulary — projected onto the shared capability list
// ---------------------------------------------------------------------------

/**
 * The two MCP scopes. Deliberately two-valued: `mcp:read` is the least
 * privilege that still lets a client act; `mcp:manage` is the full bridge key.
 * There is no `mcp:write`-only scope for the same reason user tokens have none
 * — a credential that may mutate state inherently also needs to read it, so
 * every capability is *derived*, never free-text.
 */
export const MCP_SCOPES = ["mcp:read", "mcp:manage"] as const;

/** An MCP scope. */
export type McpScope = (typeof MCP_SCOPES)[number];

/** Type guard: is `value` one of the known MCP scopes? */
export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === "string" && (MCP_SCOPES as readonly string[]).includes(value);
}

/**
 * The capability string a scope projects onto — the bridge to the shared
 * {@link hasScope} semantics (and the same shape user tokens use).
 *
 * `write` is granted **only** by `mcp:manage`; `mcp:read` grants `read` and
 * nothing else, so a read-scoped credential can never reach the write path.
 */
export const CAPABILITIES_BY_SCOPE: Record<McpScope, string> = {
  "mcp:read": "read",
  "mcp:manage": "read write",
};

/** The capability every MCP read-class action requires. */
export const READ_SCOPE: McpScope = "mcp:read";

/** The capability the write-class action additionally requires. */
export const MANAGE_SCOPE: McpScope = "mcp:manage";

/**
 * Project a set of MCP scopes **and a tenant** onto the shared
 * {@link DevicePrincipal} vocabulary — the *one* place a credential becomes a
 * principal.
 *
 * A `device`-kind principal whose `scopes` is the capability projection and
 * whose `projectId` is the credential's tenant is exactly the shape
 * {@link hasScope} understands, so the read/write decision is the same code
 * path the middleware and the telemetry routes use — `write` is present only
 * when a scope granted it explicitly ({@link CAPABILITIES_BY_SCOPE}), and the
 * tenant rides on the principal so every downstream handler can enforce it.
 *
 * `projectId` defaults to `""` only so a *scope-projection* caller (one with no
 * tenant to bind) keeps compiling; the gate never passes an empty tenant
 * through — it refuses one first (see {@link gate}).
 */
export function principalForScopes(scopes: readonly McpScope[], projectId = ""): DevicePrincipal {
  const granted = new Set<string>();
  for (const scope of scopes) {
    for (const capability of CAPABILITIES_BY_SCOPE[scope].split(/\s+/)) {
      if (capability.length > 0) granted.add(capability);
    }
  }
  return {
    kind: "device",
    projectId,
    scopes: Array.from(granted).join(" "),
  };
}

// ---------------------------------------------------------------------------
// Wire shapes — frozen so tests and clients reference names, never literals
// ---------------------------------------------------------------------------

/** Stable, machine-readable failure reasons on the `/v1/mcp` surface. */
export type McpErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "write_disabled"
  | "invalid_request";

/** The `{ error, message }` body every `/v1/mcp` rejection carries. */
export interface McpErrorBody {
  readonly error: McpErrorCode;
  readonly message: string;
}

/** Body of a successful `GET /read` or `POST /write`. */
export interface McpResultBody {
  readonly result: unknown;
}

/** The `WWW-Authenticate` challenge served with every `401`. */
export const WWW_AUTHENTICATE = 'Bearer realm="mcp"';

/** HTTP statuses this surface emits, named for readability. */
export const MCP_STATUS = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
} as const;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * What a presented bearer token resolves to: the MCP scopes it holds **and**
 * the tenant it is bound to.
 *
 * The tenant is not optional decoration — it is the whole point. A scope says
 * *what* a credential may do; `projectId` says *which tenant* it may do it in.
 * Without it a manage-scoped bridge key would be an all-tenant superuser, which
 * is precisely the cross-tenant hole this shape closes: the gate now refuses a
 * credential with no tenant (`401`), and a handler refuses any call whose
 * project argument is not that tenant.
 */
export interface McpCredential {
  /** The MCP scopes this credential holds. Empty means "holds nothing". */
  readonly scopes: readonly McpScope[];
  /**
   * The tenant this credential is bound to. `""` / absent means "unbound" and
   * is refused at the gate — a credential with no project is authorized for no
   * project, so a half-configured verifier fails closed rather than open.
   */
  readonly projectId: string;
}

/**
 * Resolve a presented bearer token to its {@link McpCredential}, or `null`.
 *
 * Production verifies the plaintext against its token store (a `user_tokens`
 * lookup yielding `read`/`admin` **and the token's bound `projectId`**,
 * projected onto MCP scopes); tests pass a stub. Returning `null` — or
 * throwing — means "not usable", and the route answers `401`; the two are
 * deliberately indistinguishable so a caller cannot probe *why* a token failed.
 * A credential that authenticates but carries no `projectId` is `401` too: a
 * token that names no tenant can act for none.
 */
export type VerifyMcpToken = (
  token: string,
) => Promise<McpCredential | null>;

/** Everything the `/v1/mcp` gate needs, injectable end-to-end. */
export interface McpGateDeps {
  /** The credential seam. Required — a gate with no verifier is invented, not secure. */
  readonly verifyToken: VerifyMcpToken;
  /**
   * The operator kill switch for the write path. `true` enables writes for
   * `mcp:manage` holders; `false` (or an omitted flag, which reads as `false`)
   * refuses every write. Defaulting to off is the fail-closed direction: a
   * deploy that forgets the flag cannot silently enable mutations.
   */
  readonly mcpWriteEnabled?: boolean;
  /** The read-path handler. Omitted → the built-in echo handler is used. */
  readonly read?: McpCallHandler;
  /** The write-path handler. Omitted → the built-in echo handler is used. */
  readonly write?: McpCallHandler;
}

/**
 * A gated MCP action. Receives the authenticated principal (never a raw token)
 * so a handler cannot accidentally re-authorize from credential material.
 */
export type McpCallHandler = (
  c: Context,
  principal: Principal,
) => unknown | Promise<unknown>;

// ---------------------------------------------------------------------------
// Gate — authenticate, then authorize through the SHARED hasScope
// ---------------------------------------------------------------------------

/** The fixed, internal status of a gate decision (never exposed as a body). */
type GateErrorCode = "unauthorized" | "insufficient_scope" | "write_disabled";

interface GateDenial {
  readonly status: 401 | 403;
  readonly code: GateErrorCode;
  readonly message: string;
  readonly scope: McpScope;
}

interface GateSuccess {
  readonly principal: Principal;
}

/**
 * The operator-facing message per denial reason.
 *
 * A static, literal-keyed `Record` (per the project's lookup-table rule) rather
 * than a `Map`: the three reasons are fixed, and each message is a frozen
 * contract a log reader can rely on. The scope is interpolated because the two
 * scope-bearing reasons name which capability was required.
 */
const DENIAL_MESSAGE: Record<GateErrorCode, (scope: McpScope) => string> = {
  unauthorized: () => "a valid MCP bearer token is required",
  insufficient_scope: (scope) =>
    `this credential lacks the "${scope}" capability required here`,
  write_disabled: () => "MCP writes are disabled (mcp_write_enabled is off)",
};

/**
 * The shared-gate capability each MCP route demands.
 *
 * This is the projection that keeps MCP on the ONE authorization model: the
 * `read`/`write` classes are exactly what {@link hasScope} understands, so a
 * write path can only ever be reached by a principal the shared gate already
 * calls `write`-capable (i.e. one granted `mcp:manage`).
 */
const CAPABILITY_BY_SCOPE: Record<McpScope, "read" | "write"> = {
  "mcp:read": "read",
  "mcp:manage": "write",
};

/**
 * The single authorization decision behind every MCP route.
 *
 * Order is deliberate and fail-closed:
 *
 *   1. **parse** with the SHARED strict `readBearerToken` — a bare or
 *      scheme-less Authorization is not a credential, so it is `401` and is
 *      never handed to a verifier;
 *   2. **resolve** through the injected seam (a throw is a refusal, not a 500),
 *      and require a **non-empty** scope set — a token that authenticates as
 *      holding nothing is authorized for nothing, which under the
 *      least-privilege default is exactly "refused";
 *   3. **authorize** with the SHARED `hasScope`, over the scope projection —
 *      `read` for a read, `write` for a write. Missing capability →
 *      `403 insufficient_scope`, checked BEFORE the flag so the flag's state is
 *      not an oracle for an unauthorized caller;
 *   4. **flag** — the write path additionally requires `mcpWriteEnabled`;
 *      a manage-holder is refused `403 write_disabled` while it is off.
 *
 * @param required the MCP scope this route demands (`mcp:read` or `mcp:manage`).
 */
async function gate(
  deps: McpGateDeps,
  header: string | undefined,
  required: McpScope,
): Promise<GateSuccess | GateDenial> {
  const refuse = (status: 401 | 403, code: GateErrorCode): GateDenial => ({
    status,
    code,
    message: DENIAL_MESSAGE[code](required),
    scope: required,
  });

  // 1. Parse via the SHARED Bearer grammar. A bare or scheme-less Authorization
  //    is not a credential at all, so it never reaches the verifier.
  const token =
    header === undefined
      ? null
      : readBearerToken({
          req: { header: () => header },
        } as unknown as Context);
  if (token === null) {
    return refuse(MCP_STATUS.unauthorized, "unauthorized");
  }

  // 2. Resolve. A throwing verifier is a refusal, never a 500. A token that
  //    authenticates as holding NOTHING is authorized for nothing either — the
  //    least-privilege default says an empty capability set holds no `read`.
  //    The same is true of a token that names NO tenant: a scope acts *within*
  //    a project, so a credential with an empty `projectId` is refused here
  //    (fail-closed) rather than reaching a handler able to touch any tenant.
  let credential: McpCredential | null;
  try {
    credential = await deps.verifyToken(token);
  } catch {
    credential = null;
  }
  if (
    credential === null ||
    credential.scopes.length === 0 ||
    typeof credential.projectId !== "string" ||
    credential.projectId.trim() === ""
  ) {
    return refuse(MCP_STATUS.unauthorized, "unauthorized");
  }

  // 3. Authorize through the SHARED gate. There is no MCP-local capability
  //    check: the principal IS the scope projection and `hasScope` is the one
  //    decision, so a `mcp:read` token is refused `mcp:manage` for free. The
  //    tenant rides on the principal, so a handler can enforce it.
  const principal = principalForScopes(credential.scopes, credential.projectId);
  if (!hasScope(principal, CAPABILITY_BY_SCOPE[required])) {
    return refuse(MCP_STATUS.forbidden, "insufficient_scope");
  }

  // 4. The write flag — a second, independent key on the manage path. Checked
  //    AFTER the scope, so an unauthorized caller never learns the flag's state.
  if (required === MANAGE_SCOPE && deps.mcpWriteEnabled !== true) {
    return refuse(MCP_STATUS.forbidden, "write_disabled");
  }

  return { principal };
}

/**
 * Build the `/v1/mcp` gate app: a read route and a write route, both behind the
 * one {@link gate} decision, so the write path can never outrun the flag.
 *
 * Mount with `app.route("/v1/mcp", createMcpGate({ verifyToken, mcpWriteEnabled }))`.
 */
export function createMcpGate(deps: McpGateDeps): Hono {
  if (typeof deps?.verifyToken !== "function") {
    throw new TypeError("createMcpGate: missing required dependency: verifyToken");
  }
  // The default action is an echo: the gate's job is authorization, and a
  // deploy that supplies no handler still gets a well-formed, gate-protected
  // surface rather than a 404 that hides whether the gate ran.
  const echo: McpCallHandler = (_c, principal) => ({ ok: true, as: principal.projectId });
  const read = deps.read ?? echo;
  const write = deps.write ?? echo;
  const app = new Hono();

  const handle = (
    c: Context,
    required: McpScope,
    handler: McpCallHandler,
  ): Promise<Response> =>
    gate(deps, c.req.header("Authorization"), required).then(async (decision) => {
      if ("principal" in decision) {
        const body: McpResultBody = { result: await handler(c, decision.principal) };
        return c.json(body, MCP_STATUS.ok);
      }
      const body: McpErrorBody = { error: decision.code, message: decision.message };
      c.header("WWW-Authenticate", WWW_AUTHENTICATE);
      return c.json(body, decision.status);
    });

  app.get("/read", (c) => handle(c, READ_SCOPE, read));
  app.post("/write", (c) => handle(c, MANAGE_SCOPE, write));
  return app;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 — shapes
// ---------------------------------------------------------------------------

/** RFC 6749 §5.1 token response, plus one documented non-standard extension. */
export interface OAuthTokenBody {
  readonly access_token: string;
  readonly token_type: "bearer";
  readonly expires_in: number;
  /** The granted scope — a space-delimited subset of {@link MCP_SCOPES}. */
  readonly scope: string;
  readonly refresh_token?: string;
  /**
   * NON-STANDARD extension: the refresh-token lifetime in seconds. RFC 6749
   * §5.1 defines only `expires_in` (the *access*-token lifetime) and leaves the
   * refresh window undefined; this field names it explicitly so a client does
   * not have to guess. Present only alongside `refresh_token`.
   */
  readonly refresh_token_expires_in?: number;
}

/** RFC 6749 §5.2 error response. */
export interface OAuthErrorBody {
  readonly error: OAuthErrorCode;
  readonly error_description?: string;
}

/** The OAuth error codes this token endpoint can emit. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_client"
  | "unsupported_grant_type"
  | "invalid_scope";

/**
 * RFC 8414 authorization-server metadata document.
 *
 * There is deliberately **no `authorization_endpoint`**. This surface is a
 * *token endpoint* (+ discovery) only: it consumes an authorization code the
 * caller already holds from an upstream consent screen; it does not run an
 * authorization endpoint itself. Advertising one would hand a stock client a
 * URL that does not exist (a `404` after redirect) — the mismatch this document
 * no longer claims. `refresh_token_expires_in` is likewise not part of RFC 8414
 * (nor of RFC 6749 §5.1); it is a **non-standard extension** carried here and
 * on the token response so a client can learn the refresh window without trial.
 */
export interface OAuthDiscoveryBody {
  readonly issuer: string;
  readonly token_endpoint: string;
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  /**
   * NON-STANDARD extension (not in RFC 8414): the refresh-token lifetime in
   * seconds, advertising the window a client may rotate within.
   */
  readonly refresh_token_expires_in?: number;
}

/**
 * An authorization code a caller presents for exchange — the state minted by the
 * (upstream) consent step and consumed here. `scopes` is the granted set;
 * `code_challenge` is the PKCE S256 challenge bound at issue time; `projectId`
 * is the tenant the grant is bound to (the token minted from it inherits it).
 */
export interface AuthorizationCode {
  readonly code: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly scopes: readonly McpScope[];
  readonly code_challenge: string;
  readonly expires_at: number;
  /**
   * The tenant this grant authorizes. Carried onto the access token so the
   * bridge acts within exactly one project — a code is never tenant-free.
   */
  readonly projectId: string;
}

/** A stored refresh token — the long-lived grant a client rotates. */
export interface RefreshToken {
  readonly token: string;
  readonly client_id: string;
  readonly scopes: readonly McpScope[];
  readonly expires_at: number;
  /** The tenant this grant authorizes; a refresh never changes it. */
  readonly projectId: string;
}

/**
 * Persistence seam for authorization codes and refresh tokens.
 *
 * `consume` MUST atomically read-and-delete: single-use is the property that
 * defeats authorization-code replay, and it cannot be achieved by a read
 * followed by a separate delete. `findRefresh` is read-only (rotation is the
 * issuer's concern), and `markUsed` satisfies the RFC 6749 §10.5 "detect
 * refresh-token replay" obligation by invalidating a rotated grant.
 */
export interface OAuthGrantStore {
  /** Atomically fetch and delete the code's grant, or `null` if absent. */
  consume(code: string): Promise<AuthorizationCode | null>;
  /** Look up a live refresh token, or `null` for unknown/expired/rotated. */
  findRefresh(token: string): Promise<RefreshToken | null>;
  /** Invalidate a refresh token (rotation / replay response). */
  markUsed(token: string): Promise<void>;
}

/**
 * Mint an access token for a `(clientId, scopes, projectId)` grant.
 *
 * The issuer decides the token's *authenticity* (it is what
 * {@link VerifyMcpToken} will accept at `/v1/mcp`), so the two seams together
 * are the whole trust chain: the exchange hands back nothing the gate would not
 * accept. `projectId` is the grant's tenant — the authorization code is bound
 * to one project, and the issuer must record that binding so the token carries
 * the tenant the gate enforces.
 */
export type IssueMcpAccessToken = (input: {
  readonly clientId: string;
  readonly scopes: readonly McpScope[];
  /** The tenant the grant is bound to; the token carries it to the gate. */
  readonly projectId: string;
}) => Promise<{ readonly token: string; readonly expiresIn: number }>;

/** Everything the OAuth token endpoint needs, injectable end-to-end. */
export interface McpOAuthDeps {
  /** Where authorization codes and refresh tokens live. */
  readonly grants: OAuthGrantStore;
  /** Mints an access token the `/v1/mcp` gate will accept. */
  readonly issueAccessToken: IssueMcpAccessToken;
  /** The advertised issuer (e.g. `https://insight.example`). */
  readonly issuer: string;
  /** Clock seam; the ONLY source of "now". Defaults to the wall clock. */
  readonly now?: () => number;
  /** Access-token lifetime in seconds. Defaults to {@link DEFAULT_ACCESS_TTL}. */
  readonly accessTokenTtlSeconds?: number;
  /** Refresh-token lifetime in seconds. Defaults to {@link DEFAULT_REFRESH_TTL}. */
  readonly refreshTokenTtlSeconds?: number;
  /** Refresh-token generator seam; defaults to a CSPRNG opaque token. */
  readonly refreshTokenFactory?: () => string;
}

// ---------------------------------------------------------------------------
// OAuth 2.1 — constants
// ---------------------------------------------------------------------------

/** Access-token lifetime: one hour (RFC 6749 recommends short-lived access tokens). */
export const DEFAULT_ACCESS_TTL = 3600;

/** Refresh-token lifetime: 30 days. */
export const DEFAULT_REFRESH_TTL = 30 * 24 * 3600;

/** PKCE method this server supports. `plain` is deliberately NOT supported. */
export const PKCE_METHOD = "S256" as const;

/**
 * RFC 8414 discovery document path, relative to the `/v1/mcp/oauth` mount (so
 * the served URL is `<issuer>/v1/mcp/oauth/.well-known/oauth-authorization-server`).
 * RFC 8414 fixes this well-known suffix; the mount prefix is this module's.
 */
export const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

/** Path of the token endpoint, relative to the issuer. */
export const TOKEN_PATH = "/v1/mcp/oauth/token";

/** Client authentication methods the token endpoint accepts. */
export const TOKEN_ENDPOINT_AUTH_METHODS = ["none"] as const;

/** Grant types the token endpoint supports. */
export const GRANT_TYPES_SUPPORTED = ["authorization_code", "refresh_token"] as const;

// ---------------------------------------------------------------------------
// OAuth 2.1 — helpers
// ---------------------------------------------------------------------------

/** Generate an opaque refresh token from the CSPRNG (never `Math.random`). */
function defaultRefreshTokenFactory(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `mrt_${base64url(bytes)}`;
}

/**
 * Verify a PKCE S256 challenge: `BASE64URL(SHA-256(verifier)) === challenge`.
 *
 * Both sides are compared as base64url strings of equal length, and the loop
 * never breaks early on the first differing character, so a caller learns only
 * "match or not". An unsupported or absent method is refused by the caller
 * (OAuth 2.1 mandates S256), so this function only ever sees a challenge it
 * must prove.
 */
export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  if (verifier.length === 0 || challenge.length === 0) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const computed = base64url(new Uint8Array(digest));
  const [a, b] = [computed, challenge.replace(/=+$/, "")];
  if (a.length !== b.length) return false;
  // Constant-time-ish comparison: no early return on the first differing byte.
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parse a space-/comma-delimited `scope` parameter into known MCP scopes. */
function parseRequestedScopes(raw: string | null | undefined): {
  readonly scopes: readonly McpScope[];
  readonly unknown: readonly string[];
} {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { scopes: [], unknown: [] };
  }
  const tokens = raw.split(/[\s,]+/).filter((token) => token.length > 0);
  const scopes: McpScope[] = [];
  const unknown: string[] = [];
  for (const token of tokens) {
    if (isMcpScope(token)) {
      if (!scopes.includes(token)) scopes.push(token);
    } else {
      unknown.push(token);
    }
  }
  return { scopes, unknown };
}

// ---------------------------------------------------------------------------
// OAuth 2.1 — route construction
// ---------------------------------------------------------------------------

/**
 * Build the `/v1/mcp/oauth` surface: the RFC 8414 discovery document and the
 * RFC 6749 token endpoint (authorization_code + refresh_token).
 */
export function createMcpOAuth(deps: McpOAuthDeps): Hono {
  assertOAuthDeps(deps);
  const now = deps.now ?? defaultClock;
  const accessTtl = deps.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL;
  const refreshTtl = deps.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL;
  const newRefreshToken = deps.refreshTokenFactory ?? defaultRefreshTokenFactory;
  const app = new Hono();

  const fail = (c: Context, status: 400 | 401, code: OAuthErrorCode, description: string): Response => {
    const body: OAuthErrorBody = { error: code, error_description: description };
    return c.json(body, status);
  };

  /**
   * Mint an RFC 6749 §5.1 response for `scopes`, optionally with a refresh
   * token. `refresh_token_expires_in` mirrors the grant's remaining lifetime as
   * the spec's non-mandatory companion to `expires_in`.
   *
   * `projectId` is the grant's tenant; it is handed to the issuer so the minted
   * token is bound to it — the token cannot outgrow the grant it came from.
   */
  const mint = async (
    c: Context,
    clientId: string,
    scopes: readonly McpScope[],
    projectId: string,
    withRefresh: boolean,
  ): Promise<Response> => {
    const issued = await deps.issueAccessToken({ clientId, scopes, projectId });
    const body: OAuthTokenBody = {
      access_token: issued.token,
      token_type: "bearer",
      expires_in: issued.expiresIn,
      scope: MCP_SCOPES.filter((s) => scopes.includes(s)).join(" "),
      ...(withRefresh
        ? { refresh_token: newRefreshToken(), refresh_token_expires_in: refreshTtl }
        : {}),
    };
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    return c.json(body, MCP_STATUS.ok);
  };

  // --- Discovery (RFC 8414) -------------------------------------------------
  // The document advertises ONLY what this module serves: the token endpoint.
  // There is no `authorization_endpoint` here because there is no `/authorize`
  // route — the consent step is upstream, so a client must not be sent to a URL
  // this server does not answer. `refresh_token_expires_in` is a non-standard
  // extension (documented on {@link OAuthDiscoveryBody}) that mirrors the token
  // response's own field.
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const body: OAuthDiscoveryBody = {
      issuer: deps.issuer,
      token_endpoint: `${deps.issuer}${TOKEN_PATH}`,
      token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS],
      scopes_supported: [...MCP_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: [...GRANT_TYPES_SUPPORTED],
      code_challenge_methods_supported: [PKCE_METHOD],
      refresh_token_expires_in: refreshTtl,
    };
    return c.json(body, MCP_STATUS.ok);
  });

  // --- Token endpoint (RFC 6749 §3.2) --------------------------------------
  app.post("/token", async (c) => {
    // `application/x-www-form-urlencoded` is the only media type the token
    // endpoint accepts (RFC 6749 §3.2); everything is a form parameter.
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await c.req.text());
    } catch {
      return fail(c, 400, "invalid_request", "the request body must be form-encoded");
    }

    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      return exchangeCode(c, form);
    }
    if (grantType === "refresh_token") {
      return exchangeRefresh(c, form);
    }
    return fail(c, 400, "unsupported_grant_type", `unsupported grant_type: ${grantType ?? "(missing)"}`);
  });

  /** RFC 6749 §4.1.3 authorization-code exchange, PKCE mandatory (OAuth 2.1). */
  async function exchangeCode(c: Context, form: URLSearchParams): Promise<Response> {
    const code = form.get("code");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");

    if (!clientId) {
      return fail(c, 400, "invalid_client", "client_id is required");
    }
    if (!code) {
      return fail(c, 400, "invalid_request", "code is required");
    }
    if (!redirectUri) {
      return fail(c, 400, "invalid_request", "redirect_uri is required");
    }
    // OAuth 2.1 mandates PKCE; a public client that skips it is refused outright
    // rather than downgraded to a bare-code exchange.
    if (!verifier) {
      return fail(c, 400, "invalid_request", "code_verifier is required (PKCE)");
    }

    // Single-use: consuming the code removes it, so a replay is `invalid_grant`.
    const grant = await deps.grants.consume(code);
    if (grant === null) {
      return fail(c, 400, "invalid_grant", "the authorization code is unknown or already used");
    }
    if (grant.expires_at <= now()) {
      return fail(c, 400, "invalid_grant", "the authorization code has expired");
    }
    if (grant.client_id !== clientId) {
      return fail(c, 400, "invalid_grant", "the authorization code was issued to another client");
    }
    // Redirect-URI binding: the exchange must present the URI the code was
    // issued to, so an intercepted code cannot be redirected elsewhere.
    if (grant.redirect_uri !== redirectUri) {
      return fail(c, 400, "invalid_grant", "redirect_uri does not match the one the code was issued to");
    }
    if (!(await verifyPkceS256(verifier, grant.code_challenge))) {
      return fail(c, 400, "invalid_grant", "the code_verifier does not match the code_challenge");
    }

    // RFC 6749 §4.1.3: a `scope` on the code exchange must be a SUBSET of the
    // grant's — the code's scopes are the ceiling. An unknown scope, or one the
    // grant does not carry, is refused (`invalid_scope`) rather than silently
    // narrowed or widened. Symmetric with the refresh grant.
    const requested = parseRequestedScopes(form.get("scope"));
    if (requested.unknown.length > 0) {
      return fail(c, 400, "invalid_scope", `unknown scope: ${requested.unknown.join(" ")}`);
    }
    for (const scope of requested.scopes) {
      if (!grant.scopes.includes(scope)) {
        return fail(c, 400, "invalid_scope", `scope exceeds the grant: ${scope}`);
      }
    }

    return mint(c, grant.client_id, grant.scopes, grant.projectId, true);
  }

  /** RFC 6749 §6 refresh grant: no escalation — the scope may only narrow. */
  async function exchangeRefresh(c: Context, form: URLSearchParams): Promise<Response> {
    const refreshToken = form.get("refresh_token");
    const clientId = form.get("client_id");
    if (!refreshToken) {
      return fail(c, 400, "invalid_request", "refresh_token is required");
    }
    if (!clientId) {
      return fail(c, 400, "invalid_client", "client_id is required");
    }

    const grant = await deps.grants.findRefresh(refreshToken);
    if (grant === null) {
      return fail(c, 400, "invalid_grant", "the refresh token is unknown, expired or already used");
    }
    if (grant.expires_at <= now()) {
      return fail(c, 400, "invalid_grant", "the refresh token has expired");
    }
    if (grant.client_id !== clientId) {
      return fail(c, 400, "invalid_grant", "the refresh token was issued to another client");
    }

    // A requested scope must be a SUBSET of the grant's; anything else is a
    // refusal, never a silent widening.
    const requested = parseRequestedScopes(form.get("scope"));
    if (requested.unknown.length > 0) {
      return fail(c, 400, "invalid_scope", `unknown scope: ${requested.unknown.join(" ")}`);
    }
    const granted =
      requested.scopes.length === 0
        ? grant.scopes
        : grant.scopes.filter((scope) => requested.scopes.includes(scope));
    if (requested.scopes.length > 0 && granted.length !== requested.scopes.length) {
      return fail(c, 400, "invalid_scope", "the requested scope exceeds the grant");
    }

    // Rotation: the presented refresh token is invalidated and a fresh one
    // issued in the same response (OAuth 2.1 refresh-token rotation). The
    // grant's tenant rides onto the new token unchanged — a refresh rotates the
    // credential, never the tenant it acts in.
    await deps.grants.markUsed(refreshToken);
    return mint(c, grant.client_id, granted, grant.projectId, true);
  }

  return app;
}

/** The OAuth surface requires a grant store, an issuer and a token minter. */
function assertOAuthDeps(deps: McpOAuthDeps): void {
  const missing: string[] = [];
  if (typeof deps?.grants?.consume !== "function") missing.push("grants.consume");
  if (typeof deps?.grants?.findRefresh !== "function") missing.push("grants.findRefresh");
  if (typeof deps?.grants?.markUsed !== "function") missing.push("grants.markUsed");
  if (typeof deps?.issueAccessToken !== "function") missing.push("issueAccessToken");
  if (typeof deps?.issuer !== "string" || deps.issuer.length === 0) missing.push("issuer");
  if (missing.length > 0) {
    throw new TypeError(`createMcpOAuth: missing required dependency: ${missing.join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams, for tests and dev
// ---------------------------------------------------------------------------

/**
 * An in-memory {@link OAuthGrantStore}.
 *
 * `consume` performs the atomic read-and-delete the real store must: JS is
 * single-threaded between the synchronous Map operations, so exactly one caller
 * can win a code — which is the single-use property, not an approximation of it.
 */
export class InMemoryOAuthGrantStore implements OAuthGrantStore {
  readonly #codes = new Map<string, AuthorizationCode>();
  readonly #refreshes = new Map<string, RefreshToken>();

  /** Register an authorization code (as the consent step would). */
  putCode(code: AuthorizationCode): this {
    this.#codes.set(code.code, code);
    return this;
  }

  /** Register a refresh token. */
  putRefresh(token: RefreshToken): this {
    this.#refreshes.set(token.token, token);
    return this;
  }

  consume(code: string): Promise<AuthorizationCode | null> {
    const found = this.#codes.get(code) ?? null;
    this.#codes.delete(code);
    return Promise.resolve(found);
  }

  findRefresh(token: string): Promise<RefreshToken | null> {
    return Promise.resolve(this.#refreshes.get(token) ?? null);
  }

  markUsed(token: string): Promise<void> {
    this.#refreshes.delete(token);
    return Promise.resolve();
  }

  /** Snapshot of the live code strings (so a test can prove single-use). */
  liveCodes(): readonly string[] {
    return Array.from(this.#codes.keys());
  }
}

/**
 * An in-memory access-token issuer + matching verifier.
 *
 * Emitting the verifier from the same object is what makes the OAuth test
 * honest: the token the exchange returns is fed back through
 * {@link createMcpGate} and accepted, so "usable token" is demonstrated rather
 * than asserted in the abstract.
 *
 * Every issued token is **bound to a tenant**: the scope list *and* the
 * `projectId` that requested it are recorded together, so verification yields a
 * {@link McpCredential} that names the one project the token may act in — the
 * binding the gate and the tool handlers both enforce.
 */
export class InMemoryMcpTokenIssuer {
  readonly #byToken = new Map<string, McpCredential>();
  #counter = 0;

  /**
   * Issue an access token carrying `scopes` bound to `projectId`. Never returns
   * the same token twice. A missing tenant is stored as `""`, which the gate
   * refuses — so a caller that forgets to bind cannot mint a usable token.
   */
  issue(input: {
    readonly clientId: string;
    readonly scopes: readonly McpScope[];
    readonly projectId?: string;
  }): Promise<{ readonly token: string; readonly expiresIn: number }> {
    this.#counter += 1;
    const token = `mcp_at_${this.#counter}_${input.clientId}`;
    this.#byToken.set(token, { scopes: input.scopes, projectId: input.projectId ?? "" });
    return Promise.resolve({ token, expiresIn: DEFAULT_ACCESS_TTL });
  }

  /** The {@link IssueMcpAccessToken} seam bound to this issuer. */
  readonly issueAccessToken: IssueMcpAccessToken = (input) => this.issue(input);

  /** The {@link VerifyMcpToken} seam the `/v1/mcp` gate authenticates against. */
  readonly verifyToken: VerifyMcpToken = (token) => {
    const credential = this.#byToken.get(token);
    return Promise.resolve(credential === undefined ? null : credential);
  };
}

export default createMcpGate;

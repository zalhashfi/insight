/**
 * resolve-project — fail-closed project/tenant resolution middleware.
 *
 * ── The invariant (INV-A1 / INV-A5, ST-A1 / ST-A5) ─────────────────────────
 * The tenant a request acts on is derived **exclusively from the credential**
 * presented in the `Authorization` header. It is never read from, and never
 * taken on the word of, the URL. A `:proj` path segment (or any equivalent
 * path claim) is treated as a *claim* only: when present it must MATCH the
 * project the credential actually resolves to, otherwise the request is
 * rejected. This is what makes the middleware **fail closed** — an ambiguous
 * or contradictory request is denied, never guessed.
 *
 * ── Credential kinds are strictly separated ────────────────────────────────
 * There are exactly two families of credential and they are not
 * interchangeable:
 *
 *   * a **project token** (`pt_…`) authenticates a machine to exactly ONE
 *     project — valid only on `device` ingress routes;
 *   * a **user session** authenticates a human — valid only on `admin` routes.
 *
 * A device ingress route presented a user session is `401`, and an admin route
 * presented a project token is `401`. A credential of the right kind that
 * resolves to the *wrong project* is `403` (authenticated, unauthorized) —
 * distinct from an absent/unknown credential, which is also `401`. The two
 * families therefore cannot be used to reach each other's surface, and a
 * cross-tenant attempt cannot even be expressed.
 *
 * ── The seam ───────────────────────────────────────────────────────────────
 * This module never touches a database or a runtime binding. Both lookups are
 * expressed by the tiny {@link CredentialLookup} interface and injected through
 * {@link ResolveProjectOptions}; production supplies D1-backed adapters (over
 * `project_tokens` / `sessions`) while tests drive in-memory fakes. Because the
 * lookup is a seam, the middleware itself is pure policy and can be pinned
 * without a running worker.
 *
 * ── What it puts on the context ────────────────────────────────────────────
 * Once resolved, the principal is exposed as `c.get("project")` (and shadowed
 * as `c.get("principal")`), so every downstream handler reads the *resolved*
 * tenant instead of re-deriving one from the request.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { can, isRole, type Permission, type Role } from "../../domains/projects/membership";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Credential-kind classification for a route surface.
 *
 * `"device"` accepts project tokens only; `"admin"` accepts user sessions only.
 * There is intentionally no `"any"`: a surface that accepted both kinds would
 * erase the separation this middleware exists to enforce.
 */
export type RouteKind = "device" | "admin";

/** Stable, machine-readable reasons a request was denied. */
export type ResolveErrorCode =
  | "missing_credential"
  | "invalid_credential"
  | "wrong_credential_kind"
  | "project_mismatch"
  | "insufficient_scope";

/**
 * Status for every denial reason.
 *
 * A static, literal-keyed table (so it is a `Record`, not a `Map`): each
 * `401` code means "we do not know who you are (or you brought the wrong kind
 * of credential)", each `403` means "we do, and this project is not yours".
 */
const STATUS_BY_CODE: Record<ResolveErrorCode, 401 | 403> = {
  missing_credential: 401,
  invalid_credential: 401,
  wrong_credential_kind: 401,
  project_mismatch: 403,
  insufficient_scope: 403,
};

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/** The two credential families. */
export type PrincipalKind = "device" | "user";

/** A machine credential scoped to exactly one project. */
export interface DevicePrincipal {
  readonly kind: "device";
  readonly projectId: string;
  /** Token id, when the credential resolves to a stored record. */
  readonly tokenId?: string;
  /**
   * Space/comma separated capability list (`"read write"`). Absent means
   * "read only": a credential minted without an explicit scope list holds the
   * least privilege that still lets it act — `read` — and never `write`.
   * `write` (and anything else) must be granted explicitly.
   */
  readonly scopes?: string;
}

/** A human credential; authorization is per project via membership. */
export interface UserPrincipal {
  readonly kind: "user";
  readonly userId: string;
  /** Which project this human is currently acting in (the active tenant). */
  readonly projectId: string;
  /** The user's role in {@link projectId}; `undefined` means "unstubbed". */
  readonly role?: Role;
  /** Optional membership-derived permission set; `undefined` means "unstubbed". */
  readonly permissions?: readonly Permission[];
  /** Present when the session carried a display name (for logging only). */
  readonly sessionId?: string;
}

/** Whatever this middleware hands downstream. */
export type Principal = DevicePrincipal | UserPrincipal;

// ---------------------------------------------------------------------------
// Lookup seam
// ---------------------------------------------------------------------------

/**
 * Result of looking a credential up.
 *
 * `null` means "no usable credential" — unknown, revoked or expired — and is
 * deliberately indistinguishable from any other lookup failure so a caller
 * cannot turn the response into an oracle. The *kind* is part of the result,
 * not a hint: it is what proves which family the credential really belongs to.
 */
export type CredentialLookupResult = Principal | null;

/** Resolve a presented project token to its principal, or `null`. */
export type DeviceTokenResolver = (token: string) => Promise<CredentialLookupResult>;

/** Resolve a presented session to its principal, or `null`. */
export type SessionResolver = (session: string) => Promise<CredentialLookupResult>;

/** The full lookup seam injected into the middleware. */
export interface CredentialLookup {
  /** `device`-route credential check. MUST be a project-token lookup. */
  readonly deviceTokens: DeviceTokenResolver;
  /** `admin`-route credential check. MUST be a session lookup. */
  readonly sessions: SessionResolver;
}

/** Options accepted by {@link resolveProject}. */
export interface ResolveProjectOptions {
  /** The seam. Both resolvers are required — a missing one fails closed. */
  readonly deviceTokens: DeviceTokenResolver;
  readonly sessions: SessionResolver;
  /**
   * Hono context key under which the resolved {@link Principal} is stored.
   * Defaults to `"project"` (the dominant concern); the payload records the
   * real kind. `"principal"` is always set too.
   */
  readonly key?: string;
}

/**
 * Hono context keys this middleware writes.
 *
 * `project` carries the principal under its dominant concern; `principal` is
 * the alias for callers that prefer the neutral name.
 */
export interface ResolveProjectVariables {
  project: Principal;
  principal: Principal;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the bearer credential from `Authorization: Bearer <token>`.
 *
 * Returns `null` when the header is absent or is not a well-formed Bearer
 * scheme, so the caller fails closed with `401` rather than falling through to
 * an unauthenticated request.
 */
export function readBearerToken(c: Context): string | null {
  const header = c.req.header("Authorization");
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Parse a `scopes` column value into a set of tokens.
 *
 * The schema stores scopes as free text; this accepts the conventional
 * space/comma separated form (`"read write"` or `"read,write"`). An
 * `undefined` scope string (no scopes column) is treated by {@link hasScope}
 * as READ-ONLY — the least-privilege default — never as unrestricted.
 */
export function parseScopes(scopes: string | undefined | null): ReadonlySet<string> {
  if (!scopes) return new Set();
  return new Set(scopes.split(/[\s,]+/).filter((s) => s.length > 0));
}

/**
 * Does this principal hold `required`?
 *
 * Scope/authorization semantics, all fail-closed:
 *   * a **device** is authorized by its `scopes`: a space/comma separated
 *     capability list where `read` and `write` are independent (a token scoped
 *     `"read"` may read but not write, and vice versa). An absent scope string
 *     means "read only" — the least-privilege default — so a scope-less token
 *     can never write; `write` must always be granted explicitly;
 *   * a **user** is authorized by membership — `permissions` when supplied,
 *     otherwise a real `role` checked through the membership permission table;
 *     an unstubbed user with neither is granted only a `read`-class action.
 */
export function hasScope(
  principal: Principal,
  required: Permission | "read" | "write",
): boolean {
  if (principal.kind === "device") {
    const requiredClass = required === "read" ? "read" : "write";
    // Least-privilege default: an ABSENT scope string no longer means
    // "unrestricted". A token minted without an explicit scope now holds
    // `read` ONLY, so a scope-less credential can never write. Write (and every
    // other capability) must be granted explicitly in the `scopes` value.
    if (principal.scopes === undefined) return requiredClass === "read";
    return parseScopes(principal.scopes).has(requiredClass);
  }

  // User: prefer an explicit permission set when the caller supplied one.
  if (principal.permissions !== undefined) {
    const permission: Permission = required === "read" ? "project:read" : "project:update";
    return principal.permissions.includes(permission);
  }

  // Fall back to membership role. An unknown/unstubbed role gets read only.
  if (principal.role === undefined) return required === "read";
  if (!isRole(principal.role)) return required === "read";
  return can(principal.role, required === "read" ? "project:read" : "project:update");
}

/** Build the JSON error body shared by every rejection. */
function deny(
  c: Context,
  code: ResolveErrorCode,
  message: string,
): Response {
  return c.json({ error: code, message }, STATUS_BY_CODE[code]);
}

/**
 * Downstream capability gate — the companion to {@link resolveProject}.
 *
 * `resolveProject` authenticates, separates the credential kinds and pins the
 * tenant; a handler that additionally needs a capability calls this to enforce
 * it. `read`-class actions are covered by the role/permissions the credential
 * carries; `write`-class actions require an explicit write capability, so a
 * `read`-scoped — or scope-less — device token, or a `member`-role session, is
 * refused `403`.
 */
export function requireScope(c: Context, required: "read" | "write"): Response | null {
  const principal = c.get("principal") as Principal | undefined;
  if (principal === undefined || !hasScope(principal, required)) {
    return deny(
      c,
      "insufficient_scope",
      `this credential lacks the "${required}" capability required here`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build the project-resolution middleware for one route surface.
 *
 * @param kind      `"device"` (project tokens only) or `"admin"` (sessions only).
 * @param options   The credential lookup seam, plus an optional context key.
 *
 * The returned middleware denies by default on anything it cannot fully verify:
 * no credential, an unparseable one, one of the wrong family for this surface,
 * or a credential whose project contradicts a `:proj` path claim.
 */
export function resolveProject(
  kind: RouteKind,
  options: ResolveProjectOptions,
): MiddlewareHandler {
  const key = options.key ?? "project";

  return async function resolveProjectMiddleware(c: Context, next: Next) {
    const presented = readBearerToken(c);
    if (presented === null) {
      return deny(
        c,
        "missing_credential",
        "a Bearer credential is required",
      );
    }

    // Route the credential to the lookup that matches THIS surface; anything
    // the other resolver would have owned is left unresolved and denied below.
    const resolved =
      kind === "device"
        ? await options.deviceTokens(presented)
        : await options.sessions(presented);

    if (resolved === null) {
      return deny(
        c,
        "invalid_credential",
        "the presented credential is unknown, revoked or expired",
      );
    }

    // Strict separation: even a resolver that returned the other kind is a
    // wrong-kind credential for this surface -> 401, never a silent pass.
    const expected: PrincipalKind = kind === "device" ? "device" : "user";
    if (resolved.kind !== expected) {
      return deny(
        c,
        "wrong_credential_kind",
        kind === "device"
          ? "device routes require a project token, not a user session"
          : "admin routes require a user session, not a project token",
      );
    }

    // The path may CLAIM a project; the credential decides. A claim that
    // contradicts the credential is denied outright (fail closed).
    const claimed = c.req.param("proj");
    if (claimed !== undefined && claimed !== resolved.projectId) {
      return deny(
        c,
        "project_mismatch",
        "the credential does not grant access to the project named in the path",
      );
    }

    // Authenticated, right kind, right tenant. Capability enforcement (the
    // `read`/`write` gate for a specific action) is deliberately NOT applied
    // here: it belongs to the handler that performs the action, via
    // requireScope. This middleware only guarantees *who* and *which tenant*.
    c.set("principal", resolved);
    c.set(key, resolved);
    await next();
  };
}

/**
 * Device ingress middleware: a project token resolves the tenant, and that
 * project is the one and only tenant the downstream handler may touch.
 */
export function resolveDeviceProject(options: ResolveProjectOptions): MiddlewareHandler {
  return resolveProject("device", options);
}

/**
 * Admin middleware: a user session resolves the acting user and tenant. The
 * caller's membership role gates further actions through {@link hasScope}.
 */
export function resolveAdminProject(options: ResolveProjectOptions): MiddlewareHandler {
  return resolveProject("admin", options);
}

export default resolveProject;

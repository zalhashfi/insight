/**
 * Security response headers middleware.
 *
 * A single Hono middleware that stamps the baseline hardening headers onto
 * *every* response the app produces — including error paths such as 404s and
 * any response generated downstream (or by a later `onError` handler), because
 * the headers are applied after `await next()` in the `finally`-equivalent
 * position.
 *
 * Mount it once, as high as possible in the middleware stack:
 *
 * ```ts
 * import { Hono } from "hono";
 * import { securityHeaders } from "./platform/middleware/security-headers";
 *
 * const app = new Hono();
 * app.use("*", securityHeaders());
 * ```
 *
 * Design notes:
 *   - Values are fixed constants here (no per-request config) so the defaults
 *     are auditable in one place. `securityHeaders()` accepts an optional
 *     partial override map for callers that need to relax a single directive
 *     (e.g. a report-only CSP) without reimplementing the whole set.
 *   - `Hono` normalizes header names case-insensitively on lookup, and the
 *     `Header` setter overwrites, so re-running this middleware is idempotent
 *     (no duplicated headers, no growing CSP).
 */

import type { MiddlewareHandler } from "hono";

/** Default Content-Security-Policy: deny everything except same-origin. */
export const DEFAULT_CONTENT_SECURITY_POLICY =
  "default-src 'self'; frame-ancestors 'none'; base-uri 'self'";

/** Default Strict-Transport-Security: one year, subdomains included. */
export const DEFAULT_STRICT_TRANSPORT_SECURITY =
  "max-age=31536000; includeSubDomains";

/**
 * The baseline header set, in the exact order it is written to the response.
 * Exported so tests (and future consumers) can assert against a single source
 * of truth instead of hard-coding strings twice.
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": DEFAULT_CONTENT_SECURITY_POLICY,
  "Strict-Transport-Security": DEFAULT_STRICT_TRANSPORT_SECURITY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
} as const;

/** Names of every header this middleware manages. */
export type SecurityHeaderName = keyof typeof SECURITY_HEADERS;

/** Optional per-header overrides; `undefined` keeps the default. */
export type SecurityHeaderOverrides = Partial<
  Record<SecurityHeaderName, string>
>;

/**
 * Resolve the effective header set from the defaults plus any overrides.
 * Callers who want to *remove* a default should pass an empty string, which
 * is still emitted (an empty `X-Frame-Options` is a valid "ignore" signal for
 * a few proxies) — we never silently drop a header, so the invariant
 * "every response carries all five" always holds.
 */
function resolveHeaders(
  overrides?: SecurityHeaderOverrides,
): Record<SecurityHeaderName, string> {
  const resolved = { ...SECURITY_HEADERS } as Record<
    SecurityHeaderName,
    string
  >;
  if (overrides) {
    for (const name of Object.keys(SECURITY_HEADERS) as SecurityHeaderName[]) {
      const value = overrides[name];
      if (typeof value === "string") resolved[name] = value;
    }
  }
  return resolved;
}

/**
 * Hono middleware that sets the baseline security headers on every response.
 *
 * Headers are written *after* the downstream handler runs, so they are present
 * regardless of how the response was produced — a 200 from a route handler, a
 * 404 for an unmatched path, or an error response from `onError`/`notFound`.
 */
export function securityHeaders(
  overrides?: SecurityHeaderOverrides,
): MiddlewareHandler {
  const headers = resolveHeaders(overrides);

  return async function securityHeadersMiddleware(c, next) {
    await next();

    for (const [name, value] of Object.entries(headers)) {
      // `set` (not `append`) keeps this idempotent when re-mounted.
      c.res.headers.set(name, value);
    }
  };
}

export default securityHeaders;

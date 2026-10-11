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

// ---------------------------------------------------------------------------
// Framing override — the one sanctioned relaxation of the baseline
// ---------------------------------------------------------------------------

/**
 * CSP `frame-ancestors` value for an allowed-origin list.
 *
 * An empty list collapses to `'self'` — the minimally-permissive *useful*
 * default: the embed may be framed by its own origin, and by nothing else. It
 * is never a wildcard and never a bare `frame-ancestors ` (which a browser
 * treats as "ignore", i.e. fail-open). A deploy widens it by supplying the
 * origins it actually trusts to iframe the board.
 */
export function frameAncestorsValue(origins: readonly string[]): string {
  const cleaned = origins.map((o) => o.trim()).filter((o) => o.length > 0);
  return cleaned.length > 0 ? cleaned.join(" ") : "'self'";
}

/**
 * Build the CSP value that replaces {@link DEFAULT_CONTENT_SECURITY_POLICY} on
 * a frameable subtree: the same baseline directives, with `frame-ancestors`
 * widened to `origins`. The other directives are preserved verbatim, so a
 * relaxation of framing never quietly loosens `default-src`/`base-uri`.
 */
export function contentSecurityPolicyForFrames(origins: readonly string[]): string {
  return DEFAULT_CONTENT_SECURITY_POLICY.replace(
    /frame-ancestors[^;]*/,
    `frame-ancestors ${frameAncestorsValue(origins)}`,
  );
}

/** Options for {@link frameableHeaders}. */
export interface FrameableOptions {
  /**
   * Origins allowed to frame the subtree, matched against CSP
   * `frame-ancestors`. The value is the deploy-configurable seam: pass the
   * dashboard host(s) that will iframe the embed (e.g.
   * `["https://app.example.com"]`). An empty list (the default) yields the
   * baseline `'none'` — same-origin framing only if the browser's default
   * applies, never a wildcard.
   */
  readonly ancestors?: readonly string[];
}

/**
 * Hono middleware that makes a subtree *frameable* by the configured origins.
 *
 * `securityHeaders()` denies framing everywhere (`X-Frame-Options: DENY` +
 * CSP `frame-ancestors 'none'`), which blocks the read-only `/embed/:token`
 * surface the product intends to be iframed. This middleware is the surgical
 * exception: it rewrites ONLY the two framing headers, leaving every other
 * hardening header untouched.
 *
 * ## Why it must be mounted OUTSIDE `securityHeaders()`
 *
 * Both middlewares write after `await next()`, so the OUTER one unwinds last
 * and its `set` wins. To override the baseline, this middleware must be
 * registered on the subtree pattern BEFORE `app.use("*", securityHeaders())`,
 * i.e. it is the outer middleware for that path:
 *
 * ```ts
 * app.use("/embed/*", frameableHeaders({ ancestors }));   // outer (per-path)
 * app.use("*", securityHeaders());                        // inner (global)
 * ```
 *
 * Every other path matches only `securityHeaders`, so the DENY default is
 * intact there. Removing this mount restores `X-Frame-Options: DENY` on
 * `/embed` — which is exactly the mutation a test pins.
 */
export function frameableHeaders(options: FrameableOptions = {}): MiddlewareHandler {
  const ancestors = (options.ancestors ?? [])
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  const csp = contentSecurityPolicyForFrames(ancestors);
  // `X-Frame-Options` has no origin-list form (only DENY/SAMEORIGIN), so it can
  // express a self-only policy but NOT a configured allow-list.
  //
  //   * No configured ancestors → the policy IS self-only, so the legacy header
  //     states it exactly: `SAMEORIGIN`.
  //   * Configured ancestors → the header is OMITTED (deleted) rather than sent
  //     empty. CSP `frame-ancestors` is the control. A legacy browser without
  //     `frame-ancestors` support therefore applies NO XFO restriction and may
  //     frame /embed from any origin — an accepted, documented tradeoff for a
  //     read-only public embed whose access is gated by the share token, and
  //     strictly better than emitting `SAMEORIGIN`, which would *contradict* and
  //     break the configured origins on every modern browser.
  const xfo = ancestors.length > 0 ? null : "SAMEORIGIN";

  return async function frameableHeadersMiddleware(c, next) {
    await next();

    c.res.headers.set("Content-Security-Policy", csp);
    if (xfo === null) {
      c.res.headers.delete("X-Frame-Options");
    } else {
      c.res.headers.set("X-Frame-Options", xfo);
    }
  };
}

export default securityHeaders;

/**
 * dashboards/embed — the `/embed/:token` read-only embed surface.
 *
 * A shared dashboard can be dropped into somebody else's page: an iframe on a
 * blog, a wall display, a status page. That is the *same* credential and the
 * *same* rule as the public JSON read (`dashboards/public.ts`, D4.3/INV-D2) — a
 * share token that resolves to a layout, filtered to the layout's allow-list on
 * the server — presented as an HTML document instead of a JSON payload. This
 * module is therefore a thin **adapter**: it owns no filtering of its own and
 * re-implements none.
 *
 * ## The one invariant is inherited, not restated
 *
 * `embed` never touches the projection or the layout directly. It asks
 * {@link PublicDashboardService.resolve} for a view and reads that view's
 * already-filtered `snapshot()`; the allow-list is applied by the very filter
 * the authenticated and JSON public surfaces use. So the deciding rule is the
 * same one, in one place: a variable not named by the layout cannot appear in
 * the rendered payload, because it never leaves the service. The HTML this
 * module renders is a *view* of a filtered payload, never a second path to the
 * data — a bug here can mis-render what it is given, but it cannot widen what
 * it is given.
 *
 * ## Read-only, again by construction
 *
 * The embed is a `GET` that renders; it exposes no mutation. The scope it
 * carries is the view's own `read_only` scope, and the module offers no write
 * route, so "an embed that writes" is not expressible here any more than it is
 * in the service.
 *
 * ## Refusals leak nothing
 *
 * An unknown, expired, revoked or blank token is the *same* uniform refusal the
 * public surface gives (`not_found`, 404) — the embed endpoint is not an oracle
 * for a guessed token. A share the deploy has decided not to embed is refused
 * `forbidden` (403): a real, non-leaking answer that says "this share exists but
 * may not be framed", distinct from "no such share". No refusal ever echoes the
 * token, the digest or a project id.
 *
 * ## SEO landing (minimum)
 *
 * A framed dashboard is not the link a crawler should surface — the token is the
 * credential and a shared URL is exactly the artefact that should not be
 * indexed. So the document carries the *minimum* a landing needs (a `<title>`
 * and meta description, both derived from the layout the share names, never
 * from project data) and it is explicitly `noindex`: `robots` meta plus an
 * `X-Robots-Tag` header. The page is a landing, not a secret — nothing in the
 * head is data the allow-list hides.
 *
 * ## Not here
 *
 * This module does not resolve seams itself: it consumes a
 * {@link PublicDashboardService} (constructed with the same `m3.publicDashboard`
 * options the JSON route uses) so there is exactly one place a share is
 * resolved. It also does not define the JSON contract — that is `public.ts`.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  PublicDashboardService,
  isPublicDashboardError,
  type DashboardLayout,
  type Point,
  type PublicDashboard,
  type PublicDashboardOptions,
} from "./public";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The mount path of the embed surface. Frozen here so a route, a test and a
 * caller that builds a link all agree on one literal instead of three.
 */
export const EMBED_PATH = "/embed";

/** The `robots` directive every embed page carries: never indexed. */
export const EMBED_ROBOTS = "noindex, nofollow";

/** The default document title when a layout names no title of its own. */
export const DEFAULT_EMBED_TITLE = "Shared dashboard";

/** The default meta description when one cannot be derived from the layout. */
export const DEFAULT_EMBED_DESCRIPTION =
  "A read-only, shared Insight dashboard.";

/**
 * Longest title/description emitted into the head, in characters.
 *
 * The layout title is caller-owned and can be arbitrarily long (or hostile); a
 * head that echoes it unbounded would let a share push a megabyte into a
 * crawler's snippet. Truncation is applied to the *derived* string here, so the
 * bound is a property of this module rather than of any one layout.
 */
export const MAX_EMBED_TITLE_LENGTH = 120;
export const MAX_EMBED_DESCRIPTION_LENGTH = 300;

// ---------------------------------------------------------------------------
// The layout an embed reads its landing copy from
// ---------------------------------------------------------------------------

/**
 * The embed's view of a layout: the {@link DashboardLayout} the filter uses,
 * plus two optional, purely-presentational fields.
 *
 * The allow-list is still `variables` — the authority for *what data is public*
 * does not move because a title exists. `title`/`description` only shape the
 * document head. They are optional, and the head falls back to constants when
 * they are absent, so a layout that names neither still renders (fail-open for
 * copy, fail-closed for data).
 */
export interface EmbedLayout extends DashboardLayout {
  /** Human title for the document head. Absent ⇒ {@link DEFAULT_EMBED_TITLE}. */
  readonly title?: string;
  /** Meta description. Absent ⇒ derived from the title / a constant. */
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// SEO landing — pure, escaped
// ---------------------------------------------------------------------------

/**
 * Escape text for interpolation into HTML text or a double-quoted attribute.
 *
 * The layout title is attacker-influenced (a share owner writes it), and the
 * embed is a document served to a stranger's browser; so every derived string
 * is escaped on the way into the template. `&`, `<`, `>`, `"` and `'` are the
 * five that can break out of text or an attribute in this template.
 */
export function escapeHtml(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#39;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** Collapse whitespace and truncate to `max`, appending an ellipsis when cut. */
function clamp(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The landing title for a layout: its `title` when usable, else the default.
 *
 * "Usable" means a non-empty string after trimming; a blank or non-string title
 * is the same as no title (fail-open to the constant, never to an empty
 * `<title>`).
 */
export function embedTitle(layout: EmbedLayout | null): string {
  const raw = layout?.title;
  if (typeof raw !== "string" || raw.trim().length === 0) return DEFAULT_EMBED_TITLE;
  return clamp(raw, MAX_EMBED_TITLE_LENGTH);
}

/**
 * The meta description for a layout: its `description` when usable, else the
 * title, else the constant. Never empty, so the tag is always meaningful.
 */
export function embedDescription(layout: EmbedLayout | null): string {
  const raw = layout?.description;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return clamp(raw, MAX_EMBED_DESCRIPTION_LENGTH);
  }
  const title = layout?.title;
  if (typeof title === "string" && title.trim().length > 0) {
    return clamp(title, MAX_EMBED_DESCRIPTION_LENGTH);
  }
  return DEFAULT_EMBED_DESCRIPTION;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What {@link renderEmbedPage} needs: a filtered view plus its landing copy. */
export interface EmbedPageInput {
  /** The layout the view was resolved over (for title/description only). */
  readonly layout: EmbedLayout | null;
  /** The allow-list, exactly as the view exposes it. */
  readonly variables: readonly string[];
  /** The **already-filtered** snapshot. Never a raw projection. */
  readonly points: readonly Point[];
}

/** The fixed, data-free parts of the document, kept out of the interpolation. */
const EMBED_STYLE = [
  ":root{color-scheme:light dark}",
  "body{margin:0;font:14px/1.5 system-ui,sans-serif}",
  "header,main{padding:1rem 1.25rem}",
  "h1{margin:0 0 .25rem;font-size:1.1rem}",
  "p{margin:0;opacity:.75}",
  "table{border-collapse:collapse;width:100%}",
  "th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #8884}",
].join("");

/**
 * Render the read-only embed document.
 *
 * The body lists the filtered `points` and the allow-listed `variables` the
 * share exposes — nothing else. Every interpolated string is escaped. The head
 * carries the minimum landing metadata and an explicit `noindex`.
 *
 * `variables` and `points` come from the resolved view, so this function cannot
 * be handed data outside the allow-list *by the route*; it is nevertheless
 * written to render whatever it is given verbatim, so it adds no hidden filter
 * that a reader might mistake for the security boundary. The boundary is the
 * service; this is a view of its output.
 */
export function renderEmbedPage(input: EmbedPageInput): string {
  const title = escapeHtml(embedTitle(input.layout));
  const description = escapeHtml(embedDescription(input.layout));

  const rows = input.points
    .map((point) => {
      const device = escapeHtml(point.device);
      const variable = escapeHtml(point.variable);
      const value = point.value === null ? "" : escapeHtml(String(point.value));
      const ts = escapeHtml(String(point.ts));
      return `<tr><td>${device}</td><td>${variable}</td><td>${value}</td><td>${ts}</td></tr>`;
    })
    .join("");

  const variables = escapeHtml(input.variables.join(", "));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="robots" content="${EMBED_ROBOTS}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<style>${EMBED_STYLE}</style>
</head>
<body>
<header>
<h1>${title}</h1>
<p>${description}</p>
</header>
<main>
<p data-variables="${variables}"></p>
<table>
<thead><tr><th>Device</th><th>Variable</th><th>Value</th><th>Timestamp</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * A refusal the embed surface can render, independent of the JSON shape.
 *
 * Reusing {@link PublicDashboardError}'s codes keeps "no such share" one
 * concept across both surfaces; the embed adds only `forbidden`, the "this
 * share may not be framed" case, which has no JSON-public analogue.
 */
export type EmbedErrorCode = "not_found" | "invalid_input" | "forbidden";

/** HTTP status for each {@link EmbedErrorCode}. */
export const EMBED_STATUS_CODE: Record<EmbedErrorCode, number> = {
  // A blank token and an unknown token are indistinguishable to a stranger.
  not_found: 404,
  invalid_input: 404,
  // A real share the deploy refuses to embed: 403, not a leak.
  forbidden: 403,
};

/** The documented body of every embed refusal: the domain-wide pair. */
export interface EmbedErrorBody {
  readonly error: EmbedErrorCode;
  readonly message: string;
}

/** Error thrown by the embed surface's failing entry points. */
export class EmbedError extends Error {
  readonly code: EmbedErrorCode;
  readonly status: number;

  constructor(code: EmbedErrorCode, message: string) {
    super(message);
    this.name = "EmbedError";
    this.code = code;
    this.status = EMBED_STATUS_CODE[code];
  }

  /** The response body for this refusal: `{ error, message }`. */
  toBody(): EmbedErrorBody {
    return { error: this.code, message: this.message };
  }
}

/** Convenience guard for `catch` blocks. */
export function isEmbedError(err: unknown): err is EmbedError {
  return err instanceof EmbedError;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Construction options for {@link EmbedDashboardService}. */
export interface EmbedDashboardOptions {
  /** The same options the JSON public route is built from — one resolver. */
  readonly publicDashboard: PublicDashboardOptions;
  /**
   * The layout lookup, reused verbatim for landing copy.
   *
   * Deliberately the *same* seam the service reads, so the title/description
   * shown are the title/description of the layout the share actually resolved
   * to — never a second lookup that could disagree with the filtered data.
   * Defaults to {@link PublicDashboardOptions.layouts}.
   */
  readonly layouts?: PublicDashboardOptions["layouts"];
  /**
   * Whether this share may be embedded at all. Defaults to allowing every
   * resolved share; a deploy that wants to gate framing passes a policy and a
   * `false` verdict becomes a uniform `forbidden` (403). The policy receives
   * only the resolved layout — never the token — so it cannot become an oracle.
   */
  readonly allowsEmbed?: (layout: EmbedLayout) => boolean;
}

/**
 * The embed surface, over an injected {@link PublicDashboardService}.
 *
 * `render(token)` resolves the token to a filtered view, reads that view's
 * allow-listed snapshot, and returns a {@link EmbedPage} — the head copy plus
 * the already-filtered points. It performs no filtering itself: the only source
 * of points is `view.snapshot()`.
 */
export class EmbedDashboardService {
  readonly #dashboard: PublicDashboardService;
  readonly #layouts: PublicDashboardOptions["layouts"];
  readonly #allowsEmbed: (layout: EmbedLayout) => boolean;

  constructor(options: EmbedDashboardOptions) {
    this.#dashboard = new PublicDashboardService(options.publicDashboard);
    this.#layouts = options.layouts ?? options.publicDashboard.layouts;
    this.#allowsEmbed = options.allowsEmbed ?? (() => true);
  }

  /**
   * Resolve `token` and produce the filtered embed page, or throw.
   *
   * @throws EmbedError `not_found`/`invalid_input` (→404) for any unusable
   *   token, reusing the public surface's uniform refusal; `forbidden` (→403)
   *   when the share resolves but the deploy's policy refuses to embed it.
   */
  async render(token: string): Promise<EmbedPage> {
    // The public surface owns the resolution rule and already collapses every
    // "no usable share" case into one uniform refusal (`not_found`/404). It is
    // re-thrown unchanged, so the two endpoints cannot drift into different
    // oracles.
    const view: PublicDashboard = await this.#dashboard.resolve(token);

    // The layout is read through the same seam the service used, so the copy
    // and the data describe the same board. A layout that vanished between the
    // two reads renders with default copy rather than failing the page — the
    // data (already filtered) is still correct.
    const looked = await this.#layouts(view.layoutId);
    const layout = isEmbedLayout(looked) ? looked : null;

    if (layout !== null && !this.#allowsEmbed(layout)) {
      throw new EmbedError("forbidden", "this shared dashboard may not be embedded");
    }

    const points = await view.snapshot();
    return { layout, variables: view.variables, points };
  }
}

/** The rendered result of a successful embed: head copy + filtered payload. */
export interface EmbedPage {
  readonly layout: EmbedLayout | null;
  readonly variables: readonly string[];
  readonly points: readonly Point[];
}

/**
 * Is `value` a layout an embed may read copy from?
 *
 * Only the presence of an object with a string `id` is required — the
 * allow-list handling is the service's job, and copy fields are optional. A
 * junk value is treated as "no copy" (defaults), never as an error.
 */
function isEmbedLayout(value: unknown): value is EmbedLayout {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value)) return false;
  return typeof value.id === "string";
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

/** Hono handler rendering one embed. */
export type EmbedHandler = (c: Context) => Promise<Response>;

/** Options accepted by {@link createEmbedRoute}. */
export interface EmbedRouteOptions {
  /** The service to render through, or the options to build one. */
  readonly service?: EmbedDashboardService;
  readonly publicDashboard?: PublicDashboardOptions;
  readonly layouts?: PublicDashboardOptions["layouts"];
  readonly allowsEmbed?: (layout: EmbedLayout) => boolean;
}

/**
 * Build the handler for `GET /embed/:token`.
 *
 * Success is `200 text/html` with the rendered page and an `X-Robots-Tag`
 * header mirroring the in-document `noindex` (a crawler that ignores the meta
 * still sees the header). A refusal is the JSON `{ error, message }` pair with
 * its frozen status (404 for an unusable token, 403 for a share the deploy will
 * not embed) — never a partial page, so nothing is rendered from a refused
 * share.
 */
export function createEmbedHandler(service: EmbedDashboardService): EmbedHandler {
  return async (c: Context): Promise<Response> => {
    try {
      const page = await service.render(c.req.param("token") ?? "");
      return new Response(renderEmbedPage(page), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          // A share token is a credential and its page is not indexable; the
          // header is the belt to the document's `robots` braces.
          "X-Robots-Tag": EMBED_ROBOTS,
          // The body is token-specific; never let an intermediary cache it.
          "Cache-Control": "private, no-store",
        },
      });
    } catch (err) {
      if (isEmbedError(err)) {
        return c.json(err.toBody(), err.status as 403 | 404);
      }
      if (isPublicDashboardError(err)) {
        return c.json(err.toBody(), err.status as 401 | 404);
      }
      throw err;
    }
  };
}

/**
 * A ready-to-mount Hono router exposing `GET /embed/:token`.
 *
 * Mount it with `app.route("/embed", createEmbedRoute({ publicDashboard }))`.
 * The router mounts its handler at `/:token` so the token is a single path
 * segment — a share token is opaque, and a segment is what a link carries.
 */
export function createEmbedRoute(options: EmbedRouteOptions): Hono {
  if (options.service === undefined && options.publicDashboard === undefined) {
    throw new TypeError(
      "createEmbedRoute: `publicDashboard` (or a ready `service`) is required",
    );
  }

  const service =
    options.service ??
    new EmbedDashboardService({
      publicDashboard: options.publicDashboard as PublicDashboardOptions,
      ...(options.layouts !== undefined ? { layouts: options.layouts } : {}),
      ...(options.allowsEmbed !== undefined ? { allowsEmbed: options.allowsEmbed } : {}),
    });

  const router = new Hono();
  router.get("/:token", createEmbedHandler(service));
  return router;
}

/**
 * A tiny typed shim over `node:fs` for the E2E D1 audit.
 *
 * The repo's tsconfig pins `types` to Cloudflare Workers + vitest, so Node's
 * own type package is not (and, per this test's scope, must not be) added. A
 * static import of `node:fs` would therefore fail typecheck. This module keeps
 * that import in one place and narrows it to exactly the two calls the audit
 * needs — a declared boundary rather than an unchecked cast at the call site.
 *
 * Only `test/e2e/m1-slice.test.ts` consumes this; it is test-only surface.
 */

// @ts-expect-error `node:fs` has no ambient type surface in this repo's
// tsconfig `types` (Cloudflare Workers + vitest only) and this task may not add
// dependencies or edit the tsconfig. Bun and Node both supply the real module
// at runtime; the two exports below are pinned by the interfaces here.
import { readdirSync, readFileSync } from "node:fs";

/** A directory entry as returned by `readdirSync(..., { withFileTypes: true })`. */
export interface Dirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** `readdirSync(path, { withFileTypes: true })` — typed names, not strings. */
export const readDirectorySync = readdirSync as unknown as (
  path: string | URL,
  options: { withFileTypes: true },
) => Dirent[];

/** `readFileSync(path, "utf8")` — text in, text out. */
export const readTextFileSync = readFileSync as unknown as (
  path: string | URL,
  encoding: "utf8",
) => string;

/**
 * A typed boundary over the Node builtins the secret scan needs: walking a
 * directory tree, reading each file as UTF-8 text, and resolving paths from
 * `import.meta.url`.
 *
 * The repo's tsconfig pins `types` to Cloudflare Workers + vitest, so Node's own
 * type package is absent (and this task must not add a dependency or widen the
 * compiler config). A static import of `node:fs`/`node:url`/`node:path` would
 * therefore fail `bun run typecheck`. Keeping the imports in one module — and
 * narrowing them to exactly the calls used — is the same declared-boundary
 * pattern `test/e2e/node-fs.ts` and `test/contracts/node-boundary.ts` already
 * use. Both Bun and Node supply the real modules at runtime.
 *
 * The `@ts-expect-error` directives below record why each import has no ambient
 * type surface in this repo's tsconfig `types`; the exports are pinned by the
 * interfaces here rather than by an unchecked cast at each call site.
 */
// @ts-expect-error `node:fs` has no ambient type surface in this repo.
import { readdirSync, readFileSync } from "node:fs";
// @ts-expect-error `node:url` has no ambient type surface in this repo.
import { fileURLToPath } from "node:url";
// @ts-expect-error `node:path` has no ambient type surface in this repo.
import { dirname, join } from "node:path";

/** A directory entry as returned by `readdirSync(..., { withFileTypes: true })`. */
export interface Dirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** `readdirSync(path, { withFileTypes: true })` — typed entries, not strings. */
export const readDirectorySync = readdirSync as unknown as (
  path: string,
  options: { withFileTypes: true },
) => readonly Dirent[];

/** `readFileSync(path, "utf8")` — text in, text out. */
export const readTextFileSync = readFileSync as unknown as (
  path: string,
  encoding: "utf8",
) => string;

/** Turn a `file:` URL (e.g. `import.meta.url`) into a filesystem path. */
export const filePathFromUrl = fileURLToPath as unknown as (url: string) => string;

/** The directory portion of a path. */
export const dirOf = dirname as unknown as (path: string) => string;

/** Join path segments. */
export const joinPath = join as unknown as (...segments: string[]) => string;

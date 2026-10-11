/**
 * A typed boundary over the Node builtins the cross-repo mirror guard needs:
 * reading the SDK's `test_main.cpp` off disk and resolving its path.
 *
 * The repo's tsconfig pins `types` to Cloudflare Workers + vitest, so Node's
 * own type package is not present (and this contract task must not add a
 * dependency or widen the compiler config). A static import of `node:fs` would
 * therefore fail `bun run typecheck`. Keeping the import in one module — with
 * the modules narrowed to exactly the calls used — is the same declared-boundary
 * pattern the e2e audit uses in `test/e2e/node-fs.ts`.
 *
 * Both Bun and Node supply the real modules at runtime.
 *
 * The `@ts-expect-error` directives below record why each import has no ambient
 * type surface in this repo's tsconfig `types`; the exports are pinned by the
 * interfaces here rather than by an unchecked cast at each call site.
 */
// @ts-expect-error `node:fs` has no ambient type surface in this repo.
import { readFileSync } from "node:fs";
// @ts-expect-error `node:url` has no ambient type surface in this repo.
import { fileURLToPath as fileURLToPathRaw } from "node:url";
// @ts-expect-error `node:path` has no ambient type surface in this repo.
import { dirname as dirnameRaw, resolve as resolveRaw } from "node:path";

/** Read a UTF-8 text file, or throw the underlying filesystem error. */
export const readTextFileSync = readFileSync as unknown as (
  path: string,
  encoding: "utf8",
) => string;

/** Turn a `file:` URL (e.g. `import.meta.url`) into a filesystem path. */
export const filePathFromUrl = fileURLToPathRaw as unknown as (url: string) => string;

/** The directory portion of a path. */
export const dirOf = dirnameRaw as unknown as (path: string) => string;

/** Resolve path segments against the current working directory. */
export const joinPath = resolveRaw as unknown as (...segments: string[]) => string;

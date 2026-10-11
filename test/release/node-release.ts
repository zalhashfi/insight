/**
 * A typed boundary over the Node builtins the release audit needs: reading
 * files, walking trees, listing tracked files, and resolving paths across the
 * sibling repos and the Bun content store.
 *
 * The repo's tsconfig pins `types` to Cloudflare Workers + vitest, so Node's own
 * type package is absent (and this release task must not add a dependency or
 * widen the compiler config). A static import of `node:fs`/`node:path` would
 * therefore fail `bun run typecheck`. Keeping the imports in one module — and
 * narrowing them to exactly the calls used — is the same declared-boundary
 * pattern `test/config/node-fs.ts`, `test/e2e/node-fs.ts` and
 * `test/contracts/node-boundary.ts` already use. Both Bun and Node supply the
 * real modules at runtime.
 *
 * The `@ts-expect-error` directives below record why each import has no ambient
 * type surface in this repo's tsconfig `types`; the exports are pinned by the
 * interfaces here rather than by an unchecked cast at each call site.
 */
// @ts-expect-error `node:fs` has no ambient type surface in this repo.
import { existsSync, readdirSync, readFileSync } from "node:fs";
// @ts-expect-error `node:child_process` has no ambient type surface in this repo.
import { spawnSync } from "node:child_process";
// @ts-expect-error `node:url` has no ambient type surface in this repo.
import { fileURLToPath } from "node:url";
// @ts-expect-error `node:path` has no ambient type surface in this repo.
import { dirname, join, resolve } from "node:path";

/** One directory entry, `readdirSync(..., { withFileTypes: true })`-shaped. */
export interface Dirent {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** `readdirSync(path, { withFileTypes: true })` — typed entries, not names. */
export const readDirectorySync = readdirSync as unknown as (
  path: string,
  options: { withFileTypes: true },
) => readonly Dirent[];

/** `readFileSync(path, "utf8")` — text in, text out. */
export const readTextFileSync = readFileSync as unknown as (
  path: string,
  encoding: "utf8",
) => string;

/** `existsSync(path)` — does a path exist (file or directory)? */
export const pathExistsSync = existsSync as unknown as (path: string) => boolean;

/** Turn a `file:` URL (e.g. `import.meta.url`) into a filesystem path. */
export const filePathFromUrl = fileURLToPath as unknown as (url: string) => string;

/** The directory portion of a path. */
export const dirOf = dirname as unknown as (path: string) => string;

/** Join path segments. */
export const joinPath = join as unknown as (...segments: string[]) => string;

/** Resolve path segments to an absolute path (right-to-left until absolute). */
export const resolvePath = resolve as unknown as (...segments: string[]) => string;

/** The captured result of a synchronous child process. */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * Run a program synchronously and capture its text output.
 *
 * `maxBuffer` is generous because one audit pipes the whole tracked tree through
 * a scanner; the default 1 MiB would truncate it and turn a real finding into a
 * silent pass. `status` is `null` when the process could not be spawned at all
 * (e.g. `git` is absent), which callers use to distinguish "0 hits" from "the
 * guard could not run".
 */
export const runSync = spawnSync as unknown as (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    encoding?: "utf8";
    maxBuffer?: number;
    env?: Record<string, string>;
  },
) => RunResult;

/**
 * Parse JSON with comments — the format `bun.lock` is written in.
 *
 * `Bun` is not in this repo's tsconfig `types` (which pins Cloudflare Workers +
 * vitest), so the global is reached through one named cast with its shape
 * pinned, exactly as `test/db/migrate-apply.test.ts` does for `Bun.file`. Bun is
 * the sole test runner here, so the runtime guarantees the method exists; no
 * runtime check would be meaningful for a host-provided global.
 */
const bunGlobal = globalThis as unknown as {
  readonly Bun: { readonly JSONC: { parse(text: string): unknown } };
};

/** Parse `text` as JSONC (JSON with comments + trailing commas). */
export function parseJsonc(text: string): unknown {
  return bunGlobal.Bun.JSONC.parse(text);
}

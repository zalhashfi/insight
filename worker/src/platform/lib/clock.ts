/**
 * clock — the single `Clock` seam for the worker.
 *
 * A `Clock` is a caller-supplied "now" seam returning Unix epoch milliseconds
 * (UTC) — the repo-wide time unit. Injecting it keeps every timestamped write
 * deterministic and lets a test pin "now" exactly, so the worker never reaches
 * for the wall clock implicitly.
 *
 * This module is the ONE declaration of both the type and the production
 * default. Every other module imports them from here (see `worker/src/platform/
 * lib/`) rather than re-declaring a structurally-identical copy, so the seam
 * cannot drift module by module. It is pure and stateless, hence safe to import
 * from any isolate.
 */

/**
 * A clock returning Unix epoch milliseconds.
 *
 * The canonical seam: the returned number is the same unit as
 * `EpochMs` in `deploy/portable/storage-interface.ts`.
 */
export type Clock = () => number;

/** Default wall clock: Unix epoch milliseconds. */
export const defaultClock: Clock = () => Date.now();

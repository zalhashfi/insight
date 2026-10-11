/**
 * external/poll — pull one external JSON source and ingest its fields as
 * telemetry variables (A31, FR-INT-04 / FR-EXT-01).
 *
 * ## What this unit is
 *
 * An *external source* is a URL the platform polls on a schedule (the
 * `SchedulerDO` alarm folds it into `min(schedule, sunset, delay, ext-poll)` —
 * see `PROJECT.md`). The body at that URL is some third-party JSON — a weather
 * API, a plant gateway, a bridge that mirrors a sensor that is not one of ours.
 * This module is the pure "fetch once → map → ingest" step: it reads the URL
 * through an injected {@link FetchLike} seam and hands the mapped points to the
 * SAME {@link TelemetrySink} the device ingest route uses, so an external
 * reading lands in exactly the ring/DO a device reading does, and the read
 * surface (`query.ts`) sees it with no special case.
 *
 * It reaches for no binding, no ambient clock and no global `fetch`: the URL is
 * fetched through {@link FetchLike} and every mapping decision is data on
 * {@link ExternalSourceConfig}. That keeps the whole rule pinned by a unit test
 * rather than through `createApp`.
 *
 * ## The four configuration knobs (FR-EXT-01)
 *
 *   1. {@link ExternalSourceConfig.envelopePath} (`envelope_path`) — **where the
 *      items live** in the parsed JSON. A source may return the objects at the
 *      root, under a key (`{"data": {...}}`), an array under a key
 *      (`{"observations": [ ... ]}`), or deeply nested
 *      (`{"payload": {"readings": [ ... ]}}`). The path is a tiny dotted / bracketed
 *      grammar: `data.readings`, `payload[0].readings`, `readings[2]`. An empty
 *      or absent path means "the root". See {@link readEnvelope}.
 *   2. {@link ExternalSourceConfig.cursor} (`cursor`) — **how to tell an item
 *      already seen from a new one**. Names the cursor field inside each item
 *      (e.g. `id`, `ts`) and the ordering that field carries. The watermark
 *      itself lives behind the injected {@link CursorStore} seam, so a re-poll
 *      resumes from where the last one stopped and an already-seen item is never
 *      ingested twice. See {@link advanceCursor}.
 *   3. {@link ExternalSourceConfig.sentinelMap} (`sentinel_map`) — **the external
 *      field → variable mapping**. `{"temp_c": "greenhouse_temp"}` turns a
 *      source's own field name into the variable name this platform records,
 *      so the mapping is declared, never inferred from the source's spelling.
 *   4. {@link ExternalSourceConfig.allowList} (`allow_list`) — **the only fields
 *      that may be ingested**. A field is ingested iff it is BOTH in the mapping
 *      AND in the allow-list; anything else is dropped before it ever reaches a
 *      sink. This is the guard that keeps a source's incidental fields (an
 *      `api_key`, an internal `id`, an operator's email) out of telemetry even
 *      when they appear in the payload. See {@link mapAllowedFields}.
 *
 * ## Fail-closed, never fatal
 *
 * A poll runs unattended on a timer, so a bad source must never take the
 * scheduler down. Every failure below — a transport error, a non-2xx response,
 * a body that is not JSON, a missing/wrongly-shaped envelope, an item that is
 * not an object — is turned into a {@link PollResult} describing *what happened*
 * (`ok: false` with a stable {@link PollFailure}), never a thrown error. A poll
 * that cannot read its source ingests nothing and leaves the cursor exactly
 * where it was, so the next tick retries from the same place instead of silently
 * skipping a window.
 *
 * Partial success is the norm and is deliberate: a payload whose envelope is
 * good but which contains one malformed item still ingests every OTHER item
 * (the malformed one is skipped and counted). Only a failure to obtain or
 * unwrap the envelope is a whole-poll failure — once items are in hand, one bad
 * row never discards the good ones.
 */

import { defaultClock } from "../../platform/lib/clock";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The minimal transport this module needs — a structural subset of the global
 * `fetch`, so the real one satisfies it as-is and a test hands in a two-line
 * stub. Named (rather than reusing the DOM `typeof fetch`) so the seam is one
 * explicit contract: given a URL, return something with a status and a JSON body.
 */
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

/** The slice of a `Response` a poll reads: the status and the parsed body. */
export interface FetchResponseLike {
  /** HTTP status code (any 2xx is a success; everything else is a failure). */
  readonly status: number;
  /** Parse the body as JSON. May throw (a non-JSON body) — the poll catches it. */
  json(): Promise<unknown>;
}

/**
 * Persistence seam for a source's cursor watermark — the one piece of state a
 * poll carries between ticks.
 *
 * Backed in production by the `external_sources` row (or the project DO); a test
 * passes a small map. `read` returning `null` means "never polled" — every item
 * is new. `write` is called ONLY after a successful ingest, so a failed poll
 * cannot advance the watermark past items it never ingested.
 */
export interface CursorStore {
  /** The stored watermark for a source, or `null` when it has never advanced. */
  read(sourceId: string): Promise<string | null> | string | null;
  /** Persist a new watermark for a source, replacing any previous value. */
  write(sourceId: string, cursor: string): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How a cursor field's values are compared to order items. */
export type CursorKind =
  /** Numeric watermark: the field is a number; the highest value wins. */
  | "number"
  /** String watermark: the field is a string compared lexicographically. */
  | "string";

/** The `cursor` knob: which field carries the watermark and how to order it. */
export interface CursorConfig {
  /**
   * The field inside each item whose value is the cursor (e.g. `"id"`, `"ts"`).
   * The value at this path must match {@link CursorConfig.kind}; an item whose
   * cursor is missing or of the wrong kind is skipped (never ingested), because
   * it cannot be ordered against the watermark.
   */
  readonly field: string;
  /**
   * How the field orders. `"number"` (the default) compares numerically;
   * `"string"` compares lexicographically (an ISO-8601 timestamp or a
   * zero-padded id orders correctly that way).
   */
  readonly kind?: CursorKind;
  /**
   * Items whose cursor is **equal to** the watermark are skipped. Defaults to
   * `true` (the watermark itself was ingested on the previous poll). Set to
   * `false` only for a source that reuses a cursor value across distinct items.
   */
  readonly skipEqual?: boolean;
}

/**
 * A poll target: the URL, where its items live, how to tell new ones apart,
 * which fields to record and under what names (FR-EXT-01).
 *
 * Every field is a plain data value so a source is fully described by stored
 * config and no behaviour hides in code. `allowList` and `sentinelMap` are the
 * two halves of the "only these fields, under these names" rule; `cursor` is the
 * "not these ones again" rule; `envelopePath` is the "where do the items live"
 * rule.
 */
export interface ExternalSourceConfig {
  /** Stable id of the source — keys the {@link CursorStore} watermark. */
  readonly sourceId: string;
  /** The URL polled. Passed verbatim to the injected {@link FetchLike}. */
  readonly url: string;
  /**
   * `envelope_path`: where the array/objects live in the parsed JSON. Empty or
   * absent means the JSON root. Dotted keys and `[n]` indices are supported
   * (`"a.b[0].readings"`). See {@link readEnvelope}.
   */
  readonly envelopePath?: string;
  /**
   * `cursor`: the field that marks an item as already-seen. Absent means the
   * source has no cursor and every poll ingests every item it finds (the caller
   * then owns de-duplication elsewhere) — an explicit choice, not a default.
   */
  readonly cursor?: CursorConfig;
  /**
   * `sentinel_map`: external item field → the variable name to record it under.
   * A field is mapped only when it is BOTH a key here AND in
   * {@link ExternalSourceConfig.allowList}.
   */
  readonly sentinelMap: Readonly<Record<string, string>>;
  /**
   * `allow_list`: the ONLY external fields that may be ingested. Membership is
   * necessary but not sufficient — a field must also be mapped in
   * {@link ExternalSourceConfig.sentinelMap}. A field present in the payload but
   * absent here is never ingested, which is what keeps a source's incidental or
   * secret fields (an `api_key`, an `email`) out of telemetry.
   */
  readonly allowList: readonly string[];
  /**
   * The project every mapped point is recorded against. Kept on the config
   * because a source belongs to exactly one project (a shared source would leak
   * one tenant's readings into another's series).
   */
  readonly projectId: string;
  /**
   * The device dimension the points are recorded under. A source has no device
   * of its own, so one synthetic key names it (e.g. `"external:acme-weather"`).
   * Defaults to the source id when omitted.
   */
  readonly device?: string;
  /**
   * Where an ingested point's `ts` comes from. `"now"` (the default) stamps the
   * poll instant from the injected {@link PollDeps.now} clock — the platform
   * time, matching the device ingest route, which ignores any sender-supplied
   * time. A field path (e.g. `"observed_at"`) instead reads the item's own
   * timestamp; the value must be a finite number of epoch milliseconds or the
   * item falls back to the poll instant.
   */
  readonly timestampField?: string | "now";
}

/** Everything a poll needs, injectable end-to-end for tests. */
export interface PollDeps {
  /** Transport seam (the real global `fetch` in production). */
  readonly fetch: FetchLike;
  /** Persistence seam for the source's watermark. */
  readonly cursor: CursorStore;
  /** Where mapped points land — the SAME sink the device ingest route uses. */
  readonly sink: TelemetrySinkLike;
  /** Clock seam (epoch ms). Defaults to wall-clock `Date.now`. */
  readonly now?: () => number;
}

/**
 * The persistence seam for accepted points — a structural subset of
 * `TelemetrySink` from `domains/telemetry/telemetry.ts`.
 *
 * Declared structurally (rather than importing the interface) so this module is
 * coupled only to the one method it calls and a test can hand in a plain
 * recorder; the real `TelemetrySink` satisfies it as-is. The signature is
 * verbatim the device route's `record`, so an external point and a device point
 * are indistinguishable downstream.
 */
export interface TelemetrySinkLike {
  record(
    projectId: string,
    device: string,
    metric: string,
    value: number | null,
    ts: number,
  ): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Stable, machine-readable reasons a whole poll failed. */
export type PollFailure =
  /** The transport seam threw (DNS, TLS, timeout, ...). */
  | "fetch_failed"
  /** The source answered a non-2xx status. */
  | "http_error"
  /** The response body was not valid JSON (`.json()` threw). */
  | "invalid_json"
  /** `envelope_path` did not resolve to items (missing key, wrong shape). */
  | "missing_envelope";

/** One point as ingested — mirrors a {@link TelemetrySinkLike.record} call. */
export interface PolledPoint {
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
}

/**
 * The outcome of one poll. `ok: true` covers any poll that obtained an envelope
 * — including one whose items all turned out to be duplicates or unchartable
 * (that is `ingested: 0`, not a failure). `ok: false` carries a stable
 * {@link PollFailure} and the fields relevant to it.
 */
export interface PollResult {
  readonly ok: boolean;
  /** The source polled. */
  readonly sourceId: string;
  /** Failure reason, present iff `ok` is false. */
  readonly failure?: PollFailure;
  /** HTTP status, when the failure was an {@link PollFailure} `"http_error"`. */
  readonly status?: number;
  /** How many points were handed to the sink (0 on a failure or a duplicate-only poll). */
  readonly ingested: number;
  /** Points actually recorded, in ingest order (for a caller / a test to assert). */
  readonly points: readonly PolledPoint[];
  /**
   * How many envelope items were skipped because they were duplicates, malformed
   * or carried no allowed field. Never a failure — a skipped item is normal.
   */
  readonly skipped: number;
  /** The watermark in force after this poll (unchanged on failure). */
  readonly cursor: string | null;
}

// ---------------------------------------------------------------------------
// Envelope path (`envelope_path`)
// ---------------------------------------------------------------------------

/** One step of a parsed envelope path: a key, or an array index (when numeric). */
type PathStep = { readonly key: string } | { readonly index: number };

/**
 * Parse `envelope_path` into steps.
 *
 * Grammar: dotted segments with optional bracketed indices. `a.b` → two keys;
 * `a[0].b` → key, index, key; `[2]` → a lone index. A bracketed segment is an
 * index only when it is all digits (so `a[id]` is the literal key `id`, not an
 * index — a JSON object key with a bracket is rare but must not crash). An empty
 * path yields no steps, which {@link readEnvelope} treats as "the root".
 */
export function parseEnvelopePath(path: string | undefined): readonly PathStep[] {
  if (path === undefined) return [];
  const trimmed = path.trim();
  if (trimmed === "") return [];

  const steps: PathStep[] = [];
  for (const segment of trimmed.split(".")) {
    // A segment may be `name`, `name[0]`, `name[0][1]`, or a bare `[0]`.
    const parts = segment.split(/\[(\d*)\]/);
    // `split` on a capturing group interleaves name, index, name, index, ...
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? "";
      if (i % 2 === 0) {
        // Literal key portion (may be empty for a leading `[0]`).
        if (part !== "") steps.push({ key: part });
      } else {
        // Captured index portion.
        if (part !== "") steps.push({ index: Number(part) });
      }
    }
  }
  return steps;
}

/**
 * `readEnvelope`: resolve `envelope_path` against the parsed JSON and return the
 * items it names.
 *
 * The result is **always** an array — a source whose envelope is a single object
 * is normalised to a one-element array, so a poll never has to branch on "one vs
 * many". A path that does not resolve (a missing key, an out-of-range index,
 * walking into a non-object, or a resolved value that is neither an object nor
 * an array) yields `null`, which the poll reports as
 * {@link PollFailure} `"missing_envelope"`. It never throws.
 */
export function readEnvelope(parsed: unknown, envelopePath: string | undefined): readonly unknown[] | null {
  let current: unknown = parsed;
  for (const step of parseEnvelopePath(envelopePath)) {
    if ("index" in step) {
      if (!Array.isArray(current)) return null;
      const next = current[step.index];
      if (next === undefined && step.index >= current.length) return null;
      current = next;
    } else {
      if (current === null || typeof current !== "object") return null;
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, step.key)) return null;
      current = record[step.key];
    }
  }

  if (Array.isArray(current)) return current;
  if (current !== null && typeof current === "object") return [current];
  return null;
}

// ---------------------------------------------------------------------------
// Field extraction & mapping (`sentinel_map` + `allow_list`)
// ---------------------------------------------------------------------------

/** Read a (possibly dotted) field from an item; `undefined` when absent. */
function readField(item: Record<string, unknown>, field: string): unknown {
  if (!field.includes(".")) return item[field];
  let current: unknown = item;
  for (const key of field.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A value is ingestible when `null` (allowed) or a finite number. */
function isIngestibleValue(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/** One field's mapping outcome from {@link mapAllowedFields}. */
interface MappedField {
  readonly variable: string;
  readonly value: number | null;
}

/**
 * `mapAllowedFields`: apply the two-field rule — a field is ingested iff it is
 * in BOTH the `sentinel_map` and the `allow_list` — and return the mapped points.
 *
 * The fields are visited in `allow_list` order so the emitted points have a
 * stable, config-driven order (assertable in a test and reproducible across
 * polls). For each allowed field that is also mapped:
 *
 *   * a missing field, or one whose value is neither a finite number nor `null`,
 *     is SKIPPED (never coerced — a string `"12"` is not silently a 12);
 *   * a mapped field NOT in the allow-list is skipped even though it exists and
 *     even though a mapping for it is configured — the allow-list is the veto.
 *
 * A field the item simply does not carry is not an error: a source that omits an
 * optional field on some rows ingests the rest.
 */
export function mapAllowedFields(
  item: Record<string, unknown>,
  config: Pick<ExternalSourceConfig, "allowList" | "sentinelMap">,
): readonly MappedField[] {
  const mapped: MappedField[] = [];

  for (const field of config.allowList) {
    const variable = config.sentinelMap[field];
    if (variable === undefined) continue; // nothing to record it as
    const value = readField(item, field);
    if (!isIngestibleValue(value)) continue; // absent, or uncoercible
    mapped.push({ variable, value });
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Cursor (`cursor`)
// ---------------------------------------------------------------------------

/** Normalise a raw cursor value to its canonical comparison form, or `null`. */
function cursorValue(raw: unknown, kind: CursorKind): string | null {
  if (kind === "number") {
    return typeof raw === "number" && Number.isFinite(raw) ? String(raw) : null;
  }
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/**
 * Compare two cursor values of the same {@link CursorKind}.
 * Returns -1, 0 or 1 (the contract `Array.prototype.sort` expects).
 */
function compareCursor(a: string, b: string, kind: CursorKind): number {
  if (kind === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  }
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The cursor of one item, or `null` when it has none usable. */
function itemCursor(item: Record<string, unknown>, cursor: CursorConfig): string | null {
  return cursorValue(readField(item, cursor.field), cursor.kind ?? "number");
}

/**
 * `advanceCursor`: fold the items that were actually ingested into a watermark.
 *
 * The new watermark is the MAXIMUM cursor among accepted items, compared
 * according to {@link CursorConfig.kind}, so a source that returns items out of
 * order (a page newest-first, or a batch with a late-arriving row) cannot drag
 * the watermark backwards and re-open a window that was already consumed. When
 * no accepted item carries a cursor the previous watermark is returned
 * unchanged — a poll that ingested nothing readable must not move the mark.
 *
 * Returned as the canonical string form; `null` means "still no watermark".
 */
export function advanceCursor(
  previous: string | null,
  items: readonly Record<string, unknown>[],
  cursor: CursorConfig,
): string | null {
  const kind = cursor.kind ?? "number";
  let best = previous;
  for (const item of items) {
    const value = itemCursor(item, cursor);
    if (value === null) continue;
    if (best === null || compareCursor(value, best, kind) > 0) best = value;
  }
  return best;
}

/**
 * Is this item already at or before the watermark? An item is "seen" when its
 * cursor is strictly less than the watermark, or equal to it and
 * {@link CursorConfig.skipEqual} is not explicitly `false`.
 *
 * An item with NO usable cursor is never treated as seen: it is skipped for a
 * different reason (it cannot be ordered), which the caller reports separately
 * so the two are distinguishable.
 */
export function isSeen(item: Record<string, unknown>, watermark: string | null, cursor: CursorConfig): boolean {
  if (watermark === null) return false;
  const value = itemCursor(item, cursor);
  if (value === null) return false;
  const kind = cursor.kind ?? "number";
  const order = compareCursor(value, watermark, kind);
  if (order < 0) return true;
  if (order > 0) return false;
  return cursor.skipEqual ?? true;
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

/**
 * Poll one external source once: fetch, unwrap, filter, map and ingest.
 *
 * The order is deliberate and observable:
 *
 *   1. **READ the watermark** before fetching, so the decision "is this item
 *      new?" is made against the same value throughout the poll.
 *   2. **FETCH** through the seam. A thrown transport error → `fetch_failed`; a
 *      non-2xx → `http_error` (with the status). Both leave the cursor untouched.
 *   3. **PARSE** the body. A body that is not JSON → `invalid_json`.
 *   4. **UNWRAP** `envelope_path`. A path that names nothing → `missing_envelope`.
 *   5. **FOR EACH ITEM** (in envelope order): skip a non-object; skip a duplicate
 *      (per `cursor`); map the allowed fields; if it maps nothing, skip; else
 *      stamp `ts` and hand each point to the sink.
 *   6. **ADVANCE the watermark** over the items that were ingested and persist
 *      it — only on a successful unwrap, so a failed poll retries in place.
 *
 * Never throws: every failure is a {@link PollResult}. The returned `points` are
 * exactly what was recorded, in order, so a caller or test can assert without a
 * spy on the sink.
 */
export async function pollSource(config: ExternalSourceConfig, deps: PollDeps): Promise<PollResult> {
  const now = deps.now ?? defaultClock;
  const cursorConfig = config.cursor;
  const base = { sourceId: config.sourceId, ingested: 0, points: [] as PolledPoint[], skipped: 0 };

  // 1. The watermark in force for this poll. The store is keyed by the source
  //    id itself: one source, one watermark.
  const previous = (await deps.cursor.read(config.sourceId)) ?? null;

  // 2. FETCH — a thrown transport error is a soft failure, not an exception.
  let response: FetchResponseLike;
  try {
    response = await deps.fetch(config.url);
  } catch {
    return { ok: false, ...base, failure: "fetch_failed", cursor: previous };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, ...base, failure: "http_error", status: response.status, cursor: previous };
  }

  // 3. PARSE — a non-JSON body (`.json()` throwing) is `invalid_json`.
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, ...base, failure: "invalid_json", cursor: previous };
  }

  // 4. UNWRAP — an envelope that names nothing is `missing_envelope`.
  const items = readEnvelope(parsed, config.envelopePath);
  if (items === null) {
    return { ok: false, ...base, failure: "missing_envelope", cursor: previous };
  }

  // 5. INGEST each item, in envelope order.
  const accepted: Record<string, unknown>[] = [];
  const points: PolledPoint[] = [];
  let skipped = 0;
  const device = config.device ?? config.sourceId;
  const tsField = config.timestampField ?? "now";

  for (const raw of items) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      skipped++;
      continue;
    }
    const item = raw as Record<string, unknown>;

    if (cursorConfig !== undefined && isSeen(item, previous, cursorConfig)) {
      skipped++;
      continue;
    }

    const mapped = mapAllowedFields(item, config);
    if (mapped.length === 0) {
      skipped++;
      continue;
    }

    const ts = resolveTimestamp(item, tsField, now());
    for (const field of mapped) {
      const point: PolledPoint = { variable: field.variable, value: field.value, ts };
      points.push(point);
      await deps.sink.record(config.projectId, device, field.variable, field.value, ts);
    }
    accepted.push(item);
  }

  // 6. ADVANCE the watermark over the accepted items and persist it.
  let next = previous;
  if (cursorConfig !== undefined) {
    next = advanceCursor(previous, accepted, cursorConfig);
    if (next !== previous && next !== null) await deps.cursor.write(config.sourceId, next);
  }

  return {
    ok: true,
    sourceId: config.sourceId,
    ingested: points.length,
    points,
    skipped,
    cursor: next,
  };
}

/**
 * The `ts` for one item: the poll instant (the default) or, for a configured
 * `timestampField`, the item's own finite numeric value in epoch ms. A field
 * that is present but not a finite number falls back to the poll instant — a
 * source with a broken clock must not produce an unorderable point.
 */
function resolveTimestamp(item: Record<string, unknown>, timestampField: string, pollInstant: number): number {
  if (timestampField === "now") return pollInstant;
  const raw = readField(item, timestampField);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : pollInstant;
}

// ---------------------------------------------------------------------------
// In-memory fakes — honest implementations of the seams, for tests & local dev
// ---------------------------------------------------------------------------

/**
 * In-memory {@link CursorStore}, keyed by source.
 *
 * Not a production store (the `external_sources` row persists in D1): it holds
 * one string per key, so a test can poll twice and observe that the second poll
 * reads back the first's watermark.
 */
export class InMemoryCursorStore implements CursorStore {
  readonly #values = new Map<string, string>();

  read(sourceId: string): string | null {
    return this.#values.get(sourceId) ?? null;
  }

  write(sourceId: string, cursor: string): void {
    this.#values.set(sourceId, cursor);
  }

  /** Every stored watermark, for inspection. */
  all(): ReadonlyMap<string, string> {
    return new Map(this.#values);
  }
}

/**
 * An in-memory {@link TelemetrySinkLike} that keeps every `record` call in
 * arrival order — the same shape `InMemoryTelemetrySink` exposes, re-declared so
 * this suite can assert the exact `(projectId, device, metric, value, ts)` tuple
 * an external point produces.
 */
export class InMemoryPollSink implements TelemetrySinkLike {
  readonly #samples: Array<{ projectId: string; device: string; metric: string; value: number | null; ts: number }> = [];

  record(projectId: string, device: string, metric: string, value: number | null, ts: number): void {
    this.#samples.push({ projectId, device, metric, value, ts });
  }

  /** Every recorded sample, in arrival order. */
  samples(): readonly { projectId: string; device: string; metric: string; value: number | null; ts: number }[] {
    return this.#samples;
  }

  /** The number of recorded samples. */
  get size(): number {
    return this.#samples.length;
  }
}

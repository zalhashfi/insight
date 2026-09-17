// Pure helpers for external API polling. No Env, no fetch, no DB —
// unit-testable in isolation. The fetch/DB side lives in service.ts.
import { validKey, MAX_STRING_VALUE } from '../telemetry/validate';

export type EnvelopeError =
  | 'envelope_not_found'
  | 'not_array'
  | 'empty_array'
  | 'no_records';

export type EnvelopeResult =
  | { ok: true; records: Record<string, unknown>[] }
  | { ok: false; error: EnvelopeError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Empty path = root; otherwise walk dot segments over plain objects only.
export function resolveEnvelope(body: unknown, path: string): EnvelopeResult {
  let cur: unknown = body;
  if (path !== '') {
    for (const seg of path.split('.')) {
      if (!isPlainObject(cur) || !(seg in cur)) return { ok: false, error: 'envelope_not_found' };
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  if (!Array.isArray(cur)) return { ok: false, error: 'not_array' };
  if (cur.length === 0) return { ok: false, error: 'empty_array' };
  const records = cur.filter(isPlainObject);
  if (records.length === 0) return { ok: false, error: 'no_records' };
  return { ok: true, records };
}

export type InferredField = {
  key: string;
  kinds: Array<'number' | 'string' | 'boolean' | 'null'>;
  nullable: boolean;
  sample: unknown;
};

// Union keys across records, skipping keys whose every value is nested.
export function inferFields(records: Record<string, unknown>[]): InferredField[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  const out: InferredField[] = [];
  for (const key of order) {
    const kinds = new Set<'number' | 'string' | 'boolean' | 'null'>();
    let nullable = false;
    let sample: unknown;
    let hasSample = false;
    let allNested = true;
    for (const r of records) {
      if (!(key in r)) continue;
      const v = (r as Record<string, unknown>)[key];
      if (!hasSample) {
        sample = v;
        hasSample = true;
      }
      if (v === null) {
        kinds.add('null');
        nullable = true;
        allNested = false;
      } else if (typeof v === 'number') {
        kinds.add('number');
        allNested = false;
      } else if (typeof v === 'string') {
        kinds.add('string');
        allNested = false;
      } else if (typeof v === 'boolean') {
        kinds.add('boolean');
        allNested = false;
      } else {
        // nested object/array, undefined, function — not a scalar candidate
      }
    }
    if (allNested || kinds.size === 0) continue;
    out.push({ key, kinds: [...kinds], nullable, sample });
  }
  return out;
}

export const SENTINEL_DEFAULT: Record<string, Array<number | string>> = {
  temperature: [-1, '-1', '-1.00'],
};

// null is always invalid; sentinels compare loosely (numeric when both finite).
export function isInvalid(
  field: string,
  value: unknown,
  sentinels: Record<string, Array<number | string>>
): boolean {
  if (value === null) return true;
  const list = sentinels[field];
  if (!Array.isArray(list)) return false;
  const v = typeof value === 'string' ? value.trim() : value;
  for (const entry of list) {
    const e = typeof entry === 'string' ? entry.trim() : entry;
    const nv = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
    const ne = typeof e === 'number' ? e : typeof e === 'string' && e !== '' ? Number(e) : NaN;
    if (Number.isFinite(nv) && Number.isFinite(ne)) {
      if (nv === ne) return true;
    } else if (String(v) === String(e)) {
      return true;
    }
  }
  return false;
}

export type CoercedValue =
  | { skip: true }
  | { skip: false; value: number | string | boolean | null };

const NUMERIC_SHAPED = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

// Truncation (not rejection) is deliberate: the poller must never build a
// batch that parseTelemetryBody would reject whole.
export function coerceValue(raw: unknown): CoercedValue {
  if (raw === null) return { skip: false, value: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { skip: false, value: raw } : { skip: true };
  }
  if (typeof raw === 'boolean') return { skip: false, value: raw };
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (NUMERIC_SHAPED.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return { skip: false, value: n };
    }
    return { skip: false, value: t.slice(0, MAX_STRING_VALUE) };
  }
  return { skip: true };
}

// Numeric compare when both Number()-finite, else code-unit string compare.
export function compareCursor(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  }
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

export type PollIntervalMinutes = 2 | 5 | 15 | 30 | 60;

// Next wall-clock multiple of the interval plus exactly 30s. All five
// intervals divide 60, so minute-of-hour alignment is timezone-independent.
export function nextPollFireAt(intervalMinutes: PollIntervalMinutes, fromMs: number): number {
  const base = Math.floor(fromMs / 60000);
  const aligned = base - (base % intervalMinutes);
  let fire = aligned * 60000 + 30000;
  if (fire <= fromMs) fire += intervalMinutes * 60000;
  return fire;
}

// Byte-identical duplicate of the rule in
// worker/src/domains/telemetry/telemetry.ts:49-54 (duplicate, don't refactor
// the hot path).
export function suffixVariable(variable: string, deviceKey: string): string {
  if (deviceKey && !variable.toLowerCase().endsWith(`_${deviceKey.toLowerCase()}`)) {
    return `${variable}_${deviceKey}`;
  }
  return variable;
}

export { validKey };

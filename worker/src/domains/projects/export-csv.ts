// CSV export of telemetry history. Reads the same R2 objects ProjectDO writes
// (see runFlush), so the only source for a real range is R2 — the DO ring buffer
// holds an hour at a time.
//
// Two layouts:
//   long — one row per point: ts,device,variable,value. Streams, never buffered.
//   wide — one row per timestamp, one column per variable. Buffered a bucket at
//          a time so a month-long export doesn't sit in memory.

import type { Env } from '../../env';
import { hourBucket, hourBucketsBetween } from '../../platform/lib/time-bucket';

export type ExportFormat = 'long' | 'wide';

export type CsvExportOptions = {
  /** Inclusive unix seconds. */
  from: number;
  /** Inclusive unix seconds. */
  to: number;
  /** null = every variable in the range. */
  variables: string[] | null;
  /** null = every device; otherwise match the R2 `device` field. */
  deviceId: string | null;
  /** True when deviceId names the project's default device, whose rows carry null. */
  deviceIsDefault: boolean;
  format: ExportFormat;
};

type Point = { ts: number; device: string | null; variable: string; value: unknown };

// A spreadsheet treats a leading =, +, -, @, tab or CR as the start of a
// formula, so a value a device chose could execute in whoever opens the file.
// Numbers and booleans are exempt: they are emitted numerically.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') return csvField(JSON.stringify(value));

  let text = String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (text.includes('"') || text.includes(',') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function csvRow(fields: unknown[]): string {
  return `${fields.map(csvField).join(',')}\n`;
}

// Streams every point in [from, to] straight off R2, one hour bucket at a time.
async function* readPoints(
  env: Env,
  projectId: string,
  opts: CsvExportOptions
): AsyncGenerator<Point> {
  const wanted = opts.variables ? new Set(opts.variables) : null;

  for (const bucket of hourBucketsBetween(opts.from, opts.to)) {
    let cursor: string | undefined;
    do {
      const list = await env.R2.list({
        prefix: `telemetry/${projectId}/${bucket}/`,
        ...(cursor ? { cursor } : {}),
      });

      for (const object of list.objects) {
        const body = await env.R2.get(object.key);
        if (!body) continue;

        for (const raw of (await body.text()).split('\n')) {
          if (!raw.trim()) continue;
          let point: Point;
          try {
            point = JSON.parse(raw) as Point;
          } catch {
            // A truncated line beats aborting a long export.
            continue;
          }

          if (point.ts < opts.from || point.ts > opts.to) continue;
          if (wanted && !wanted.has(point.variable)) continue;
          if (opts.deviceId) {
            const keep = opts.deviceIsDefault
              ? point.device === null
              : point.device === opts.deviceId;
            if (!keep) continue;
          }
          yield point;
        }
      }

      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  }
}

async function* longRows(
  env: Env,
  projectId: string,
  opts: CsvExportOptions
): AsyncGenerator<string> {
  yield csvRow(['ts', 'device', 'variable', 'value']);
  for await (const point of readPoints(env, projectId, opts)) {
    yield csvRow([point.ts, point.device, point.variable, point.value]);
  }
}

// One hour bucket at a time, so the working set is a bucket rather than a range.
async function* wideRows(
  env: Env,
  projectId: string,
  opts: CsvExportOptions
): AsyncGenerator<string> {
  let columns: string[] | null = opts.variables;
  let wroteHeader = false;
  let bucket = new Map<number, Map<string, unknown>>();
  let currentBucket: string | null = null;

  function* flush(): Generator<string> {
    const stamps = [...bucket.keys()].sort((a, b) => a - b);
    for (const ts of stamps) {
      const row = bucket.get(ts)!;
      yield csvRow([ts, ...(columns ?? []).map((key) => row.get(key) ?? null)]);
    }
    bucket = new Map();
  }

  for await (const point of readPoints(env, projectId, opts)) {
    const at = hourBucket(point.ts);
    if (at !== currentBucket) {
      if (currentBucket !== null) yield* flush();
      currentBucket = at;
    }

    // No explicit selection: the column set comes from the first point seen.
    // Writing the header is deferred so both branches emit it exactly once.
    if (columns === null) columns = [point.variable];

    if (!wroteHeader) {
      yield csvRow(['ts', ...columns]);
      wroteHeader = true;
    }

    const row = bucket.get(point.ts) ?? new Map<string, unknown>();
    row.set(point.variable, point.value);
    bucket.set(point.ts, row);
  }

  yield* flush();
}

export function exportCsv(
  env: Env,
  projectId: string,
  opts: CsvExportOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const rows = opts.format === 'wide'
    ? wideRows(env, projectId, opts)
    : longRows(env, projectId, opts);

  return new ReadableStream({
    async pull(controller) {
      const next = await rows.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    cancel() {
      void rows.return(undefined);
    },
  });
}

// The CSV export contract: what a consumer opening the file observes. Covers the
// two things that would silently corrupt a download — a missing `wide` header
// (found while building this, fixed in wideRows) and a spreadsheet executing a
// device-chosen string as a formula.
// Run with `bun test worker/test/export-csv.test.ts`.

import { test, expect } from 'bun:test';
import { exportCsv, type CsvExportOptions } from '../src/domains/projects/export-csv';
import type { Env } from '../src/env';

const HOUR = 3600;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - HOUR;

function bucketOf(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}`;
}

// R2 holding one hour of points, plus one point in the following hour to prove
// the range clamp.
function envWith(points: Array<Record<string, unknown>>): Env {
  const objects = new Map<string, string>([
    [`telemetry/prj_a/${bucketOf(T0)}/r-1.ndjson`, points.map((p) => JSON.stringify(p)).join('\n') + '\n'],
    [`telemetry/prj_a/${bucketOf(T0 + HOUR)}/r-2.ndjson`, JSON.stringify({ ts: T0 + HOUR + 5, device: 'dev_a', variable: 'temp', value: 99 }) + '\n'],
  ]);

  return {
    R2: {
      list: async ({ prefix }: { prefix: string }) => ({
        objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      }),
      get: async (key: string) => {
        const body = objects.get(key);
        return body === undefined ? null : { text: async () => body };
      },
    },
  } as unknown as Env;
}

function options(over: Partial<CsvExportOptions> = {}): CsvExportOptions {
  return {
    from: T0,
    to: T0 + HOUR - 1,
    variables: null,
    deviceId: null,
    deviceIsDefault: false,
    format: 'long',
    ...over,
  };
}

const text = (points: Array<Record<string, unknown>>, over: Partial<CsvExportOptions> = {}) =>
  new Response(exportCsv(envWith(points), 'prj_a', options(over))).text();

const rows = (points: Array<Record<string, unknown>>, over: Partial<CsvExportOptions> = {}) =>
  text(points, over).then((t) => t.trimEnd().split('\n'));

const temp = (ts: number, value: unknown) => ({ ts, device: 'dev_a', variable: 'temp', value });

test('long: a header naming the columns, then one row per point', async () => {
  const out = await rows([temp(T0 + 10, 23.4), temp(T0 + 20, 24.1)]);
  expect(out[0]).toBe('ts,device,variable,value');
  expect(out).toHaveLength(3);
});

test('long: points outside the requested range are excluded', async () => {
  const out = await rows([temp(T0 + 10, 23.4)]);
  expect(out.some((l) => Number(l.split(',')[0]) > T0 + HOUR - 1)).toBe(false);
});

test('wide: the header names the selection even when no row carries it yet', async () => {
  // Regression: the header was only emitted from the inferred-columns branch, so
  // an explicit selection produced a headerless file.
  const out = await rows([temp(T0 + 10, 23.4)], { format: 'wide', variables: ['temp', 'humidity'] });
  expect(out[0]).toBe('ts,temp,humidity');
});

test('wide: one row per timestamp, in ascending time order', async () => {
  const out = await rows([temp(T0 + 20, 24.1), temp(T0 + 10, 23.4)], {
    format: 'wide',
    variables: ['temp'],
  });
  expect(out.slice(1).map((l) => Number(l.split(',')[0]))).toEqual([T0 + 10, T0 + 20]);
});

test('wide: a variable missing at a timestamp renders as an empty field', async () => {
  const out = await rows([temp(T0 + 10, 23.4), { ts: T0 + 10, device: 'dev_a', variable: 'humidity', value: 61 }], {
    format: 'wide',
    variables: ['humidity', 'temp'],
  });
  expect(out[1]).toBe(`${T0 + 10},61,23.4`);
});

test('an empty range still emits the long header', async () => {
  expect(await text([temp(T0 + 10, 23.4)], { from: T0 - 10 * HOUR, to: T0 - 9 * HOUR }))
    .toBe('ts,device,variable,value\n');
});

test('a device-chosen string cannot become a spreadsheet formula', async () => {
  const out = await rows([{ ts: T0 + 10, device: 'dev_a', variable: 'inj', value: '=1+1' }]);
  expect(out[1]).toBe(`${T0 + 10},dev_a,inj,'=1+1`);
});

test('a number is never treated as a formula', async () => {
  const out = await rows([{ ts: T0 + 10, device: 'dev_a', variable: 'n', value: -5 }]);
  expect(out[1]).toBe(`${T0 + 10},dev_a,n,-5`);
});

test('a value with a comma or quote is quoted and its quotes doubled', async () => {
  const out = await rows([{ ts: T0 + 10, device: 'dev_a', variable: 'q', value: 'a,b"c' }]);
  expect(out[1]).toBe(`${T0 + 10},dev_a,q,"a,b""c"`);
});

test('an object value is JSON-encoded into one quoted field', async () => {
  const out = await rows([{ ts: T0 + 10, device: 'dev_a', variable: 'o', value: { nested: [1, 2] } }]);
  expect(out[1]).toBe(`${T0 + 10},dev_a,o,"{""nested"":[1,2]}"`);
});

test('the default device matches rows that carry a null device', async () => {
  const points = [temp(T0 + 10, 23.4), { ts: T0 + 20, device: null, variable: 'temp', value: 24.1 }];
  const asDefault = await rows(points, { deviceId: 'dev_default', deviceIsDefault: true });
  // Only the null-device row belongs to the default device; the named one is out.
  expect(asDefault.slice(1).map((l) => l.split(',')[1])).toEqual(['']);

  const asNamed = await rows(points, { deviceId: 'dev_a' });
  expect(asNamed.some((l) => l.startsWith(`${T0 + 20},,`))).toBe(false);
});

test('the variable filter keeps only the requested keys', async () => {
  const out = await rows([temp(T0 + 10, 23.4), { ts: T0 + 20, device: 'dev_a', variable: 'other', value: 1 }], {
    variables: ['temp'],
  });
  expect(out.slice(1).every((l) => l.includes(',temp,'))).toBe(true);
  expect(out).toHaveLength(2);
});

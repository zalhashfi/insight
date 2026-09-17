// The external-poll pure contract: envelope resolution, field inference,
// value coercion, cursor ordering, and aligned fire times.
// Run with `bun test worker/test/external-poll.test.ts`.

import { test, expect } from 'bun:test';
import {
  resolveEnvelope,
  inferFields,
  isInvalid,
  coerceValue,
  compareCursor,
  nextPollFireAt,
  suffixVariable,
  SENTINEL_DEFAULT,
} from '../src/domains/external-sources/poll';

test('resolveEnvelope: root array passes through', () => {
  const body = [{ id: 1, co2: '625' }];
  const r = resolveEnvelope(body, '');
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.records.length).toBe(1);
});

test('resolveEnvelope: dotted path resolves, missing path errors', () => {
  const body = { data: { items: [{ id: 1 }] } };
  const ok = resolveEnvelope(body, 'data.items');
  expect(ok.ok).toBe(true);
  const miss = resolveEnvelope(body, 'data.nope');
  expect(miss.ok).toBe(false);
  if (!miss.ok) expect(miss.error).toBe('envelope_not_found');
});

test('resolveEnvelope: non-array and empty array error', () => {
  expect(resolveEnvelope({ a: 1 }, '').ok).toBe(false);
  const empty = resolveEnvelope([], '');
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error).toBe('empty_array');
  const noObj = resolveEnvelope([1, 'x', null], '');
  expect(noObj.ok).toBe(false);
  if (!noObj.ok) expect(noObj.error).toBe('no_records');
});

test('inferFields: union keys, nested objects skipped', () => {
  const fields = inferFields([
    { id: 1, co2: '625', meta: { a: 1 } },
    { id: 2, pm25: '33', meta: { b: 2 } },
  ]);
  const keys = fields.map((f) => f.key).sort();
  expect(keys).toEqual(['co2', 'id', 'pm25']);
  const co2 = fields.find((f) => f.key === 'co2')!;
  expect(co2.nullable).toBe(false);
  expect(co2.sample).toBe('625');
});

test('inferFields: marks nullable when null seen', () => {
  const fields = inferFields([{ hum: null }, { hum: '80' }]);
  expect(fields.find((f) => f.key === 'hum')!.nullable).toBe(true);
});

test('isInvalid: null always invalid, sentinels loose-match', () => {
  expect(isInvalid('temperature', null, SENTINEL_DEFAULT)).toBe(true);
  expect(isInvalid('temperature', '-1.00', SENTINEL_DEFAULT)).toBe(true);
  expect(isInvalid('temperature', -1, SENTINEL_DEFAULT)).toBe(true);
  expect(isInvalid('temperature', '23.5', SENTINEL_DEFAULT)).toBe(false);
  expect(isInvalid('co2', '625', SENTINEL_DEFAULT)).toBe(false);
  expect(isInvalid('co2', null, SENTINEL_DEFAULT)).toBe(true);
});

test('coerceValue: numeric strings become numbers, null stays null', () => {
  expect(coerceValue('625')).toEqual({ skip: false, value: 625 });
  expect(coerceValue(null)).toEqual({ skip: false, value: null });
  expect(coerceValue(33)).toEqual({ skip: false, value: 33 });
  expect(coerceValue(true)).toEqual({ skip: false, value: true });
  expect(coerceValue(undefined)).toEqual({ skip: true });
  expect(coerceValue({ a: 1 })).toEqual({ skip: true });
  expect(coerceValue(NaN)).toEqual({ skip: true });
});

test('coerceValue: overlong strings truncate to 512', () => {
  const r = coerceValue('x'.repeat(600));
  expect(r.skip).toBe(false);
  if (!r.skip) expect((r.value as string).length).toBe(512);
});

test('compareCursor: numeric vs string ordering', () => {
  expect(compareCursor(595837, 595838)).toBe(-1);
  expect(compareCursor(595838, 595837)).toBe(1);
  expect(compareCursor(595838, 595838)).toBe(0);
  expect(compareCursor('a', 'b')).toBe(-1);
  expect(compareCursor('2026-09-17 00:34:00', '2026-09-17 00:36:00')).toBe(-1);
});

test('nextPollFireAt: aligns to wall-clock multiples plus 30s', () => {
  const at = (min: number, sec: number) => Date.UTC(2026, 8, 17, 0, min, sec);
  // interval 5 from xx:04:10 -> xx:05:30
  expect(nextPollFireAt(5, at(4, 10))).toBe(Date.UTC(2026, 8, 17, 0, 5, 30));
  // interval 5 from xx:05:31 -> xx:10:30
  expect(nextPollFireAt(5, at(5, 31))).toBe(Date.UTC(2026, 8, 17, 0, 10, 30));
  // interval 2 from xx:01:00 -> xx:02:30
  expect(nextPollFireAt(2, at(1, 0))).toBe(Date.UTC(2026, 8, 17, 0, 2, 30));
});

test('suffixVariable: mirrors telemetry auto-suffix rule', () => {
  expect(suffixVariable('co2', 'TULT')).toBe('co2_TULT');
  expect(suffixVariable('co2_TULT', 'TULT')).toBe('co2_TULT');
  expect(suffixVariable('CO2_tult', 'TULT')).toBe('CO2_tult');
});

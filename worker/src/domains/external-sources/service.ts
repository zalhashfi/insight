// External sources: polled JSON APIs mapped into telemetry (1 URL = 1 device).
// CRUD mirrors domains/integrations/service.ts: any project member manages
// sources, audit entries on mutation, sealed headers at rest.

import { z } from 'zod';
import type { Env } from '../../env';
import { newId } from '../../platform/lib/ids';
import { recordAudit } from '../../platform/lib/audit';
import { safeParse, buildUpdate } from '../../platform/lib/sql';
import { sealSourceHeaders, openSourceHeaders } from '../../platform/lib/external-source-secrets';
import { type Actor, ServiceError } from '../../platform/lib/service';
import { assertProjectAccess } from '../projects/service';
import { normaliseDeviceKey, resolveDevice, touchDevice } from '../devices/service';
import { upsertVariables } from '../telemetry/variables';
import { validKey, validValue } from '../telemetry/validate';
import { projectStub } from '../../platform/durable-objects/stubs';
import {
  resolveEnvelope,
  inferFields,
  isInvalid,
  coerceValue,
  compareCursor,
  SENTINEL_DEFAULT,
  suffixVariable,
  type InferredField,
} from './poll';

export const POLL_INTERVALS = [2, 5, 15, 30, 60] as const;
export type PollIntervalMinutes = (typeof POLL_INTERVALS)[number];
export const MAX_SOURCES_PER_PROJECT = 20;
const MAX_BODY_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const intervalSchema = z.number().refine((v): v is PollIntervalMinutes =>
  (POLL_INTERVALS as readonly number[]).includes(v), { message: 'invalid interval' });

const sentinelEntry = z.union([z.number(), z.string()]);
const createSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().min(1).max(2000),
  device_key: z.string().min(1).max(64),
  interval_minutes: intervalSchema.optional(),
  envelope_path: z.string().max(500).optional(),
  fields: z.array(z.string().min(1).max(64)).min(1).max(50),
  cursor_field: z.string().min(1).max(64).optional(),
  sentinel_map: z.record(z.string(), z.array(sentinelEntry).max(10)).optional(),
  headers: z.record(z.string().max(128), z.string().max(1024)).optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().min(1).max(2000).optional(),
  device_key: z.string().min(1).max(64).optional(),
  interval_minutes: intervalSchema.optional(),
  envelope_path: z.string().max(500).optional(),
  fields: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  cursor_field: z.string().min(1).max(64).optional(),
  sentinel_map: z.record(z.string(), z.array(sentinelEntry).max(10)).optional(),
  headers: z.record(z.string().max(128), z.string().max(1024)).optional(),
  enabled: z.boolean().optional(),
});

export type ExternalSourceShape = {
  id: string;
  project_id: string;
  name: string;
  url: string;
  device_key: string;
  interval_minutes: PollIntervalMinutes;
  envelope_path: string;
  fields: string[];
  cursor_field: string;
  sentinel_map: Record<string, Array<number | string>>;
  headers_present: boolean;
  enabled: boolean;
  last_cursor: string | null;
  last_run_at: number | null;
  last_run_status: 'ok' | 'error' | 'skipped' | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type SourceRow = {
  id: string;
  project_id: string;
  name: string;
  url: string;
  device_key: string;
  interval_minutes: number;
  envelope_path: string;
  fields: string;
  cursor_field: string;
  sentinel_map: string;
  headers: string;
  enabled: number;
  last_cursor: string | null;
  last_run_at: number | null;
  last_run_status: 'ok' | 'error' | 'skipped' | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

const ENVELOPE_RE = /^[A-Za-z0-9_.-]*$/;

function checkUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ServiceError('bad_request', 'invalid url', 'invalid_url');
  }
  // Trust model mirrors http_service: any URL a project member can reach.
  // No SSRF guard — documented, not enforced.
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ServiceError('bad_request', 'url must be http(s)', 'invalid_url');
  }
}

function parseJsonColumn<T>(raw: string, fallback: T): T {
  const v = safeParse(raw);
  return (v === null || v === undefined ? fallback : (v as T)) ?? fallback;
}

async function shape(env: Env, r: SourceRow): Promise<ExternalSourceShape> {
  const headersRaw = await openSourceHeaders(env, r.headers);
  const headersObj = parseJsonColumn<Record<string, string>>(headersRaw, {});
  return {
    id: r.id,
    project_id: r.project_id,
    name: r.name,
    url: r.url,
    device_key: r.device_key,
    interval_minutes: (POLL_INTERVALS as readonly number[]).includes(r.interval_minutes)
      ? (r.interval_minutes as PollIntervalMinutes)
      : 5,
    envelope_path: r.envelope_path,
    fields: parseJsonColumn<string[]>(r.fields, []),
    cursor_field: r.cursor_field,
    sentinel_map: parseJsonColumn<Record<string, Array<number | string>>>(r.sentinel_map, {}),
    headers_present: Object.keys(headersObj).length > 0,
    enabled: r.enabled === 1,
    last_cursor: r.last_cursor,
    last_run_at: r.last_run_at,
    last_run_status: r.last_run_status,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listSources(env: Env, projectId: string): Promise<ExternalSourceShape[]> {
  const rows = await env.DB
    .prepare(
      `SELECT id, project_id, name, url, device_key, interval_minutes, envelope_path,
              fields, cursor_field, sentinel_map, headers, enabled,
              last_cursor, last_run_at, last_run_status, last_error,
              created_at, updated_at, archived_at
         FROM external_sources WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at DESC`
    )
    .bind(projectId)
    .all<SourceRow>();
  const out: ExternalSourceShape[] = [];
  for (const r of rows.results) out.push(await shape(env, r));
  return out;
}

type CreateInput = z.infer<typeof createSchema>;

export async function createSource(
  env: Env,
  actor: Actor,
  projectId: string,
  input: CreateInput
): Promise<ExternalSourceShape> {
  await assertProjectAccess(env, actor, projectId);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError('bad_request', 'invalid input', 'invalid_input');
  const v = parsed.data;

  checkUrl(v.url);
  const deviceKey = normaliseDeviceKey(v.device_key);
  if (!deviceKey) throw new ServiceError('bad_request', 'invalid device_key', 'invalid_device_key');
  if (v.envelope_path && !ENVELOPE_RE.test(v.envelope_path)) {
    throw new ServiceError('bad_request', 'invalid envelope_path', 'invalid_envelope_path');
  }
  for (const f of v.fields) {
    if (!validKey(f)) throw new ServiceError('bad_request', `invalid field: ${f}`, 'invalid_field');
  }
  if (v.cursor_field && !validKey(v.cursor_field)) {
    throw new ServiceError('bad_request', 'invalid cursor_field', 'invalid_cursor_field');
  }

  const countRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM external_sources WHERE project_id = ? AND archived_at IS NULL`)
    .bind(projectId)
    .first<{ n: number }>();
  if ((countRow?.n ?? 0) >= MAX_SOURCES_PER_PROJECT) {
    throw new ServiceError('bad_request', 'too many external sources', 'too_many_sources');
  }

  const id = newId('external');
  const now = Math.floor(Date.now() / 1000);
  const interval = v.interval_minutes ?? 5;
  const sentinel = v.sentinel_map ?? SENTINEL_DEFAULT;
  const headers = v.headers ?? {};
  await env.DB
    .prepare(
      `INSERT INTO external_sources
         (id, project_id, name, url, device_key, interval_minutes, envelope_path,
          fields, cursor_field, sentinel_map, headers, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id, projectId, v.name.trim(), v.url.trim(), deviceKey, interval,
      v.envelope_path ?? '', JSON.stringify(v.fields), v.cursor_field ?? 'id',
      JSON.stringify(sentinel), await sealSourceHeaders(env, headers),
      v.enabled === false ? 0 : 1, actor.userId, now, now
    )
    .run();

  await recordAudit(env, {
    projectId,
    userId: actor.userId,
    action: 'external_source.create',
    targetType: 'external_source',
    targetId: id,
    metadata: { name: v.name, url: v.url, source: actor.source },
  });
  return {
    id, project_id: projectId, name: v.name.trim(), url: v.url.trim(), device_key: deviceKey,
    interval_minutes: interval, envelope_path: v.envelope_path ?? '', fields: v.fields,
    cursor_field: v.cursor_field ?? 'id', sentinel_map: sentinel,
    headers_present: Object.keys(headers).length > 0, enabled: v.enabled !== false,
    last_cursor: null, last_run_at: null, last_run_status: null, last_error: null,
    created_at: now, updated_at: now,
  };
}

type UpdateInput = z.infer<typeof updateSchema>;

export async function updateSource(
  env: Env,
  actor: Actor,
  projectId: string,
  id: string,
  input: UpdateInput
): Promise<ExternalSourceShape> {
  await assertProjectAccess(env, actor, projectId);
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError('bad_request', 'invalid input', 'invalid_input');
  const v = parsed.data;

  const existing = await env.DB
    .prepare(`SELECT * FROM external_sources WHERE id = ? AND project_id = ? AND archived_at IS NULL`)
    .bind(id, projectId)
    .first<SourceRow>();
  if (!existing) throw new ServiceError('not_found', 'external source not found');

  const patch: Record<string, unknown> = {};
  if (v.name !== undefined) {
    const name = v.name.trim();
    if (!name) throw new ServiceError('bad_request', 'name is required', 'missing_name');
    patch.name = name;
  }
  if (v.url !== undefined) {
    checkUrl(v.url);
    patch.url = v.url.trim();
  }
  if (v.device_key !== undefined) {
    const dk = normaliseDeviceKey(v.device_key);
    if (!dk) throw new ServiceError('bad_request', 'invalid device_key', 'invalid_device_key');
    patch.device_key = dk;
  }
  if (v.interval_minutes !== undefined) patch.interval_minutes = v.interval_minutes;
  if (v.envelope_path !== undefined) {
    if (v.envelope_path && !ENVELOPE_RE.test(v.envelope_path)) {
      throw new ServiceError('bad_request', 'invalid envelope_path', 'invalid_envelope_path');
    }
    patch.envelope_path = v.envelope_path;
  }
  if (v.fields !== undefined) {
    for (const f of v.fields) {
      if (!validKey(f)) throw new ServiceError('bad_request', `invalid field: ${f}`, 'invalid_field');
    }
    patch.fields = JSON.stringify(v.fields);
  }
  if (v.cursor_field !== undefined) {
    if (!validKey(v.cursor_field)) {
      throw new ServiceError('bad_request', 'invalid cursor_field', 'invalid_cursor_field');
    }
    patch.cursor_field = v.cursor_field;
  }
  if (v.sentinel_map !== undefined) patch.sentinel_map = JSON.stringify(v.sentinel_map);
  if (v.headers !== undefined) patch.headers = await sealSourceHeaders(env, v.headers);
  if (v.enabled !== undefined) patch.enabled = v.enabled ? 1 : 0;

  const u = buildUpdate(patch);
  if (!u) throw new ServiceError('bad_request', 'no fields to update', 'no_fields');

  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(`UPDATE external_sources SET ${u.clause}, updated_at = ? WHERE id = ? AND project_id = ?`)
    .bind(...u.values, now, id, projectId)
    .run();

  const enabling = v.enabled === true;
  const disabling = v.enabled === false;
  await recordAudit(env, {
    projectId,
    userId: actor.userId,
    action: enabling ? 'external_source.enable' : disabling ? 'external_source.disable' : 'external_source.update',
    targetType: 'external_source',
    targetId: id,
    metadata: { source: actor.source },
  });
  const row = await env.DB
    .prepare(`SELECT * FROM external_sources WHERE id = ? AND project_id = ?`)
    .bind(id, projectId)
    .first<SourceRow>();
  return shape(env, row!);
}

export async function deleteSource(env: Env, actor: Actor, projectId: string, id: string): Promise<void> {
  await assertProjectAccess(env, actor, projectId);
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB
    .prepare(`UPDATE external_sources SET archived_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND archived_at IS NULL`)
    .bind(now, now, id, projectId)
    .run();
  if (res.meta.changes === 0) throw new ServiceError('not_found', 'external source not found');
  await recordAudit(env, {
    projectId,
    userId: actor.userId,
    action: 'external_source.delete',
    targetType: 'external_source',
    targetId: id,
    metadata: { source: actor.source },
  });
}

// ── fetch + preview ──────────────────────────────────────────────────────────

export type FetchOutcome =
  | { ok: true; body: unknown }
  | { ok: false; error: string; detail?: string };

async function fetchJson(url: string, headers: Record<string, string>): Promise<FetchOutcome> {
  const merged: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'insight-external-poll', 'Cache-Control': 'no-store', ...headers };
  let res: Response;
  try {
    res = await fetch(url, { headers: merged, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cf: { cacheTtl: 0 } });
  } catch (e) {
    return { ok: false, error: 'fetch_failed', detail: String(e).slice(0, 500) };
  }
  const len = Number(res.headers.get('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return { ok: false, error: 'response_too_large' };
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: 'fetch_failed', detail: String(e).slice(0, 500) };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, error: 'response_too_large' };
  if (!res.ok) return { ok: false, error: 'bad_status', detail: `HTTP ${res.status}` };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

export type PreviewResult =
  | { ok: true; total: number; records: Record<string, unknown>[]; fields: Array<InferredField & { invalid: boolean }>; suggested_cursor: string }
  | { ok: false; error: string; detail?: string };

export async function previewSource(
  _env: Env,
  _projectId: string,
  input: { url: string; envelope_path?: string; headers?: Record<string, string>; sentinel_map?: Record<string, Array<number | string>> }
): Promise<PreviewResult> {
  checkUrl(input.url);
  const fetched = await fetchJson(input.url, input.headers ?? {});
  if (!fetched.ok) return fetched;
  const resolved = resolveEnvelope(fetched.body, input.envelope_path ?? '');
  if (!resolved.ok) return resolved;
  const total = resolved.records.length;
  const allKeys = new Set<string>();
  for (const r of resolved.records) for (const k of Object.keys(r)) allKeys.add(k);
  const cursorGuess = allKeys.has('id') ? 'id' : allKeys.has('created_at') ? 'created_at' : Object.keys(resolved.records[0] ?? {})[0] ?? 'id';
  const ordered = [...resolved.records].sort((a, b) => compareCursor(a[cursorGuess], b[cursorGuess]));
  const records = ordered.slice(-5);
  const fields = inferFields(records);
  const sentinels = input.sentinel_map ?? SENTINEL_DEFAULT;
  const suggested = cursorGuess;
  return {
    ok: true,
    total,
    records,
    fields: fields.map((f) => ({ ...f, invalid: isInvalid(f.key, f.sample, sentinels) })),
    suggested_cursor: suggested,
  };
}

// ── single poll run ──────────────────────────────────────────────────────────

export type PollRunResult =
  | { ok: true; status: 'ok'; detail: 'ingested' | 'no_new_data'; points: number }
  | { ok: false; error: string; detail?: string };

export async function runSourcePoll(env: Env, sourceId: string, dryRun = false): Promise<PollRunResult> {
  const row = await env.DB
    .prepare(`SELECT * FROM external_sources WHERE id = ? AND archived_at IS NULL`)
    .bind(sourceId)
    .first<SourceRow>();
  if (!row || row.enabled !== 1) return { ok: true, status: 'ok', detail: 'no_new_data', points: 0 };

  const now = Math.floor(Date.now() / 1000);
  const fail = async (error: string, detail?: string): Promise<PollRunResult> => {
    if (!dryRun) {
      await env.DB
        .prepare(`UPDATE external_sources SET last_run_at = ?, last_run_status = 'error', last_error = ? WHERE id = ?`)
        .bind(now, (detail ? `${error}: ${detail}` : error).slice(0, 500), row.id)
        .run();
    }
    return { ok: false, error, detail };
  };

  const headersObj = parseJsonColumn<Record<string, string>>(await openSourceHeaders(env, row.headers), {});
  const fetched = await fetchJson(row.url, headersObj);
  if (!fetched.ok) return fail(fetched.error, fetched.detail);
  const resolved = resolveEnvelope(fetched.body, row.envelope_path);
  if (!resolved.ok) return fail(resolved.error);

  const cursorField = row.cursor_field;
  const ordered = [...resolved.records].sort((a, b) => compareCursor(a[cursorField], b[cursorField]));
  const newest = ordered[ordered.length - 1]!;
  if (!(cursorField in newest) || newest[cursorField] === undefined || newest[cursorField] === null) {
    return fail('cursor_missing');
  }
  const fresh = row.last_cursor == null
    ? [newest]
    : ordered.filter((r) => compareCursor(r[cursorField], row.last_cursor) > 0);
  if (fresh.length === 0) {
    if (!dryRun) {
      await env.DB
        .prepare(`UPDATE external_sources SET last_run_at = ?, last_run_status = 'ok', last_error = NULL WHERE id = ?`)
        .bind(now, row.id)
        .run();
    }
    return { ok: true, status: 'ok', detail: 'no_new_data', points: 0 };
  }

  const record = fresh[fresh.length - 1]!;
  const wanted = parseJsonColumn<string[]>(row.fields, []);
  const points: Array<{ variable: string; value: number | string | boolean | null }> = [];
  for (const key of wanted) {
    if (!(key in record)) continue;
    const coerced = coerceValue(record[key]);
    if (coerced.skip) continue;
    // Sentinel values are still ingested — they mark dead sensors visibly.
    const variable = suffixVariable(key, row.device_key);
    if (!validKey(variable) || !validValue(coerced.value)) continue;
    points.push({ variable, value: coerced.value });
  }
  if (points.length === 0) return fail('no_mappable_points');

  if (!dryRun) {
    // Mirrors telemetry.ts:47 — auto-creates the device, then direct DO ingest.
    const device = await resolveDevice(env, row.project_id, normaliseDeviceKey(row.device_key), now);
    const stub = projectStub(env, row.project_id);
    await stub.ingest(row.project_id, points, device?.storageId ?? '');
    if (device) {
      await Promise.all([
        upsertVariables(env, row.project_id, device.id, points.map((p) => p.variable), now),
        touchDevice(env, device.id),
      ]);
    }
    await env.DB
      .prepare(`UPDATE external_sources SET last_cursor = ?, last_run_at = ?, last_run_status = 'ok', last_error = NULL WHERE id = ?`)
      .bind(String(newest[cursorField]), now, row.id)
      .run();
  }
  return { ok: true, status: 'ok', detail: 'ingested', points: points.length };
}

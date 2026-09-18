import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../env';
import { requireSession } from '../../platform/middleware/require-session';
import { resolveProject, type ProjectContextVars } from '../../platform/middleware/resolve-project';
import { recordAudit } from '../../platform/lib/audit';
import { actorFromSession, serviceErrorResponse } from '../../platform/lib/service';
import { ensureScheduler, rescheduleScheduler } from '../../platform/durable-objects/scheduler-do';
import { parseBody } from '../../platform/lib/validate';
import {
  listSources,
  createSource,
  updateSource,
  deleteSource,
  previewSource,
  runSourcePoll,
  POLL_INTERVALS,
  type PollIntervalMinutes,
} from './service';
import { SENTINEL_DEFAULT } from './poll';
const sentinelEntry = z.union([z.number(), z.string()]);
const intervalField = z.number().refine((v): v is PollIntervalMinutes =>
  (POLL_INTERVALS as readonly number[]).includes(v), { message: 'invalid interval' });
const baseSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().min(1).max(2000),
  device_key: z.string().min(1).max(64),
  interval_minutes: intervalField,
  envelope_path: z.string().max(500),
  fields: z.array(z.string().min(1).max(64)).min(1).max(50),
  cursor_field: z.string().min(1).max(64),
  sentinel_map: z.record(z.string(), z.array(sentinelEntry).max(10)),
  headers: z.record(z.string().max(128), z.string().max(1024)),
  enabled: z.boolean(),
});
const createSchema = baseSchema.partial().required({ name: true, url: true, device_key: true, fields: true });
const updateSchema = baseSchema.partial();

const externalSources = new Hono<{ Bindings: Env; Variables: ProjectContextVars }>();

externalSources.use('*', requireSession);
externalSources.use('*', resolveProject);

// GET /v1/admin/projects/:proj/external-sources
externalSources.get('/', async (c) => {
  try {
    const project = c.get('project');
    actorFromSession(c.get('user'));
    const list = await listSources(c.env, project.id);
    if (list.some((s) => s.enabled)) {
      c.executionCtx.waitUntil(ensureScheduler(c.env));
    }
    return c.json({ external_sources: list });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// POST /v1/admin/projects/:proj/external-sources
externalSources.post('/', async (c) => {
  try {
    const project = c.get('project');
    const actor = actorFromSession(c.get('user'));
    const body = await parseBody(c, createSchema);
    const src = await createSource(c.env, actor, project.id, body);
    c.executionCtx.waitUntil(rescheduleScheduler(c.env));
    return c.json({ external_source: src }, 201);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// POST /v1/admin/projects/:proj/external-sources/preview (no write)
externalSources.post('/preview', async (c) => {
  try {
    const project = c.get('project');
    actorFromSession(c.get('user'));
    const body = await parseBody(c, baseSchema.partial());
    if (!body.url) return c.json({ error: 'invalid_input', reason: 'url is required' }, 400);
    const out = await previewSource(c.env, project.id, {
      url: body.url,
      envelope_path: body.envelope_path ?? '',
      headers: body.headers ?? {},
      sentinel_map: body.sentinel_map ?? SENTINEL_DEFAULT,
    });
    if (!out.ok) return c.json({ error: out.error, detail: out.detail }, 502);
    return c.json({ preview: out });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// POST /v1/admin/projects/:proj/external-sources/:id/test (fetch+map, never ingests)
externalSources.post('/:id/test', async (c) => {
  try {
    const project = c.get('project');
    actorFromSession(c.get('user'));
    const id = c.req.param('id');
    const list = await listSources(c.env, project.id);
    const src = list.find((s) => s.id === id);
    if (!src) return c.json({ error: 'not_found' }, 404);
    const res = await runSourcePoll(c.env, id, true);
    if (!res.ok) return c.json({ error: res.error, detail: res.detail }, 502);
    return c.json({ result: res });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// POST /v1/admin/projects/:proj/external-sources/:id/run (immediate write poll)
externalSources.post('/:id/run', async (c) => {
  try {
    const project = c.get('project');
    const actor = actorFromSession(c.get('user'));
    const id = c.req.param('id');
    const res = await runSourcePoll(c.env, id, false);
    await recordAudit(c.env, {
      projectId: project.id,
      userId: actor.userId,
      action: 'external_source.run',
      targetType: 'external_source',
      targetId: id,
      metadata: { source: actor.source },
    }).catch(() => {});
    if (!res.ok) return c.json({ error: res.error, detail: res.detail }, 502);
    return c.json({ result: res });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// PATCH /v1/admin/projects/:proj/external-sources/:id
externalSources.patch('/:id', async (c) => {
  try {
    const project = c.get('project');
    const actor = actorFromSession(c.get('user'));
    const body = await parseBody(c, updateSchema);
    const src = await updateSource(c.env, actor, project.id, c.req.param('id'), body as Parameters<typeof updateSource>[4]);
    c.executionCtx.waitUntil(rescheduleScheduler(c.env));
    return c.json({ external_source: src });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// DELETE /v1/admin/projects/:proj/external-sources/:id (soft delete)
externalSources.delete('/:id', async (c) => {
  try {
    const project = c.get('project');
    const actor = actorFromSession(c.get('user'));
    await deleteSource(c.env, actor, project.id, c.req.param('id'));
    c.executionCtx.waitUntil(rescheduleScheduler(c.env));
    return c.body(null, 204);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

export default externalSources;
export { POLL_INTERVALS };

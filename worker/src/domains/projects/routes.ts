import { Hono, type Context } from 'hono';
import type { Env } from '../../env';
import { requireSession, type UserContextVars } from '../../platform/middleware/require-session';
import { recordAudit } from '../../platform/lib/audit';
import { userCanAccessProject } from '../../platform/lib/roles';
import { projectStub } from '../../platform/durable-objects/stubs';
import { exportProject } from './export';
import { exportCsv, type CsvExportOptions } from './export-csv';
import { createProject, updateProject, listAccessibleProjects } from './service';
import { listDevices } from '../devices/service';
import { actorFromSession, ServiceError, serviceErrorResponse } from '../../platform/lib/service';

const projects = new Hono<{ Bindings: Env; Variables: UserContextVars }>();

projects.use('*', requireSession);

projects.get('/', async (c) => {
  return c.json({ projects: await listAccessibleProjects(c.env, actorFromSession(c.get('user'))) });
});

projects.post('/', async (c) => {
  const body = await c.req.json<{ name?: string }>();
  try {
    const p = await createProject(c.env, actorFromSession(c.get('user')), { name: body.name ?? '' });
    return c.json(p, 201);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// PATCH /v1/admin/projects/:proj  body: { name?, description? }
projects.patch('/:proj', async (c) => {
  const projId = c.req.param('proj');
  const body = await c.req.json<{ name?: string; description?: string | null }>();
  try {
    const row = await updateProject(c.env, actorFromSession(c.get('user')), projId, {
      name: body.name,
      ...('description' in body ? { description: body.description ?? null } : {}),
    });
    return c.json(row);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// POST /v1/admin/projects/:proj/flush  -> { flushed, keys, newCursor }
// Forces the Project DO alarm to run now. Handy for smoke tests + ops; nothing
// on the hot path depends on this.
projects.post('/:proj/flush', async (c) => {
  const projId = c.req.param('proj');
  const user = c.get('user');
  if (!(await userCanAccessProject(c.env, user.id, projId))) return c.json({ error: 'forbidden' }, 403);

  const result = await projectStub(c.env, projId).flushNow();
  return c.json(result);
});

// Everything the project owns, as NDJSON. Streamed — a project with a year of
// history is far too big to assemble in memory. Carries no secrets.
projects.get('/:proj/export', async (c) => {
  const projId = c.req.param('proj');
  const user = c.get('user');
  if (!(await userCanAccessProject(c.env, user.id, projId))) return c.json({ error: 'forbidden' }, 403);

  await recordAudit(c.env, {
    projectId: projId,
    userId: user.id,
    action: 'project.export',
    targetType: 'project',
    targetId: projId,
  });

  return new Response(exportProject(c.env, projId), {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${projId}.ndjson"`,
    },
  });
});

// Telemetry history as CSV, for a chosen range, variable set and device. Reads
// R2 directly rather than the DO: the ring buffer only holds an hour.
projects.get('/:proj/export.csv', async (c) => {
  const projId = c.req.param('proj');
  const user = c.get('user');
  if (!(await userCanAccessProject(c.env, user.id, projId))) return c.json({ error: 'forbidden' }, 403);

  try {
    const opts = await parseExportQuery(c, projId);
    await recordAudit(c.env, {
      projectId: projId,
      userId: user.id,
      action: 'project.export',
      targetType: 'project',
      targetId: projId,
      metadata: {
        format: opts.format,
        from: opts.from,
        to: opts.to,
        variables: opts.variables?.length ?? 0,
      },
    });

    const safeId = projId.replace(/[^A-Za-z0-9_-]/g, '');
    return new Response(exportCsv(c.env, projId, opts), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeId}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

// Throws ServiceError so the handler's single catch turns every rejection into a
// clean 4xx. The range ceiling lives in hourBucketsBetween, which the export
// itself calls.
async function parseExportQuery(
  c: Context<{ Bindings: Env; Variables: UserContextVars }>,
  projId: string
): Promise<CsvExportOptions> {
  const now = Math.floor(Date.now() / 1000);
  const to = c.req.query('to') ? Number(c.req.query('to')) : now;
  const from = c.req.query('from') ? Number(c.req.query('from')) : to - 86400;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from >= to) {
    throw new ServiceError('bad_request', 'from must be an integer before to', 'invalid_range');
  }

  const format = c.req.query('format') ?? 'long';
  if (format !== 'long' && format !== 'wide') {
    throw new ServiceError('bad_request', 'format must be long or wide', 'invalid_format');
  }

  const varsRaw = c.req.query('vars');
  const variables = varsRaw
    ? [...new Set(varsRaw.split(',').map((v) => v.trim()).filter(Boolean))].slice(0, 250)
    : null;

  let deviceId: string | null = null;
  let deviceIsDefault = false;
  const deviceRaw = c.req.query('device');
  if (deviceRaw) {
    const device = (await listDevices(c.env, projId)).find((d) => d.id === deviceRaw);
    if (!device) throw new ServiceError('not_found', 'no such device', 'unknown_device');
    deviceId = device.id;
    // The default device's rows carry a null device in R2.
    deviceIsDefault = device.is_default === 1;
  }

  return { from, to, variables, deviceId, deviceIsDefault, format };
}

// Cascade: wipes the project's Project DO (which owns R2 telemetry history, not
// covered by D1 FK cascade), then deletes the D1 row — which cascades dashboards,
// project_variables, project_tokens, user_tokens, project_members via FK.
//
// Dashboard DOs are intentionally NOT destroyed here: that was an RPC per
// dashboard. Each one's only D1-backed row disappears via the cascade, so on any
// reconnect its bootstrap returns dashboard_not_found and closes; an idle DO with
// no alarm and a few bytes of SQLite costs effectively nothing.
projects.delete('/:proj', async (c) => {
  const projId = c.req.param('proj');
  const user = c.get('user');

  if (!(await userCanAccessProject(c.env, user.id, projId))) return c.json({ error: 'forbidden' }, 403);

  // The project's own DO holds all variable state + R2 telemetry history.
  try {
    await projectStub(c.env, projId).destroy();
  } catch (e) {
    console.error('project DO destroy failed', projId, e);
  }

  await c.env.DB.prepare(`DELETE FROM projects WHERE id = ?`).bind(projId).run();

  c.executionCtx.waitUntil(
    recordAudit(c.env, {
      projectId: null,
      userId: user.id,
      action: 'project.delete',
      targetType: 'project',
      targetId: projId,
    })
  );

  return c.body(null, 204);
});

export default projects;

import { Hono } from 'hono';
import type { Env } from '../../env';
import { requireSession } from '../../platform/middleware/require-session';
import { resolveProject, type ProjectContextVars } from '../../platform/middleware/resolve-project';
import { recordAudit } from '../../platform/lib/audit';
import { serviceErrorResponse } from '../../platform/lib/service';
import { listFirmware, deleteFirmware, assignFirmware, uploadFirmware, SAFE_VERSION } from './ota';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const admin = new Hono<{ Bindings: Env; Variables: ProjectContextVars }>();

admin.use('*', requireSession);
admin.use('*', resolveProject);

admin.get('/', async (c) => {
  const project = c.get('project');
  return c.json({ firmware: await listFirmware(c.env, project.id) });
});

admin.delete('/:id', async (c) => {
  const project = c.get('project');
  const id = c.req.param('id');
  try {
    await deleteFirmware(c.env, project.id, id);
    await recordAudit(c.env, {
      projectId: project.id,
      userId: c.get('user').id,
      action: 'firmware.delete',
      targetType: 'firmware',
      targetId: id,
    });
    return c.body(null, 204);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

admin.put('/assign/:deviceId', async (c) => {
  const project = c.get('project');
  const deviceId = c.req.param('deviceId');
  const body = await c.req.json<{ firmware_id?: string | null }>();
  try {
    await assignFirmware(c.env, project.id, deviceId, body.firmware_id ?? null);
    await recordAudit(c.env, {
      projectId: project.id,
      userId: c.get('user').id,
      action: 'firmware.assign',
      targetType: 'device',
      targetId: deviceId,
      metadata: { firmware_id: body.firmware_id ?? null },
    });
    return c.body(null, 204);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

admin.post('/upload', async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner' && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);

  const len = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(len) && len > MAX_IMAGE_BYTES + 4096) {
    return c.json({ error: 'image_too_large', max_bytes: MAX_IMAGE_BYTES }, 413);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'invalid_form_data' }, 400);
  }

  const file = form.get('file') as unknown;
  if (!(file instanceof File)) return c.json({ error: 'missing_file' }, 400);
  if (!file.name.toLowerCase().endsWith('.bin')) return c.json({ error: 'invalid_file_type' }, 400);
  if (file.size > MAX_IMAGE_BYTES) return c.json({ error: 'image_too_large', max_bytes: MAX_IMAGE_BYTES }, 413);

  const version = String(form.get('version') ?? '');
  const rawNotes = form.get('notes');
  const notes = rawNotes ? String(rawNotes).trim() || null : null;
  const rawTarget = form.get('target');
  const target = rawTarget ? String(rawTarget).trim() || null : null;
  const project = c.get('project');

  try {
    const row = await uploadFirmware(c.env, project.id, user.id, {
      version,
      notes,
      target,
      body: await file.arrayBuffer(),
    });
    await recordAudit(c.env, {
      projectId: project.id,
      userId: user.id,
      action: 'firmware.upload',
      targetType: 'firmware',
      targetId: row.id,
      metadata: { version: row.version, size: row.size },
    });
    return c.json({ firmware: row }, 201);
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

admin.patch('/:id', async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner' && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const project = c.get('project');
  const id = c.req.param('id');
  const body = await c.req.json<{ version?: string; notes?: string | null }>().catch(() => ({}) as { version?: string; notes?: string | null });

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.version !== undefined) {
    const v = body.version.trim();
    if (!v || !SAFE_VERSION.test(v)) return c.json({ error: 'invalid_version' }, 400);
    updates.push('version = ?');
    binds.push(v);
  }
  if (body.notes !== undefined) {
    updates.push('notes = ?');
    binds.push(body.notes ? body.notes.trim() || null : null);
  }
  if (updates.length === 0) return c.json({ error: 'no_changes' }, 400);

  binds.push(id, project.id);
  try {
    const res = await c.env.DB
      .prepare(`UPDATE firmware SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`)
      .bind(...binds)
      .run();
    if (res.meta.changes === 0) return c.json({ error: 'not_found' }, 404);

    await recordAudit(c.env, {
      projectId: project.id,
      userId: user.id,
      action: 'firmware.update',
      targetType: 'firmware',
      targetId: id,
      metadata: body,
    });

    const row = await c.env.DB
      .prepare(`SELECT id, version, target, size, sha256, notes, created_at FROM firmware WHERE id = ? AND project_id = ?`)
      .bind(id, project.id)
      .first();
    return c.json({ firmware: row });
  } catch {
    return c.json({ error: 'conflict', reason: 'duplicate_version' }, 409);
  }
});

admin.get('/:id/image', async (c) => {
  const user = c.get('user');
  if (user.role !== 'owner' && user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  const project = c.get('project');
  const id = c.req.param('id');

  const row = await c.env.DB
    .prepare(`SELECT r2_key FROM firmware WHERE id = ? AND project_id = ?`)
    .bind(id, project.id)
    .first<{ r2_key: string }>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const object = await c.env.R2.get(row.r2_key);
  if (!object) return c.json({ error: 'not_found' }, 404);

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
    },
  });
});

export default admin;

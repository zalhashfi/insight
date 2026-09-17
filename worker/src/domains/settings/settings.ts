import { Hono } from 'hono';
import type { Env } from '../../env';
import { requireSession, type UserContextVars } from '../../platform/middleware/require-session';
import { getSetting, setSetting } from '../../platform/lib/deployment-settings';
import { AUDIT_ENABLED_KEY, recordAudit } from '../../platform/lib/audit';
import { MCP_ENABLED_KEY, MCP_WRITE_ENABLED_KEY } from '../../mcp/flags';
import { agentRepo, setAgentRepo } from '../firmware/agent-config';
import { serviceErrorResponse } from '../../platform/lib/service';

// Deployment-wide settings — owner only. The audit-log toggle and the MCP
// server switches.

const settings = new Hono<{ Bindings: Env; Variables: UserContextVars }>();

settings.use('*', requireSession);
settings.use('*', async (c, next) => {
  if (c.get('user').role !== 'owner') return c.json({ error: 'forbidden', reason: 'owner_only' }, 403);
  await next();
});

// GET /v1/admin/settings
settings.get('/', async (c) => {
  const [auditEnabled, mcpEnabled, mcpWriteEnabled, agentRepoName] = await Promise.all([
    getSetting(c.env, AUDIT_ENABLED_KEY),
    getSetting(c.env, MCP_ENABLED_KEY),
    getSetting(c.env, MCP_WRITE_ENABLED_KEY),
    agentRepo(c.env),
  ]);
  return c.json({
    audit_log_enabled: auditEnabled === '1',
    mcp_enabled: mcpEnabled === '1',
    mcp_write_enabled: mcpWriteEnabled === '1',
    agent_repo: agentRepoName,
  });
});

// PUT /v1/admin/settings/audit-log  body: { enabled: boolean }
// Enabling starts recording every action (user + system). Disabling stops
// recording AND wipes all existing entries — "stop and forget".
settings.put('/audit-log', async (c) => {
  const actor = c.get('user');
  const body = await c.req.json<{ enabled?: boolean }>();
  const enabled = body.enabled === true;

  await setSetting(c.env, AUDIT_ENABLED_KEY, enabled ? '1' : null);

  if (enabled) {
    // setSetting busted the KV cache, so recordAudit now sees the flag as on —
    // make the enable itself the first entry of the fresh log.
    await recordAudit(c.env, {
      projectId: null,
      userId: actor.id,
      action: 'audit_log.enable',
      targetType: 'deployment',
    });
  } else {
    await c.env.DB.prepare(`DELETE FROM audit_log`).run();
  }

  return c.json({ audit_log_enabled: enabled });
});

// PUT /v1/admin/settings/mcp  body: { enabled: boolean }
// Master switch for the MCP server. When off, /v1/mcp returns 404.
settings.put('/mcp', async (c) => {
  const actor = c.get('user');
  const body = await c.req.json<{ enabled?: boolean }>();
  const enabled = body.enabled === true;

  await setSetting(c.env, MCP_ENABLED_KEY, enabled ? '1' : null);
  // Disabling the server also disarms write tools, so the next enable starts
  // from the safe (read-only) default rather than silently re-arming control.
  if (!enabled) await setSetting(c.env, MCP_WRITE_ENABLED_KEY, null);

  await recordAudit(c.env, {
    projectId: null,
    userId: actor.id,
    action: enabled ? 'mcp.enable' : 'mcp.disable',
    targetType: 'deployment',
  });

  return c.json({ mcp_enabled: enabled, ...(enabled ? {} : { mcp_write_enabled: false }) });
});

// PUT /v1/admin/settings/mcp-write  body: { enabled: boolean }
// Gates the management/control tools (incl. set_variable). No-op unless MCP is
// already on. Default off so an LLM can never command hardware without an
// explicit second opt-in.
settings.put('/mcp-write', async (c) => {
  const actor = c.get('user');
  const body = await c.req.json<{ enabled?: boolean }>();
  const enabled = body.enabled === true;

  if (enabled && (await getSetting(c.env, MCP_ENABLED_KEY)) !== '1') {
    return c.json({ error: 'bad_request', reason: 'mcp_disabled' }, 400);
  }

  await setSetting(c.env, MCP_WRITE_ENABLED_KEY, enabled ? '1' : null);

  await recordAudit(c.env, {
    projectId: null,
    userId: actor.id,
    action: enabled ? 'mcp.write_enable' : 'mcp.write_disable',
    targetType: 'deployment',
  });

  return c.json({ mcp_write_enabled: enabled });
});

// PUT /v1/admin/settings/agent-repo  body: { repo: string | null }
// Which GitHub repo the Code page offers the build agent from. Null clears the
// setting, falling the deployment back to INSIGHT_AGENT_REPO or the default.
settings.put('/agent-repo', async (c) => {
  const actor = c.get('user');
  const body = await c.req.json<{ repo?: string | null }>();
  try {
    await setAgentRepo(c.env, body.repo ?? null);
    await recordAudit(c.env, {
      projectId: null,
      userId: actor.id,
      action: 'settings.agent_repo',
      targetType: 'deployment',
      metadata: { repo: body.repo ?? null },
    });
    return c.json({ agent_repo: await agentRepo(c.env) });
  } catch (e) {
    return serviceErrorResponse(c, e);
  }
});

export default settings;

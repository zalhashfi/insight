import type {
  D1Database,
  R2Bucket,
  KVNamespace,
  DurableObjectNamespace,
  Fetcher,
  Workflow,
} from '@cloudflare/workers-types';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  // OAuth 2.1 store + helpers, injected by the OAuthProvider wrapper.
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  ASSETS: Fetcher;
  PROJECT_DO: DurableObjectNamespace;
  DASHBOARD_DO: DurableObjectNamespace;
  // Singleton scheduler DO: one alarm set to the next schedule/sunset automation
  // fire time. Re-armed when automations change. Replaces the every-minute cron.
  SCHEDULER_DO: DurableObjectNamespace;
  // MCP server agent. One DO instance per client session (streamable-http:<id>),
  // only instantiated when the owner-gated /v1/mcp endpoint is hit. Bound under
  // the name the `agents` library expects by default (MCP_OBJECT).
  MCP_OBJECT: DurableObjectNamespace;
  PROVISION: Workflow;

  // Upstream repo (owner/repo) the Settings → Version & updates page polls
  // to detect new commits. Plaintext var defaulted in wrangler.toml.
  INSIGHT_UPSTREAM_REPO?: string;

  // When set (any non-empty value), emit the per-request `[auth] …` success/
  // redirect logs. Errors are always logged regardless. Off in production keeps
  // the auth hot path quiet (observability log volume).
  INSIGHT_DEBUG_AUTH?: string;

  // Fallback GitHub repo (owner/name) the Code page downloads the build agent
  // from, used when the owner has not set one in Settings → Agent repository.
  INSIGHT_AGENT_REPO?: string;
}

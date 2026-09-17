// Which GitHub repo the Code page downloads the build agent from. The agent is
// an optional CLI the operator runs on their own machine; the fork ships no
// binary of its own, so the URL has to be configurable rather than hardcoded at
// somebody else's repo. Precedence mirrors the update check in
// domains/settings/version.ts: deployment setting, then plaintext var, then a
// default that names the operator's own fork.

import type { Env } from '../../env';
import { getSetting, setSetting } from '../../platform/lib/deployment-settings';
import { ServiceError } from '../../platform/lib/service';

export const AGENT_REPO_KEY = 'agent_repo';
export const AGENT_REPO_DEFAULT = 'zalhashfi/insight-agent';

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function agentRepo(env: Env): Promise<string> {
  const stored = (await getSetting(env, AGENT_REPO_KEY))?.trim();
  if (stored) return stored;
  return (env.INSIGHT_AGENT_REPO ?? AGENT_REPO_DEFAULT).trim() || AGENT_REPO_DEFAULT;
}

export async function setAgentRepo(env: Env, repo: string | null): Promise<void> {
  const next = repo?.trim() || null;
  if (next && !REPO_RE.test(next)) {
    throw new ServiceError('bad_request', 'repo must be owner/name', 'invalid_repo');
  }
  await setSetting(env, AGENT_REPO_KEY, next);
}

// Aligned poll scheduling for external sources. Scheduler math lives in the
// engine, never in the DO — mirrors worker/src/platform/engine/schedule.ts.
import type { Env } from '../../env';
import { chunk, MAX_BOUND_PARAMS, inClause } from '../lib/sql';
import { nextPollFireAt } from '../../domains/external-sources/poll';
import { runSourcePoll } from '../../domains/external-sources/service';

export type ExternalPollPlan = { fireAt: number | null; due: string[] };

type PollRow = { id: string; interval_minutes: number };

const VALID_INTERVALS: ReadonlySet<number> = new Set([2, 5, 15, 30, 60]);

export async function computeNextExternalPoll(env: Env): Promise<ExternalPollPlan> {
  const rows = await env.DB
    .prepare(
      `SELECT id, interval_minutes FROM external_sources WHERE enabled = 1 AND archived_at IS NULL`
    )
    .all<PollRow>();

  const now = Date.now();
  let best: number | null = null;
  const entries: { id: string; fireAt: number }[] = [];

  for (const r of rows.results) {
    const interval = VALID_INTERVALS.has(r.interval_minutes) ? r.interval_minutes : 5;
    const next = nextPollFireAt(interval as 2 | 5 | 15 | 30 | 60, now);
    entries.push({ id: r.id, fireAt: next });
    if (best == null || next < best) best = next;
  }

  if (best == null) return { fireAt: null, due: [] };
  const due = entries.filter((e) => e.fireAt - best! < 1000).map(({ id }) => id);
  return { fireAt: best, due };
}

// Run due source polls sequentially; one bad source never aborts the batch.
export async function runDueExternalPolls(env: Env, due: string[]): Promise<number> {
  if (due.length === 0) return 0;
  let ran = 0;
  for (const part of chunk([...new Set(due)], MAX_BOUND_PARAMS)) {
    const rows = await env.DB
      .prepare(`SELECT id FROM external_sources WHERE enabled = 1 AND archived_at IS NULL AND id IN ${inClause(part.length)}`)
      .bind(...part)
      .all<{ id: string }>();
    for (const r of rows.results) {
      try {
        await runSourcePoll(env, r.id, false);
        ran++;
      } catch (e) {
        console.error('[scheduler] external poll failed', r.id, e);
      }
    }
  }
  return ran;
}

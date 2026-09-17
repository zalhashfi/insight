import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../../env';
import { computeNextScheduled, runScheduledDue, runDueDelays, nextDelayFireAt, type SchedulePlan } from '../engine/schedule';
import { computeNextExternalPoll, runDueExternalPolls, type ExternalPollPlan } from '../engine/external-poll';

// Singleton scheduler. Holds ONE alarm set to the next schedule/sunset fire time
// OR the next pending delay resume, whichever is sooner; on wake it runs whatever
// is due and re-arms. Same alarm primitive the ProjectDO uses for its flush. Zero
// compute while idle; nothing scheduled => no alarm.
//
// Addressed by a fixed name ("scheduler") so every caller reaches one instance.
export class SchedulerDO extends DurableObject<Env> {
  // Recompute the soonest fire across schedule/sunset triggers and pending delay
  // resumes, and (re)arm the alarm — disarming when nothing is pending. Called on
  // automation create/update/delete, on each new delay, and after the alarm fires.
  async reschedule(): Promise<void> {
    const plan = await computeNextScheduled(this.env);
    const delayAt = await nextDelayFireAt(this.env);
    const extPlan = await computeNextExternalPoll(this.env).catch((e) => {
      console.error('[scheduler] external poll plan failed', e);
      return { fireAt: null, due: [] } satisfies ExternalPollPlan;
    });
    await this.ctx.storage.put('plan', plan);
    await this.ctx.storage.put('extPlan', extPlan);

    const fireAt = soonest(plan.fireAt, delayAt, extPlan.fireAt);
    if (fireAt == null) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.delete('plan');
      await this.ctx.storage.delete('extPlan');
      return;
    }
    await this.ctx.storage.setAlarm(fireAt);
  }

  // Lazy self-heal: arm only if nothing is currently scheduled (cheap — no D1
  // read when an alarm already exists).
  async ensure(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) != null) return;
    await this.reschedule();
  }

  // Pull the alarm earlier for a new delay, without a full recompute. A later
  // delay needs nothing — the next reschedule() picks it up when the current
  // alarm fires. O(1): no D1 scan on the hot delay-creation path.
  async armFor(fireAtMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || fireAtMs < current) await this.ctx.storage.setAlarm(fireAtMs);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    // The alarm may have fired for a schedule, a delay, or an external poll
    // (or all at once). Run schedule fires only when their planned instant has
    // actually arrived.
    const plan = await this.ctx.storage.get<SchedulePlan>('plan');
    if (plan?.fireAt != null && plan.fireAt <= now) {
      try {
        await runScheduledDue(this.env, plan.due, Math.floor(plan.fireAt / 1000));
      } catch (e) {
        console.error('[scheduler] run failed', e);
      }
    }
    const extPlan = await this.ctx.storage.get<ExternalPollPlan>('extPlan');
    if (extPlan?.fireAt != null && extPlan.fireAt <= now) {
      try {
        await runDueExternalPolls(this.env, extPlan.due);
      } catch (e) {
        console.error('[scheduler] external poll failed', e);
      }
    }
    try {
      await runDueDelays(this.env, now);
    } catch (e) {
      console.error('[scheduler] delay resume failed', e);
    }
    await this.reschedule();
  }
}

// Smallest of three optional epochs.
function soonest(a: number | null, b: number | null, c: number | null = null): number | null {
  let best: number | null = null;
  for (const v of [a, b, c]) {
    if (v == null) continue;
    if (best == null || v < best) best = v;
  }
  return best;
}

const NAME = 'scheduler';

type SchedulerStub = {
  reschedule(): Promise<void>;
  ensure(): Promise<void>;
  armFor(fireAtMs: number): Promise<void>;
};

function stub(env: Env): SchedulerStub {
  return env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(NAME)) as unknown as SchedulerStub;
}

// Best-effort helpers for route handlers (wrap in waitUntil).
export async function rescheduleScheduler(env: Env): Promise<void> {
  try { await stub(env).reschedule(); } catch (e) { console.error('reschedule scheduler failed', e); }
}

export async function ensureScheduler(env: Env): Promise<void> {
  try { await stub(env).ensure(); } catch (e) { console.error('ensure scheduler failed', e); }
}

export async function armSchedulerFor(env: Env, fireAtMs: number): Promise<void> {
  try { await stub(env).armFor(fireAtMs); } catch (e) { console.error('arm scheduler failed', e); }
}

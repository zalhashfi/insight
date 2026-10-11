import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROL_TTL_MS,
  InMemoryProjectControlStorage,
  OTA_WINDOW_MS,
  ProjectControl,
  type OtaQuotaResult,
  type PendingControl,
  type ProjectControlStorage,
} from "../../worker/src/platform/durable-objects/project-control";
import {
  PROJECT_CONTROL_DDL,
  PROJECT_CONTROL_TABLES,
  projectControlStatements,
} from "../../worker/src/platform/durable-objects/project-control-schema";

/**
 * Spec tests for the project control plane (`ProjectControl`).
 *
 * Every dependency is injected — an in-memory storage seam plus a clock — so
 * each contract is asserted against a value we control outright:
 *
 *   1. **Delivery** — an enqueued command is returned by `pendingControls`,
 *      and is gone after `ackControls`.
 *   2. **Idempotent ack** — acking the same id twice (or an unknown id) is a
 *      no-op, never a throw, and never resurrects a command.
 *   3. **Expiry** (INV-T6 / ST-T6) — moving the clock past the TTL drops the
 *      command *and* persists `status = 'expired'`; it is never returned again,
 *      on this call or a later one.
 *   4. **OTA quota** — N consumes under the limit succeed, the (limit+1)th is
 *      refused without consuming, and rolling the clock past the hour resets
 *      the window.
 *   5. **DDL** — the schema string declares `pending_control` and `ota_quota`.
 */

const DEVICE = "dev_alpha";
const VARIABLE = "setpoint";

/** A clock the test owns, so TTL and window arithmetic is exactly knowable. */
const FIXED_NOW = 1_700_000_000_123;

/**
 * A control plane backed by fresh in-memory storage, plus a clock the test can
 * advance. `set()` moves the clock forward one millisecond at a time, so a test
 * can step *onto* a boundary and just past it.
 */
async function control(): Promise<{
  control: ProjectControl;
  storage: InMemoryProjectControlStorage;
  now: () => number;
  advance: (ms: number) => void;
}> {
  const storage = new InMemoryProjectControlStorage();
  let now = FIXED_NOW;
  const instance = new ProjectControl({ storage, now: () => now });
  await instance.init();
  return {
    control: instance,
    storage,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Enqueue and require the stored row, so tests read exactly what was queued. */
async function enqueue(
  instance: ProjectControl,
  overrides: Partial<{ id: string; device: string; variable: string; value: string | null; ttlMs: number }> = {},
): Promise<PendingControl> {
  return instance.enqueueControl({
    id: overrides.id ?? "cmd_1",
    device: overrides.device ?? DEVICE,
    variable: overrides.variable ?? VARIABLE,
    // `??` would erase an explicit `null`, which is a valid payload.
    value: "value" in overrides ? overrides.value : "21.5",
    ttlMs: overrides.ttlMs,
  });
}

// ---------------------------------------------------------------------------
// Delivery and acknowledgement
// ---------------------------------------------------------------------------
describe("ProjectControl — enqueue, poll, ack", () => {
  it("returns an enqueued command from pendingControls", async () => {
    const { control: pc } = await control();
    await enqueue(pc);

    const pending = await pc.pendingControls(DEVICE);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: "cmd_1",
      device: DEVICE,
      variable: VARIABLE,
      value: "21.5",
      ttlMs: DEFAULT_CONTROL_TTL_MS,
      createdAt: FIXED_NOW,
      status: "pending",
    });
  });

  it("defaults the TTL to 24h and persists the value opaquely", async () => {
    const { control: pc } = await control();
    const stored = await enqueue(pc, { value: null });

    expect(stored.ttlMs).toBe(86_400_000);
    expect(stored.ttlMs).toBe(DEFAULT_CONTROL_TTL_MS);
    expect(stored.value).toBeNull();

    // A re-enqueue of the same id upserts rather than duplicating.
    await enqueue(pc, { value: "22.0", ttlMs: 60_000 });
    const pending = await pc.pendingControls(DEVICE);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ value: "22.0", ttlMs: 60_000 });
  });

  it("drops an acked command from pending", async () => {
    const { control: pc } = await control();
    await enqueue(pc);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(1);

    const acked = await pc.ackControls(["cmd_1"]);
    expect(acked).toEqual(["cmd_1"]);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);
  });

  it("scopes pending to one device, and to all devices when omitted", async () => {
    const { control: pc } = await control();
    await enqueue(pc, { id: "cmd_a", device: "dev_a" });
    await enqueue(pc, { id: "cmd_b", device: "dev_b" });

    expect((await pc.pendingControls("dev_a")).map((row) => row.id)).toEqual(["cmd_a"]);
    expect((await pc.pendingControls("dev_b")).map((row) => row.id)).toEqual(["cmd_b"]);
    expect((await pc.pendingControls()).map((row) => row.id)).toEqual(["cmd_a", "cmd_b"]);
  });

  it("returns pending commands oldest first", async () => {
    const { control: pc, advance } = await control();
    await enqueue(pc, { id: "first" });
    advance(1_000);
    await enqueue(pc, { id: "second" });
    advance(1_000);
    await enqueue(pc, { id: "third" });

    expect((await pc.pendingControls(DEVICE)).map((row) => row.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Idempotent acknowledgement
// ---------------------------------------------------------------------------
describe("ProjectControl.ackControls — idempotence", () => {
  it("acking the same id twice is a no-op, not an error", async () => {
    const { control: pc } = await control();
    await enqueue(pc);

    const first = await pc.ackControls(["cmd_1"]);
    expect(first).toEqual(["cmd_1"]);

    // The second ack reports no transition and throws nothing.
    const second = await pc.ackControls(["cmd_1"]);
    expect(second).toEqual([]);

    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);
  });

  it("acking an unknown id is a no-op, not an error", async () => {
    const { control: pc } = await control();
    await enqueue(pc);

    await expect(pc.ackControls(["never_enqueued"])).resolves.toEqual([]);
    // The real command is untouched by the unrelated ack.
    expect(await pc.pendingControls(DEVICE)).toHaveLength(1);
  });

  it("acks a batch, ignoring the ids that are already terminal", async () => {
    const { control: pc } = await control();
    await enqueue(pc, { id: "cmd_1" });
    await enqueue(pc, { id: "cmd_2" });
    await enqueue(pc, { id: "cmd_3" });
    await pc.ackControls(["cmd_2"]);

    const acked = await pc.ackControls(["cmd_1", "cmd_2", "cmd_3", "ghost"]);
    expect(acked).toEqual(["cmd_1", "cmd_3"]);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expiry — INV-T6 / ST-T6
// ---------------------------------------------------------------------------
describe("ProjectControl.pendingControls — expiry (INV-T6/ST-T6)", () => {
  it("drops a command past its TTL and marks it expired", async () => {
    const { control: pc, storage, advance } = await control();
    await enqueue(pc, { ttlMs: DEFAULT_CONTROL_TTL_MS });

    // Still live right up to the deadline...
    advance(DEFAULT_CONTROL_TTL_MS);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(1);

    // ...and dead one millisecond past it.
    advance(1);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);

    // The drop was persisted, not merely filtered: the row survives as expired.
    const stored = await storage.getControl("cmd_1");
    expect(stored?.status).toBe("expired");
  });

  it("never returns an expired command again, even after more time passes", async () => {
    const { control: pc, advance } = await control();
    await enqueue(pc, { ttlMs: 60_000 });

    advance(60_000 + 1);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);

    // A later poll still returns nothing stale.
    advance(DEFAULT_CONTROL_TTL_MS);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);
    expect(await pc.pendingControls()).toHaveLength(0);
  });

  it("expires per command, leaving live commands deliverable", async () => {
    const { control: pc, advance } = await control();
    await enqueue(pc, { id: "short", ttlMs: 1_000 });
    await enqueue(pc, { id: "long", ttlMs: DEFAULT_CONTROL_TTL_MS });

    advance(1_001);
    expect((await pc.pendingControls(DEVICE)).map((row) => row.id)).toEqual(["long"]);
  });

  it("does not resurrect an expired command when it is acked", async () => {
    const { control: pc, storage, advance } = await control();
    await enqueue(pc, { ttlMs: 1_000 });

    advance(1_001);
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);

    // Acking an expired row is a no-op — terminal states are terminal.
    expect(await pc.ackControls(["cmd_1"])).toEqual([]);
    expect((await storage.getControl("cmd_1"))?.status).toBe("expired");
    expect(await pc.pendingControls(DEVICE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OTA quota
// ---------------------------------------------------------------------------
describe("ProjectControl.checkAndConsumeOtaQuota", () => {
  it("allows N consumes under the limit and refuses the (limit+1)th", async () => {
    const { control: pc } = await control();
    const limit = 3;

    for (let i = 1; i <= limit; i += 1) {
      const result = await pc.checkAndConsumeOtaQuota(DEVICE, limit);
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error("unreachable");
      expect(result.used).toBe(i);
      expect(result.windowStart).toBe(FIXED_NOW);
    }

    const denied: OtaQuotaResult = await pc.checkAndConsumeOtaQuota(DEVICE, limit);
    expect(denied.allowed).toBe(false);
    if (denied.allowed) throw new Error("unreachable");
    expect(denied.reason).toBe("quota_exceeded");
    expect(denied.used).toBe(limit);

    // A denied check consumes nothing: the budget is still exactly spent.
    const stillDenied = await pc.checkAndConsumeOtaQuota(DEVICE, limit);
    expect(stillDenied).toMatchObject({ allowed: false, used: limit });
  });

  it("tracks each device's budget independently", async () => {
    const { control: pc } = await control();

    await pc.checkAndConsumeOtaQuota("dev_a", 1);
    expect(await pc.checkAndConsumeOtaQuota("dev_a", 1)).toMatchObject({ allowed: false });
    // dev_b has its own window and its own budget.
    expect(await pc.checkAndConsumeOtaQuota("dev_b", 1)).toMatchObject({
      allowed: true,
      used: 1,
    });
  });

  it("resets the window once the clock rolls past the hour", async () => {
    const { control: pc, advance } = await control();
    const limit = 2;

    await pc.checkAndConsumeOtaQuota(DEVICE, limit);
    await pc.checkAndConsumeOtaQuota(DEVICE, limit);
    expect(await pc.checkAndConsumeOtaQuota(DEVICE, limit)).toMatchObject({
      allowed: false,
      used: 2,
    });

    // One millisecond short of the hour: still the same window, still denied.
    advance(OTA_WINDOW_MS - 1);
    expect(await pc.checkAndConsumeOtaQuota(DEVICE, limit)).toMatchObject({
      allowed: false,
      used: 2,
      windowStart: FIXED_NOW,
    });

    // The hour has rolled: a fresh window opens at the current instant.
    advance(1);
    const fresh = await pc.checkAndConsumeOtaQuota(DEVICE, limit);
    expect(fresh).toMatchObject({ allowed: true, used: 1 });
    expect(fresh.windowStart).toBe(FIXED_NOW + OTA_WINDOW_MS);
  });

  it("persists the quota row so the window survives a restart", async () => {
    const { control: pc, storage } = await control();
    await pc.checkAndConsumeOtaQuota(DEVICE, 5);

    expect(await storage.getOtaQuota(DEVICE)).toEqual({
      device: DEVICE,
      windowStart: FIXED_NOW,
      used: 1,
    });

    const revived = new ProjectControl({ storage, now: () => FIXED_NOW });
    expect(await revived.checkAndConsumeOtaQuota(DEVICE, 5)).toMatchObject({
      allowed: true,
      used: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
describe("project control schema DDL", () => {
  it("declares pending_control and ota_quota", () => {
    expect(PROJECT_CONTROL_DDL).toContain("pending_control");
    expect(PROJECT_CONTROL_DDL).toContain("ota_quota");
    for (const table of PROJECT_CONTROL_TABLES) {
      expect(PROJECT_CONTROL_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(PROJECT_CONTROL_DDL).toContain("id         TEXT    PRIMARY KEY");
    expect(PROJECT_CONTROL_DDL).toContain("device       TEXT    PRIMARY KEY");
  });

  it("splits into idempotent statements on top-level semicolons", () => {
    const statements = projectControlStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.endsWith(";")).toBe(true);
      expect(statement).toContain("IF NOT EXISTS");
    }
    expect(projectControlStatements()).toEqual(statements);
    expect(statements.filter((s) => s.includes("CREATE TABLE"))).toHaveLength(2);
  });

  it("is exposed by the storage seam so an adapter can execute it", () => {
    const storage: ProjectControlStorage = new InMemoryProjectControlStorage();
    expect(storage.ddl()).toEqual(projectControlStatements());
  });
});

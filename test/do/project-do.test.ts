import { describe, expect, it } from "vitest";
import {
  InMemoryProjectStorage,
  ProjectDO,
  type ProjectStorage,
  type PushResult,
  type StateRow,
} from "../../worker/src/platform/durable-objects/project-do";
import {
  PROJECT_DDL,
  PROJECT_TABLES,
  projectStatements,
} from "../../worker/src/platform/durable-objects/project-schema";

/**
 * Spec tests for the A11 projection (`ProjectDO`).
 *
 * Every dependency is injected — an in-memory storage seam plus a clock — so
 * each contract is asserted against a value we control outright:
 *
 *   1. **Projection** — an accepted push lands its `(value, ts, seq)` in the
 *      `latest_state` row for its `(device, variable)` stream.
 *   2. **Ordering** (INV-T2 / D4.4) — a stale `ts` is ignored and leaves the
 *      stored row untouched; an equal `ts` is last-write-wins, tie-broken by
 *      `seq` (a higher seq wins, a lower seq is ignored).
 *   3. **Independence** — devices and variables are separate streams; writing
 *      one never disturbs another.
 *   4. **Receipt** — `receivePush` (the shard→project entry) reports landed vs
 *      ignored vs malformed as a value, never a throw.
 *   5. **DDL** — the schema string declares `latest_state` with the composite
 *      primary key the projection relies on.
 */

const DEVICE = "dev_alpha";
const VARIABLE = "temp";

/** A clock the test owns, so bookkeeping is exactly knowable. */
const FIXED_NOW = 1_700_000_000_123;

/** Build an initialised project backed by fresh in-memory storage. */
async function project(): Promise<{
  do: ProjectDO;
  storage: InMemoryProjectStorage;
}> {
  const storage = new InMemoryProjectStorage();
  const instance = new ProjectDO({ storage, now: () => FIXED_NOW });
  await instance.init();
  return { do: instance, storage };
}

/** Push and require acceptance, returning the outcome. */
async function accept(
  instance: ProjectDO,
  push: {
    device?: string;
    variable?: string;
    value: number | null;
    ts: number;
    seq: number;
  },
): Promise<Extract<PushResult, { accepted: true }>> {
  const result = await instance.applyPush({
    device: push.device ?? DEVICE,
    variable: push.variable ?? VARIABLE,
    value: push.value,
    ts: push.ts,
    seq: push.seq,
  });
  if (!result.accepted) {
    throw new Error(
      `expected acceptance, got ${result.reason} at ts=${push.ts} seq=${push.seq}`,
    );
  }
  return result;
}

/** The single stored row of a stream, requiring it to exist. */
function row(instance: ProjectDO, device = DEVICE, variable = VARIABLE): StateRow {
  const rows = instance.getState(device, variable);
  expect(rows).toHaveLength(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------
describe("ProjectDO.applyPush — projection", () => {
  it("projects an accepted push into latest_state", async () => {
    const { do: projectDO } = await project();

    const result = await accept(projectDO, { value: 25.4, ts: 10, seq: 1 });
    expect(result.accepted).toBe(true);

    const state = row(projectDO);
    expect(state).toMatchObject({
      device: DEVICE,
      variable: VARIABLE,
      value: 25.4,
      ts: 10,
      seq: 1,
    });
  });

  it("moves a stream forward when a newer ts arrives", async () => {
    const { do: projectDO } = await project();
    await accept(projectDO, { value: 25.4, ts: 10, seq: 1 });
    await accept(projectDO, { value: 26.0, ts: 11, seq: 2 });

    expect(row(projectDO)).toMatchObject({ value: 26.0, ts: 11, seq: 2 });
  });
});

// ---------------------------------------------------------------------------
// Ordering — INV-T2 / D4.4
// ---------------------------------------------------------------------------
describe("ProjectDO.applyPush — ordering (INV-T2/D4.4)", () => {
  it("ignores an older ts, leaving state unchanged (stale)", async () => {
    const { do: projectDO } = await project();
    await accept(projectDO, { value: 25.4, ts: 10, seq: 1 });

    const stale = await projectDO.applyPush({
      device: DEVICE,
      variable: VARIABLE,
      value: 99.9,
      ts: 9,
      seq: 2,
    });

    expect(stale.accepted).toBe(false);
    if (stale.accepted) throw new Error("unreachable");
    expect(stale.reason).toBe("stale");
    expect(stale.storedTs).toBe(10);
    expect(stale.storedSeq).toBe(1);

    // The stale push changed nothing.
    expect(row(projectDO)).toMatchObject({ value: 25.4, ts: 10, seq: 1 });
  });

  it("wins on an equal ts with a higher seq (LWW by seq)", async () => {
    const { do: projectDO } = await project();
    await accept(projectDO, { value: 25.4, ts: 10, seq: 1 });

    const tie = await accept(projectDO, { value: 25.5, ts: 10, seq: 2 });
    expect(tie.reason).toBe("tie_break");
    expect(row(projectDO)).toMatchObject({ value: 25.5, ts: 10, seq: 2 });
  });

  it("is ignored on an equal ts with a lower seq", async () => {
    const { do: projectDO } = await project();
    await accept(projectDO, { value: 25.4, ts: 10, seq: 2 });

    const lost = await projectDO.applyPush({
      device: DEVICE,
      variable: VARIABLE,
      value: 1,
      ts: 10,
      seq: 1,
    });

    expect(lost.accepted).toBe(false);
    if (lost.accepted) throw new Error("unreachable");
    expect(lost.reason).toBe("tie_lost");
    expect(row(projectDO)).toMatchObject({ value: 25.4, ts: 10, seq: 2 });
  });

  it("accepts an equal ts with an equal seq (>= tie-break boundary)", async () => {
    const { do: projectDO } = await project();
    await accept(projectDO, { value: 25.4, ts: 10, seq: 1 });

    const replay = await accept(projectDO, { value: 25.4, ts: 10, seq: 1 });
    expect(replay.reason).toBe("tie_break");
    expect(row(projectDO)).toMatchObject({ value: 25.4, ts: 10, seq: 1 });
  });
});

// ---------------------------------------------------------------------------
// Independence — devices and variables are separate streams
// ---------------------------------------------------------------------------
describe("ProjectDO — stream independence", () => {
  it("keeps multiple devices and variables independent", async () => {
    const { do: projectDO } = await project();

    await accept(projectDO, { device: "dev_a", variable: "temp", value: 1, ts: 10, seq: 1 });
    await accept(projectDO, { device: "dev_a", variable: "hum", value: 2, ts: 11, seq: 1 });
    await accept(projectDO, { device: "dev_b", variable: "temp", value: 3, ts: 12, seq: 1 });

    expect(projectDO.getState("dev_a", "temp")).toMatchObject([{ value: 1, ts: 10 }]);
    expect(projectDO.getState("dev_a", "hum")).toMatchObject([{ value: 2, ts: 11 }]);
    expect(projectDO.getState("dev_b", "temp")).toMatchObject([{ value: 3, ts: 12 }]);

    // A newer push to one stream leaves the others exactly as they were.
    await accept(projectDO, { device: "dev_a", variable: "temp", value: 9, ts: 20, seq: 2 });
    expect(projectDO.getState("dev_a", "hum")).toMatchObject([{ value: 2, ts: 11 }]);
    expect(projectDO.getState("dev_b", "temp")).toMatchObject([{ value: 3, ts: 12 }]);
  });
});

// ---------------------------------------------------------------------------
// Receipt — receivePush, the shard→project entry
// ---------------------------------------------------------------------------
describe("ProjectDO.receivePush", () => {
  it("is a receipt for a well-formed push, landing the same projection", async () => {
    const { do: projectDO } = await project();

    const result = await projectDO.receivePush({
      device: DEVICE,
      variable: VARIABLE,
      value: 25.4,
      ts: 10,
      seq: 1,
    });

    expect(result).toMatchObject({ accepted: true, reason: "newer" });
    expect(row(projectDO)).toMatchObject({ value: 25.4, ts: 10, seq: 1 });
  });

  it("reports an ignored push as a value, never a throw", async () => {
    const { do: projectDO } = await project();
    await projectDO.receivePush({ device: DEVICE, variable: VARIABLE, value: 25.4, ts: 10, seq: 1 });

    const stale = await projectDO.receivePush({
      device: DEVICE,
      variable: VARIABLE,
      value: 0,
      ts: 5,
      seq: 9,
    });
    expect(stale).toMatchObject({ accepted: false, reason: "stale" });
  });

  it("rejects a malformed push (no stream / non-finite keys) as invalid", async () => {
    const { do: projectDO } = await project();

    const unnamed = await projectDO.receivePush({
      device: "",
      variable: VARIABLE,
      value: 1,
      ts: 10,
      seq: 1,
    });
    expect(unnamed).toMatchObject({ accepted: false, reason: "invalid" });

    const nonFinite = await projectDO.receivePush({
      device: DEVICE,
      variable: VARIABLE,
      value: 1,
      ts: Number.NaN,
      seq: 1,
    });
    expect(nonFinite).toMatchObject({ accepted: false, reason: "invalid" });

    // Neither malformed push created a row.
    expect(projectDO.getState()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Priming — the projection survives a restart via storage
// ---------------------------------------------------------------------------
describe("ProjectDO.init", () => {
  it("primes the mirror from storage so getState survives a restart", async () => {
    const { do: first, storage } = await project();
    await first.applyPush({
      device: DEVICE,
      variable: VARIABLE,
      value: 25.4,
      ts: 10,
      seq: 1,
    });

    const revived = new ProjectDO({ storage, now: () => FIXED_NOW });
    await revived.init();

    expect(revived.getState(DEVICE, VARIABLE)).toMatchObject([
      { value: 25.4, ts: 10, seq: 1 },
    ]);
  });

  it("returns copies, so a caller cannot mutate stored rows", async () => {
    const storage: ProjectStorage = new InMemoryProjectStorage();
    await storage.putState({ device: DEVICE, variable: VARIABLE, value: 1, ts: 1, seq: 0 });

    const first = await storage.listState();
    first[0] = { ...first[0], value: 99 };
    const second = await storage.getState(DEVICE, VARIABLE);
    expect(second?.value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------
describe("project schema DDL", () => {
  it("declares latest_state with the (device, variable) primary key", () => {
    expect(PROJECT_DDL).toContain("latest_state");
    expect(PROJECT_DDL).toContain("PRIMARY KEY (device, variable)");
    for (const table of PROJECT_TABLES) {
      expect(PROJECT_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("splits into idempotent statements on top-level semicolons", () => {
    const statements = projectStatements();
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.endsWith(";")).toBe(true);
      expect(statement).toContain("IF NOT EXISTS");
    }
    expect(projectStatements()).toEqual(statements);
    expect(projectStatements().filter((s) => s.includes("CREATE TABLE"))).toHaveLength(2);
  });

  it("is exposed by the storage seam so an adapter can execute it", () => {
    const storage: ProjectStorage = new InMemoryProjectStorage();
    expect(storage.ddl()).toEqual(projectStatements());
  });
});

import { describe, expect, it } from "vitest";
import {
  AUDIT_SETTINGS_PERMISSION,
  AUDIT_STATUS_CODE,
  AuditError,
  AuditLog,
  InMemoryAuditStore,
  InMemoryMembershipLookup,
  NON_SENSITIVE_ACTIONS,
  SENSITIVE_ACTIONS,
  byNewestFirst,
  isAuditError,
  isSensitive,
  isSensitiveAction,
  type AuditRecord,
  type AuditStore,
} from "../../worker/src/domains/settings/audit-log";

/**
 * Spec tests for the settings audit log (task: settings/audit-log).
 *
 * The domain talks to the {@link AuditStore} seam and the membership seam, so
 * these tests drive two in-memory fakes and assert the four contracts the task
 * names, plus the two structural claims that make them trustworthy:
 *
 *   1. **A sensitive action is recorded** — actor, target and a `at` stamp all
 *      land in the store, with a stable id and the action's category.
 *   2. **Non-sensitive actions are not recorded** — `record` refuses them
 *      (`not_sensitive`) and the store stays untouched.
 *   3. **Disabled → no records** — after the owner disables logging, `record`
 *      returns `null` and the raw append count does not move (the disabled
 *      state is *not* a read-time filter).
 *   4. **Read is newest-first** — even when the store hands entries back
 *      oldest-first, `read` sorts them newest-first and never mutates the
 *      store's array.
 *
 * Denials are asserted through the module's documented convention: entry points
 * throw a {@link AuditError} with a stable `code`, never an `{ ok:false }`
 * result.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Build a log over fresh fakes, a deterministic clock and a deterministic id
 * sequence. `u_owner` owns `proj_a`; authorization tests add junior roles.
 */
function setup() {
  let clock = 1_000;
  let seq = 0;
  const store = new InMemoryAuditStore({
    now: () => (clock += 1_000),
    genId: () => `e_${++seq}`,
  });
  const membership = new InMemoryMembershipLookup();
  membership.grant("proj_a", "u_owner", "owner");

  const log = new AuditLog(store, {
    membership,
    now: () => (clock += 1_000),
  });

  return { store, membership, log };
}

/** Assert that `fn` rejects with an AuditError carrying `code`. */
async function expectDenied(fn: () => Promise<unknown>, code: string): Promise<AuditError> {
  try {
    await fn();
  } catch (err) {
    expect(isAuditError(err)).toBe(true);
    if (!isAuditError(err)) throw err;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`expected AuditError("${code}") but call resolved`);
}

// ---------------------------------------------------------------------------
// Vocabulary (pure)
// ---------------------------------------------------------------------------

describe("action vocabulary", () => {
  it("records exactly the sensitive actions, each with a category", () => {
    expect(SENSITIVE_ACTIONS).toEqual({
      delete: "destructive",
      token_create: "token",
      token_revoke: "token",
      settings_change: "settings",
      settings_reset: "settings",
      audit_log_enable: "settings",
      audit_log_disable: "settings",
    });
  });

  it("names the actions it deliberately does NOT record", () => {
    expect([...NON_SENSITIVE_ACTIONS]).toEqual([
      "read",
      "list",
      "render",
      "telemetry_ingest",
    ]);
  });

  it("classifies a sensitive action and rejects a non-sensitive one", () => {
    expect(isSensitiveAction("delete")).toBe(true);
    expect(isSensitive("token_revoke")).toBe(true);
    expect(isSensitiveAction("read")).toBe(false);
    expect(isSensitiveAction("telemetry_ingest")).toBe(false);
    expect(isSensitiveAction("nonsense")).toBe(false);
    expect(isSensitiveAction(42)).toBe(false);
    // A prototype key must not be mistaken for an action name.
    expect(isSensitiveAction("toString")).toBe(false);
    expect(isSensitiveAction("constructor")).toBe(false);
  });

  it("maps every audit error onto a documented HTTP status", () => {
    expect(AUDIT_STATUS_CODE).toEqual({
      invalid_input: 400,
      not_sensitive: 400,
      not_a_member: 403,
      forbidden: 403,
    });
  });

  it("gates the owner switch with the owner permission", () => {
    // `project:delete` is declared owner-only in projects/membership.ts, so the
    // switch reuses that vocabulary instead of minting a second lattice.
    expect(AUDIT_SETTINGS_PERMISSION).toBe("project:delete");
  });

  it("orders newest-first, with the id as a deterministic tie-break", () => {
    const entry = (id: string, at: number): AuditRecord => ({
      id,
      projectId: "proj_a",
      action: "delete",
      category: "destructive",
      actorId: "u_owner",
      target: "d_1",
      at,
    });

    const sorted = [entry("e_1", 5), entry("e_3", 9), entry("e_2", 9)].sort(byNewestFirst);

    // 9 > 5, and within the same stamp the larger id comes first.
    expect(sorted.map((e) => e.id)).toEqual(["e_3", "e_2", "e_1"]);
  });
});

// ---------------------------------------------------------------------------
// 1. A sensitive action is recorded with actor + target + ts
// ---------------------------------------------------------------------------

describe("recording a sensitive action", () => {
  it("records the actor, the target and a timestamp", async () => {
    const { log, store } = setup();

    const recorded = await log.record({
      projectId: "proj_a",
      action: "delete",
      actorId: "u_owner",
      target: "device:greenhouse-1",
    });

    expect(recorded).not.toBeNull();
    expect(recorded).toMatchObject({
      projectId: "proj_a",
      action: "delete",
      category: "destructive",
      actorId: "u_owner",
      target: "device:greenhouse-1",
      at: 2_000, // the injected clock; never the caller's word
    });
    expect(recorded?.id).toBe("e_1");

    // It really landed in the store, and reads back as the same entry.
    expect(store.appended()).toBe(1);
    expect(await log.read("proj_a")).toEqual([recorded]);
  });

  it("derives the category from the action rather than trusting the caller", async () => {
    const { log } = setup();

    await log.record({
      projectId: "proj_a",
      action: "token_create",
      actorId: "u_owner",
      target: "tok_1",
    });
    await log.record({
      projectId: "proj_a",
      action: "settings_change",
      actorId: "u_owner",
      target: "settings:retention",
    });

    const trail = await log.read("proj_a");
    expect(trail.map((e) => [e.action, e.category])).toEqual([
      ["settings_change", "settings"],
      ["token_create", "token"],
    ]);
  });

  it("scopes entries to their project", async () => {
    const { log } = setup();

    await log.record({
      projectId: "proj_a",
      action: "delete",
      actorId: "u_owner",
      target: "device:1",
    });
    await log.record({
      projectId: "proj_b",
      action: "delete",
      actorId: "u_owner",
      target: "device:2",
    });

    expect((await log.read("proj_a")).map((e) => e.target)).toEqual(["device:1"]);
    expect((await log.read("proj_b")).map((e) => e.target)).toEqual(["device:2"]);
  });

  it("refuses a blank actor or target instead of recording a nameless entry", async () => {
    const { log, store } = setup();

    await expectDenied(
      () =>
        log.record({ projectId: "proj_a", action: "delete", actorId: "  ", target: "device:1" }),
      "invalid_input",
    );
    await expectDenied(
      () =>
        log.record({ projectId: "proj_a", action: "delete", actorId: "u_owner", target: "" }),
      "invalid_input",
    );
    await expectDenied(
      () =>
        log.record({ projectId: "", action: "delete", actorId: "u_owner", target: "device:1" }),
      "invalid_input",
    );

    // Neither failure wrote anything.
    expect(store.appended()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Non-sensitive actions are not recorded
// ---------------------------------------------------------------------------

describe("non-sensitive actions are not recorded", () => {
  it("refuses a non-sensitive action loudly and writes nothing", async () => {
    const { log, store } = setup();

    for (const action of NON_SENSITIVE_ACTIONS) {
      await expectDenied(
        () => log.record({ projectId: "proj_a", action, actorId: "u_owner", target: "anything" }),
        "not_sensitive",
      );
    }

    // The store is provably untouched — a refused action is not a no-op entry.
    expect(store.appended()).toBe(0);
    expect(await log.read("proj_a")).toEqual([]);
  });

  it("refuses an unknown action name", async () => {
    const { log, store } = setup();

    await expectDenied(
      () =>
        log.record({
          projectId: "proj_a",
          action: "look_at_it" as "delete",
          actorId: "u_owner",
          target: "device:1",
        }),
      "not_sensitive",
    );

    expect(store.appended()).toBe(0);
  });

  it("a sensitive and a non-sensitive call do not collapse to the same outcome", async () => {
    const { log, store } = setup();

    // Sensitive -> an entry appears. Non-sensitive -> a throw, no entry.
    expect(
      await log.record({
        projectId: "proj_a",
        action: "delete",
        actorId: "u_owner",
        target: "device:1",
      }),
    ).not.toBeNull();
    await expectDenied(
      () =>
        log.record({
          projectId: "proj_a",
          action: "read",
          actorId: "u_owner",
          target: "device:1",
        }),
      "not_sensitive",
    );

    expect(store.appended()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Disabled → no records
// ---------------------------------------------------------------------------

describe("the owner switch", () => {
  it("records nothing once logging is disabled", async () => {
    const { log, store } = setup();

    // Baseline: one real action is recorded.
    await log.record({
      projectId: "proj_a",
      action: "delete",
      actorId: "u_owner",
      target: "device:1",
    });
    expect(store.appended()).toBe(1);

    await log.setEnabled("proj_a", false, "u_owner");

    // The switch left a marker of its own (disabling is itself audit-worthy),
    // so count from here: every further sensitive action is dropped.
    const afterSwitch = store.appended();
    const dropped = await log.record({
      projectId: "proj_a",
      action: "token_revoke",
      actorId: "u_owner",
      target: "tok_1",
    });

    expect(dropped).toBeNull();
    expect(store.appended()).toBe(afterSwitch); // unchanged: nothing recorded
    expect(await log.isEnabled("proj_a")).toBe(false);
  });

  it("never consults the store's append path while disabled", async () => {
    const { log, store } = setup();

    await log.setEnabled("proj_a", false, "u_owner");
    const afterSwitch = store.appended();

    for (const action of ["delete", "token_create", "settings_change"] as const) {
      expect(
        await log.record({ projectId: "proj_a", action, actorId: "u_owner", target: "x" }),
      ).toBeNull();
    }

    // Disabled is an absolute guarantee: not "filtered at read", not "written
    // as a no-op". The underlying journal did not move.
    expect(store.appended()).toBe(afterSwitch);
  });

  it("records again after the owner re-enables logging", async () => {
    const { log, store } = setup();

    await log.setEnabled("proj_a", false, "u_owner");
    expect(
      await log.record({
        projectId: "proj_a",
        action: "delete",
        actorId: "u_owner",
        target: "device:1",
      }),
    ).toBeNull();

    await log.setEnabled("proj_a", true, "u_owner");
    const recorded = await log.record({
      projectId: "proj_a",
      action: "delete",
      actorId: "u_owner",
      target: "device:2",
    });

    expect(recorded).not.toBeNull();
    expect(recorded?.target).toBe("device:2");
    // The switch's own two flips are in the trail alongside the action.
    expect((await log.read("proj_a")).map((e) => e.action)).toEqual([
      "delete",
      "audit_log_enable",
      "audit_log_disable",
    ]);
    expect(store.appended()).toBe(3);
  });

  it("defaults to ON when the project never touched the switch", async () => {
    const { log } = setup();

    expect(await log.isEnabled("proj_a")).toBe(true);
    expect(
      await log.record({
        projectId: "proj_a",
        action: "delete",
        actorId: "u_owner",
        target: "device:1",
      }),
    ).not.toBeNull();
  });

  it("only the owner may flip the switch", async () => {
    const { log, membership, store } = setup();
    membership.grant("proj_a", "u_admin", "admin");
    membership.grant("proj_a", "u_member", "member");

    await expectDenied(() => log.setEnabled("proj_a", false, "u_admin"), "forbidden");
    await expectDenied(() => log.setEnabled("proj_a", false, "u_member"), "forbidden");
    await expectDenied(() => log.setEnabled("proj_a", false, "u_stranger"), "not_a_member");

    // A refused flip changes nothing: logging is still on.
    expect(await log.isEnabled("proj_a")).toBe(true);
    expect(store.appended()).toBe(0);
  });

  it("flips the switch per project, not globally", async () => {
    const { log, membership } = setup();
    membership.grant("proj_b", "u_owner", "owner");

    await log.setEnabled("proj_a", false, "u_owner");

    expect(await log.isEnabled("proj_a")).toBe(false);
    expect(await log.isEnabled("proj_b")).toBe(true);
    expect(
      await log.record({
        projectId: "proj_b",
        action: "delete",
        actorId: "u_owner",
        target: "device:1",
      }),
    ).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Newest-first read ordering
// ---------------------------------------------------------------------------

describe("read ordering", () => {
  it("returns entries newest-first", async () => {
    const { log } = setup();

    for (const target of ["device:1", "device:2", "device:3"]) {
      await log.record({
        projectId: "proj_a",
        action: "delete",
        actorId: "u_owner",
        target,
      });
    }

    const trail = await log.read("proj_a");
    expect(trail.map((e) => e.target)).toEqual(["device:3", "device:2", "device:1"]);
    // Strictly descending stamps — newest first, not mere insertion order.
    expect(trail.map((e) => e.at)).toEqual([4_000, 3_000, 2_000]);
  });

  it("imposes the order even when the store hands entries back oldest-first", async () => {
    // The seam contract says list order is unspecified; this fake returns
    // oldest-first on purpose, so the sort in `read` is what makes the
    // assertion pass rather than an accident of the store.
    const oldestFirst: AuditRecord[] = [
      {
        id: "e_1",
        projectId: "proj_a",
        action: "delete",
        category: "destructive",
        actorId: "u_owner",
        target: "old",
        at: 10,
      },
      {
        id: "e_2",
        projectId: "proj_a",
        action: "token_revoke",
        category: "token",
        actorId: "u_owner",
        target: "new",
        at: 20,
      },
    ];
    const store: AuditStore = {
      async append() {
        throw new Error("not used");
      },
      async listByProject() {
        return oldestFirst;
      },
      async getEnabled() {
        return true;
      },
      async setEnabled() {},
    };
    const membership = new InMemoryMembershipLookup();
    const log = new AuditLog(store, { membership });

    const trail = await log.read("proj_a");
    expect(trail.map((e) => e.target)).toEqual(["new", "old"]);
    // The store's own array was not reordered in place.
    expect(oldestFirst.map((e) => e.target)).toEqual(["old", "new"]);
  });

  it("breaks a same-millisecond tie deterministically instead of by luck", async () => {
    const store = new InMemoryAuditStore({ now: () => 5_000 });
    const membership = new InMemoryMembershipLookup();
    let seq = 0;
    const log = new AuditLog(store, { membership, genId: () => `e_${++seq}` });

    await log.record({
      projectId: "proj_a",
      action: "delete",
      actorId: "u_owner",
      target: "first",
    });
    await log.record({
      projectId: "proj_a",
      action: "delete",
      actorId: "u_owner",
      target: "second",
    });

    // Same stamp, so id descending decides: the later record (`e_2`) is first.
    expect((await log.read("proj_a")).map((e) => e.target)).toEqual(["second", "first"]);
  });
});

// ---------------------------------------------------------------------------
// Append-only shape & input validation
// ---------------------------------------------------------------------------

describe("append-only and validation", () => {
  it("offers no way to rewrite the trail", () => {
    const { store } = setup();

    // The seam's verb set is the guarantee: no update, no delete, no clear.
    for (const verb of ["update", "delete", "clear", "remove", "purge"]) {
      expect(verb in store).toBe(false);
    }
  });

  it("rejects a blank project on read and on the switch", async () => {
    const { log } = setup();

    await expectDenied(() => log.read("  "), "invalid_input");
    await expectDenied(() => log.setEnabled("", true, "u_owner"), "invalid_input");
    await expectDenied(() => log.setEnabled("proj_a", true, " "), "invalid_input");
    await expectDenied(() => log.isEnabled(""), "invalid_input");
  });

  it("exposes a guard for catch blocks", () => {
    expect(isAuditError(new AuditError("not_sensitive", "x"))).toBe(true);
    expect(isAuditError(new Error("x"))).toBe(false);
    expect(new AuditError("forbidden", "x").status).toBe(403);
  });
});

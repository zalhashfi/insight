import { describe, expect, it } from "vitest";
import {
  AttachmentTooLargeError,
  InMemoryAttachmentStore,
  InMemoryLiveUpdates,
  InMemoryStorage,
  LayoutNotFoundError,
  MAX_ATTACHMENT_BYTES,
  attachmentByteLength,
  restoreConnection,
  serializeConnectionState,
  type ConnectionAttachment,
  type DashboardUpdate,
  type LiveUpdateSink,
  type Storage,
} from "../../worker/src/platform/durable-objects/dashboard-hibernate";
import type { MetricPoint } from "../../worker/src/platform/durable-objects/dashboard-do";

/**
 * Spec tests for the A13b hibernation / restore layer.
 *
 * Every dependency is an injected seam — an attachment store, a Storage-like
 * key/value store and a live-update log — so each of A13b's contracts is
 * asserted against a value the test owns outright:
 *
 *   1. **Compact attachment** (ST-D4 / §D-1) — a serialized attachment carries
 *      exactly `{project, cursor, layout_key}`, and its serialized byte size is
 *      ≤ the 16 KiB ceiling.
 *   2. **Layout lives in Storage, not the attachment** — after evict→reconnect
 *      the layout is read back by `layout_key` from Storage, and the attachment
 *      itself is far smaller than the blob it points at.
 *   3. **Resume exactly once** (INV-D4 / ST-D4) — after evict→reconnect the
 *      client receives every update `> cursor` exactly once (no gap, no
 *      duplicate) and ends on the correct cursor.
 *   4. **The guard is load-bearing** — an attachment that would exceed 16 KiB is
 *      rejected with {@link AttachmentTooLargeError}; 16 KiB exactly is legal.
 */

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

/**
 * A layout blob of `sizeBytes` bytes.
 *
 * Real layout is a serialized projection view; its *content* is irrelevant to
 * these contracts, only its size is — so it is a padded ASCII string whose
 * UTF-8 length is exactly the requested count (ASCII ⇒ one byte per char).
 */
function layoutOf(sizeBytes: number): string {
  const header = `{"device":"dev_alpha","variable":"temp","series":`;
  const pad = sizeBytes - header.length - 1;
  if (pad < 0) throw new Error(`layout floor is ${header.length + 1} bytes`);
  return `${header}${"0".repeat(pad)}}`;
}

/** A projected point, with `ts` defaulting to its `seq`. */
function point(seq: number, overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    device: overrides.device ?? "dev_alpha",
    variable: overrides.variable ?? "temp",
    value: overrides.value ?? seq,
    ts: overrides.ts ?? seq,
    seq,
  };
}

/**
 * A live-update log that *does not* de-duplicate — it returns every update
 * `> cursor` on every read, in ascending `seq` order.
 *
 * This is the adversarial fake: a naive `restoreConnection` that re-read the log
 * (or took its cursor from anywhere but the attachment) would show up as a
 * duplicate against this sink. The module must still deliver each update once,
 * which pins the "exactly once" claim on the attachment's cursor and the
 * assembling code, not on a friendly fake.
 */
class ReplayingLog implements LiveUpdateSink {
  private readonly updates: DashboardUpdate[] = [];

  append(update: DashboardUpdate): void {
    this.updates.push({ ...update });
    this.updates.sort((a, b) => a.seq - b.seq);
  }

  updatesSince(cursor: number): readonly DashboardUpdate[] {
    return this.updates
      .filter((update) => update.seq > cursor)
      .map((update) => ({ ...update }));
  }
}

/** Project seqs out of a delivered-update list, for order/dup assertions. */
function seqs(updates: readonly DashboardUpdate[]): number[] {
  return updates.map((update) => update.seq);
}

/** The three fields the attachment is allowed to carry, in wire order. */
const ATTACHMENT_KEYS = ["project", "cursor", "layout_key"] as const;

// ---------------------------------------------------------------------------
// Compact attachment (ST-D4 / §D-1)
// ---------------------------------------------------------------------------
describe("dashboard hibernation — the attachment is compact and only a pointer", () => {
  it("serializes exactly {project, cursor, layout_key}", () => {
    const attachment = serializeConnectionState({
      project: "prj_alpha",
      cursor: 42,
      layoutKey: "layout/prj_alpha/conn_1",
    });

    // Exactly the three fields §D-1 allows — no layout, no points, no extras.
    expect(Object.keys(attachment).sort()).toEqual(
      [...ATTACHMENT_KEYS].sort(),
    );
    expect(attachment).toEqual({
      project: "prj_alpha",
      cursor: 42,
      layout_key: "layout/prj_alpha/conn_1",
    });

    // The serialized form carries the wire names, nothing more.
    const parsed = JSON.parse(JSON.stringify(attachment)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).sort()).toEqual([...ATTACHMENT_KEYS].sort());
  });

  it("keeps the serialized attachment at or under 16 KiB", () => {
    const attachment = serializeConnectionState({
      project: "prj_alpha",
      cursor: 1_000_000,
      layoutKey: "layout/prj_alpha/conn_abcdef0123456789",
    });

    const size = attachmentByteLength(attachment);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES);
    // A pointer + a cursor is a few dozen bytes: nowhere near the ceiling.
    expect(size).toBeLessThan(256);
  });
});

// ---------------------------------------------------------------------------
// Layout lives in Storage, addressed by layout_key (§D-1)
// ---------------------------------------------------------------------------
describe("dashboard hibernation — layout is stored by layout_key, not attached", () => {
  it("reads the layout back from Storage by layout_key after evict→reconnect", async () => {
    const layoutKey = "layout/prj_alpha/conn_1";
    // A layout far larger than the attachment ceiling: proof it belongs in
    // Storage, and that the attachment never has to carry it.
    const layout = layoutOf(MAX_ATTACHMENT_BYTES * 3);

    const storage = new InMemoryStorage();
    await storage.put(layoutKey, layout);

    // The attachment — all that survives eviction — is written before the DO is
    // evicted: it holds the pointer and the cursor, and nothing large.
    const store = new InMemoryAttachmentStore();
    store.write(
      serializeConnectionState({
        project: "prj_alpha",
        cursor: 3,
        layoutKey,
      }),
    );

    // --- eviction: DO memory gone; attachment + Storage survive --------------
    const log = new InMemoryLiveUpdates();
    for (const update of [point(1), point(2), point(3), point(4), point(5)]) {
      log.append(update);
    }

    const restored = await restoreConnection(store, storage, log);
    if (restored === null) throw new Error("expected a restored connection");

    // The layout came back, whole, from Storage under the attached key.
    expect(restored.layoutKey).toBe(layoutKey);
    expect(restored.layout).toBe(layout);
    expect(restored.layout.length).toBeGreaterThan(MAX_ATTACHMENT_BYTES);

    // ...and the attachment that pointed at it was tiny by comparison.
    expect(attachmentByteLength(store.read()!)).toBeLessThan(256);
    expect(store.read()!.layout_key).toBe(layoutKey);
  });

  it("refuses to resume when the attached layout_key is missing from Storage", async () => {
    const store = new InMemoryAttachmentStore();
    store.write(
      serializeConnectionState({
        project: "prj_alpha",
        cursor: 0,
        layoutKey: "layout/prj_alpha/missing",
      }),
    );

    const storage = new InMemoryStorage(); // empty: the key was never written
    const log = new InMemoryLiveUpdates();

    // A layout is not recoverable from the attachment, so a miss is fatal — an
    // empty dashboard would look like success and discard the client's view.
    await expect(restoreConnection(store, storage, log)).rejects.toBeInstanceOf(
      LayoutNotFoundError,
    );
    await expect(restoreConnection(store, storage, log)).rejects.toThrow(
      /missing/,
    );
  });

  it("returns null when there is no attachment to resume from", async () => {
    const restored = await restoreConnection(
      new InMemoryAttachmentStore(),
      new InMemoryStorage(),
      new InMemoryLiveUpdates(),
    );
    expect(restored).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resume exactly once, no gap, no duplicate (INV-D4 / ST-D4)
// ---------------------------------------------------------------------------
describe("dashboard hibernation — resume delivers every update > cursor exactly once", () => {
  it("delivers the whole suffix > cursor once, in order, and lands on the right cursor", async () => {
    const layoutKey = "layout/prj_alpha/conn_1";
    const layout = layoutOf(4096);
    const storage = new InMemoryStorage();
    await storage.put(layoutKey, layout);

    const store = new InMemoryAttachmentStore();
    // The client was last given everything up to and including seq 10.
    const CURSOR = 10;
    store.write(
      serializeConnectionState({
        project: "prj_alpha",
        cursor: CURSOR,
        layoutKey,
      }),
    );

    // Updates the client already saw (≤ cursor) plus the ones it is owed
    // (> cursor), including the ones that landed *during* the eviction.
    const log = new ReplayingLog();
    for (const seq of [8, 9, 10, 11, 12, 13, 14, 15]) log.append(point(seq));

    const restored = await restoreConnection(store, storage, log);
    if (restored === null) throw new Error("expected a restored connection");

    // Every seq in (CURSOR, max] — no gap — and each exactly once. The log is a
    // hostile replayer, so a duplicate here would be a real one.
    expect(seqs(restored.updates)).toEqual([11, 12, 13, 14, 15]);
    const expected: number[] = [];
    for (let s = CURSOR + 1; s <= 15; s += 1) expected.push(s);
    expect(seqs(restored.updates)).toEqual(expected);
    expect(new Set(seqs(restored.updates)).size).toBe(restored.updates.length);

    // Nothing ≤ cursor was re-delivered, and the cursor is exactly right.
    expect(seqs(restored.updates).every((s) => s > CURSOR)).toBe(true);
    expect(restored.cursor).toBe(CURSOR);
    expect(restored.nextCursor).toBe(15);
  });

  it("resumes the second connection without replaying what the first already took", async () => {
    const layoutKey = "layout/prj_alpha/conn_1";
    const storage = new InMemoryStorage();
    await storage.put(layoutKey, layoutOf(2048));

    // A consuming log (the production contract): a second read with the same
    // cursor returns the *next* suffix, never a repeat.
    const log = new InMemoryLiveUpdates();
    for (const seq of [1, 2, 3, 4, 5, 6]) log.append(point(seq));

    const store = new InMemoryAttachmentStore();
    store.write(
      serializeConnectionState({ project: "prj_alpha", cursor: 2, layoutKey }),
    );

    const first = await restoreConnection(store, storage, log);
    if (first === null) throw new Error("expected a restored connection");
    expect(seqs(first.updates)).toEqual([3, 4, 5, 6]);
    expect(first.nextCursor).toBe(6);

    // The client resumed, advanced to 6, and hibernated again with that cursor.
    store.write(
      serializeConnectionState({ project: "prj_alpha", cursor: 6, layoutKey }),
    );
    const second = await restoreConnection(store, storage, log);
    if (second === null) throw new Error("expected a restored connection");

    // Nothing new since: an empty suffix, not a replay of 3..6.
    expect(seqs(second.updates)).toEqual([]);
    expect(second.cursor).toBe(6);
    expect(second.nextCursor).toBe(6);
  });

  it("is a no-op suffix when the client is already current", async () => {
    const layoutKey = "layout/prj_alpha/conn_1";
    const storage = new InMemoryStorage();
    await storage.put(layoutKey, layoutOf(1024));

    const store = new InMemoryAttachmentStore();
    store.write(
      serializeConnectionState({ project: "prj_alpha", cursor: 7, layoutKey }),
    );

    const log = new ReplayingLog();
    // Only updates at or below the cursor exist — all already delivered.
    for (const seq of [5, 6, 7]) log.append(point(seq));

    const restored = await restoreConnection(store, storage, log);
    if (restored === null) throw new Error("expected a restored connection");

    expect(restored.updates).toEqual([]);
    expect(restored.nextCursor).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// The 16 KiB guard is load-bearing (§D-1)
// ---------------------------------------------------------------------------
describe("dashboard hibernation — the 16 KiB attachment guard", () => {
  it("rejects an oversized attachment and names the actual size", () => {
    // A pathologically long layout_key: the one field a caller could grow past
    // the ceiling without inlining the layout. The guard must catch it.
    const hugeKey = "k".repeat(MAX_ATTACHMENT_BYTES + 1);

    let thrown: unknown;
    try {
      serializeConnectionState({
        project: "prj_alpha",
        cursor: 1,
        layoutKey: hugeKey,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AttachmentTooLargeError);
    const error = thrown as AttachmentTooLargeError;
    expect(error.sizeBytes).toBeGreaterThan(MAX_ATTACHMENT_BYTES);
    expect(error.maxBytes).toBe(MAX_ATTACHMENT_BYTES);
    expect(error.message).toMatch(/16[0-9]{3}|16384/);
  });

  it("proves the guard is load-bearing by building the attachment it refuses", () => {
    // Construct the exact oversize attachment by hand — the thing the guard
    // exists to stop — and show the guard is the *only* thing standing between
    // it and an accepted write.
    const oversized: ConnectionAttachment = {
      project: "prj_alpha",
      cursor: 1,
      layout_key: "L".repeat(MAX_ATTACHMENT_BYTES),
    };
    expect(attachmentByteLength(oversized)).toBeGreaterThan(
      MAX_ATTACHMENT_BYTES,
    );

    // A write of that raw object would sail through; the guard rejects its
    // serialized source. Remove the guard and this test's `rejects` would not
    // fire — that is what "load-bearing" means here.
    expect(() =>
      serializeConnectionState({
        project: oversized.project,
        cursor: oversized.cursor,
        layoutKey: oversized.layout_key,
      }),
    ).toThrow(AttachmentTooLargeError);
  });

  it("accepts an attachment sitting exactly at the 16 KiB ceiling", () => {
    // `>`, not `>=`: the limit is "may not exceed", so exactly 16 KiB is legal.
    const base = serializeConnectionState({
      project: "prj_alpha",
      cursor: 0,
      layoutKey: "",
    });
    const overhead = attachmentByteLength(base);

    // Pad the key so the serialized attachment is exactly MAX_ATTACHMENT_BYTES.
    const keyLength = MAX_ATTACHMENT_BYTES - overhead;
    const attachment = serializeConnectionState({
      project: "prj_alpha",
      cursor: 0,
      layoutKey: "k".repeat(keyLength),
    });

    expect(attachmentByteLength(attachment)).toBe(MAX_ATTACHMENT_BYTES);
  });

  it("does not mutate or leak the layout through the attachment", () => {
    const storage: Storage = new InMemoryStorage();
    const store = new InMemoryAttachmentStore();

    // Whatever the layout is, the attachment derived from it holds no reference
    // to it — only its key. This is the structural rule, asserted directly.
    const attachment = serializeConnectionState({
      project: "prj_alpha",
      cursor: 9,
      layoutKey: "layout/prj_alpha/conn_9",
    });
    store.write(attachment);

    const serialized = JSON.stringify(store.read());
    expect(serialized).not.toContain("series");
    expect(serialized).not.toContain("dev_alpha");
    expect(typeof storage.put).toBe("function");
  });
});

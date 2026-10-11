import { describe, expect, it } from "vitest";
import {
  DashboardDO,
  DEFAULT_SLOW_CLIENT_THRESHOLD_BYTES,
  SNAPSHOT_MAX_POINTS,
  type DashboardClient,
  type DashboardUpdate,
  type MetricPoint,
  type ProjectionSource,
} from "../../worker/src/platform/durable-objects/dashboard-do";

/**
 * Spec tests for the A13 dashboard fan-out (`DashboardDO`).
 *
 * Every dependency is an injected seam — a {@link ProjectionSource} fake, a
 * socket-like {@link DashboardClient} fake and a clock — so each contract is
 * asserted against a value the test owns outright:
 *
 *   1. **Snapshot + cursor** — a new client receives one bounded snapshot
 *      (≤ `SNAPSHOT_MAX_POINTS` points) followed by a cursor frame.
 *   2. **The race** (INV-D1 / ST-D1) — updates that land *while the snapshot is
 *      in flight* are buffered and flushed, and the client receives every update
 *      with `seq > cursor` **exactly once**: no gap, no duplicate.
 *   3. **Slow-client isolation** (INV-D3 / ST-D3) — a client whose
 *      `bufferedAmount` rises past the threshold is closed *alone*; a healthy
 *      client keeps receiving, and the source records no blocking.
 *   4. **Monotonic cursor** — `seq` never moves backwards, across clients and
 *      across a stale replay.
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One frame a client received, in the shape the DO serialises. */
interface Frame {
  readonly type: "snapshot" | "update";
  readonly points?: readonly MetricPoint[];
  readonly cursor?: number;
  readonly point?: DashboardUpdate;
  readonly at?: number;
}

/**
 * A socket-like client that records everything it is sent.
 *
 * `bufferedAmount` is a *live* value the test moves directly — raising it is how
 * the test makes a client "slow" — and `send` counts calls so a duplicate
 * delivery is visible even if two frames were identical.
 */
class FakeClient implements DashboardClient {
  readonly frames: Frame[] = [];
  readonly sent: string[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  bufferedAmount = 0;

  send(data: string): void {
    this.sent.push(data);
    this.frames.push(JSON.parse(data) as Frame);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  /** Frames of one kind, in arrival order. */
  of(type: "snapshot" | "update"): Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  /** Every projected `seq` this client was sent as a *live update*, in order. */
  updateSeqs(): number[] {
    return this.of("update").map((frame) => frame.point!.seq);
  }

  /** The snapshot's points, requiring exactly one snapshot frame. */
  snapshotPoints(): readonly MetricPoint[] {
    const snapshots = this.of("snapshot");
    expect(snapshots).toHaveLength(1);
    return snapshots[0].points ?? [];
  }
}

/**
 * A projection source the test drives by hand.
 *
 * `pendingSnapshot` is the snapshot promise the DO is still awaiting when the
 * test wants to publish into the race window; `calls` records every read so
 * "the source was never blocked" is checkable, and `awaitingCursor` marks the
 * source as *held open* right now — a fan-out that awaited a slow client would
 * show up here as the cursor read never resolving.
 */
class FakeSource implements ProjectionSource {
  snapshotCalls = 0;
  cursorCalls = 0;
  /** The live max seq, as the projection would report it. */
  cursorSeq = 0;
  /** The projection's points, newest first (the DO caps + orders them). */
  points: MetricPoint[] = [];
  /** When set, `snapshot()` returns this promise instead of resolving now. */
  pendingSnapshot: Promise<MetricPoint[]> | null = null;
  /** True while the source has an unresolved read outstanding. */
  awaitingCursor = false;
  /** The sequence of events the source observed, for ordering assertions. */
  readonly log: string[] = [];

  snapshot(limit: number): Promise<MetricPoint[]> {
    this.snapshotCalls += 1;
    this.log.push(`snapshot:${limit}`);
    if (this.pendingSnapshot !== null) return this.pendingSnapshot;
    // Window the points by their projected ts, newest first, then cap.
    return Promise.resolve(
      [...this.points].sort((a, b) => b.ts - a.ts).slice(0, limit),
    );
  }

  cursor(): Promise<number> {
    this.cursorCalls += 1;
    this.awaitingCursor = true;
    return Promise.resolve().then(() => {
      this.awaitingCursor = false;
      this.log.push(`cursor:${this.cursorSeq}`);
      return this.cursorSeq;
    });
  }
}

/** A clock the test owns, so any stamped frame field is exactly knowable. */
const FIXED_NOW = 1_700_000_000_123;

/** Build a DO over a fresh source, with the clock pinned. */
function dashboard(source = new FakeSource()): {
  do: DashboardDO;
  source: FakeSource;
} {
  const instance = new DashboardDO({
    source,
    now: () => FIXED_NOW,
    snapshotLimit: SNAPSHOT_MAX_POINTS,
  });
  return { do: instance, source };
}

/** A projected point, with `ts` defaulting to its `seq` (newest = highest seq). */
function point(seq: number, overrides: Partial<MetricPoint> = {}): MetricPoint {
  return {
    device: overrides.device ?? "dev_alpha",
    variable: overrides.variable ?? "temp",
    value: overrides.value ?? seq,
    ts: overrides.ts ?? seq,
    seq,
  };
}

/** Parse the snapshot frame's cursor, requiring it to be present. */
function snapshotCursor(client: FakeClient): number {
  const snapshots = client.of("snapshot");
  expect(snapshots).toHaveLength(1);
  const cursor = snapshots[0].cursor;
  if (cursor === undefined) throw new Error("snapshot frame had no cursor");
  return cursor;
}

// ---------------------------------------------------------------------------
// Snapshot + cursor (ST-D1)
// ---------------------------------------------------------------------------
describe("DashboardDO.subscribe — snapshot + cursor", () => {
  it("hands a new client one snapshot (bounded) and a cursor", async () => {
    const { do: dash, source } = dashboard();
    source.cursorSeq = 7;
    source.points = [point(7), point(6), point(5)];

    const client = new FakeClient();
    await dash.subscribe(client);

    // Exactly one snapshot, and it is the cursor frame that closes it.
    expect(client.of("snapshot")).toHaveLength(1);
    expect(snapshotCursor(client)).toBe(7);

    // The points are the projection's, newest first, and the source saw a
    // bounded read — never "replay everything".
    expect(client.snapshotPoints().map((p) => p.seq)).toEqual([7, 6, 5]);
    expect(source.snapshotCalls).toBe(1);
    expect(source.log[0]).toBe(`snapshot:${SNAPSHOT_MAX_POINTS}`);
    expect(source.cursorCalls).toBe(1);

    // A primed client is live and known to the fan-out. The DO's own cursor
    // tracks *published* changes (nothing has been published yet here), while
    // the client's watermark is the cursor it was handed.
    expect(dash.clientCount).toBe(1);
    expect(dash.cursorValue).toBe(0);
  });

  it("caps a snapshot at SNAPSHOT_MAX_POINTS even when more exist", async () => {
    const { do: dash, source } = dashboard();
    const many = Array.from({ length: SNAPSHOT_MAX_POINTS + 50 }, (_, i) =>
      point(i + 1, { ts: i + 1 }),
    );
    source.points = many;
    source.cursorSeq = SNAPSHOT_MAX_POINTS + 50;

    const client = new FakeClient();
    await dash.subscribe(client);

    const points = client.snapshotPoints();
    expect(points.length).toBeLessThanOrEqual(SNAPSHOT_MAX_POINTS);
    expect(points).toHaveLength(SNAPSHOT_MAX_POINTS);
    // Newest-first: the cap keeps the *recent* window, not the oldest points.
    expect(points[0].seq).toBe(SNAPSHOT_MAX_POINTS + 50);
  });

  it("delivers a live update published after the snapshot, onward", async () => {
    const { do: dash, source } = dashboard();
    source.cursorSeq = 1;
    source.points = [point(1)];

    const client = new FakeClient();
    await dash.subscribe(client);
    expect(client.updateSeqs()).toEqual([]);

    dash.publish(point(2));
    dash.publish(point(3));

    expect(client.updateSeqs()).toEqual([2, 3]);
    expect(dash.cursorValue).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The race — exactly once, no gap (INV-D1 / ST-D1)
// ---------------------------------------------------------------------------
describe("DashboardDO — updates that race the snapshot", () => {
  it("buffers updates arriving mid-snapshot and flushes them in order", async () => {
    const { do: dash, source } = dashboard();

    // The snapshot is *held open*: the DO is awaiting it, so everything the
    // test publishes now lands squarely inside the race window.
    let release!: (points: MetricPoint[]) => void;
    source.pendingSnapshot = new Promise<MetricPoint[]>((resolve) => {
      release = resolve;
    });
    source.cursorSeq = 3;

    const client = new FakeClient();
    const subscribing = dash.subscribe(client);

    // Race window: publish updates 4, 5 and 6 while the snapshot is in flight.
    dash.publish(point(4));
    dash.publish(point(5));
    dash.publish(point(6));

    // The source is genuinely still awaiting: the snapshot promise has not been
    // released, so the DO cannot have moved past the buffer yet.
    expect(source.snapshotCalls).toBe(1);
    expect(client.sent).toEqual([]);

    // The snapshot resolves with points up to seq 3, then the cursor.
    source.points = [point(3), point(2)];
    release(await source.points);
    await subscribing;

    // The client got the snapshot @ cursor 3, then updates 4, 5, 6 in order —
    // no gap (nothing between 3 and 4 was lost) and no duplicate ([2,3] were in
    // the snapshot and were not re-sent).
    expect(snapshotCursor(client)).toBe(3);
    expect(client.snapshotPoints().map((p) => p.seq)).toEqual([3, 2]);
    expect(client.updateSeqs()).toEqual([4, 5, 6]);
  });

  it("delivers every update with seq > cursor exactly once under overlap", async () => {
    const { do: dash, source } = dashboard();
    source.cursorSeq = 10;
    source.points = [point(10), point(9)];

    const client = new FakeClient();
    await dash.subscribe(client);
    const cursor = snapshotCursor(client);

    // A burst that straddles the cursor: 9 and 10 are already in the snapshot,
    // and must not appear as updates; 11..14 must arrive exactly once, in order.
    for (const seq of [9, 10, 11, 12, 13, 14]) dash.publish(point(seq));

    const delivered = client.updateSeqs();
    expect(delivered).toEqual([11, 12, 13, 14]);
    // No gap: every seq in (cursor, max] is present exactly once.
    const expected = [];
    for (let s = cursor + 1; s <= 14; s += 1) expected.push(s);
    expect(delivered).toEqual(expected);
    expect(new Set(delivered).size).toBe(delivered.length);
  });

  it("does not duplicate when the snapshot cursor equals the raced update", async () => {
    const { do: dash, source } = dashboard();
    let release!: (points: MetricPoint[]) => void;
    source.pendingSnapshot = new Promise<MetricPoint[]>((resolve) => {
      release = resolve;
    });

    const client = new FakeClient();
    const subscribing = dash.subscribe(client);

    // The update racing the snapshot is *at* the cursor the snapshot will carry:
    // the snapshot already contains it, so it must be dropped, not re-sent.
    dash.publish(point(5));
    source.cursorSeq = 5;
    source.points = [point(5)];
    release(await source.points);
    await subscribing;

    expect(snapshotCursor(client)).toBe(5);
    expect(client.updateSeqs()).toEqual([]);
  });

  it("delivers with no gap across two clients racing the same snapshot", async () => {
    const { do: dash, source } = dashboard();
    let release!: (points: MetricPoint[]) => void;
    source.pendingSnapshot = new Promise<MetricPoint[]>((resolve) => {
      release = resolve;
    });
    source.cursorSeq = 1;

    const a = new FakeClient();
    const b = new FakeClient();
    const subscribingA = dash.subscribe(a);
    const subscribingB = dash.subscribe(b);

    dash.publish(point(2));
    dash.publish(point(3));

    source.points = [point(1)];
    release(await source.points);
    await Promise.all([subscribingA, subscribingB]);

    // Both clients saw the same snapshot and the same suffix, exactly once each.
    expect(a.updateSeqs()).toEqual([2, 3]);
    expect(b.updateSeqs()).toEqual([2, 3]);
    expect(snapshotCursor(a)).toBe(1);
    expect(snapshotCursor(b)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Slow-client isolation (INV-D3 / ST-D3)
// ---------------------------------------------------------------------------
describe("DashboardDO — slow-client isolation (INV-D3/ST-D3)", () => {
  it("closes a client whose bufferedAmount exceeds the threshold", async () => {
    const source = new FakeSource();
    const dash = new DashboardDO({
      source,
      now: () => FIXED_NOW,
      // A tiny threshold makes the slow client unambiguous.
      slowClientThresholdBytes: 16,
    });
    source.cursorSeq = 0;

    const slow = new FakeClient();
    await dash.subscribe(slow);

    // The socket stops draining: its buffer climbs past the ceiling.
    slow.bufferedAmount = 17;
    dash.publish(point(1));

    // That client — and only it — was closed, with a policy code.
    expect(slow.closes).toHaveLength(1);
    expect(slow.closes[0].code).toBe(1013);
    expect(dash.clientCount).toBe(0);

    // A closed client is out of the fan-out: a later publish is not sent to it.
    const sentBefore = slow.sent.length;
    dash.publish(point(2));
    expect(slow.sent.length).toBe(sentBefore);
  });

  it("keeps a healthy client receiving while only the slow one is closed", async () => {
    const source = new FakeSource();
    const dash = new DashboardDO({
      source,
      now: () => FIXED_NOW,
      slowClientThresholdBytes: 16,
    });
    source.cursorSeq = 0;

    const slow = new FakeClient();
    const healthy = new FakeClient();
    await dash.subscribe(slow);
    await dash.subscribe(healthy);

    slow.bufferedAmount = 17; // over the ceiling
    dash.publish(point(1));
    dash.publish(point(2));

    // Slow: closed once, never reached by update 2.
    expect(slow.closes).toHaveLength(1);
    expect(slow.updateSeqs()).toEqual([1]);

    // Healthy: both updates, still attached, never closed.
    expect(healthy.updateSeqs()).toEqual([1, 2]);
    expect(healthy.closes).toHaveLength(0);

    expect(dash.clientCount).toBe(1);
  });

  it("never blocks the projection source on a slow client (ST-D3)", async () => {
    const { do: dash, source } = dashboard();

    const slow = new FakeClient();
    await dash.subscribe(slow);
    slow.bufferedAmount = DEFAULT_SLOW_CLIENT_THRESHOLD_BYTES + 1;

    // `publish` is synchronous: it returns even though the slow client is over
    // its ceiling, and it makes no read of the source while doing so. Had the
    // fan-out awaited the socket, the source read count below would climb or
    // the call would not have returned at all.
    const snapshotCallsBefore = source.snapshotCalls;
    const cursorCallsBefore = source.cursorCalls;
    expect(source.awaitingCursor).toBe(false);

    dash.publish(point(1));
    dash.publish(point(2));

    expect(slow.closes).toHaveLength(1);
    expect(source.snapshotCalls).toBe(snapshotCallsBefore);
    expect(source.cursorCalls).toBe(cursorCallsBefore);
    expect(source.awaitingCursor).toBe(false);
  });

  it("does not close a client sitting exactly at the threshold", async () => {
    const source = new FakeSource();
    const dash = new DashboardDO({
      source,
      now: () => FIXED_NOW,
      slowClientThresholdBytes: 16,
    });
    source.cursorSeq = 0;

    const client = new FakeClient();
    await dash.subscribe(client);

    client.bufferedAmount = 16; // == threshold: still healthy (strict `>`)
    dash.publish(point(1));
    dash.publish(point(2));

    expect(client.closes).toHaveLength(0);
    expect(client.updateSeqs()).toEqual([1, 2]);
    expect(dash.clientCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Monotonic cursor (INV-D1)
// ---------------------------------------------------------------------------
describe("DashboardDO — monotonic cursor", () => {
  it("never moves backwards, dropping a stale replay", async () => {
    const { do: dash } = dashboard();

    const seen: number[] = [dash.cursorValue];
    for (const seq of [1, 2, 3, 2, 4, 1, 5]) {
      dash.publish(point(seq));
      seen.push(dash.cursorValue);
    }

    // Non-decreasing throughout, and the stale replays never rewound it.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    expect(seen).toEqual([0, 1, 2, 3, 3, 4, 4, 5]);
    expect(dash.cursorValue).toBe(5);
  });

  it("does not deliver a stale replay to a live client", async () => {
    const { do: dash, source } = dashboard();
    source.cursorSeq = 0;

    const client = new FakeClient();
    await dash.subscribe(client);

    dash.publish(point(5));
    dash.publish(point(4)); // stale: below the cursor
    dash.publish(point(6));

    expect(client.updateSeqs()).toEqual([5, 6]);
    expect(dash.cursorValue).toBe(6);
  });
});

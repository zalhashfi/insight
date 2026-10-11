/**
 * DashboardDO — the live read fan-out for one project's dashboard.
 *
 * Where the project DO owns the *current picture* of a project's telemetry
 * ({@link ../project-do}), this module owns how a **subscriber** learns about
 * changes to it: a new dashboard client gets a bounded snapshot of the
 * projection plus a cursor, and from then on receives every update that lands
 * *after* that cursor, in order, exactly once.
 *
 * ## Seams
 *
 * A plain class with no Cloudflare types in its signature — the same shape as
 * the sibling DOs:
 *
 *   - **source** — a {@link ProjectionSource} seam: read a bounded snapshot of
 *     the projection, and observe the monotonic `seq` of the newest projected
 *     change. Production adapts the project DO / its storage onto this; tests
 *     inject a fake.
 *   - **client** — a {@link DashboardClient} seam: the socket-like minimum a
 *     fan-out needs, namely `send`, `bufferedAmount` and `close`. Production
 *     adapts a Cloudflare `WebSocket`; tests inject a recording fake.
 *   - **now** — a `Clock` returning Unix epoch milliseconds, so any bookkeeping
 *     stamp is reproducible. No ambient `Date.now()` is read unless the caller
 *     omits the clock.
 *
 * ## Snapshot + cursor, and the race they must survive (INV-D1 / ST-D1)
 *
 * A snapshot is a read of shared state that takes *time*: while it is in
 * flight, new updates keep arriving. The naive order — await the snapshot,
 * subscribe, then send — loses every update that landed in between (a **gap**);
 * the opposite order — subscribe, then snapshot — re-delivers updates the
 * snapshot already contains (a **duplicate**).
 *
 * {@link DashboardDO.subscribe} resolves the race by composition:
 *
 *   1. **Subscribe first.** The client is attached to the fan-out *before* the
 *      snapshot is read, so no update can slip past it.
 *   2. **Buffer while the snapshot is in flight.** While `subscribed = true`
 *      the client is in `sending` mode: every fan-out reaches it and is appended
 *      to a per-client buffer instead of the socket.
 *   3. **Read the snapshot and the cursor.** `snapshot()` is a bounded read
 *      (≤ {@link SNAPSHOT_MAX_POINTS} points, newest first as the projection
 *      orders them) and `cursor()` is the monotonic `seq` of the newest change.
 *   4. **Send snapshot + cursor, then flush the buffer in order.** The cursor
 *      is sent as the last part of the snapshot, so a client can tell snapshot
 *      content from live content. Only then does the client flip to `live`.
 *
 * The result is the guarantee the spec asks for: the client receives a snapshot
 * at cursor `C`, and **every** update with `seq > C` **exactly once** — updates
 * older than `C` were already in the snapshot and are dropped on flush, updates
 * at or below `C` that race the snapshot are dropped for the same reason, and
 * every update above `C` is delivered once (buffered or, after the flush,
 * directly). See {@link DashboardDO.publish} and {@link DashboardDO.flush}.
 *
 * ## Monotonic cursor
 *
 * `seq` is the cursor, and {@link DashboardDO.publish} keeps it monotonic by
 * construction: it accepts a payload only when its `seq` is at least the
 * current cursor, and drops anything older as a stale replay. A cursor therefore
 * never moves backwards across a client's lifetime (INV-D1).
 *
 * ## Slow-client isolation (INV-D3 / ST-D3)
 *
 * A dashboard fan-out must never let one unresponsive client stall the others,
 * and must never let delivery block *ingest* — the source that publishes an
 * update must not be held hostage by a socket drain. So the delivery path is
 * deliberately **synchronous end to end**:
 *
 *   - {@link DashboardDO.publish} sends to every client inline and returns
 *     without awaiting anything — the source is never blocked (ST-D3).
 *   - A client whose `bufferedAmount` exceeds
 *     {@link DashboardDOOptions.slowClientThresholdBytes} is **closed, that
 *     client only**: it is marked `closed` and removed from the fan-out, so it
 *     cannot be sent to again, while every other client still receives the
 *     update.
 *
 * ## Not here (A13b)
 *
 * **WebSocket Hibernation is a separate task (A13b)** and is *not* implemented
 * here. The seam that makes it a drop-in later is deliberately narrow: the
 * fan-out state is per-client bookkeeping keyed by an opaque client, and a
 * hibernating implementation would rehydrate that bookkeeping from
 * `ctx.storage` on wake. See the {@link HibernationHook} note on
 * {@link DashboardDOOptions} — this module defines the hook, nothing more.
 */

import type { Clock } from "../lib/clock";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The most points a snapshot may carry.
 *
 * A snapshot is a *bounded* read: a dashboard paints from it immediately and
 * then follows the cursor, so it needs a useful recent window rather than the
 * whole projection. The projection's own order (newest `ts` first) is the order
 * of the returned points, and this cap is applied to that order.
 */
export const SNAPSHOT_MAX_POINTS = 300;

/**
 * The default per-client backpressure ceiling, in bytes.
 *
 * A socket whose unflushed send buffer has grown past this is a client that is
 * not keeping up: at roughly one `MetricPoint` per message, a few tens of
 * kilobytes is already hundreds of undelivered points, so the connection is
 * assumed dead rather than allowed to consume unbounded memory. See
 * {@link DashboardDO.isSlow}.
 */
export const DEFAULT_SLOW_CLIENT_THRESHOLD_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * One point in a snapshot — a projected reading, in the shape the projection
 * already exposes. Deliberately the {@link StateRow} fields the dashboard needs
 * and nothing DO-specific.
 */
export interface MetricPoint {
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
  /** The projected sample's sequence number; also the fan-out cursor. */
  readonly seq: number;
}

/** One live update: a point whose projected `seq` is newer than a client's cursor. */
export type DashboardUpdate = MetricPoint;

/**
 * The projection source this DO fans out from.
 *
 * Two reads, both promise-based, so the production adapter (the project DO or
 * its storage) and the test fake satisfy it identically:
 *
 *   - {@link ProjectionSource.snapshot} — at most `limit` points of the current
 *     projection, newest first, with `seq <= cursor` (so the snapshot never
 *     contains anything a client must *also* receive live).
 *   - {@link ProjectionSource.cursor} — the monotonic `seq` of the newest
 *     projected change. The two are read in this order, snapshot first, so the
 *     cursor a client is given is always ≥ any point inside its snapshot.
 */
export interface ProjectionSource {
  /** The current projection, newest first, capped at `limit` points. */
  snapshot(limit: number): Promise<MetricPoint[]>;
  /** The monotonic `seq` of the newest projected change. */
  cursor(): Promise<number>;
}

/**
 * The socket-like seam one dashboard client presents.
 *
 * This is the minimum fan-out needs, and no more — a Cloudflare `WebSocket`
 * satisfies it as-is, and so does a test's recording fake:
 *
 *   - {@link DashboardClient.send} — queue one already-serialised message.
 *     Synchronous by design, so publishing never awaits a socket.
 *   - {@link DashboardClient.bufferedAmount} — bytes queued but not yet written
 *     to the network. The backpressure signal (see {@link DashboardDO.isSlow}).
 *   - {@link DashboardClient.close} — terminate this client only. Called when it
 *     is slow; never for a healthy one.
 */
export interface DashboardClient {
  send(data: string): void;
  readonly bufferedAmount: number;
  close(code?: number, reason?: string): void;
}

/**
 * Documented hook for **A13b (WebSocket Hibernation)** — not implemented here.
 *
 * Hibernation is a *lifetime* change, not a protocol change: the DO would be
 * evicted between messages and rehydrated on the next one. Everything this
 * module needs to support that is already a seam — the projection source and
 * per-client bookkeeping keyed by an opaque client — so the work A13b would do
 * is, on wake, to rebuild {@link DashboardDO}'s client table from persisted
 * state rather than from live sockets.
 *
 * The hook exists so that change has one obvious home; it is intentionally not
 * called by this implementation.
 */
export interface HibernationHook {
  /** Called instead of `init` when the DO is being rehydrated from a wake. */
  readonly rehydrate?: () => Promise<void>;
}

/** Construction options for {@link DashboardDO}. */
export interface DashboardDOOptions {
  readonly source: ProjectionSource;
  /** Points per snapshot; defaults to {@link SNAPSHOT_MAX_POINTS}. */
  readonly snapshotLimit?: number;
  /** Backpressure ceiling in bytes; defaults to the module default. */
  readonly slowClientThresholdBytes?: number;
  /** Clock returning Unix epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: Clock;
  /** Reserved for A13b; see {@link HibernationHook}. */
  readonly hibernation?: HibernationHook;
}

// ---------------------------------------------------------------------------
// Per-client state
// ---------------------------------------------------------------------------

/**
 * What the DO knows about one subscribed client.
 *
 * `mode` is the whole snapshot race in one field:
 *
 *   - `sending` — the snapshot is in flight; fan-out messages are **buffered**.
 *   - `live`    — the snapshot has been sent; fan-out messages go straight out.
 *   - `closed`  — the client is gone (slow, or explicitly removed). Never sent
 *     to again.
 *
 * `cursor` is the client's watermark: the highest `seq` it has been *given*
 * (snapshot included). It is what "exactly once, no gap" is defined against.
 */
interface Subscription {
  readonly client: DashboardClient;
  mode: "sending" | "live" | "closed";
  /** Updates held while the snapshot is in flight, in arrival order. */
  readonly buffer: DashboardUpdate[];
  /** The client's watermark: highest `seq` delivered (snapshot + live). */
  cursor: number;
}

// ---------------------------------------------------------------------------
// DashboardDO
// ---------------------------------------------------------------------------

/**
 * The live dashboard fan-out for one project.
 *
 * Construct with {@link DashboardDOOptions}, then:
 *
 *   - {@link DashboardDO.subscribe} — attach a client; resolves once it has its
 *     snapshot + cursor and the buffer has been flushed.
 *   - {@link DashboardDO.publish} — fan one projected change out to every live
 *     client. Synchronous: it never awaits, so it never blocks its source.
 *   - {@link DashboardDO.clientCount} / {@link DashboardDO.cursorValue} —
 *     diagnostics a test (or an operator) can assert on.
 */
export class DashboardDO {
  private readonly source: ProjectionSource;
  private readonly clock: Clock;
  private readonly snapshotLimit: number;
  private readonly slowClientThresholdBytes: number;

  /**
   * Every client the DO is fanning out to, live or mid-snapshot.
   *
   * Insertion-ordered, so delivery order across clients is the order they
   * subscribed — deterministic, and therefore assertable.
   */
  private readonly clients = new Set<DashboardClient>();
  private readonly subscriptions = new Map<DashboardClient, Subscription>();

  /** The fan-out cursor: the monotonic `seq` of the newest published change. */
  private seq = 0;

  constructor(options: DashboardDOOptions) {
    this.source = options.source;
    this.clock = options.now ?? (() => Date.now());
    this.snapshotLimit = options.snapshotLimit ?? SNAPSHOT_MAX_POINTS;
    this.slowClientThresholdBytes =
      options.slowClientThresholdBytes ?? DEFAULT_SLOW_CLIENT_THRESHOLD_BYTES;
    // `options.hibernation` is accepted and ignored — A13b's hook, not A13's.
  }

  /**
   * How many clients are currently attached (including mid-snapshot ones).
   *
   * Kept as a named accessor rather than exposing the table: it is the fan-out's
   * observable membership, the thing a dashboard test asserts isolation on.
   */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * The current fan-out cursor (`seq`). Monotonic by construction.
   *
   * A named accessor because the cursor is the module's public watermark — the
   * value every "exactly once, no gap" claim is stated against.
   */
  get cursorValue(): number {
    return this.seq;
  }

  /**
   * Attach one client and deliver its snapshot + cursor, then follow live.
   *
   * The order is load-bearing and is exactly the invariant (INV-D1 / ST-D1):
   *
   *   1. record the client in `sending` mode — **before** awaiting the source,
   *      so an update published during the snapshot is buffered, not lost;
   *   2. read the bounded snapshot, then the cursor, from the source;
   *   3. send the snapshot points, then a `snapshot` control frame carrying the
   *      cursor;
   *   4. flush the buffer in arrival order, delivering every buffered update
   *      with `seq > cursor` **exactly once**, and drop anything `<= cursor`
   *      (already inside the snapshot);
   *   5. flip to `live`, after which fan-out goes straight to the socket.
   *
   * Resolves once the flush is done, so a caller that awaits `subscribe` can
   * assert on a fully-primed client.
   */
  async subscribe(client: DashboardClient): Promise<void> {
    // A client that re-subscribes keeps its place rather than double-counting.
    if (this.subscriptions.has(client)) return;

    // (1) Attach first. From here on, `publish` finds this client and buffers.
    const sub: Subscription = {
      client,
      mode: "sending",
      buffer: [],
      cursor: 0,
    };
    this.subscriptions.set(client, sub);
    this.clients.add(client);

    // (2) Bounded snapshot, then the cursor. Snapshot first, so the cursor the
    // client is handed is always >= every seq inside that snapshot.
    const points = await this.source.snapshot(this.snapshotLimit);
    const cursor = await this.source.cursor();

    // The client may have been closed while the snapshot was in flight (a slow
    // client, or an explicit removal): nothing more is sent to it.
    if (sub.mode === "closed") return;

    // (3) The snapshot, then its cursor, as distinct frames: a client can tell
    // "this is your starting picture @ C" from "this is a live change".
    this.sendJson(client, { type: "snapshot", points, cursor });

    // The cursor is the client's watermark as well: the snapshot is *at* C, so
    // buffered updates at or below C are duplicates and must not be re-sent.
    sub.cursor = cursor;

    // (4) Drain the race window, in arrival order, exactly once. `flush` reports
    // whether the client survived it: a client that tripped its threshold
    // mid-flush is already closed and must not be flipped to live.
    if (!this.flush(sub)) return;

    // (5) Live from here: publish() sends directly (and still applies the
    // cursor gate, so a stale replay is never delivered).
    sub.mode = "live";
  }

  /**
   * Fan one projected change out to every attached client.
   *
   * Deliberately **synchronous**: there is no `await` anywhere on this path, so
   * a publish can never be held up by a client's socket — the source that
   * published is never blocked (INV-D3 / ST-D3). Backpressure is handled the
   * only safe way for a fan-out: a client over its threshold is closed, that
   * client alone, and everyone else is unaffected.
   *
   * Cursor monotonicity: a payload whose `seq` is below the current cursor is a
   * stale replay and is dropped rather than delivered, so the cursor (and every
   * client's watermark) never moves backwards.
   */
  publish(update: DashboardUpdate): void {
    if (update.seq < this.seq) return; // stale replay: the cursor never rewinds
    this.seq = update.seq;

    for (const sub of [...this.subscriptions.values()]) {
      if (sub.mode === "closed") continue;
      if (update.seq <= sub.cursor) continue; // already delivered, exactly once

      if (sub.mode === "sending") {
        // Snapshot still in flight: hold it, in order, for the flush.
        sub.buffer.push(update);
        continue;
      }

      // Live: send inline. A send that pushes the client past its threshold
      // gets the client closed — for that client only — and nothing else.
      this.deliver(sub, update);
    }
  }

  /** Remove a client (e.g. its socket closed on the far end) from the fan-out. */
  unsubscribe(client: DashboardClient): void {
    this.closeClient(client, 1000, "unsubscribed");
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Drain one client's buffer, in arrival order, sending each held update once.
   *
   * The buffer holds every update that raced the snapshot, but the snapshot
   * itself covers everything at or below the cursor — so an update `<= cursor`
   * is a duplicate and is dropped, and each `> cursor` is sent exactly once and
   * advances the client's watermark. A client that trips its threshold mid-flush
   * is closed and the rest of its buffer is discarded (it is gone; no other
   * client is touched).
   *
   * Returns `false` when the client was closed during the flush, so the caller
   * knows not to re-read (and cannot mis-narrow) `sub.mode`.
   */
  private flush(sub: Subscription): boolean {
    for (const update of sub.buffer) {
      if (sub.mode === "closed") break;
      if (update.seq <= sub.cursor) continue; // covered by the snapshot
      this.deliver(sub, update);
    }
    sub.buffer.length = 0;
    return sub.mode !== "closed";
  }

  /**
   * Send one update to one live client and apply the backpressure policy.
   *
   * The watermark advances *before* the send is judged, because the update has
   * been handed to the socket: it must not be re-sent on a later flush, slow or
   * not. The threshold check is the isolation rule (INV-D3): the offending
   * client is closed, and the caller's loop simply moves on to the next one.
   *
   * The comparison is strict (`>`), so a client sitting exactly at the threshold
   * is still healthy — the threshold is "past this", not "from here".
   */
  private deliver(sub: Subscription, update: DashboardUpdate): void {
    this.sendJson(sub.client, { type: "update", point: update });
    sub.cursor = update.seq;
    if (sub.client.bufferedAmount > this.slowClientThresholdBytes) {
      this.closeClient(sub.client, 1013, "slow_client");
    }
  }

  /**
   * Close one client and forget it.
   *
   * `closed` is set before the socket call and the client is removed from both
   * tables, so no later publish can find it — a closed client is never sent to
   * again, and its buffer is dropped with it. Every other client is untouched,
   * which is the whole of "close that client only".
   */
  private closeClient(
    client: DashboardClient,
    code?: number,
    reason?: string,
  ): void {
    const sub = this.subscriptions.get(client);
    if (sub !== undefined) {
      sub.mode = "closed";
      sub.buffer.length = 0;
      this.subscriptions.delete(client);
    }
    this.clients.delete(client);
    client.close(code, reason);
  }

  /**
   * Serialise and hand one frame to a client.
   *
   * A `send` on a socket that is already gone throws; a fan-out must not let
   * that take down the publish for *every other* client, so the failure is
   * contained here and treated as the client being dead — it is dropped from
   * the fan-out and the caller carries on. `now` is stamped so frames carry a
   * reproducible clock reading (see {@link DashboardDOOptions.now}).
   */
  private sendJson(
    client: DashboardClient,
    frame: {
      readonly type: "snapshot" | "update";
      readonly points?: readonly MetricPoint[];
      readonly point?: DashboardUpdate;
      readonly cursor?: number;
    },
  ): void {
    const payload = JSON.stringify({ ...frame, at: this.clock() });
    try {
      client.send(payload);
    } catch {
      this.closeClient(client);
    }
  }
}

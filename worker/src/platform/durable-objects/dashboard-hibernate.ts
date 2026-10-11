/**
 * DashboardDO hibernation / restore (A13b).
 *
 * A {@link DashboardDO} fans a project's projection out to live WebSocket
 * clients (A13). Hibernation is a *lifetime* change, not a protocol change: the
 * DO may be evicted between messages, its in-memory tables — the client set, the
 * per-client buffers, the cursor — gone, and the instance rehydrated on the next
 * message. This module is the narrow seam that makes that survivable, layered
 * over the same fan-out rather than reaching into it.
 *
 * ## The one thing that survives: the attachment
 *
 * On eviction Cloudflare keeps exactly one per-connection bit: the
 * {@link WebSocket} **attachment**, a ≤16 KiB opaque blob on the socket. It is
 * *the only* state that outlives the DO, so it has to be the whole of what a
 * reconnecting client needs to resume. This module makes it exactly that:
 *
 *   - {@link serializeConnectionState} packs `{project, cursor, layout_key}`
 *     into a compact attachment — a project tag, the client's watermark, and a
 *     **pointer** to the layout, never the layout itself.
 *   - The layout (potentially hundreds of KB) lives in **Storage**, keyed by
 *     `layout_key`; on wake {@link restoreConnection} reads it back by that key.
 *   - The attachment is asserted and enforced **≤ {@link MAX_ATTACHMENT_BYTES}
 *     (16 KiB)** at serialisation time (§D-1, provisional): an over-large
 *     attachment is *rejected*, not truncated, because a truncated attachment
 *     would silently drop the cursor and re-deliver or lose a client's updates.
 *
 * ## Resuming exactly once (INV-D4 / ST-D4)
 *
 * A resume is the same "no gap, no duplicate" problem A13 solved for the first
 * subscribe (INV-D1), now stated across an eviction: after the DO is gone and
 * rehydrated, a client must receive **every** update with `seq > cursor`
 * **exactly once** — nothing lost in the gap the eviction left, nothing it
 * already saw delivered twice. {@link restoreConnection} reproduces A13's
 * resolution over the seams:
 *
 *   1. **Read the layout by `layout_key`** from Storage — the DO has no memory of
 *      it, so a missing layout is a hard failure, not an empty dashboard.
 *   2. **Read the cursor from the attachment alone** — the sole surviving
 *      per-connection bit; it is the watermark the resume is defined against.
 *   3. **Read the live update log** (`liveUpdates.updatesSince(cursor)`), which
 *      returns exactly the updates `> cursor` in ascending `seq` order.
 *   4. **Assemble and deliver** the layout + that suffix as one resumption, so
 *      the client's next update is `cursor + 1`: no gap.
 *
 * The "exactly once, no duplicate" half comes from the log's own contract:
 * `updatesSince(cursor)` is defined to return each update with `seq > cursor`
 * once, in order, and to move the log's own resume cursor past them as it hands
 * them over. The store and the log are separate objects, so a naive
 * re-read would see the same suffix twice; step 3 reads through the seam, which
 * advances, so a second resume with the same attachment sees the *next* suffix
 * rather than a repeat. See {@link LiveUpdateSink}.
 *
 * ## The structural rule (§D-1)
 *
 * The attachment size ceiling is what forces layout out of the attachment and
 * into Storage: layout is unbounded, the attachment is not. So this module keeps
 * the two apart by construction — a layout is only ever referenced, never
 * inlined — and the guard in {@link serializeConnectionState} is load-bearing:
 * with it removed, a fan-out that inlined even a modest layout would sail under
 * the wire limit and then fail *invalid* on the next wake. The test asserts the
 * guard rejects exactly that case.
 *
 * ## What this module does NOT do
 *
 * It does not touch {@link DashboardDO} — the fan-out is A13's and is "built
 * alongside": the client seam here is the same socket-shaped minimum, so the
 * production adapter that drives both passes one object to each. This module is
 * the lifetime layer; the DO is the fan-out. The seam is deliberately narrow —
 * an attachment store, a Storage-like key/value seam and the live-update log —
 * so the production adapter can map it one-for-one onto
 * `ws.serializeAttachment()` / `ctx.storage` without either side knowing about
 * the other.
 */

import type { DashboardUpdate, MetricPoint } from "./dashboard-do";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The largest attachment Cloudflare will keep on a WebSocket, in bytes (§D-1,
 * provisional).
 *
 * 16 KiB — `16 * 1024` — is the platform ceiling for a serialized attachment.
 * It is *provisional* in the spec sense: the number is asserted here and the
 * guard in {@link serializeConnectionState} enforces it, so if the platform
 * figure is revised the change is one constant, not a scatter of literals. The
 * value is a limit on the *serialized* attachment (a UTF-8 byte count), which is
 * the thing the platform measures, not on any in-memory field.
 */
export const MAX_ATTACHMENT_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// The attachment
// ---------------------------------------------------------------------------

/**
 * The compact per-connection attachment — the **only** bit of a client that
 * survives an eviction.
 *
 * Three fields, and deliberately no fourth:
 *
 *   - `project` — which project's dashboard this connection belongs to, so a
 *     wake can refuse (or route) a connection whose attachment names the wrong
 *     DO rather than resuming it against the wrong projection.
 *   - `cursor` — the client's watermark: the highest `seq` it has been *given*.
 *     This is what "resume with every update `> cursor`, exactly once" is
 *     defined against (INV-D4 / ST-D4).
 *   - `layout_key` — a **pointer** to the layout in Storage. The layout itself
 *     is unbounded and lives under this key; keeping only the pointer here is
 *     what holds the attachment under {@link MAX_ATTACHMENT_BYTES}.
 *
 * Field names are the wire names (`layout_key`, snake_case) so the serialized
 * form is the contract, not an artefact of how the interface happens to be
 * declared.
 */
export interface ConnectionAttachment {
  /** The project this connection belongs to. */
  readonly project: string;
  /** The client's watermark: highest `seq` delivered (snapshot + live). */
  readonly cursor: number;
  /** Storage key under which this connection's layout blob is stored. */
  readonly layout_key: string;
}

/** The three inputs {@link serializeConnectionState} packs into an attachment. */
export interface ConnectionState {
  readonly project: string;
  readonly cursor: number;
  readonly layoutKey: string;
}

/**
 * Thrown when a connection's state cannot be packed into a legal attachment.
 *
 * A distinct type rather than a bare `Error`, so a caller can tell "this
 * connection cannot hibernate" (reject it, keep it live or reload it) from an
 * unrelated failure. The message names the limit and the actual size, because
 * the cause of an oversize attachment is almost always an inlined blob rather
 * than an unlucky cursor.
 */
export class AttachmentTooLargeError extends Error {
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(sizeBytes: number, maxBytes: number) {
    super(
      `attachment is ${sizeBytes} bytes, over the ${maxBytes}-byte limit ` +
        `(MAX_ATTACHMENT_BYTES); store large dashboard state in Storage under ` +
        `layout_key and keep only the pointer in the attachment`,
    );
    this.name = "AttachmentTooLargeError";
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * The attachment's exact serialized bytes — the count the 16 KiB ceiling is on.
 *
 * The attachment is JSON, so its size is the size of its UTF-8 JSON text; there
 * is no envelope around it. `TextEncoder` is native to both the workers runtime
 * and Bun/Node ≥18, so one code path measures the guard and the test alike — a
 * guard that measured something else would be theatre.
 */
export function attachmentByteLength(attachment: ConnectionAttachment): number {
  return new TextEncoder().encode(JSON.stringify(attachment)).length;
}

/**
 * Pack a connection's resumable state into a compact attachment (§D-1).
 *
 * The result carries `{project, cursor, layout_key}` and **nothing else**: the
 * layout is not accepted here (there is no parameter for it), so the only way
 * for an attachment to grow past the ceiling is a pathologically long
 * `project`/`layout_key`, which is what the guard catches.
 *
 * The guard is load-bearing, not decorative: an attachment over
 * {@link MAX_ATTACHMENT_BYTES} would be rejected by the platform on the next
 * wake — the connection would fail to resume *at all*, losing the cursor with
 * it — so the failure is surfaced here, at serialisation, as
 * {@link AttachmentTooLargeError}. The check is `>`, so an attachment sitting
 * exactly at the ceiling is still legal (the limit is "may not exceed").
 *
 * @throws AttachmentTooLargeError when the serialized attachment exceeds the
 *   16 KiB ceiling.
 */
export function serializeConnectionState(
  state: ConnectionState,
): ConnectionAttachment {
  const attachment: ConnectionAttachment = {
    project: state.project,
    cursor: state.cursor,
    layout_key: state.layoutKey,
  };

  const size = attachmentByteLength(attachment);
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(size, MAX_ATTACHMENT_BYTES);
  }
  return attachment;
}

// ---------------------------------------------------------------------------
// Seams — attachment store, Storage, live-update log
// ---------------------------------------------------------------------------

/**
 * The per-connection attachment store — the seam over
 * `WebSocket.serializeAttachment()` / `deserializeAttachment()`.
 *
 * Serialization is deliberately the *store's* job here, not this module's: the
 * production adapter hands the attachment to the platform (which owns the wire
 * format) and the test fake keeps the object. Either way the module reads and
 * writes the *same* type it defined, so the round-trip never re-parses a shape
 * it did not produce. `null` is the platform's own empty result, mirrored
 * rather than invented.
 */
export interface AttachmentStore {
  /** Persist one connection's attachment for the next wake. */
  write(attachment: ConnectionAttachment): void;
  /** The attachment persisted for this connection, or `null` if there is none. */
  read(): ConnectionAttachment | null;
}

/**
 * The Storage-like key/value seam — the layout's home between evictions.
 *
 * Two operations, because the layout is addressed only by key and is read whole:
 * {@link Storage.put} stores a blob under a `layout_key`, {@link Storage.get}
 * reads it back. Promise-based, so the production adapter maps it onto
 * `ctx.storage.put`/`get` (both async) and the test fake resolves immediately;
 * the module does not care which.
 *
 * The value is a string (the serialized layout). Storage is *not* size-capped
 * the way an attachment is — that asymmetry is the entire reason layout lives
 * here rather than in the attachment.
 */
export interface Storage {
  /** Store `value` under `key`, replacing anything already there. */
  put(key: string, value: string): Promise<void>;
  /** The blob stored under `key`, or `null` when the key is unset. */
  get(key: string): Promise<string | null>;
}

/** One update as the log stores it — a projected point, in wire order. */
export type LiveUpdate = DashboardUpdate;

/** One update as it is attached to a restored connection's frame. */
export type RestoredUpdate = DashboardUpdate;

/**
 * The live-update log — the feed a resumed connection replays from.
 *
 * This is the seam that makes "exactly once" observable. The log is an
 * **ordered, cursor-addressable** append-only feed: {@link LiveUpdateSink.append}
 * records one projected change, and {@link LiveUpdateSink.updatesSince} returns
 * the updates a resuming client is owed — every update with `seq > cursor`, in
 * ascending `seq` order, each exactly once.
 *
 * `updatesSince` is defined as a **consuming** read for the purpose of a single
 * connection's resume: it advances the log's own resume watermark to the last
 * update it returns, so a second call with the same cursor returns the *next*
 * suffix, never a repeat. That is what lets {@link restoreConnection} be a
 * straight-line read and still guarantee no duplicate: the "deliver exactly once"
 * and "advance past what was delivered" happen together, and cannot drift apart.
 *
 * The production adapter backs this with the DO's ring/history storage; the test
 * fake is a plain array plus that same one-line advance, so the semantics are
 * asserted rather than assumed.
 */
export interface LiveUpdateSink {
  /** Record one projected change. Ordering is by `seq`. */
  append(update: LiveUpdate): void;
  /**
   * The updates owed to a client resuming at `cursor`: every update with
   * `seq > cursor`, ascending, each once. Advances the log's resume watermark
   * past what it returns (see the interface note), so it never replays them.
   */
  updatesSince(cursor: number): readonly RestoredUpdate[];
}

// ---------------------------------------------------------------------------
// The restored connection
// ---------------------------------------------------------------------------

/**
 * What {@link restoreConnection} produces: a rehydrated connection.
 *
 * The layout is the *content* the client left off with — read back from Storage
 * by `layout_key`, not from the attachment — and `updates` is the ordered suffix
 * of live changes it is owed. The two together are the resume payload.
 */
export interface RestoredConnection {
  /** The project, from the attachment. */
  readonly project: string;
  /** The cursor the resume started from, from the attachment (the watermark). */
  readonly cursor: number;
  /** The `layout_key` the layout was read under (from the attachment). */
  readonly layoutKey: string;
  /** The layout blob, read back from Storage — the large state, not in the attachment. */
  readonly layout: string;
  /** Every update with `seq > cursor`, ascending, each exactly once. */
  readonly updates: readonly RestoredUpdate[];
  /**
   * The cursor after the resume: the `seq` of the last delivered update, or the
   * starting cursor when there was nothing to deliver. The client's new
   * watermark — the invariant INV-D4/ST-D4 is stated against.
   */
  readonly nextCursor: number;
}

/**
 * A storage miss while restoring: the attachment named a `layout_key` that
 * Storage does not hold.
 *
 * A hard failure rather than a fallback to an empty layout. An empty dashboard
 * would look like success and silently discard the client's actual view; a
 * thrown miss names the key and is recoverable (the caller can force a fresh
 * snapshot) — silence is not.
 */
export class LayoutNotFoundError extends Error {
  readonly layoutKey: string;

  constructor(layoutKey: string) {
    super(
      `no layout stored under layout_key ${JSON.stringify(layoutKey)}; the ` +
        `attachment points at Storage, so a missing blob is a broken resume`,
    );
    this.name = "LayoutNotFoundError";
    this.layoutKey = layoutKey;
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Resume a hibernated connection from its surviving attachment.
 *
 * The eviction has already happened: in-memory state is gone and `attachment`
 * (read back through {@link AttachmentStore.read}) is the only per-connection
 * bit left. This rebuilds the rest — the layout, from Storage, and the owed
 * updates, from the log — and returns them as one {@link RestoredConnection}:
 *
 *   1. **Require an attachment.** A connection with none cannot resume (there is
 *      no cursor to resume from); `null` is reported, not thrown, because "was
 *      never hibernated" is a normal state the caller routes around.
 *   2. **Read the layout by `layout_key`** from Storage — the large state comes
 *      back by pointer, never from the attachment (§D-1). A miss is a hard
 *      {@link LayoutNotFoundError}.
 *   3. **Read the owed updates** `> cursor` from the log, ascending, each once
 *      (INV-D4/ST-D4): the log's consuming read is what makes the suffix a
 *      suffix and not a repeat.
 *   4. **Return** the connection with its layout, its updates, and its
 *      `nextCursor` advanced to the last update delivered.
 *
 * The cursor is taken from the attachment alone — the sole surviving
 * per-connection bit — so `updates` is by construction exactly
 * `{ u : u.seq > cursor }`, no gap the eviction could have opened and no
 * duplicate it could have replayed.
 *
 * @returns the restored connection, or `null` when the store held no attachment.
 * @throws LayoutNotFoundError when the attachment's `layout_key` is unset in
 *   Storage.
 */
export async function restoreConnection(
  attachmentStore: AttachmentStore,
  storage: Storage,
  liveUpdates: LiveUpdateSink,
): Promise<RestoredConnection | null> {
  // (1) The only surviving per-connection bit — without it there is nothing to
  // resume: no cursor to define "> cursor" against.
  const attachment = attachmentStore.read();
  if (attachment === null) return null;

  // (2) The large state, by pointer, from Storage. A miss is fatal: the layout
  // is not recoverable from the attachment, which is the point of §D-1.
  const layout = await storage.get(attachment.layout_key);
  if (layout === null) throw new LayoutNotFoundError(attachment.layout_key);

  // (3) The owed suffix, `> cursor`, exactly once. The log's read advances its
  // own watermark, so this cannot be replayed into a duplicate.
  const updates = liveUpdates.updatesSince(attachment.cursor);

  // (4) The new watermark: the last update delivered, or where we started.
  const nextCursor =
    updates.length === 0 ? attachment.cursor : updates[updates.length - 1].seq;

  return {
    project: attachment.project,
    cursor: attachment.cursor,
    layoutKey: attachment.layout_key,
    layout,
    updates,
    nextCursor,
  };
}

// ---------------------------------------------------------------------------
// In-memory implementations — honest fakes of each seam, for tests
// ---------------------------------------------------------------------------

/**
 * In-memory {@link AttachmentStore} — models a WebSocket's attachment slot.
 *
 * One slot, last-write-wins, `null` until written: exactly the platform's
 * semantics, so a test round-trip through it is a real round-trip.
 */
export class InMemoryAttachmentStore implements AttachmentStore {
  private attachment: ConnectionAttachment | null = null;

  write(attachment: ConnectionAttachment): void {
    this.attachment = { ...attachment };
  }

  read(): ConnectionAttachment | null {
    return this.attachment === null ? null : { ...this.attachment };
  }
}

/**
 * In-memory {@link Storage} — models `ctx.storage`'s key/value face.
 *
 * Unbounded (no attachment ceiling), so a test can store a layout larger than
 * {@link MAX_ATTACHMENT_BYTES} and prove the layout *belongs* in Storage: the
 * size that would reject an attachment is accepted here without complaint.
 */
export class InMemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    const value = this.values.get(key);
    return Promise.resolve(value === undefined ? null : value);
  }
}

/**
 * In-memory {@link LiveUpdateSink} — an ordered log with a consuming read.
 *
 * Updates are kept in ascending `seq` order (a resumed client must see them in
 * `seq` order, not arrival order), and `updatesSince` advances a per-cursor
 * watermark as it hands updates over: it returns each update with `seq > cursor`
 * once, then remembers the last `seq` returned for that cursor so a second call
 * returns the next suffix rather than a repeat. That single line of state is the
 * fake's whole contribution to "exactly once", and it mirrors the production
 * adapter's contract exactly.
 */
export class InMemoryLiveUpdates implements LiveUpdateSink {
  private readonly updates: LiveUpdate[] = [];
  /** Per-cursor resume watermark: the last `seq` already handed over. */
  private readonly delivered = new Map<number, number>();

  append(update: LiveUpdate): void {
    this.updates.push({ ...update });
    // Keep the log ordered by `seq`, stable for equal seqs (append order).
    this.updates.sort((a, b) => a.seq - b.seq);
  }

  updatesSince(cursor: number): readonly RestoredUpdate[] {
    const from = Math.max(cursor, this.delivered.get(cursor) ?? cursor);
    const owed = this.updates.filter((update) => update.seq > from);
    if (owed.length > 0) {
      this.delivered.set(cursor, owed[owed.length - 1].seq);
    }
    return owed.map((update) => ({ ...update }));
  }
}

/** Re-exported so a consumer can name the point type without a second import. */
export type { DashboardUpdate, MetricPoint };

import { describe, expect, it } from "vitest";
import { createApp, type App, type AppDeps } from "../../worker/src/app";
import {
  PublicDashboardService,
  type DashboardLayout,
  type FrameSource,
  type Point,
  type Share,
  type ShareResolver,
  type ProjectionSource,
} from "../../worker/src/domains/dashboards/public";
import { sha256Hex } from "../../worker/src/domains/firmware/upload";
import type { PublicDashboardError } from "../../worker/src/domains/dashboards/public";

/**
 * Spec tests for the A24 PUBLIC STREAM route — `/v1/public/dashboards/:token/stream`.
 *
 * The snapshot route is already pinned; this suite covers the *live* half, where
 * the leak risk is highest: a stream keeps emitting after the initial read, so a
 * filter applied only to the snapshot would leak every later change. The route
 * is driven through the REAL composed app (`createApp` with the
 * `publicDashboard` group), so the assertions observe what the wired surface
 * answers — not a re-implementation.
 *
 *   1. **The allow-list is enforced frame-by-frame.** A frame for a variable
 *      outside the layout is never written to the stream; a frame inside it is.
 *   2. **The secret never appears in the stream bytes.**
 *   3. **An unresolvable share is a uniform 404 before any stream opens.**
 *   4. **The service's own `subscribe` filters identically to `filterFrame`.**
 *
 * Time is not simulated or slept: the frame source delivers its queued frames
 * *on subscribe*, so the stream's bytes are fully determined before the response
 * is read and no wall-clock wait is needed.
 */

const PROJECT = "prj_public";
const SHARE_TOKEN = "shr_stream_token";
const SECRET_VALUE = 424242;

/**
 * A frame source that delivers a fixed script of frames the moment it is
 * subscribed — deterministic, no timers, no hand-driven async races.
 */
class ScriptedFrames implements FrameSource {
  #script: Point[];
  unsubscribed = 0;

  constructor(script: Point[]) {
    this.#script = script;
  }

  subscribe(_projectId: string, onFrame: (frame: Point) => void): () => void {
    for (const frame of this.#script) onFrame(frame);
    return () => {
      this.unsubscribed += 1;
    };
  }
}

function point(variable: string, value: number, seq: number): Point {
  return { device: "dev_1", variable, value, ts: 1_700_000_000_000, seq };
}

function shareResolver(): ShareResolver {
  return async (presented): Promise<Share | null> => {
    if (presented !== SHARE_TOKEN) return null;
    return {
      id: "shr_1",
      tokenHash: await sha256Hex(new TextEncoder().encode(SHARE_TOKEN)),
      projectId: PROJECT,
      layoutId: "dash_1",
      expiresAt: null,
      revokedAt: null,
    };
  };
}

function publicLayout(): DashboardLayout {
  return { id: "dash_1", variables: ["temp"] };
}

function harness(frames: FrameSource): App {
  const deps: AppDeps = {
    deviceTokens: async () => null,
    sessions: async () => null,
    ingest: {
      verifyToken: async () => null,
      sink: { record: async () => undefined },
      devices: { register: () => undefined, has: () => false },
    },
    query: {
      credentials: async () => null,
      projects: { state: async () => [] },
      shards: { ring: async () => [] },
    },
    m3: {
      publicDashboard: {
        shares: shareResolver(),
        layouts: async (id) => (id === "dash_1" ? publicLayout() : null),
        projection: { snapshot: async () => [] },
        frames,
      },
    },
  };
  return createApp(deps);
}

// ---------------------------------------------------------------------------
// 1 & 2. The stream enforces the allow-list, per frame
// ---------------------------------------------------------------------------

describe("GET /v1/public/dashboards/:token/stream — allow-list enforced per frame", () => {
  it("delivers an allow-listed frame and drops one outside the layout", async () => {
    // The script mixes a private frame and a public one; only the public one may
    // reach the wire — the same rule the snapshot uses, applied to the live path.
    const frames = new ScriptedFrames([
      point("secret_token", SECRET_VALUE, 2),
      point("temp", 21, 1),
    ]);
    const app = harness(frames);

    const res = await app.request(`/v1/public/dashboards/${SHARE_TOKEN}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Read the buffered SSE bytes until the public frame is present, then close
    // the stream: a live SSE endpoint stays open by design, so `res.text()`
    // (which waits for close) would hang. No timers — the frames were enqueued
    // synchronously on subscribe, so the reads resolve from the buffer.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // Stop once the public frame's VALUE appears (the allow-list line also
    // contains the word "temp", so the value is the unambiguous signal).
    while (!text.includes("21")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();

    expect(text).toContain("temp");
    expect(text).toContain("21");
    // The secret's variable AND value never reach the wire.
    expect(text).not.toContain("secret_token");
    expect(text).not.toContain(String(SECRET_VALUE));
    // The allow-list is announced first, so the client knows what it may receive.
    expect(text).toContain('"variables":["temp"]');
  });

  it("answers an unresolvable share with a uniform 404 (no stream opened)", async () => {
    const app = harness(new ScriptedFrames([]));
    const res = await app.request("/v1/public/dashboards/not_a_share/stream");
    expect(res.status).toBe(404);
    const body: { error: string } = await res.json();
    expect(body.error).toBe("not_found");
  });

  it("closes cleanly when the deploy has no frame seam", async () => {
    // No `frames` in the options: streaming is unavailable, and the route closes
    // the stream after announcing the allow-list rather than holding it open.
    const app = createApp({
      deviceTokens: async () => null,
      sessions: async () => null,
      ingest: {
        verifyToken: async () => null,
        sink: { record: async () => undefined },
        devices: { register: () => undefined, has: () => false },
      },
      query: {
        credentials: async () => null,
        projects: { state: async () => [] },
        shards: { ring: async () => [] },
      },
      m3: {
        publicDashboard: {
          shares: shareResolver(),
          layouts: async () => publicLayout(),
          projection: { snapshot: async () => [] },
        },
      },
    });
    const res = await app.request(`/v1/public/dashboards/${SHARE_TOKEN}/stream`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"variables":["temp"]');
  });
});

// ---------------------------------------------------------------------------
// 3. The service's `subscribe` filters exactly like `filterFrame`
// ---------------------------------------------------------------------------

describe("PublicDashboard.subscribe — same allow-list as the snapshot/frame filter", () => {
  function serviceWith(frames: FrameSource | undefined): PublicDashboardService {
    return new PublicDashboardService({
      shares: shareResolver(),
      layouts: async () => publicLayout(),
      projection: { snapshot: async () => [] },
      ...(frames !== undefined ? { frames } : {}),
    });
  }

  it("delivers only allow-listed frames and exposes an unsubscribe", async () => {
    const frames = new ScriptedFrames([
      point("temp", 1, 1),
      point("secret_token", SECRET_VALUE, 2),
      point("temp", 2, 3),
    ]);
    const service = serviceWith(frames);
    const view = await service.resolve(SHARE_TOKEN);

    const received: Point[] = [];
    const unsubscribe = await view.subscribe((frame) => received.push(frame));

    expect(received.map((f) => f.variable)).toEqual(["temp", "temp"]);
    expect(received.map((f) => f.value)).toEqual([1, 2]);

    unsubscribe();
    expect(frames.unsubscribed).toBe(1);
  });

  it("refuses with not_found when the deploy has no frame seam", async () => {
    const service = serviceWith(undefined);
    const view = await service.resolve(SHARE_TOKEN);
    const err: PublicDashboardError = await view
      .subscribe(() => undefined)
      .then(() => {
        throw new Error("expected a refusal");
      })
      .catch((e: PublicDashboardError) => e);
    expect(err.code).toBe("not_found");
  });
});

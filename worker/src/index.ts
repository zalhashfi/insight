import { Hono } from "hono";

/**
 * Insight Worker skeleton.
 *
 * Exposed routes:
 *   GET /healthz   -> 200 { "ok": true }
 *   GET /v1/version -> { "name": "insight", "version": "0.0.1" }
 *
 * The `app` is exported so tests can exercise it in-process via
 * `app.request("/healthz")` without a running server.
 */
export const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true }, 200));

app.get("/v1/version", (c) =>
  c.json({ name: "insight", version: "0.0.1" }, 200),
);

export default app;

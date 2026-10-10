import { describe, expect, it } from "vitest";
import { app } from "../worker/src/index";

describe("worker skeleton", () => {
  it("GET /healthz returns 200 {ok:true}", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /v1/version returns the version object", async () => {
    const res = await app.request("/v1/version");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "insight", version: "0.0.1" });
  });
});

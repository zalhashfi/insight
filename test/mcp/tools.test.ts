import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  MCP_TOOLS,
  MCP_TOOL_SPECS,
  READ_TOOLS,
  REDACTED,
  WRITE_TOOLS,
  createMcpToolRoutes,
  createMcpTools,
  findTool,
  isMcpToolName,
  isSecretKey,
  redactSecrets,
  InMemoryMcpToolStores,
  type McpToolDeps,
  type McpTools,
  type SeriesPoint,
  type StateRow,
} from "../../worker/src/mcp/tools";
import {
  MANAGE_SCOPE,
  READ_SCOPE,
  type McpCredential,
  type McpScope,
} from "../../worker/src/mcp/gate";
import type { Principal } from "../../worker/src/platform/middleware/resolve-project";
import type { Rule } from "../../worker/src/platform/engine/run";

/**
 * Spec tests for the MCP **tool surface** (`worker/src/mcp/tools.ts`).
 *
 * The contracts that carry the weight:
 *
 *   1. **Reads are real** — a read tool returns the data the injected seam
 *      holds, not a fixture and not an echo. `get_state`, `get_series` and the
 *      rest are asserted against values written *into the stores*.
 *   2. **Writes need both keys** — `mcp:manage` AND `mcp_write_enabled`;
 *      either missing → the gate denies and the store is untouched. With both,
 *      the write *applies* (the store is observably changed).
 *   3. **No delete tool exists** — the catalogue contains no destructive verb,
 *      and the dispatch refuses one a caller might guess at.
 *   4. **Secrets never appear** — a secret placed in an integration config does
 *      not appear, verbatim, in the serialized output of ANY tool.
 *   5. **A scope is not a tenant** — a credential bound to one project is
 *      refused a call naming another, for **reads as well as writes**, through
 *      the REAL gate path (the verifier mints the principal; the tool layer
 *      enforces the tenant). Within-tenant calls succeed.
 */

// ---------------------------------------------------------------------------
// Fixtures & harness
// ---------------------------------------------------------------------------

const PROJECT = "proj_alpha";
const OTHER_PROJECT = "proj_beta";
const USER = "user_owner";
const DEVICE = "sim-01";

/** A token the fake verifier maps to a set of MCP scopes. */
const READ_TOKEN = "mcp_read_" + "a".repeat(32);
const MANAGE_TOKEN = "mcp_manage_" + "b".repeat(32);

const SCOPES_BY_TOKEN: Record<string, readonly McpScope[]> = {
  [READ_TOKEN]: [READ_SCOPE],
  [MANAGE_TOKEN]: [MANAGE_SCOPE],
};

/**
 * The verifier the bridge mounts: a recognised token resolves to a credential
 * **bound to {@link PROJECT}** — the tenant its grant named. The gate refuses a
 * tenant-less credential, so a real deploy's verifier always binds one; this
 * stub does the same, which is what makes the cross-tenant tests exercise the
 * real gate + tool path rather than a hand-built principal.
 */
const verifyToken = async (token: string): Promise<McpCredential | null> => {
  const scopes = SCOPES_BY_TOKEN[token];
  return scopes === undefined ? null : { scopes, projectId: PROJECT };
};

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/**
 * `McpTools.call` returns `unknown` (the wire result is opaque to the transport,
 * exactly as `McpResultBody.result` is). A test names the shape it expects and
 * casts once here — an unchecked assertion over a value this file's own store
 * fixture produced, so the shape is known a priori.
 */
function asShape<T>(value: unknown): T {
  return value as T;
}

/** A principal for the write path's own role check (owner of {@link PROJECT}). */
const OWNER: Principal = { kind: "user", userId: USER, projectId: PROJECT, role: "owner" };

const TEMP_RULE: Rule = {
  id: "rule_temp",
  cooldownMs: 0,
  conditions: [],
  actions: [{ type: "set_variable", key: "temp", value: 1 }],
};

/** A secret value, in a shape the value-markers recognise. */
const SECRET = "sk_live_51H_integration_secret_value";
/** An innocuous config key that nevertheless carries the secret plaintext. */
const NESTED_SECRET = "sk_live_51 nested in an innocent key";

/** Build a fully seeded store bundle for one project. */
function stores(now: () => number = () => 1_000): InMemoryMcpToolStores {
  const s = new InMemoryMcpToolStores(now);
  s.addProject(PROJECT, USER, "owner", "Alpha");
  s.addProject(OTHER_PROJECT, "other_owner", "owner", "Beta");
  s.addVariable(PROJECT, "temp", 21.5);
  s.addState(PROJECT, { device: DEVICE, variable: "temp", value: 21.5, ts: 900, seq: 3 });
  s.addSeriesPoint(PROJECT, { device: DEVICE, variable: "temp", value: 21, ts: 800, seq: 1 });
  s.addSeriesPoint(PROJECT, { device: DEVICE, variable: "temp", value: 21.5, ts: 900, seq: 3 });
  s.addLayout(PROJECT, "main", ["temp"]);
  s.addAutomation(PROJECT, "rule_temp", TEMP_RULE);
  s.addIntegration(PROJECT, "hooks", {
    url: "https://hooks.example/abc",
    apiKey: SECRET,
    nested: { note: NESTED_SECRET },
  });
  return s;
}

/** The tool set + its deps, built over a seeded store bundle. */
function tools(now: () => number = () => 1_000): {
  set: McpTools;
  deps: McpToolDeps;
  fake: InMemoryMcpToolStores;
} {
  const fake = stores(now);
  const deps = fake.seams;
  return { set: createMcpTools(deps), deps, fake };
}

/**
 * Mount the whole bridge exactly as a deploy would — the gate in front of the
 * tools at `/v1/mcp` — so every request drives the real routes through a real
 * Hono app. No bindings, no network. Uses {@link createMcpToolRoutes} so a
 * tool's typed error becomes its wire response, exactly as the real mount does.
 */
function bridge(options: {
  readonly mcpWriteEnabled?: boolean;
  readonly now?: () => number;
} = {}): { app: Hono; fake: InMemoryMcpToolStores } {
  const fake = stores(options.now ?? (() => 1_000));
  const app = new Hono();
  app.route(
    "/v1/mcp",
    createMcpToolRoutes({ ...fake.seams, gate: { verifyToken, mcpWriteEnabled: options.mcpWriteEnabled } }),
  );
  return { app, fake };
}

/** The envelope a gated tool call returns inside `{ result }`. */
interface WireEnvelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly message?: string;
}

/** GET a read tool through the bridge, unwrapping the tool envelope. */
async function readCall(
  app: Hono,
  token: string,
  tool: string,
  params: Record<string, string> = {},
): Promise<{ status: number; result?: unknown; error?: string; raw: string }> {
  const query = new URLSearchParams({ tool, ...params }).toString();
  const res = await app.request(`/v1/mcp/read?${query}`, { headers: bearer(token) });
  const raw = await res.text();
  const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
  const body = asShape<{ result?: unknown; error?: string }>(parsed);
  const envelope = asShape<WireEnvelope>(body.result ?? {});
  return {
    status: res.status,
    result: envelope.ok === false ? envelope : envelope.data,
    error: envelope.ok === false ? envelope.error : body.error,
    raw,
  };
}

/** POST a write tool through the bridge, unwrapping the tool envelope. */
async function writeCall(
  app: Hono,
  token: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ status: number; result?: unknown; error?: string; raw: string }> {
  const res = await app.request("/v1/mcp/write", {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  const raw = await res.text();
  const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
  const body = asShape<{ result?: unknown; error?: string }>(parsed);
  const envelope = asShape<WireEnvelope>(body.result ?? {});
  return {
    status: res.status,
    result: envelope.ok === false ? envelope : envelope.data,
    error: envelope.ok === false ? envelope.error : body.error,
    raw,
  };
}

// ---------------------------------------------------------------------------
// 1. The catalogue — reads, writes, and no delete
// ---------------------------------------------------------------------------

describe("mcp tools — the catalogue", () => {
  it("advertises every read and write tool exactly once", () => {
    const specNames = MCP_TOOL_SPECS.map((t) => t.name);
    expect(specNames).toEqual(MCP_TOOLS.map((t) => t.name));
    expect(new Set(specNames).size).toBe(specNames.length);
    expect(MCP_TOOL_SPECS).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length);
  });

  it("registers NO delete tool — no destructive verb exists at all", () => {
    // A broad sweep: any name mentioning a destructive verb is a failure, not
    // just the exact spellings a reviewer might imagine.
    const destructive = MCP_TOOLS.filter((t) => /(^|_)(delete|remove|destroy|purge|drop|revoke)(_|$)/i.test(t.name));
    expect(destructive).toEqual([]);
    expect(MCP_TOOLS.every((t) => t.kind === "read" || t.kind === "write")).toBe(true);

    // And the dispatch refuses a guessed delete name outright.
    expect(isMcpToolName("delete_project")).toBe(false);
    expect(findTool("delete_integration")).toBeUndefined();
  });

  it("tags every write tool with the manage scope and every read with read", () => {
    for (const spec of MCP_TOOL_SPECS) {
      expect(spec.scope).toBe(spec.kind === "write" ? MANAGE_SCOPE : READ_SCOPE);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Read tools return REAL data from the injected seams
// ---------------------------------------------------------------------------

describe("mcp tools — reads return real data", () => {
  it("get_state returns the projection the state seam holds", async () => {
    const { set } = tools();
    const result = asShape<{ state: StateRow[] }>(
      await set.call("get_state", { projectId: PROJECT }, OWNER),
    );
    expect(result.state).toHaveLength(1);
    expect(result.state[0]).toMatchObject({ device: DEVICE, variable: "temp", value: 21.5, seq: 3 });
  });

  it("get_series returns the ring points inside the window", async () => {
    const { set } = tools(() => 1_000);
    const result = asShape<{ series: SeriesPoint[] }>(
      await set.call("get_series", { projectId: PROJECT, variable: "temp", windowMs: 300 }, OWNER),
    );
    // now=1000, window=300 → [700, 1000]; both seeded points are in range.
    expect(result.series.map((p) => p.value)).toEqual([21, 21.5]);
  });

  it("list_variables, list_dashboards, list_automations and list_integrations read the seeded stores", async () => {
    const { set } = tools();
    const vars = asShape<{ variables: unknown[] }>(
      await set.call("list_variables", { projectId: PROJECT }, OWNER),
    );
    const layouts = asShape<{ dashboards: { id: string }[] }>(
      await set.call("list_dashboards", { projectId: PROJECT }, OWNER),
    );
    const autos = asShape<{ automations: { id: string }[] }>(
      await set.call("list_automations", { projectId: PROJECT }, OWNER),
    );

    expect(vars.variables).toHaveLength(1);
    expect(layouts.dashboards.map((l) => l.id)).toEqual(["main"]);
    expect(autos.automations.map((a) => a.id)).toEqual(["rule_temp"]);
  });

  it("get_project returns the real project, and a foreign id is not_found", async () => {
    const { set } = tools();
    const hit = asShape<{ project: { name: string } }>(
      await set.call("get_project", { projectId: PROJECT }, OWNER),
    );
    expect(hit.project.name).toBe("Alpha");
    await expect(set.call("get_project", { projectId: "nope" }, OWNER)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("serves reads through the mounted bridge for a read-scoped token", async () => {
    const { app } = bridge();
    const res = await readCall(app, READ_TOKEN, "get_project", { projectId: PROJECT });
    const project = asShape<{ project: { id: string } }>(res.result);
    expect(res.status).toBe(200);
    expect(project.project.id).toBe(PROJECT);
  });

  it("a read tool on the read path that is actually a write is refused", async () => {
    const { app } = bridge({ mcpWriteEnabled: true });
    const res = await readCall(app, READ_TOKEN, "set_variable", { projectId: PROJECT, key: "temp" });
    // The gate authorized the read (200); the *tool* refused the mutation,
    // reported in the result envelope rather than as a gate denial.
    expect(res.status).toBe(200);
    expect(res.error).toBe("read_only");
  });
});

// ---------------------------------------------------------------------------
// 3. Writes need BOTH keys — scope AND flag
// ---------------------------------------------------------------------------

describe("mcp tools — writes need `mcp:manage` AND the flag", () => {
  it("denies a write with a read-scoped token (insufficient_scope), store untouched", async () => {
    const { app, fake } = bridge({ mcpWriteEnabled: true });
    const res = await writeCall(app, READ_TOKEN, "set_variable", { projectId: PROJECT, key: "temp", value: 99 });
    expect(res.status).toBe(403);
    expect(res.error).toBe("insufficient_scope");
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("denies a manage-scoped write while the flag is OFF (write_disabled), store untouched", async () => {
    const { app, fake } = bridge({ mcpWriteEnabled: false });
    const res = await writeCall(app, MANAGE_TOKEN, "set_variable", { projectId: PROJECT, key: "temp", value: 99 });
    expect(res.status).toBe(403);
    expect(res.error).toBe("write_disabled");
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("denies an anonymous write (401)", async () => {
    const { app, fake } = bridge({ mcpWriteEnabled: true });
    const res = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "set_variable", args: { projectId: PROJECT, key: "temp", value: 99 } }),
    });
    expect(res.status).toBe(401);
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("applies the write when the token holds manage AND the flag is on", async () => {
    const { app, fake } = bridge({ mcpWriteEnabled: true });
    const res = await writeCall(app, MANAGE_TOKEN, "set_variable", { projectId: PROJECT, key: "temp", value: 99 });
    const body = asShape<{ variable: { value: number } }>(res.result);
    expect(res.status).toBe(200);
    // The store is observably changed — the write really applied.
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(99);
    expect(body.variable.value).toBe(99);
  });

  it("applies a create_integration write through the bridge", async () => {
    const { app, fake } = bridge({ mcpWriteEnabled: true });
    const res = await writeCall(app, MANAGE_TOKEN, "create_integration", {
      projectId: PROJECT,
      integrationId: "slack",
      config: { url: "https://slack.example/hook" },
    });
    expect(res.status).toBe(200);
    expect(fake.integrations.get(PROJECT)?.get("slack")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Write semantics — create vs update, role/tenant guards, emit
// ---------------------------------------------------------------------------

describe("mcp tools — write semantics", () => {
  it("create_variable rejects a duplicate; update_variable rejects an absent one", async () => {
    const { set } = tools();
    await expect(
      set.call("create_variable", { projectId: PROJECT, key: "temp" }, OWNER),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      set.call("update_variable", { projectId: PROJECT, key: "ghost" }, OWNER),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("create_layout / create_automation apply, and set_variable clears with a null value", async () => {
    const { set, fake } = tools();
    await set.call("create_layout", { projectId: PROJECT, layoutId: "ops", variables: ["temp"] }, OWNER);
    await set.call("create_automation", { projectId: PROJECT, automationId: "rule_2", rule: TEMP_RULE }, OWNER);
    const cleared = asShape<{ variable: { value: number | null } }>(
      await set.call("set_variable", { projectId: PROJECT, key: "temp", value: null }, OWNER),
    );

    expect(fake.layouts.get(PROJECT)?.get("ops")).toBeDefined();
    expect(fake.automations.get(PROJECT)?.get("rule_2")).toBeDefined();
    expect(cleared.variable.value).toBeNull();
  });

  it("emit_event dispatches the trigger to the event seam", async () => {
    const { set, fake } = tools();
    const res = asShape<{ emitted: boolean; event: string }>(
      await set.call("emit_event", { projectId: PROJECT, event: "door_open", payload: { at: 5 } }, OWNER),
    );

    expect(res).toMatchObject({ emitted: true, event: "door_open" });
    expect(fake.events).toEqual([{ projectId: PROJECT, event: "door_open", payload: { at: 5 } }]);
  });

  it("refuses a write by a non-member user (forbidden), store untouched", async () => {
    const { set, fake } = tools();
    const stranger: Principal = { kind: "user", userId: "stranger", projectId: PROJECT, role: "member" };
    await expect(
      set.call("set_variable", { projectId: PROJECT, key: "temp", value: 99 }, stranger),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(21.5);
  });

  it("refuses a device principal writing to another tenant (forbidden)", async () => {
    const { set, fake } = tools();
    const device: Principal = { kind: "device", projectId: PROJECT, scopes: "read write" };
    await expect(
      set.call("set_variable", { projectId: OTHER_PROJECT, key: "temp", value: 1 }, device),
    ).rejects.toMatchObject({ code: "forbidden" });
    // The foreign tenant's store was never touched.
    expect(fake.variables.get(OTHER_PROJECT)).toBeUndefined();
  });

  it("refuses a device principal READING another tenant (forbidden) — scope is not a tenant", async () => {
    // A read is a copy of another tenant's data, so the SAME binding applies.
    // A `read write` device principal bound to PROJECT may not read OTHER.
    const { set } = tools();
    const device: Principal = { kind: "device", projectId: PROJECT, scopes: "read write" };
    await expect(
      set.call("get_state", { projectId: OTHER_PROJECT }, device),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      set.call("list_integrations", { projectId: OTHER_PROJECT }, device),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses an UNBOUND device principal (empty tenant) for both read and write — fail-closed", async () => {
    // The exact hole: a principal whose credential carried no tenant. It must be
    // authorized for nothing, not for everything.
    const { set } = tools();
    const unbound: Principal = { kind: "device", projectId: "", scopes: "read write" };
    await expect(
      set.call("get_state", { projectId: PROJECT }, unbound),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      set.call("set_variable", { projectId: PROJECT, key: "temp", value: 1 }, unbound),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("allows a device principal within its own tenant for reads AND writes", async () => {
    // The other half of the contract: the binding must not over-refuse.
    const { set, fake } = tools();
    const device: Principal = { kind: "device", projectId: PROJECT, scopes: "read write" };
    const state = asShape<{ state: StateRow[] }>(
      await set.call("get_state", { projectId: PROJECT }, device),
    );
    expect(state.state).toHaveLength(1);
    await set.call("set_variable", { projectId: PROJECT, key: "temp", value: 55 }, device);
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(55);
  });

  it("refuses a NON-MEMBER user reading a foreign tenant (forbidden)", async () => {
    const { set } = tools();
    const outsider: Principal = { kind: "user", userId: "outsider", projectId: OTHER_PROJECT, role: "member" };
    await expect(
      set.call("get_state", { projectId: PROJECT }, outsider),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a guessed delete tool at dispatch as read_only (not a write tool)", async () => {
    const { set } = tools();
    await expect(
      set.call("delete_project", { projectId: PROJECT }, OWNER),
    ).rejects.toMatchObject({ code: "unknown_tool" });
    // Even the write path's own switch refuses it.
    await expect(
      set.call("delete_automation", { projectId: PROJECT, automationId: "rule_temp" }, OWNER),
    ).rejects.toMatchObject({ code: "unknown_tool" });
  });
});

// ---------------------------------------------------------------------------
// 5. Secrets NEVER appear in any tool output
// ---------------------------------------------------------------------------

describe("mcp tools — secret redaction", () => {
  it("does not leak an integration config secret through ANY tool output", async () => {
    const { set } = tools();

    // Drive every read tool and every read that could surface the integration,
    // serializing each result and scanning it for the secret.
    const calls: [string, Record<string, unknown>][] = [
      ["list_projects", {}],
      ["get_project", { projectId: PROJECT }],
      ["list_variables", { projectId: PROJECT }],
      ["get_state", { projectId: PROJECT }],
      ["get_series", { projectId: PROJECT, variable: "temp" }],
      ["list_dashboards", { projectId: PROJECT }],
      ["get_dashboard", { projectId: PROJECT, dashboardId: "main" }],
      ["list_automations", { projectId: PROJECT }],
      ["get_automation", { projectId: PROJECT, automationId: "rule_temp" }],
      ["list_integrations", { projectId: PROJECT }],
      ["get_integration", { projectId: PROJECT, integrationId: "hooks" }],
    ];

    for (const [name, args] of calls) {
      const serialized = JSON.stringify(await set.call(name, args, OWNER));
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(NESTED_SECRET);
      expect(serialized).not.toContain("51H_integration");
    }
  });

  it("redacts the secret-bearing config key structurally AND its plaintext by value", async () => {
    const { set } = tools();
    const out = asShape<{ integration: { config: Record<string, unknown> } }>(
      await set.call("get_integration", { projectId: PROJECT, integrationId: "hooks" }, OWNER),
    );
    const nested = asShape<{ note: string }>(out.integration.config.nested);

    // Structural: the key `apiKey` looks secret-bearing → replaced outright.
    expect(out.integration.config.apiKey).toBe(REDACTED);
    // Value: the same plaintext under an innocent key is rewritten.
    expect(nested.note).toBe(REDACTED);
    // The non-secret parts survive, so redaction is not "drop everything".
    expect(out.integration.config.url).toBe("https://hooks.example/abc");
  });

  it("redacts the secret in the response of the write that stored it", async () => {
    const { app } = bridge({ mcpWriteEnabled: true });
    const res = await writeCall(app, MANAGE_TOKEN, "create_integration", {
      projectId: PROJECT,
      integrationId: "webhook",
      config: { url: "https://example.test", apiKey: "sk_live_write_response_secret" },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain("sk_live_write_response_secret");
  });

  it("registers a written secret so it is redacted even under an innocent key later", async () => {
    const { set, fake } = tools();
    // A secret stored through the tool (registers into the registry)...
    await set.call(
      "create_integration",
      { projectId: PROJECT, integrationId: "reg", config: { apiKey: "sk_live_registered_1" } },
      OWNER,
    );
    // ...then placed verbatim under an innocent key in a layout's variables,
    // where only the value pass can catch it.
    await set.call(
      "create_layout",
      { projectId: PROJECT, layoutId: "leaky", variables: ["sk_live_registered_1"] },
      OWNER,
    );
    const out = JSON.stringify(await set.call("get_dashboard", { projectId: PROJECT, dashboardId: "leaky" }, OWNER));
    expect(out).not.toContain("sk_live_registered_1");
    expect(fake.layouts.get(PROJECT)?.get("leaky")).toBeDefined();
  });

  it("is a total, recursive primitive — arrays and nesting included", () => {
    const out = asShape<{ a: { apiToken: string }; list: { password?: string; note?: string }[]; plain: string }>(
      redactSecrets({
        a: { apiToken: "whatever" },
        list: [{ password: "hunter2" }, { note: "ok" }],
        plain: "fine",
      }),
    );

    expect(out.a.apiToken).toBe(REDACTED);
    expect(out.list[0].password).toBe(REDACTED);
    expect(out.list[1].note).toBe("ok");
    expect(out.plain).toBe("fine");
  });

  it("classifies secret-bearing keys without over-redacting ordinary ones", () => {
    expect(isSecretKey("apiKey")).toBe(true);
    expect(isSecretKey("API_KEY")).toBe(true);
    expect(isSecretKey("clientSecret")).toBe(true);
    expect(isSecretKey("accessToken")).toBe(true);
    expect(isSecretKey("url")).toBe(false);
    expect(isSecretKey("temp")).toBe(false);
    expect(isSecretKey("name")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Composition + mount helper
// ---------------------------------------------------------------------------

describe("mcp tools — composition", () => {
  it("throws loudly when a required store is missing", () => {
    const { deps } = tools();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.state;
    expect(() => createMcpTools(broken as unknown as McpToolDeps)).toThrow(/state/);
  });

  it("createMcpToolRoutes serves reads and gated writes end-to-end", async () => {
    const fake = stores();
    const app = new Hono();
    app.route("/v1/mcp", createMcpToolRoutes({ ...fake.seams, gate: { verifyToken, mcpWriteEnabled: true } }));

    const read = await app.request(`/v1/mcp/read?tool=list_integrations&projectId=${PROJECT}`, {
      headers: bearer(READ_TOKEN),
    });
    expect(read.status).toBe(200);

    const write = await app.request("/v1/mcp/write", {
      method: "POST",
      headers: { ...bearer(MANAGE_TOKEN), "content-type": "application/json" },
      body: JSON.stringify({ tool: "set_variable", args: { projectId: PROJECT, key: "temp", value: 7 } }),
    });
    expect(write.status).toBe(200);
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 7. Tenant isolation end-to-end — through the REAL gate path
//
// The gate mints the principal from the credential's tenant; the tool layer
// enforces it. These cases drive the composed bridge (gate + tools) exactly as
// a deploy mounts it, so a hand-built principal cannot paper over a hole: the
// credential the verifier binds to PROJECT is refused a call naming OTHER.
// ---------------------------------------------------------------------------

describe("mcp tools — tenant isolation through the real gate path", () => {
  /** The composed bridge, over an isolated store bundle, for cross-tenant cases. */
  function composedBridge(): { app: Hono; fake: InMemoryMcpToolStores } {
    const fake = stores();
    const app = new Hono();
    app.route(
      "/v1/mcp",
      createMcpToolRoutes({ ...fake.seams, gate: { verifyToken, mcpWriteEnabled: true } }),
    );
    return { app, fake };
  }

  it("a token bound to PROJECT is REFUSED a cross-tenant read (forbidden, no data)", async () => {
    const { app } = composedBridge();

    const read = await readCall(app, READ_TOKEN, "get_state", { projectId: OTHER_PROJECT });
    expect(read.status).toBe(200); // the gate authorized the READ class...
    expect(read.error).toBe("forbidden"); // ...but the tenant check refused the target
    // No data from the foreign tenant crossed the wire — only the refusal.
    expect(read.raw).toContain("forbidden");
    expect(read.raw).not.toContain(OTHER_PROJECT);

    // And it really did not read: the other tenant's integrations are likewise
    // refused, so no read tool leaks a foreign tenant.
    const integrations = await readCall(app, READ_TOKEN, "list_integrations", { projectId: OTHER_PROJECT });
    expect(integrations.error).toBe("forbidden");
  });

  it("a manage token bound to PROJECT is REFUSED a cross-tenant write (forbidden, store untouched)", async () => {
    const { app, fake } = composedBridge();

    const write = await writeCall(app, MANAGE_TOKEN, "set_variable", {
      projectId: OTHER_PROJECT,
      key: "temp",
      value: 99,
    });
    expect(write.status).toBe(200); // gate authorized the WRITE class...
    expect(write.error).toBe("forbidden"); // ...but the tenant check refused the target
    expect(fake.variables.get(OTHER_PROJECT)).toBeUndefined();
  });

  it("the SAME token succeeds WITHIN its own tenant for both read and write", async () => {
    const { app, fake } = composedBridge();

    const read = await readCall(app, READ_TOKEN, "get_project", { projectId: PROJECT });
    expect(read.status).toBe(200);
    expect(read.error).toBeUndefined();

    const write = await writeCall(app, MANAGE_TOKEN, "set_variable", {
      projectId: PROJECT,
      key: "temp",
      value: 5,
    });
    expect(write.status).toBe(200);
    expect(write.error).toBeUndefined();
    expect(fake.variables.get(PROJECT)?.get("temp")?.value).toBe(5);
  });
});

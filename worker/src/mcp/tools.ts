/**
 * mcp/tools — the MCP **tool surface** (the AI bridge's verbs), expressed as a
 * pure factory over injected seams.
 *
 * `mcp/gate.ts` owns *who may call* (authentication + `mcp:read` /
 * `mcp:manage` + the `mcp_write_enabled` flag). This module owns *what can be
 * called*: the named tools an AI client discovers and invokes, and the mapping
 * from each tool to the domain seam that already implements it.
 *
 * ```
 *   GET  /v1/mcp/read   ?tool=<name>&…                 → 200 { result }  (mcp:read)
 *   POST /v1/mcp/write  { "tool": <name>, "args": { … } }                (mcp:manage + flag)
 * ```
 *
 * It re-implements **none** of the domain behaviour. Every tool is a thin
 * adapter onto an existing seam — the project/membership service, the
 * projection reader, the shard ring reader, the automation repo, the
 * integration store — so the bridge cannot drift from the API: the same
 * `MembershipService` that gates the admin routes backs a `create_project`
 * tool call, the same projection reader answers `get_state`, and so on.
 * `createMcpTools` therefore takes the *same* seam objects the rest of the
 * worker injects; the tools are a second front door onto one implementation,
 * never a parallel one.
 *
 * ## Reads vs writes — and why a write is a second, independent decision
 *
 * {@link MCP_TOOLS} is a frozen, two-kind catalogue. A `read` tool is served
 * through the gate's read path (`mcp:read`); a `write` tool exists **only** on
 * the write path, behind `mcp:manage` AND `mcp_write_enabled`. The table and
 * the gate agree because {@link McpTools.write} is the *only* dispatch site a
 * write tool has: there is no alternate entry that could serve a mutation to a
 * read-scoped caller, and {@link McpTools.read} refuses a write name outright.
 *
 * ## A scope is not a tenant — every call is tenant-checked
 *
 * The gate authenticates a credential and gives it a tenant (its `projectId`).
 * But a tool call *names* a project in its arguments, and a scope alone does not
 * prove the caller may touch that project: a manage-scoped bridge key would
 * otherwise read and write any tenant. So **both** paths re-check the tenant at
 * the tool boundary: the read dispatch calls `authorizeRead` and the write
 * dispatch calls `authorizeWrite`, each requiring the principal's tenant to
 * equal the project the call names. A device/MCP principal is bound to exactly
 * one tenant (empty ⇒ refused, fail-closed); a user must be a member (any role
 * reads, owner/admin writes). This mirrors the shared middleware's INV-A1/A5
 * rule — the tenant comes from the credential, and a claim that does not match
 * it is refused — so a bridge call cannot cross a tenant boundary the REST
 * surface would not.
 *
 * ## No delete tool exists
 *
 * Deliberately. The mutation surface an AI client can reach is
 * create/update/set/emit only; there is no delete verb at all.
 * {@link isWriteToolName} refuses any name that is not one of the frozen
 * writes, so a caller cannot conjure one, and {@link McpToolStores} exposes no
 * seam that could implement one. Deleting a tenant stays a human, owner-only
 * action on the admin surface (`DELETE /v1/admin/projects/:proj`), never a
 * bridge verb.
 *
 * ## Secrets never leave through a tool
 *
 * An integration's `config` holds credentials (a webhook signing key, an API
 * token). **Every** tool result is passed through {@link redactSecrets} before
 * it is returned, and every nested string is scanned, so a secret cannot appear
 * in *any* tool's output — not the read that fetched the integration, not the
 * write that just stored one, not a list that happens to include it. Redaction
 * is *structural* (secret-bearing keys are replaced wholesale) **and**
 * *value-based* (the plaintext of a known secret is replaced wherever it
 * appears), because there are two ways to leak: by the key it sits under
 * (`config.apiKey`) and by its value turning up under an innocent key. Both are
 * covered, and both passes recurse, so a secret nested inside an array of
 * widgets is redacted exactly as a secret at the top level.
 *
 * ## Seams
 *
 * Every side effect is injected; nothing here owns a store, a clock or a
 * binding. {@link InMemoryMcpToolStores} is the honest default for tests and
 * dev. The module never reads `env` and never invents a binding.
 */

import type { Context } from "hono";
import { Hono } from "hono";
import {
  MANAGE_SCOPE,
  READ_SCOPE,
  createMcpGate,
  type McpCallHandler,
  type McpCredential,
  type McpGateDeps,
  type McpScope,
  type VerifyMcpToken,
} from "./gate";
import { hasScope, type Principal } from "../platform/middleware/resolve-project";
import type { Project, Role } from "../domains/projects/membership";
import type { AutomationRecord } from "../platform/engine/manual-run";
import type { Rule } from "../platform/engine/run";

// ---------------------------------------------------------------------------
// Tool catalogue
// ---------------------------------------------------------------------------

/** The two classes of tool. A `write` is reachable only on the gated write path. */
export type McpToolKind = "read" | "write";

/** A discoverable tool: its name, kind and a one-line description for a client. */
export interface McpTool {
  readonly name: string;
  readonly kind: McpToolKind;
  readonly description: string;
}

/** Read tools — served through `mcp:read`. No side effects. */
export const READ_TOOLS = [
  { name: "list_projects", kind: "read", description: "List the projects visible to the caller." },
  { name: "get_project", kind: "read", description: "Read one project by id." },
  { name: "list_variables", kind: "read", description: "List the variable keys a project knows." },
  { name: "get_state", kind: "read", description: "Read the current projection (latest per stream)." },
  { name: "get_series", kind: "read", description: "Read a variable's series over a window." },
  { name: "list_dashboards", kind: "read", description: "List a project's dashboard layouts." },
  { name: "get_dashboard", kind: "read", description: "Read one dashboard layout by id." },
  { name: "list_automations", kind: "read", description: "List a project's automations." },
  { name: "get_automation", kind: "read", description: "Read one automation by id." },
  { name: "list_integrations", kind: "read", description: "List a project's integrations (secrets redacted)." },
  { name: "get_integration", kind: "read", description: "Read one integration by id (secrets redacted)." },
] as const satisfies readonly McpTool[];

/**
 * Write tools — served through `mcp:manage` AND `mcp_write_enabled`.
 *
 * There is intentionally **no** delete member: the surface is create/update/
 * set/emit only. See the module docblock.
 */
export const WRITE_TOOLS = [
  { name: "create_project", kind: "write", description: "Create a project owned by the caller." },
  { name: "update_project", kind: "write", description: "Rename a project." },
  { name: "create_variable", kind: "write", description: "Declare a project variable." },
  { name: "update_variable", kind: "write", description: "Update a declared variable's metadata." },
  { name: "set_variable", kind: "write", description: "Set (or clear) a project variable's value." },
  { name: "create_layout", kind: "write", description: "Create a dashboard layout." },
  { name: "update_layout", kind: "write", description: "Update a dashboard layout." },
  { name: "create_automation", kind: "write", description: "Create an automation rule." },
  { name: "update_automation", kind: "write", description: "Update an automation rule." },
  { name: "create_integration", kind: "write", description: "Create an integration." },
  { name: "update_integration", kind: "write", description: "Update an integration." },
  { name: "emit_event", kind: "write", description: "Emit a discrete event that can fire automations." },
] as const satisfies readonly McpTool[];

/**
 * The whole frozen catalogue, reads first.
 *
 * Frozen and `as const` so a client can enumerate it and a test can assert the
 * *exact* membership — in particular that no `delete*` name is ever present.
 */
export const MCP_TOOLS: readonly McpTool[] = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS]);

/** Names of the write tools, as a set for O(1) membership checks. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(WRITE_TOOLS.map((t) => t.name));

/** Is `name` one of the frozen write tools? */
export function isWriteToolName(name: unknown): name is string {
  return typeof name === "string" && WRITE_TOOL_NAMES.has(name);
}

/** Is `name` any known tool (read or write)? */
export function isMcpToolName(name: unknown): name is string {
  return typeof name === "string" && MCP_TOOLS.some((t) => t.name === name);
}

/** The tool spec for `name`, or `undefined` when it is not a known tool. */
export function findTool(name: unknown): McpTool | undefined {
  return typeof name === "string" ? MCP_TOOLS.find((t) => t.name === name) : undefined;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * The placeholder substituted for redacted secret material.
 *
 * A single, literal marker (not an empty string) so a client can tell "a secret
 * was here and has been removed" from "this field was absent" — an absence
 * would be indistinguishable from a broken integration.
 */
export const REDACTED = "[redacted]" as const;

/**
 * Inline secret markers: a **value** containing any of these is secret material
 * no matter what key it sits under. Deliberately narrow and literal — the
 * markers real credential formats actually carry — so an ordinary value
 * ("temperature", "prod") is never redacted by accident.
 */
const SECRET_VALUE_MARKERS: readonly string[] = Object.freeze([
  "sk_live_",
  "sk_test_",
  "AKIA",
  "-----BEGIN",
  "password=",
  "secret=",
  "token=",
  "Bearer ",
]);

/**
 * Substrings in a **key name** that mark the value beneath it as secret.
 *
 * Matched case-insensitively, as a substring, so `apiKey`, `API_KEY`,
 * `clientSecret`, `accessToken`, `authorization` and `passwordHash` are all
 * caught without enumerating every spelling. Structural redaction is the first
 * line of defence: it removes a secret by *where* it lives.
 */
const SECRET_KEY_MARKERS: readonly string[] = Object.freeze([
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "private_key",
  "privatekey",
  "credential",
  "authorization",
  "signing",
  "webhook_key",
  "access_key",
]);

/** Whitespace folded out of a key before marker matching (`api_key` → `apikey`). */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

/** Does this key name look secret-bearing? */
export function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  const flat = normaliseKey(key);
  return SECRET_KEY_MARKERS.some((m) => lower.includes(m) || flat.includes(m.replace(/[_-]/g, "")));
}

/** Does this string value carry an inline secret marker? */
export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_MARKERS.some((m) => value.includes(m));
}

/**
 * The registry of known secret plaintexts for one tools instance.
 *
 * A `Set` is used (not a list scan) because the value pass runs over every
 * string in every result; the registry holds the exact strings an integration's
 * `config` carries, so they are removed even when they reappear under a key
 * that does not look secret. It is populated by {@link McpToolStores} as
 * integrations are written, and can be seeded for already-stored secrets.
 */
export class SecretRegistry {
  readonly #values = new Set<string>();

  /** Register a known secret plaintext (a no-op for an empty string). */
  add(secret: unknown): this {
    if (typeof secret === "string" && secret.length > 0) this.#values.add(secret);
    return this;
  }

  /** Register every string leaf of an object (used for an integration `config`). */
  addDeep(value: unknown): this {
    collectStrings(value).forEach((s) => this.add(s));
    return this;
  }

  /** Every registered secret, longest first so an overlapping pair is fully removed. */
  get values(): readonly string[] {
    return [...this.#values].sort((a, b) => b.length - a.length);
  }

  /** Is `value` a registered secret? */
  has(value: string): boolean {
    return this.#values.has(value);
  }
}

/** Every string leaf of a JSON-ish value, depth-first. */
function collectStrings(value: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      out.push(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v !== null && typeof v === "object") {
      for (const inner of Object.values(v as Record<string, unknown>)) walk(inner);
    }
  };
  walk(value);
  return out;
}

/** Replace every registered secret occurrence inside one string. */
function redactString(value: string, secrets: readonly string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/**
 * Redact secret material from a tool result — **structurally and by value**.
 *
 * The walk is total and recursive over the JSON value a tool returns:
 *
 *   1. **By key.** A property whose *name* looks secret-bearing
 *      ({@link isSecretKey}) has its value replaced by {@link REDACTED}
 *      outright — the value itself is never inspected, so an unregistered
 *      secret under `config.apiKey` is still removed.
 *   2. **By value.** Any string containing a registered secret
 *      ({@link SecretRegistry}) or an inline marker
 *      ({@link looksLikeSecretValue}) is rewritten, so the same plaintext
 *      cannot survive under an innocent key.
 *   3. **Recurse.** Arrays and nested objects are visited; `Date`/`Map`/class
 *      instances are left as-is except for their string leaves, which still
 *      pass through rule 2.
 *
 * A non-object scalar is returned unchanged (after rule 2 for strings), so the
 * function is safe on any tool result.
 */
export function redactSecrets(value: unknown, secrets: SecretRegistry | readonly string[] = []): unknown {
  // A `SecretRegistry` normalises to its longest-first plaintext list; a raw
  // array is normalised the same way, so the walk sees one shape either way.
  const registry = secrets instanceof SecretRegistry ? secrets.values : sortedFrom(secrets);
  return redactWalk(value, registry);
}

/** Build a longest-first, de-duplicated list from a raw secret array. */
function sortedFrom(values: readonly string[]): readonly string[] {
  const set = new Set(values.filter((v) => typeof v === "string" && v.length > 0));
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Redact an integration record for the wire.
 *
 * An integration `config` is a secret container by contract: whatever a provider
 * needs to authenticate (webhook URLs, bot tokens, API keys) lives there, and the
 * value may carry **no inline marker** and sit under an **innocent key** (e.g.
 * `chat_id`, `note`) when it was seeded outside the tool write-path. Structural
 * key-matching alone would let such a value through. So the whole `config` is
 * replaced leaf-by-leaf with {@link REDACTED} — the *shape* survives (a caller
 * still sees which keys exist) but no value does. `redactSecrets` then runs over
 * the whole record for defence in depth (e.g. a secret echoed into `name`).
 */
export function redactIntegration(record: unknown): unknown {
  if (record === null || typeof record !== "object") return redactSecrets(record);
  const source = record as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = key === "config" ? redactConfigDeep(value) : value;
  }
  return redactSecrets(out);
}

/** Replace every leaf of a config object with {@link REDACTED}, preserving shape. */
function redactConfigDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfigDeep);
  if (value === null || typeof value !== "object") return REDACTED;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactConfigDeep(inner);
  }
  return out;
}

/** The recursive core of {@link redactSecrets}. */
function redactWalk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) return REDACTED;
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactWalk(item, secrets));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  // A plain object (or a class instance treated as one): redact by key, then by
  // value over the survivors.
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactWalk(inner, secrets);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool specifications — the shape a client sees and a call must satisfy
// ---------------------------------------------------------------------------

/** One declared parameter of a tool, as advertised in the catalogue. */
export interface McpToolParam {
  readonly name: string;
  readonly type: "string" | "number" | "object" | "array";
  readonly required: boolean;
}

/** The full spec for a tool: its wire name, kind, params and required scope. */
export interface McpToolSpec extends McpTool {
  readonly params: readonly McpToolParam[];
  /** The MCP scope a call to this tool demands. */
  readonly scope: McpScope;
}

/** Does this tool require `mcp:manage` (i.e. is it a write)? */
export function requiresManageScope(tool: McpTool): boolean {
  return tool.kind === "write";
}

/** Parameter helper: a required string. */
const str = (name: string): McpToolParam => ({ name, type: "string", required: true });
/** Parameter helper: an optional string. */
const strOpt = (name: string): McpToolParam => ({ name, type: "string", required: false });
/** Parameter helper: a required object. */
const obj = (name: string): McpToolParam => ({ name, type: "object", required: true });

/**
 * Parameters + scope per tool name.
 *
 * Kept as an explicit {@link Record} keyed by the frozen tool names (the
 * project's "frozen lookup table" convention) rather than derived, so the shape
 * a client is told about and the shape a call is validated against are one
 * literal a reader can compare at a glance.
 */
const SPECS: Record<string, { readonly params: readonly McpToolParam[]; readonly scope: McpScope }> = {
  // --- reads -----------------------------------------------------------
  list_projects: { params: [strOpt("actorId")], scope: READ_SCOPE },
  get_project: { params: [str("projectId")], scope: READ_SCOPE },
  list_variables: { params: [str("projectId")], scope: READ_SCOPE },
  get_state: { params: [str("projectId"), strOpt("device"), strOpt("variable")], scope: READ_SCOPE },
  get_series: {
    params: [str("projectId"), str("variable"), { name: "windowMs", type: "number", required: false }],
    scope: READ_SCOPE,
  },
  list_dashboards: { params: [str("projectId")], scope: READ_SCOPE },
  get_dashboard: { params: [str("projectId"), str("dashboardId")], scope: READ_SCOPE },
  list_automations: { params: [str("projectId")], scope: READ_SCOPE },
  get_automation: { params: [str("projectId"), str("automationId")], scope: READ_SCOPE },
  list_integrations: { params: [str("projectId")], scope: READ_SCOPE },
  get_integration: { params: [str("projectId"), str("integrationId")], scope: READ_SCOPE },

  // --- writes ----------------------------------------------------------
  create_project: { params: [str("name"), str("ownerId"), strOpt("id"), strOpt("slug")], scope: MANAGE_SCOPE },
  update_project: { params: [str("projectId"), str("name")], scope: MANAGE_SCOPE },
  create_variable: { params: [str("projectId"), str("key"), strOpt("unit")], scope: MANAGE_SCOPE },
  update_variable: { params: [str("projectId"), str("key"), strOpt("unit")], scope: MANAGE_SCOPE },
  set_variable: {
    params: [str("projectId"), str("key"), { name: "value", type: "number", required: false }],
    scope: MANAGE_SCOPE,
  },
  create_layout: { params: [str("projectId"), str("layoutId"), { name: "variables", type: "array", required: false }], scope: MANAGE_SCOPE },
  update_layout: { params: [str("projectId"), str("layoutId"), { name: "variables", type: "array", required: false }], scope: MANAGE_SCOPE },
  create_automation: { params: [str("projectId"), str("automationId"), obj("rule")], scope: MANAGE_SCOPE },
  update_automation: { params: [str("projectId"), str("automationId"), obj("rule")], scope: MANAGE_SCOPE },
  create_integration: { params: [str("projectId"), str("integrationId"), obj("config")], scope: MANAGE_SCOPE },
  update_integration: { params: [str("projectId"), str("integrationId"), obj("config")], scope: MANAGE_SCOPE },
  emit_event: { params: [str("projectId"), str("event"), { name: "payload", type: "object", required: false }], scope: MANAGE_SCOPE },
};

/** The full spec list, in catalogue order. */
export const MCP_TOOL_SPECS: readonly McpToolSpec[] = Object.freeze(
  MCP_TOOLS.map((tool) => ({
    ...tool,
    params: SPECS[tool.name]?.params ?? [],
    scope: SPECS[tool.name]?.scope ?? (tool.kind === "write" ? MANAGE_SCOPE : READ_SCOPE),
  })),
);

/** The declared spec for `name`, or `undefined`. */
export function findToolSpec(name: unknown): McpToolSpec | undefined {
  return typeof name === "string" ? MCP_TOOL_SPECS.find((t) => t.name === name) : undefined;
}

// ---------------------------------------------------------------------------
// Seams — the stores every tool reads or writes through
// ---------------------------------------------------------------------------

/** One project variable declaration. */
export interface VariableRecord {
  readonly projectId: string;
  readonly key: string;
  readonly unit?: string;
  /** The last value set through `set_variable`, or `null` when never set. */
  readonly value: number | null;
  readonly updatedAt: number;
}

/** One stored integration, as the tools surface reads and writes it. */
export interface IntegrationRecord {
  readonly projectId: string;
  readonly id: string;
  /** The integration's configuration — the secret-bearing part. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
}

/** One dashboard layout, addressable by id within a project. */
export interface LayoutRecord {
  readonly projectId: string;
  readonly id: string;
  readonly variables: readonly string[];
  readonly updatedAt: number;
}

/**
 * The project store, scoped to a tenant where a tenant applies.
 *
 * Mirrors the parts of `ProjectRepo` the bridge needs. `updateProject` is
 * optional to match that seam: an adapter that cannot persist a rename is the
 * honest `unsupported` error rather than a silent no-op.
 */
export interface McpProjectStore {
  listProjects(): Promise<readonly Project[]>;
  getProject(projectId: string): Promise<Project | null>;
  createProject(input: {
    readonly id?: string;
    readonly name: string;
    readonly slug?: string;
    readonly ownerId: string;
    readonly now: number;
  }): Promise<Project>;
  updateProject?(projectId: string, patch: { name: string }, now: number): Promise<Project | null>;
  /** The caller's role in a project, or `null` when they are not a member. */
  roleOf(projectId: string, actorId: string): Promise<Role | null>;
}

/** A project's variable declarations. */
export interface McpVariableStore {
  list(projectId: string): Promise<readonly VariableRecord[]>;
  get(projectId: string, key: string): Promise<VariableRecord | null>;
  put(record: VariableRecord): Promise<void>;
}

/**
 * The projection reader — the `latest_state` index a read and a `set_variable`
 * both consult. `read` is the whole `(device, variable)` projection;
 * `latestValue` is the one-value query the engine's `ProjectionReader` uses.
 */
export interface McpStateStore {
  read(projectId: string, device?: string, variable?: string): Promise<readonly StateRow[]>;
  latestValue(projectId: string, key: string): Promise<number | null>;
}

/** One projected stream row. Mirrors the DO's `StateRow` shape. */
export interface StateRow {
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/** A point of a variable's series. */
export interface SeriesPoint {
  readonly device: string;
  readonly variable: string;
  readonly value: number | null;
  readonly ts: number;
  readonly seq: number;
}

/** The series (ring) reader, scoped to a project. */
export interface McpSeriesStore {
  series(projectId: string, variable: string, windowMs: number, now: number): Promise<readonly SeriesPoint[]>;
}

/** The dashboard-layout store. */
export interface McpLayoutStore {
  list(projectId: string): Promise<readonly LayoutRecord[]>;
  get(projectId: string, layoutId: string): Promise<LayoutRecord | null>;
  put(record: LayoutRecord): Promise<void>;
}

/** The automation store, keyed `(projectId, automationId)`. */
export interface McpAutomationStore {
  list(projectId: string): Promise<readonly AutomationRecord[]>;
  get(projectId: string, automationId: string): Promise<AutomationRecord | null>;
  put(record: AutomationRecord): Promise<void>;
}

/** The integration store. */
export interface McpIntegrationStore {
  list(projectId: string): Promise<readonly IntegrationRecord[]>;
  get(projectId: string, integrationId: string): Promise<IntegrationRecord | null>;
  put(record: IntegrationRecord): Promise<void>;
}

/** The event dispatch seam — the same shape `domains/telemetry/events` uses. */
export type McpEventDispatcher = (trigger: {
  readonly projectId: string;
  readonly event: string;
  readonly payload: unknown;
}) => Promise<void> | void;

/**
 * Everything the tool surface needs, injectable end-to-end.
 *
 * Every group is a seam object; the module holds no store of its own and reads
 * no ambient state except the injected {@link McpToolDeps.now} clock. The
 * stores are the *same* objects the rest of the worker composes, so a tool call
 * is indistinguishable from the equivalent API call downstream.
 */
export interface McpToolDeps {
  /** Projects + membership lookup (writes: create/update). */
  readonly projects: McpProjectStore;
  /** Variable declarations. */
  readonly variables: McpVariableStore;
  /** The projection reader (`get_state`, `set_variable` verification). */
  readonly state: McpStateStore;
  /** The series/ring reader (`get_series`). */
  readonly series: McpSeriesStore;
  /** Dashboard layouts. */
  readonly layouts: McpLayoutStore;
  /** Automation rules. */
  readonly automations: McpAutomationStore;
  /** Integrations (their `config` is secret-bearing). */
  readonly integrations: McpIntegrationStore;
  /** Discrete-event dispatch (`emit_event`). */
  readonly events: McpEventDispatcher;
  /** Clock; the ONLY source of "now". Defaults to the wall clock. */
  readonly now?: () => number;
  /**
   * The secret registry used by redaction. Optional; a fresh one is created
   * when omitted. Supply it to seed already-stored secrets, or to share one
   * registry across a deployment's tool surfaces.
   */
  readonly secrets?: SecretRegistry;
}

/** Default wall clock. */
const defaultClock = (): number => Date.now();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, machine-readable tool-failure reasons. */
export type McpToolErrorCode =
  | "unknown_tool"
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "read_only";

/** The `{ error, message }` body a tool rejection carries. */
export interface McpToolErrorBody {
  readonly error: McpToolErrorCode;
  readonly message: string;
}

/** A typed tool failure a handler maps onto its wire status. */
export class McpToolError extends Error {
  readonly code: McpToolErrorCode;
  readonly status: number;

  constructor(code: McpToolErrorCode, message: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.status = code === "unknown_tool" || code === "invalid_request" ? 400 : code === "read_only" ? 403 : code === "not_found" ? 404 : 403;
  }

  toBody(): McpToolErrorBody {
    return { error: this.code, message: this.message };
  }
}

/** Is `err` one of this module's typed tool failures? */
export function isMcpToolError(err: unknown): err is McpToolError {
  return err instanceof McpToolError;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/** A parsed, validated tool-call argument bag. */
export type ToolArgs = Readonly<Record<string, unknown>>;

/** Require a non-blank string argument, or throw `invalid_request`. */
function reqString(args: ToolArgs, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpToolError("invalid_request", `"${name}" must be a non-blank string`);
  }
  return value;
}

/** Read an optional string argument. */
function optString(args: ToolArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/** Read an optional finite-number argument; `null`/absent → `null`. */
function optNumber(args: ToolArgs, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new McpToolError("invalid_request", `"${name}" must be a finite number`);
  }
  return value;
}

/** Read an optional plain-object argument. */
function optObject(args: ToolArgs, name: string): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new McpToolError("invalid_request", `"${name}" must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Read a required plain-object argument. */
function reqObject(args: ToolArgs, name: string): Record<string, unknown> {
  const value = optObject(args, name);
  if (value === undefined) {
    throw new McpToolError("invalid_request", `"${name}" is required and must be an object`);
  }
  return value;
}

/** Read an optional string-array argument. */
function optStringArray(args: ToolArgs, name: string): readonly string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new McpToolError("invalid_request", `"${name}" must be an array of strings`);
  }
  return value as readonly string[];
}

// ---------------------------------------------------------------------------
// The tool set
// ---------------------------------------------------------------------------

/**
 * The MCP tool set, bound to injected seams.
 *
 * {@link listTools} advertises the catalogue; {@link read}/{@link write} are the
 * two `McpCallHandler`s a deploy hands to {@link createMcpGate}; {@link call}
 * is the direct, already-authorized entry a test (or an in-process caller) uses
 * to invoke one tool by name. Every result — from every path — is redacted.
 */
export interface McpTools {
  /** The frozen catalogue, specs included. */
  listTools(): readonly McpToolSpec[];
  /** Invoke a tool by name after authorization; redacts the result. */
  call(name: string, args: ToolArgs, principal: Principal): Promise<unknown>;
  /** The read-path handler for `createMcpGate` (`?tool=<name>` + query args). */
  readonly read: McpCallHandler;
  /** The write-path handler for `createMcpGate` (`{ tool, args }` body). */
  readonly write: McpCallHandler;
  /** The secret registry this set redacts with (for seeding in tests). */
  readonly secrets: SecretRegistry;
}

/**
 * Build the tool surface over injected seams.
 *
 * @throws TypeError when a required store is missing — a bridge with a hole
 *   would serve a tool that cannot work, so composition fails loudly instead.
 */
export function createMcpTools(deps: McpToolDeps): McpTools {
  assertDeps(deps);
  const now = deps.now ?? defaultClock;
  const secrets = deps.secrets ?? new SecretRegistry();

  /** Read a project, or throw `not_found` — the tenant-safe 404. */
  async function requireProject(projectId: string): Promise<Project> {
    const project = await deps.projects.getProject(projectId);
    if (project === null) {
      throw new McpToolError("not_found", `no such project: ${projectId}`);
    }
    return project;
  }

  /**
   * Authorize a **read** against a project.
   *
   * A read is not free: reading another tenant's state, series, dashboards or
   * integrations is exactly the leak this refuses. The rule is the same one the
   * write path uses and the same the shared middleware enforces (INV-A1/A5):
   *
   *   * a `device` principal (an MCP bearer, a project token) is bound to
   *     **one** tenant — the `projectId` its credential carried through the
   *     gate. A read of any other project is refused, and so is a read by an
   *     **unbound** principal (`projectId === ""`): a credential that names no
   *     project may read none, which is the fail-closed direction;
   *   * a `user` principal must be a **member** of the project — any role may
   *     read, but a non-member may not. A project that does not exist at all is
   *     `not_found` (a missing resource, not a boundary the caller owns), while
   *     a project that exists but the user is not in is `forbidden`.
   *
   * Matching is exact and total; there is no prefix or wildcard that could turn
   * "the tenant I hold" into "every tenant".
   */
  async function authorizeRead(principal: Principal, projectId: string): Promise<void> {
    if (principal.kind === "device") {
      // A device/MCP principal is bound to one tenant. A read of any other —
      // or from an unbound credential — is refused outright, with no existence
      // probe, so a foreign id is never an oracle.
      if (principal.projectId === "" || principal.projectId !== projectId) {
        throw new McpToolError("forbidden", "the credential does not grant access to this project");
      }
      return;
    }
    // A user must be a member. Distinguish "no such project" (404) from "not
    // yours" (403): the former is a missing resource, the latter a refusal.
    await requireProject(projectId);
    const role = await deps.projects.roleOf(projectId, principal.userId);
    if (role === null) {
      throw new McpToolError("forbidden", "the caller is not a member of this project");
    }
  }

  /**
   * Authorize a **write** against a project.
   *
   * The caller already holds `mcp:manage` (the gate decided that), but a scope
   * is a bridge capability, not a tenant role: the actor must *also* be allowed
   * to mutate the named project. A `device` principal (a project token, or an
   * MCP bearer bound to a tenant) is scoped to its own project, so it may write
   * only there — an **unbound** principal (`projectId === ""`) is refused
   * outright, because a credential with no tenant may write to none. A `user`
   * principal must be a member with a mutating role. This is the second lock —
   * the same owner/admin distinction the admin routes enforce — applied at the
   * bridge so a manage-scoped token cannot mutate a tenant it does not belong
   * to.
   */
  async function authorizeWrite(principal: Principal, projectId: string, actorId: string): Promise<void> {
    if (principal.kind === "device") {
      // A device principal carries its own tenant; a write to any other tenant —
      // or from an unbound credential — is refused, because the token's scope is
      // that one project.
      if (principal.projectId === "" || principal.projectId !== projectId) {
        throw new McpToolError("forbidden", "the credential does not grant access to this project");
      }
      return;
    }
    const role = await deps.projects.roleOf(projectId, actorId);
    if (role !== "owner" && role !== "admin") {
      throw new McpToolError("forbidden", "only an owner or admin may mutate this project");
    }
  }

  /** The acting user id: the principal's own, or an explicit override. */
  function actorOf(principal: Principal, args: ToolArgs): string {
    if (principal.kind === "user") return principal.userId;
    const explicit = optString(args, "actorId");
    return explicit ?? principal.projectId;
  }

  // --- read handlers ---------------------------------------------------

  async function runRead(name: string, args: ToolArgs, principal: Principal): Promise<unknown> {
    switch (name) {
      case "list_projects": {
        const all = await deps.projects.listProjects();
        if (principal.kind === "device") {
          // A device principal sees exactly its own tenant — never the whole
          // installation. An unbound device principal (`projectId === ""`) sees
          // nothing, the fail-closed direction rather than an all-tenant list.
          const visible = principal.projectId === "" ? [] : all.filter((p) => p.id === principal.projectId);
          return { projects: visible };
        }
        // A human sees only the projects they belong to.
        const visibleForUser: Project[] = [];
        for (const project of all) {
          if (await deps.projects.roleOf(project.id, principal.userId)) visibleForUser.push(project);
        }
        return { projects: visibleForUser };
      }
      case "get_project": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        return { project: await requireProject(projectId) };
      }
      case "list_variables": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const variables = await deps.variables.list(projectId);
        return { variables };
      }
      case "get_state": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const state = await deps.state.read(projectId, optString(args, "device"), optString(args, "variable"));
        return { state };
      }
      case "get_series": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const variable = reqString(args, "variable");
        const windowMs = optNumber(args, "windowMs") ?? 60 * 60 * 1000;
        if (windowMs < 0) {
          throw new McpToolError("invalid_request", "windowMs must be non-negative");
        }
        const series = await deps.series.series(projectId, variable, windowMs, now());
        return { series };
      }
      case "list_dashboards": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const layouts = await deps.layouts.list(projectId);
        return { dashboards: layouts };
      }
      case "get_dashboard": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const dashboardId = reqString(args, "dashboardId");
        const layout = await deps.layouts.get(projectId, dashboardId);
        if (layout === null) throw new McpToolError("not_found", `no such dashboard: ${dashboardId}`);
        return { dashboard: layout };
      }
      case "list_automations": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const automations = await deps.automations.list(projectId);
        return { automations };
      }
      case "get_automation": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const automationId = reqString(args, "automationId");
        const automation = await deps.automations.get(projectId, automationId);
        if (automation === null) throw new McpToolError("not_found", `no such automation: ${automationId}`);
        return { automation };
      }
      case "list_integrations": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const integrations = await deps.integrations.list(projectId);
        return { integrations: integrations.map(redactIntegration) };
      }
      case "get_integration": {
        const projectId = reqString(args, "projectId");
        await authorizeRead(principal, projectId);
        const integrationId = reqString(args, "integrationId");
        const integration = await deps.integrations.get(projectId, integrationId);
        if (integration === null) throw new McpToolError("not_found", `no such integration: ${integrationId}`);
        return { integration: redactIntegration(integration) };
      }
      default:
        throw new McpToolError("unknown_tool", `unknown read tool: ${name}`);
    }
  }

  // --- write handlers --------------------------------------------------

  async function runWrite(name: string, args: ToolArgs, principal: Principal): Promise<unknown> {
    switch (name) {
      case "create_project": {
        const projectName = reqString(args, "name");
        const ownerId = reqString(args, "ownerId");
        const actor = actorOf(principal, args);
        // A user may only create projects they own; a device token is not a
        // project-creation credential (it is scoped to an existing tenant).
        if (principal.kind !== "user") {
          throw new McpToolError("forbidden", "a project must be created by a user credential");
        }
        if (actor !== ownerId) {
          throw new McpToolError("forbidden", "the ownerId must be the acting user");
        }
        const project = await deps.projects.createProject({
          id: optString(args, "id"),
          name: projectName,
          slug: optString(args, "slug"),
          ownerId,
          now: now(),
        });
        return { project };
      }
      case "update_project": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const update = deps.projects.updateProject;
        if (typeof update !== "function") {
          throw new McpToolError("invalid_request", "this project store cannot update projects");
        }
        const project = await update.call(deps.projects, projectId, { name: reqString(args, "name") }, now());
        if (project === null) throw new McpToolError("not_found", `no such project: ${projectId}`);
        return { project };
      }
      case "create_variable":
      case "update_variable": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const key = reqString(args, "key");
        const existing = await deps.variables.get(projectId, key);
        if (name === "create_variable" && existing !== null) {
          throw new McpToolError("invalid_request", `variable already exists: ${key}`);
        }
        if (name === "update_variable" && existing === null) {
          throw new McpToolError("not_found", `no such variable: ${key}`);
        }
        const record: VariableRecord = {
          projectId,
          key,
          unit: optString(args, "unit") ?? existing?.unit,
          value: existing?.value ?? null,
          updatedAt: now(),
        };
        await deps.variables.put(record);
        return { variable: record };
      }
      case "set_variable": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const key = reqString(args, "key");
        const value = optNumber(args, "value");
        const existing = await deps.variables.get(projectId, key);
        const record: VariableRecord = {
          projectId,
          key,
          unit: existing?.unit,
          value,
          updatedAt: now(),
        };
        await deps.variables.put(record);
        return { variable: record };
      }
      case "create_layout":
      case "update_layout": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const layoutId = reqString(args, "layoutId");
        const existing = await deps.layouts.get(projectId, layoutId);
        if (name === "create_layout" && existing !== null) {
          throw new McpToolError("invalid_request", `layout already exists: ${layoutId}`);
        }
        if (name === "update_layout" && existing === null) {
          throw new McpToolError("not_found", `no such layout: ${layoutId}`);
        }
        const variables = optStringArray(args, "variables") ?? existing?.variables ?? [];
        const record: LayoutRecord = { projectId, id: layoutId, variables, updatedAt: now() };
        await deps.layouts.put(record);
        return { dashboard: record };
      }
      case "create_automation":
      case "update_automation": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const automationId = reqString(args, "automationId");
        const existing = await deps.automations.get(projectId, automationId);
        if (name === "create_automation" && existing !== null) {
          throw new McpToolError("invalid_request", `automation already exists: ${automationId}`);
        }
        if (name === "update_automation" && existing === null) {
          throw new McpToolError("not_found", `no such automation: ${automationId}`);
        }
        const rule = reqObject(args, "rule") as unknown as Rule;
        const record: AutomationRecord = { id: automationId, projectId, rule };
        await deps.automations.put(record);
        return { automation: record };
      }
      case "create_integration":
      case "update_integration": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const integrationId = reqString(args, "integrationId");
        const existing = await deps.integrations.get(projectId, integrationId);
        if (name === "create_integration" && existing !== null) {
          throw new McpToolError("invalid_request", `integration already exists: ${integrationId}`);
        }
        if (name === "update_integration" && existing === null) {
          throw new McpToolError("not_found", `no such integration: ${integrationId}`);
        }
        const config = reqObject(args, "config");
        // Register the config's secret leaves so the same plaintext is redacted
        // even if it later appears under an innocent key in some other result.
        secrets.addDeep(config);
        const record: IntegrationRecord = { projectId, id: integrationId, config, updatedAt: now() };
        await deps.integrations.put(record);
        return { integration: redactIntegration(record) };
      }
      case "emit_event": {
        const projectId = reqString(args, "projectId");
        await requireProject(projectId);
        await authorizeWrite(principal, projectId, actorOf(principal, args));
        const event = reqString(args, "event");
        const payload = optObject(args, "payload") ?? null;
        await deps.events({ projectId, event, payload });
        return { emitted: true, event };
      }
      default:
        // Includes every `delete*` name: it is simply not a tool.
        throw new McpToolError("read_only", `unknown write tool: ${name}`);
    }
  }

  /** Dispatch one tool after authorization, always redacting the result. */
  async function call(name: string, args: ToolArgs, principal: Principal): Promise<unknown> {
    const tool = findTool(name);
    if (tool === undefined) {
      throw new McpToolError("unknown_tool", `unknown tool: ${String(name)}`);
    }
    const result = tool.kind === "read" ? await runRead(name, args, principal) : await runWrite(name, args, principal);
    return redactSecrets(result, secrets);
  }

  /** Refuse a write tool reached on the read path. */
  async function serveRead(name: string, args: ToolArgs, principal: Principal): Promise<unknown> {
    const tool = findTool(name);
    if (tool === undefined) {
      throw new McpToolError("unknown_tool", `unknown tool: ${String(name)}`);
    }
    if (tool.kind === "write") {
      // A write name on the read path is refused outright: the read path is
      // read-scoped, so it may never serve a mutation.
      throw new McpToolError("read_only", `"${name}" is a write tool and requires mcp:manage`);
    }
    return call(name, args, principal);
  }

  /** Parse the query string of a `GET /read` into a tool + args. */
  function readRequest(c: Context): { name: string; args: ToolArgs } {
    const url = new URL(c.req.url);
    const name = url.searchParams.get("tool") ?? "";
    // A query string carries only strings, but a read tool may declare a numeric
    // parameter (e.g. `get_series.windowMs`). Coerce by the DECLARED type so the
    // documented GET surface accepts the parameter instead of rejecting every
    // numeric arg as a non-number — the JSON write path already delivers real
    // numbers and is left untouched.
    const numeric = new Set(
      (SPECS[name]?.params ?? []).filter((p) => p.type === "number").map((p) => p.name),
    );
    const args: Record<string, unknown> = {};
    url.searchParams.forEach((value, key) => {
      if (key === "tool") return;
      if (numeric.has(key)) {
        const parsed = Number(value);
        args[key] = Number.isFinite(parsed) ? parsed : value; // non-numeric → let the tool reject it
      } else {
        args[key] = value;
      }
    });
    return { name, args };
  }

  /** Parse the JSON body of a `POST /write` into a tool + args. */
  async function writeRequest(c: Context): Promise<{ name: string; args: ToolArgs }> {
    let raw: string;
    try {
      raw = await c.req.text();
    } catch {
      throw new McpToolError("invalid_request", "could not read the request body");
    }
    let parsed: unknown;
    try {
      parsed = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      throw new McpToolError("invalid_request", "malformed JSON body");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new McpToolError("invalid_request", "body must be a { tool, args } object");
    }
    const record = parsed as Record<string, unknown>;
    const name = typeof record.tool === "string" ? record.tool : "";
    const args =
      record.args !== undefined && record.args !== null && typeof record.args === "object" && !Array.isArray(record.args)
        ? (record.args as Record<string, unknown>)
        : {};
    return { name, args };
  }

  const read: McpCallHandler = async (c, principal) => {
    const { name, args } = readRequest(c);
    return serveRead(name, args, principal);
  };

  const write: McpCallHandler = async (c, principal) => {
    const { name, args } = await writeRequest(c);
    return runWrite(name, args, principal).then((r) => redactSecrets(r, secrets));
  };

  return {
    listTools: () => MCP_TOOL_SPECS,
    call,
    read,
    write,
    secrets,
  };
}

/**
 * Compose the full bridge: the gate (auth + scope + flag) in front of the tool
 * surface, exactly as a deploy mounts it.
 *
 * The read path serves read tools; the write path serves write tools and is
 * reachable only with `mcp:manage` **and** `mcp_write_enabled` — the two keys
 * {@link createMcpGate} enforces before either handler runs. A *tool-level*
 * failure (an unknown tool, a bad argument, a missing record) is not an
 * authorization decision, so it is reported **inside** the gated result as a
 * `{ ok: false, error, message }` envelope — the gate's `200 { result }` shape
 * is its own frozen contract, and a tool error must not be confused with the
 * gate's `401`/`403` refusals. A successful call is `{ ok: true, data }`.
 */
export function createMcpToolRoutes(deps: McpToolDeps & { readonly gate: McpGateDeps }): Hono {
  const tools = createMcpTools(deps);
  const app = new Hono();
  app.route(
    "/",
    createMcpGate({
      verifyToken: deps.gate.verifyToken,
      mcpWriteEnabled: deps.gate.mcpWriteEnabled,
      read: envelope(tools.read),
      write: envelope(tools.write),
    }),
  );
  return app;
}

/** A successful tool result on the wire. */
export interface McpToolOkEnvelope {
  readonly ok: true;
  readonly data: unknown;
}

/** A tool-level failure on the wire (distinct from the gate's own refusals). */
export interface McpToolFailEnvelope {
  readonly ok: false;
  readonly error: McpToolErrorCode;
  readonly message: string;
}

/** What a tool handler returns to the gate as its `result`. */
export type McpToolEnvelope = McpToolOkEnvelope | McpToolFailEnvelope;

/**
 * Wrap a tool handler so a {@link McpToolError} becomes a
 * {@link McpToolFailEnvelope} and success becomes a {@link McpToolOkEnvelope}.
 */
function envelope(handler: McpCallHandler): McpCallHandler {
  return async (c, principal) => {
    try {
      return { ok: true, data: await handler(c, principal) } satisfies McpToolOkEnvelope;
    } catch (err) {
      if (isMcpToolError(err)) {
        return { ok: false, error: err.code, message: err.message } satisfies McpToolFailEnvelope;
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// In-memory stores — honest defaults for tests and dev
// ---------------------------------------------------------------------------

/**
 * In-memory {@link McpToolStores}-shaped containers, wired into one bundle.
 *
 * Models each store's contract closely enough that a test failure here is a
 * failure of the tool logic, not of the fake: tenant ids are part of the key
 * (so a cross-tenant lookup is simply absent), reads return copies, and an
 * integration's config is stored verbatim (redaction happens on the way *out*).
 * Every write is observable, so {@link InMemoryMcpToolStores.lastIntegration}
 * and friends make "the write applied" a direct assertion.
 */
export class InMemoryMcpToolStores {
  readonly projects = new Map<string, Project>();
  readonly members = new Map<string, Map<string, Role>>();
  readonly variables = new Map<string, Map<string, VariableRecord>>();
  readonly state = new Map<string, Map<string, StateRow>>();
  readonly series = new Map<string, SeriesPoint[]>();
  readonly layouts = new Map<string, Map<string, LayoutRecord>>();
  readonly automations = new Map<string, Map<string, AutomationRecord>>();
  readonly integrations = new Map<string, Map<string, IntegrationRecord>>();
  readonly events: { projectId: string; event: string; payload: unknown }[] = [];
  readonly clock: () => number;
  /** Ids created by {@link McpProjectStore.createProject}. */
  readonly createdProjectIds: string[] = [];

  constructor(now: () => number = () => 1_000) {
    this.clock = now;
  }

  /** Seed a project (and optionally the actor's role in it). */
  addProject(projectId: string, actorId?: string, role: Role = "owner", name = projectId): this {
    const at = this.clock();
    this.projects.set(projectId, {
      id: projectId,
      name,
      slug: projectId,
      ownerId: actorId ?? "owner",
      createdAt: at,
      updatedAt: at,
    });
    if (actorId) this.members.set(projectId, new Map([[actorId, role]]));
    return this;
  }

  /** Seed a variable. */
  addVariable(projectId: string, key: string, value: number | null = null): this {
    const inner = this.variables.get(projectId) ?? new Map<string, VariableRecord>();
    inner.set(key, { projectId, key, value, updatedAt: this.clock() });
    this.variables.set(projectId, inner);
    return this;
  }

  /** Seed a projected state row for `projectId` (the `latest_state` index). */
  addState(projectId: string, row: StateRow): this {
    const inner = this.state.get(projectId) ?? new Map<string, StateRow>();
    inner.set(`${row.device}\u0000${row.variable}`, row);
    this.state.set(projectId, inner);
    return this;
  }

  /** Seed one dashboard layout. */
  addLayout(projectId: string, layoutId: string, variables: readonly string[] = []): this {
    const inner = this.layouts.get(projectId) ?? new Map<string, LayoutRecord>();
    inner.set(layoutId, { projectId, id: layoutId, variables, updatedAt: this.clock() });
    this.layouts.set(projectId, inner);
    return this;
  }

  /** Seed one automation rule. */
  addAutomation(projectId: string, automationId: string, rule: Rule): this {
    const inner = this.automations.get(projectId) ?? new Map<string, AutomationRecord>();
    inner.set(automationId, { id: automationId, projectId, rule });
    this.automations.set(projectId, inner);
    return this;
  }

  /** Seed one integration (its `config` may carry secret material). */
  addIntegration(projectId: string, integrationId: string, config: Record<string, unknown> = {}): this {
    const inner = this.integrations.get(projectId) ?? new Map<string, IntegrationRecord>();
    inner.set(integrationId, { projectId, id: integrationId, config, updatedAt: this.clock() });
    this.integrations.set(projectId, inner);
    return this;
  }

  /** Seed one series point into a project's ring. */
  addSeriesPoint(projectId: string, point: SeriesPoint): this {
    const rows = this.series.get(projectId) ?? [];
    rows.push(point);
    this.series.set(projectId, rows);
    return this;
  }

  /** The seams bundle this fake satisfies. */
  get seams(): McpToolStores {
    return {
      projects: {
        listProjects: async () => [...this.projects.values()],
        getProject: async (id) => this.projects.get(id) ?? null,
        createProject: async (input) => {
          const id = input.id ?? `p_${this.projects.size + 1}`;
          const at = this.clock();
          const project: Project = {
            id,
            name: input.name,
            slug: input.slug ?? input.name.toLowerCase(),
            ownerId: input.ownerId,
            createdAt: at,
            updatedAt: at,
          };
          this.projects.set(id, project);
          this.members.set(id, new Map([[input.ownerId, "owner"]]));
          this.createdProjectIds.push(id);
          return project;
        },
        updateProject: async (id, patch) => {
          const project = this.projects.get(id);
          if (project === undefined) return null;
          const next: Project = { ...project, name: patch.name, updatedAt: this.clock() };
          this.projects.set(id, next);
          return next;
        },
        roleOf: async (id, actorId) => this.members.get(id)?.get(actorId) ?? null,
      },
      variables: {
        list: async (projectId) => [...(this.variables.get(projectId)?.values() ?? [])],
        get: async (projectId, key) => this.variables.get(projectId)?.get(key) ?? null,
        put: async (record) => {
          const inner = this.variables.get(record.projectId) ?? new Map<string, VariableRecord>();
          inner.set(record.key, record);
          this.variables.set(record.projectId, inner);
        },
      },
      state: {
        read: async (projectId, device, variable) =>
          [...(this.state.get(projectId)?.values() ?? [])].filter(
            (row) => (device === undefined || row.device === device) && (variable === undefined || row.variable === variable),
          ),
        latestValue: async (projectId, key) => {
          const rows = [...(this.state.get(projectId)?.values() ?? [])].filter((r) => r.variable === key);
          if (rows.length === 0) return null;
          return rows.reduce((best, row) => (best === null || row.ts > best.ts ? row : best)).value;
        },
      },
      series: {
        series: async (projectId, variable, windowMs, now) =>
          (this.series.get(projectId) ?? [])
            .filter((p) => p.variable === variable && p.ts >= now - windowMs && p.ts <= now)
            .sort((a, b) => a.ts - b.ts || a.seq - b.seq),
      },
      layouts: {
        list: async (projectId) => [...(this.layouts.get(projectId)?.values() ?? [])],
        get: async (projectId, layoutId) => this.layouts.get(projectId)?.get(layoutId) ?? null,
        put: async (record) => {
          const inner = this.layouts.get(record.projectId) ?? new Map<string, LayoutRecord>();
          inner.set(record.id, record);
          this.layouts.set(record.projectId, inner);
        },
      },
      automations: {
        list: async (projectId) => [...(this.automations.get(projectId)?.values() ?? [])],
        get: async (projectId, automationId) => this.automations.get(projectId)?.get(automationId) ?? null,
        put: async (record) => {
          const inner = this.automations.get(record.projectId) ?? new Map<string, AutomationRecord>();
          inner.set(record.id, record);
          this.automations.set(record.projectId, inner);
        },
      },
      integrations: {
        list: async (projectId) => [...(this.integrations.get(projectId)?.values() ?? [])],
        get: async (projectId, integrationId) => this.integrations.get(projectId)?.get(integrationId) ?? null,
        put: async (record) => {
          const inner = this.integrations.get(record.projectId) ?? new Map<string, IntegrationRecord>();
          inner.set(record.id, record);
          this.integrations.set(record.projectId, inner);
        },
      },
      events: (trigger) => {
        this.events.push(trigger);
      },
      now: this.clock,
    };
  }
}

/** The seam bundle shape `McpToolStores` names (alias of `McpToolDeps` minus secrets). */
export type McpToolStores = Omit<McpToolDeps, "secrets">;

// ---------------------------------------------------------------------------
// Composition guard
// ---------------------------------------------------------------------------

/** The required stores; a missing one is a composition error, not a 500. */
const REQUIRED_STORES = [
  "projects",
  "variables",
  "state",
  "series",
  "layouts",
  "automations",
  "integrations",
] as const;

/** Throw loudly when a required store is absent or malformed. */
function assertDeps(deps: McpToolDeps): void {
  const missing: string[] = [];
  for (const name of REQUIRED_STORES) {
    const store = deps?.[name];
    if (typeof store !== "object" || store === null) missing.push(name);
  }
  if (typeof deps?.events !== "function") missing.push("events");
  if (missing.length > 0) {
    throw new TypeError(`createMcpTools: missing required dependency: ${missing.join(", ")}`);
  }
}

export type { McpCallHandler, McpCredential, McpGateDeps, VerifyMcpToken };
export { hasScope };

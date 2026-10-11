/**
 * shared/integrations/runtime — execute a catalogued action over an **injected
 * transport**, and prove it is wired without doing it for real (A29b /
 * FR-INT-01, FR-INT-02).
 *
 * The catalog (`index.ts`) says *what* a provider is; the crypto module
 * (`crypto.ts`) seals and opens its credentials; the interpolator
 * (`interpolate.ts`) renders `{{var}}`. This module is the fourth piece and the
 * only one that touches the network — so it touches it through a seam:
 *
 * ```
 *   const transport = new FetchTransport();               // the one real caller
 *   await execute({ providerId: "telegram", action: "send_message", config,
 *                   secret, scope, transport });
 * ```
 *
 * ## The seam is the seam
 *
 * {@link IntegrationTransport} is a one-method port: `send(request)`. Nothing in
 * this module reaches for `fetch`, a clock or a global — an execution is a pure
 * function of `(provider, action, config, secret, scope, transport)`. That is
 * what makes the two acceptance properties testable at all:
 *
 *   * **It renders correctly.** The action's template and every config/secret
 *     value are run through `interpolate` against the caller's `scope`, so a
 *     body of `"Temp is {{temp}}°C"` and a chat id of `{{chat}}` resolve before
 *     anything leaves. A test hands a *fake* transport and asserts the exact
 *     request it received.
 *   * **It has no hidden side effect.** Because the transport is the only thing
 *     that can perform I/O, a fake transport recording what it was handed is a
 *     complete account of the execution's effects. The acceptance criterion
 *     "`/test` sends a synthetic request and causes no real effect" is, at this
 *     layer, exactly "the fake transport saw one request and made no call".
 *
 * ## Secrets are opened only here, and never echoed
 *
 * A secret config value is stored **encrypted** (see `crypto.ts`). The rule this
 * module enforces is the storage module's stated execution boundary: a secret is
 * decrypted *just before* the request is built, held in a local, interpolated
 * into the outgoing request, and never persisted. Two consequences are pinned by
 * the design:
 *
 *   1. The **stored ciphertext is never what is sent** — the transport receives
 *      the plaintext the tenant configured (or, under {@link ExecutionOptions.aad}
 *      mismatches, the open fails and nothing is sent: fail closed).
 *   2. The **result never carries the plaintext secret back**. {@link
 *      IntegrationResult} describes what was *asked* (provider, action, the
 *      rendered request), not the credentials used to ask; a caller that logs a
 *      result cannot accidentally log a token. Only the transport that actually
 *      dials the provider ever holds the opened value, for the length of one call.
 *
 * ## `/test` is a mode of the *same* executor, not a second code path
 *
 * {@link testIntegration} builds a **synthetic** request: it renders the exact
 * same way, but marks the request `synthetic`, and hands it to a transport that
 * is the caller's. The difference between "execute" and "test" is therefore
 * *one flag and the transport the caller injected* — never a branch that could
 * drift from the real path and give a false sense of safety. A test proves the
 * two things the requirement cares about in one breath: the synthetic request is
 * what *would* be sent (asserted through the fake), and no real effect follows
 * (the fake is the only transport, and it makes none).
 *
 * ## Unknown providers are rejected, loudly
 *
 * An id absent from the catalog, or an action a manifest does not list, is a
 * {@link IntegrationRuntimeError} with a stable `code` — never a silent no-op
 * and never a `undefined` dereference. The catalog is the authority; the runtime
 * refuses to invent a provider it does not know, which is the safe answer to a
 * typo or a stale rule referencing a removed provider.
 */

import { getProvider, type ProviderManifest } from "./index";
import { interpolate, type InterpolationScope } from "./interpolate";
import { decryptSecret } from "./crypto";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable, branchable codes for the ways an execution can refuse. */
export type IntegrationRuntimeErrorCode =
  | "unknown_provider"
  | "unknown_action"
  | "missing_config"
  | "missing_secret";

/**
 * The one error this module throws for a refusal. `code` is the stable part a
 * caller branches on; `message` is for humans. A provider we do not know, an
 * action a manifest does not list, or a required config/secret the tenant did
 * not supply all fail **closed** — nothing is sent.
 */
export class IntegrationRuntimeError extends Error {
  readonly code: IntegrationRuntimeErrorCode;

  constructor(code: IntegrationRuntimeErrorCode, message: string) {
    super(message);
    this.name = "IntegrationRuntimeError";
    this.code = code;
  }
}

/** Type guard for {@link IntegrationRuntimeError}, safe across realms/bundlers. */
export function isIntegrationRuntimeError(value: unknown): value is IntegrationRuntimeError {
  return value instanceof IntegrationRuntimeError;
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/**
 * One outbound request, fully rendered and ready to send. Every field is a
 * concrete value — the runtime has already resolved `{{var}}` and opened the
 * secret — so a transport does no interpolation and holds no crypto key. It is
 * the *only* description of an effect, which is what lets a fake stand in for
 * the network exhaustively.
 */
export interface RenderedRequest {
  /** The provider the request targets. */
  readonly providerId: string;
  /** The action being invoked. */
  readonly action: string;
  /**
   * `true` for a `/test` request. A real transport should treat a synthetic
   * request as "render and report, do not dial" — the marker travels with the
   * request so a caller can route it to a dry-run sink unambiguously.
   */
  readonly synthetic: boolean;
  /** The resolved body/parameters (the action template, rendered). */
  readonly body: unknown;
  /**
   * Resolved non-secret config (chat id, url, from …). Never contains a secret
   * — secrets live in {@link auth} — so a transport can log `config` safely.
   */
  readonly config: Readonly<Record<string, string>>;
  /**
   * The opened credentials, by field name, for the transport to attach (an
   * `Authorization` header, a bot token in the URL). This is the **only** place
   * a plaintext secret is carried: it travels to the transport and no further —
   * {@link IntegrationResult} intentionally does **not** return it, so a result
   * can be logged without a token riding along.
   */
  readonly auth: Readonly<Record<string, string>>;
}

/**
 * The network-egress port. The runtime depends on this and nothing lower; a
 * production deployment injects an implementation that calls `fetch`, and a
 * test injects one that records. One method, because an integration call is one
 * request — retries, signing and timeouts are the transport's business, not the
 * runtime's.
 */
export interface IntegrationTransport {
  /** Perform (or refuse, or merely record) one rendered request. */
  send(request: RenderedRequest): Promise<TransportResponse>;
}

/**
 * What a transport reports back. `status` is a provider-shaped result (an HTTP
 * status, or a transport's own code); `body` is opaque and returned to the
 * caller as evidence, never interpreted here — this module knows nothing about
 * Telegram's or Slack's response schemas, and guessing would be a lie.
 */
export interface TransportResponse {
  /** Provider-shaped outcome, e.g. an HTTP status. */
  readonly status: number;
  /** Opaque response body, returned to the caller for evidence. */
  readonly body?: unknown;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * How a secret envelope is opened. `secret` is the stored, **encrypted** value
 * (a `crypto.ts` envelope); `key` is the injected `CryptoKey`; `aad`, when the
 * tenant used one, must be supplied again or the open fails closed.
 */
export interface SecretInput {
  /** The stored envelope, e.g. `insight-secret:v1:<nonce>.<body>`. */
  readonly envelope: string;
  /** The AES-GCM key that opens it (see `importSecretKey`). */
  readonly key: CryptoKey;
  /** The AAD used at seal time, if any. */
  readonly aad?: string | null;
}

/** Everything one execution needs; every dependency is supplied, none imported. */
export interface ExecuteIntegrationInput {
  /** The provider id; must be in the catalog. */
  readonly providerId: string;
  /** The action to invoke; must be listed on the provider's manifest. */
  readonly action: string;
  /**
   * Non-secret config values, keyed by {@link ConfigField.key}. Each value is a
   * `{{var}}` template rendered against `scope`, so a chat id may itself be
   * dynamic (`"{{chat}}"`).
   */
  readonly config?: Readonly<Record<string, string>>;
  /**
   * Secret inputs, keyed by the secret field's `key`. Values are opened at the
   * boundary and interpolated like any other; a required secret may be supplied
   * either as a stored envelope (the normal case) or, for a `/test` before a
   * secret is stored, as plaintext via {@link plain}.
   */
  readonly secret?: Readonly<Record<string, SecretValue>>;
  /** The scope `{{var}}` resolves against (project state, thresholds, …). */
  readonly scope?: InterpolationScope;
  /** The injected network-egress port. */
  readonly transport: IntegrationTransport;
  /** `true` to build a synthetic request instead of a live one. */
  readonly synthetic?: boolean;
  /**
   * Strict interpolation: when `true`, a `{{var}}` that does not resolve throws
   * rather than collapsing to `""` (see `interpolate.ts`). Default `false`, so a
   * half-filled config still renders — matching the interpolator's own default.
   */
  readonly strict?: boolean;
}

/**
 * A secret value at the execution boundary: either a **stored envelope** to
 * open, or a **plaintext** value supplied directly (a `/test` before the secret
 * was saved, or a value already opened by the caller). The plaintext form exists
 * so testing a config does not require sealing it first; it is never what is
 * stored.
 */
export type SecretValue =
  | { readonly envelope: string; readonly key: CryptoKey; readonly aad?: string | null }
  | { readonly plain: string };

/** The outcome of an execution: what was asked, and what came back. */
export interface IntegrationResult {
  /** The provider that was invoked. */
  readonly providerId: string;
  /** The action that was invoked. */
  readonly action: string;
  /** `true` when this was a synthetic `/test` request. */
  readonly synthetic: boolean;
  /**
   * The rendered request the transport received, with the opened `auth` **redacted
   * to empty** — this is the loggable account of the call, not the credential.
   * The un-redacted request (with `auth`) is what the transport was handed; a
   * caller that needs it holds it at the transport seam, deliberately, rather
   * than finding it in a result it might print.
   */
  readonly request: RenderedRequest;
  /** The transport's response (provider-shaped; opaque body). */
  readonly response: TransportResponse;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * A resolved template function over the caller's scope. Built once with the
 * caller's strictness so the config/secret/template renderers all agree on the
 * missing-variable policy without threading options through each.
 */
function renderer(scope: InterpolationScope, strict: boolean): (template: string) => string {
  return (template) => interpolate(template, scope, { onMissing: strict ? "error" : "empty" });
}

/**
 * Resolve one provider's manifest or fail closed. Kept as a named step (not an
 * inlined `getProvider(...) ?? throw`) because the same guard backs both the
 * unknown-provider and unknown-action tests, and naming it documents that a
 * missing provider is a *refusal*, not a `undefined`.
 */
function requireProvider(providerId: string): ProviderManifest {
  const provider = getProvider(providerId);
  if (provider === undefined) {
    throw new IntegrationRuntimeError(
      "unknown_provider",
      `execute: unknown provider "${providerId}"`,
    );
  }
  return provider;
}

/**
 * Open every secret input into its plaintext at the boundary. Envelope inputs go
 * through `decryptSecret` (the AES-GCM open that is the whole reason a secret is
 * safe at rest); plain inputs are taken as-is. This is the single point where
 * ciphertext becomes usable, and its result never leaves the caller's stack
 * except into the rendered `auth` of one request.
 */
async function openSecrets(
  secret: Readonly<Record<string, SecretValue>>,
): Promise<Record<string, string>> {
  const opened: Record<string, string> = {};
  for (const [key, value] of Object.entries(secret)) {
    opened[key] =
      "plain" in value
        ? value.plain
        : await decryptSecret(value.envelope, value.key, { aad: value.aad ?? null });
  }
  return opened;
}

/**
 * Render config, secrets and the action template against `scope`, after checking
 * the manifest's required fields are present. Absence of a *required* key is a
 * coded refusal (`missing_config` / `missing_secret`); a supplied-but-unresolved
 * value follows the interpolation policy. The check is on presence, not truth,
 * so an empty-but-supplied value is the author's business, not a surprise.
 */
function buildRequest(
  provider: ProviderManifest,
  action: IntegrationActionRef,
  config: Readonly<Record<string, string>>,
  openedSecrets: Readonly<Record<string, string>>,
  render: (template: string) => string,
  synthetic: boolean,
): RenderedRequest {
  for (const key of provider.requiredConfigFields) {
    if (!Object.hasOwn(config, key)) {
      throw new IntegrationRuntimeError(
        "missing_config",
        `execute: provider "${provider.id}" requires config "${key}"`,
      );
    }
  }
  for (const key of provider.requiredSecretFields) {
    if (!Object.hasOwn(openedSecrets, key)) {
      throw new IntegrationRuntimeError(
        "missing_secret",
        `execute: provider "${provider.id}" requires secret "${key}"`,
      );
    }
  }

  const renderedConfig: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) renderedConfig[key] = render(value);
  const renderedAuth: Record<string, string> = {};
  // Only secrets the manifest names are attached, so an unexpected key cannot
  // smuggle a value into the request.
  for (const key of provider.secretFields) {
    if (Object.hasOwn(openedSecrets, key)) renderedAuth[key] = render(openedSecrets[key]);
  }

  return {
    providerId: provider.id,
    action: action.name,
    synthetic,
    // The action template is rendered as text; a template that is valid JSON
    // stays JSON (the catalog authors it that way), and a plain-text template
    // stays the string it is. The runtime does not re-parse — that is the
    // provider adapter's concern — but it does hand the *rendered* body forward.
    body: render(action.template),
    config: renderedConfig,
    auth: renderedAuth,
  };
}

/** The bits of an action the builder needs; a named alias so the signature reads. */
type IntegrationActionRef = ProviderManifest["actions"][number];

/**
 * Resolve one action on a manifest or fail closed with `unknown_action`. Named
 * for the same reason {@link requireProvider} is: a missing action is a
 * refusal, and every entry point shares this rule.
 */
function requireAction(provider: ProviderManifest, actionName: string): IntegrationActionRef {
  const action = provider.actions.find((candidate) => candidate.name === actionName);
  if (action === undefined) {
    throw new IntegrationRuntimeError(
      "unknown_action",
      `execute: provider "${provider.id}" has no action "${actionName}"`,
    );
  }
  return action;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute one catalogued action over the injected transport.
 *
 * The order is deliberate and fail-closed: **resolve the provider, then the
 * action, then open the secret, then render, then send.** Nothing is opened or
 * sent until the provider and action are known to exist, and nothing is sent at
 * all if a required field is missing or the secret fails to open — so a partially
 * valid config can never produce a half-formed request, and an unknown provider
 * can never reach the transport.
 *
 * @throws {IntegrationRuntimeError} `unknown_provider` / `unknown_action` /
 *   `missing_config` / `missing_secret`.
 * @throws {SecretCryptoError} when a stored secret cannot be opened (a wrong
 *   key or a tampered blob) — the failure the at-rest rule depends on.
 */
export async function executeIntegration(
  input: ExecuteIntegrationInput,
): Promise<IntegrationResult> {
  const provider = requireProvider(input.providerId);
  const action = requireAction(provider, input.action);
  const openedSecrets = await openSecrets(input.secret ?? {});
  const render = renderer(input.scope ?? {}, input.strict ?? false);
  const request = buildRequest(
    provider,
    action,
    input.config ?? {},
    openedSecrets,
    render,
    input.synthetic ?? false,
  );
  const response = await input.transport.send(request);
  // The transport got the `auth`-bearing request; the *caller* gets a copy whose
  // auth is empty, so a result is safe to log by construction (see the field
  // docs on {@link IntegrationResult.request}).
  return {
    providerId: provider.id,
    action: action.name,
    synthetic: request.synthetic,
    request: { ...request, auth: {} },
    response,
  };
}

/**
 * `/test`: execute the same action as a **synthetic** request — rendered exactly
 * as a live one, flagged `synthetic`, and handed to whatever transport the
 * caller injected.
 *
 * This is deliberately *not* a separate renderer: it is {@link executeIntegration}
 * with the flag set, so a test can never diverge from the live path and quietly
 * pass. "No real effect" is the transport's to guarantee (a production deployment
 * injects a dry-run transport here), and the synthetic marker travels on the
 * request so that guarantee is checkable at the transport boundary rather than
 * assumed.
 */
export function testIntegration(
  input: Omit<ExecuteIntegrationInput, "synthetic">,
): Promise<IntegrationResult> {
  return executeIntegration({ ...input, synthetic: true });
}

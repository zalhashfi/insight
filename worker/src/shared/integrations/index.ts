/**
 * shared/integrations/index — the **catalog**: what outbound integrations this
 * build knows how to speak to (A29b / FR-INT-01).
 *
 * An integration is a tenant's stored connection to the outside world: a
 * Telegram bot that texts a greenhouse's caretaker, a Slack webhook that posts
 * to `#ops`, a PagerDuty key that pages on-call. The catalog is the single,
 * declarative answer to "which providers, and what does each need?" — a plain
 * data table, no I/O and no behaviour:
 *
 * ```
 *   const spec = PROVIDERS.telegram;          // PROVIDERS[providerId]
 *   spec.configFields;                        // non-secret config a tenant fills
 *   spec.secretFields;                        // the fields sealed with crypto.ts
 *   spec.actions.map(a => a.name);            // ["send_message"]
 * ```
 *
 * ## Why a manifest and not eight ad-hoc code paths
 *
 * The alternative — a `switch (provider)` in the runtime — spreads "what a
 * provider needs" across branches that drift apart. A manifest keeps one
 * provider's facts in one record: which config keys are required, which are
 * *secrets*, and what action it exposes. The UI renders a form from it, the
 * store validates against it, {@link ../runtime} renders and dispatches from
 * it, and a test can enumerate it. One table, three consumers, zero drift.
 *
 * ## Config vs. secret — the split is the security boundary
 *
 * Every field is either **config** (a non-sensitive value: a chat id, a webhook
 * URL's channel, a `from` address) or **secret** (a credential: a bot token, a
 * signing key, a client secret). The split is not cosmetic: a `secret` field's
 * value is sealed with `crypto.ts` (AES-GCM) before it is stored and is only
 * opened at the execution boundary in `runtime.ts`. A field declared here as
 * `secret` is *never* held in plaintext at rest, and a field declared as config
 * is never mistaken for a credential. Marking the wrong one is therefore a
 * security bug, which is why the classification lives beside the field and is
 * asserted by the tests.
 *
 * ## Actions carry a shape, not a payload
 *
 * An {@link IntegrationAction} names the verbs a provider supports (`send`,
 * `send_message`, `trigger_incident`) and describes how an action body is
 * *shaped*: a `template` is the default body the action sends, authored with
 * `{{var}}` placeholders that `runtime.ts` resolves against a scope. The
 * catalog never renders anything — it only declares. Execution is a separate,
 * injected concern, so this module stays pure data a test can read.
 *
 * ## The eight providers (FR-INT-01)
 *
 * Exactly the set the requirement names, in the order it names them:
 * `http_service` (generic egress), `email` (SMTP/API mail), `telegram`,
 * `slack`, `discord`, `twilio` (SMS/voice), `ms_teams` (Teams webhook) and
 * `pagerduty` (incidents). New providers are a record added here, not a code
 * path anywhere else.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/**
 * The providers this build speaks to, exactly as FR-INT-01 enumerates them.
 * A union (not a loose `string`) so a switch over a provider is exhaustive and
 * an unknown id fails to type-check at the call site that reads the catalog.
 */
export type ProviderId =
  | "http_service"
  | "email"
  | "telegram"
  | "slack"
  | "discord"
  | "twilio"
  | "ms_teams"
  | "pagerduty";

/** Every provider id, in the requirement's own order. */
export const PROVIDER_IDS: readonly ProviderId[] = [
  "http_service",
  "email",
  "telegram",
  "slack",
  "discord",
  "twilio",
  "ms_teams",
  "pagerduty",
];

/**
 * A field a provider's config carries. `secret: true` means the value is sealed
 * at rest (`crypto.ts`) and only decrypted at the execution boundary
 * (`runtime.ts`); `secret: false` (the default) means an ordinary stored value.
 */
export interface ConfigField {
  /** The key as it appears in the config object, e.g. `"bot_token"`. */
  readonly key: string;
  /** Human label for a rendered form; never used for logic. */
  readonly label: string;
  /** `true` when the value is a credential that must be sealed at rest. */
  readonly secret: boolean;
  /**
   * `true` when the action cannot run without it. Optional fields (a Slack
   * `thread_ts`, an email `cc`) may be absent.
   */
  readonly required: boolean;
}

/**
 * One verb a provider exposes. `template` is the **default** body the action
 * sends — a value carrying `{{var}}` placeholders resolved by `runtime.ts`
 * against the caller's scope. It is a *shape* hint, not a contract: a caller
 * may supply its own payload, and the runtime always renders through its
 * injected transport.
 */
export interface IntegrationAction {
  /** The action's name within its provider, e.g. `"send_message"`. */
  readonly name: string;
  /** Human description of the effect; never used for logic. */
  readonly description: string;
  /** A default, `{{var}}`-templated body for this action. */
  readonly template: string;
}

/**
 * A provider's manifest: its identity, the config it requires, the credential
 * fields among that config, and the actions it exposes. This is the whole
 * declarative surface of a provider — nothing about execution lives here.
 */
export interface ProviderManifest {
  /** Stable id, matching a {@link ProviderId}. */
  readonly id: ProviderId;
  /** Human name for listings. */
  readonly name: string;
  /** One-line description of what the provider is for. */
  readonly description: string;
  /** Every config field, secret or not, in the order a form should show them. */
  readonly configFields: readonly ConfigField[];
  /** The subset of {@link configFields} whose values are sealed at rest. */
  readonly secretFields: readonly string[];
  /** Required non-secret config keys (convenience view of `configFields`). */
  readonly requiredConfigFields: readonly string[];
  /** Required secret keys (convenience view of `configFields`). */
  readonly requiredSecretFields: readonly string[];
  /** The actions the provider exposes; at least one. */
  readonly actions: readonly IntegrationAction[];
}

// ---------------------------------------------------------------------------
// Small authoring helpers (keep each manifest a readable literal)
// ---------------------------------------------------------------------------

/**
 * A non-secret config field, and {@link secretField} its sealed counterpart.
 * These exist as named, exported authoring verbs (rather than raw object
 * literals) so a manifest never spells `secret: false` by omission — the choice
 * between a stored value and a credential is always stated, which is the whole
 * point of the split.
 */
export function configField(key: string, label: string, required = true): ConfigField {
  return { key, label, secret: false, required };
}

/** A secret config field — its value is sealed at rest before storage. */
export function secretField(key: string, label: string, required = true): ConfigField {
  return { key, label, secret: true, required };
}

/**
 * Derive the two "required" convenience views and the secret list from the
 * field table, so a manifest author writes each field **once**. Hand-maintaining
 * three parallel lists is exactly how a secret ends up absent from
 * `secretFields` (and therefore stored in the clear) — deriving them makes that
 * unrepresentable.
 */
function manifest(
  id: ProviderId,
  name: string,
  description: string,
  configFields: readonly ConfigField[],
  actions: readonly IntegrationAction[],
): ProviderManifest {
  return {
    id,
    name,
    description,
    configFields,
    secretFields: configFields.filter((f) => f.secret).map((f) => f.key),
    requiredConfigFields: configFields
      .filter((f) => !f.secret && f.required)
      .map((f) => f.key),
    requiredSecretFields: configFields
      .filter((f) => f.secret && f.required)
      .map((f) => f.key),
    actions,
  };
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * The eight manifests, keyed by provider id. Frozen so a consumer cannot mutate
 * the catalog out from under another (a test enumerates it; the runtime dispatches
 * from it), and typed as a total record over {@link ProviderId} so a *missing*
 * provider is a compile error, not a runtime `undefined`.
 */
export const PROVIDERS: Readonly<Record<ProviderId, ProviderManifest>> = Object.freeze({
  http_service: manifest(
    "http_service",
    "HTTP service",
    "Call an arbitrary HTTP endpoint with a templated body.",
    [
      configField("url", "Endpoint URL"),
      configField("method", "HTTP method", false),
      secretField("auth_header", "Authorization header", false),
    ],
    [
      {
        name: "send",
        description: "POST the rendered body to the configured endpoint.",
        template: '{"message":"{{message}}","value":{{value}}}',
      },
    ],
  ),
  email: manifest(
    "email",
    "Email",
    "Send a transactional email through the mail provider.",
    [
      configField("from", "From address"),
      configField("to", "To address"),
      secretField("api_key", "Mail API key"),
    ],
    [
      {
        name: "send",
        description: "Send one email to the configured recipient.",
        template: '{"subject":"{{subject}}","body":"{{message}}"}',
      },
    ],
  ),
  telegram: manifest(
    "telegram",
    "Telegram",
    "Send a message to a Telegram chat via the Bot API.",
    [
      secretField("bot_token", "Bot token"),
      configField("chat_id", "Chat id"),
    ],
    [
      {
        name: "send_message",
        description: "Deliver a text message to the chat.",
        template: "{{message}}",
      },
    ],
  ),
  slack: manifest(
    "slack",
    "Slack",
    "Post a message to a Slack channel via an incoming webhook.",
    [
      secretField("webhook_url", "Incoming webhook URL"),
      configField("channel", "Channel", false),
    ],
    [
      {
        name: "send_message",
        description: "Post a message to the channel.",
        template: '{"text":"{{message}}"}',
      },
    ],
  ),
  discord: manifest(
    "discord",
    "Discord",
    "Post a message to a Discord channel via a webhook.",
    [
      secretField("webhook_url", "Webhook URL"),
      configField("username", "Display name", false),
    ],
    [
      {
        name: "send_message",
        description: "Post a message to the webhook's channel.",
        template: '{"content":"{{message}}"}',
      },
    ],
  ),
  twilio: manifest(
    "twilio",
    "Twilio",
    "Send an SMS or place a call through Twilio.",
    [
      secretField("auth_token", "Auth token"),
      configField("account_sid", "Account SID"),
      configField("from", "From number"),
      configField("to", "To number"),
    ],
    [
      {
        name: "send_sms",
        description: "Send an SMS to the configured number.",
        template: '{"Body":"{{message}}"}',
      },
      {
        name: "place_call",
        description: "Place a call reading a TwiML document.",
        template: "{{twiml}}",
      },
    ],
  ),
  ms_teams: manifest(
    "ms_teams",
    "Microsoft Teams",
    "Post a card to a Microsoft Teams channel via a webhook.",
    [
      secretField("webhook_url", "Incoming webhook URL"),
    ],
    [
      {
        name: "send_card",
        description: "Post a message card to the channel.",
        template: '{"text":"{{message}}"}',
      },
    ],
  ),
  pagerduty: manifest(
    "pagerduty",
    "PagerDuty",
    "Raise or resolve a PagerDuty incident.",
    [
      secretField("routing_key", "Events routing key"),
      configField("service", "Service name", false),
    ],
    [
      {
        name: "trigger_incident",
        description: "Trigger a new incident.",
        template: '{"summary":"{{summary}}","severity":"{{severity}}"}',
      },
      {
        name: "resolve_incident",
        description: "Resolve an existing incident.",
        template: '{"dedup_key":"{{dedup_key}}"}',
      },
    ],
  ),
});

/**
 * Look a provider up by id, returning `undefined` for anything not in the
 * catalog. Reads the entry as an **own** property only, so a prototype key
 * (`"constructor"`, `"toString"`, `"__proto__"`) is "not found" rather than a
 * function the runtime would then treat as a manifest — the same own-property
 * rule the interpolator applies to a scope.
 */
export function getProvider(providerId: string): ProviderManifest | undefined {
  return Object.hasOwn(PROVIDERS, providerId)
    ? (PROVIDERS as Readonly<Record<string, ProviderManifest>>)[providerId]
    : undefined;
}

/** The catalog as an array, in {@link PROVIDER_IDS} order. */
export function listProviders(): readonly ProviderManifest[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}

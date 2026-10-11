import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  PROVIDER_IDS,
  configField,
  getProvider,
  listProviders,
  type ProviderId,
  type ProviderManifest,
} from "../../worker/src/shared/integrations/index";
import {
  IntegrationRuntimeError,
  REDACTED_SECRET,
  executeIntegration,
  isIntegrationRuntimeError,
  testIntegration,
  type DryRunTransport,
  type IntegrationTransport,
  type RenderedRequest,
  type TransportResponse,
} from "../../worker/src/shared/integrations/runtime";
import {
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  importSecretKey,
} from "../../worker/src/shared/integrations/crypto";

/**
 * Spec tests for the A29b integration catalog + runtime (FR-INT-01/02),
 * over the seams A29 established.
 *
 * The two facts this file pins are the task's:
 *
 *   1. **The catalog is complete and well-formed.** Exactly the eight providers
 *      FR-INT-01 names, each with a manifest that separates config from secret
 *      and lists at least one action. The catalog is pure data, so the test
 *      reads it directly — there is nothing to mock.
 *   2. **The runtime is pure over its transport.** Every execution goes through
 *      an **injected fake transport** that records the {@link RenderedRequest} it
 *      was handed. That single seam is why "no real effect" is testable without
 *      the network: the fake is the only thing that *could* perform I/O, and the
 *      assertion is exactly what it saw. A `/test` is asserted the same way,
 *      with the request additionally flagged `synthetic`.
 *
 * Secrets are exercised against the **real** AES-GCM pair: the test seals a
 * token with `encryptSecret`, hands the *envelope* to the runtime, and asserts
 * the transport received the *plaintext* — i.e. the runtime opened it at the
 * boundary and never forwarded the stored ciphertext. Nothing about crypto is
 * mocked here.
 */

// ---------------------------------------------------------------------------
// A recording transport — the only thing that can perform an effect
// ---------------------------------------------------------------------------

/**
 * The fake transport: it records every {@link RenderedRequest} and returns a
 * canned response, performing **no** I/O. `sent` is the append-only journal the
 * tests read back, and its emptiness after a refusal is the "no effect" proof.
 */
class RecordingTransport implements IntegrationTransport {
  /**
   * A recorder performs no I/O, so it declares itself dry-run — honest, and the
   * only kind a `/test` accepts. `executeIntegration` (the live path) takes any
   * kind, so the same recorder stands in there too.
   */
  readonly kind = "dry-run" as const;
  readonly sent: RenderedRequest[] = [];
  private readonly response: TransportResponse;

  constructor(response: TransportResponse = { status: 200, body: { ok: true } }) {
    this.response = response;
  }

  send(request: RenderedRequest): Promise<TransportResponse> {
    this.sent.push(request);
    return Promise.resolve(this.response);
  }
}

/** A scope as a project state projection would be handed to the runtime. */
const SCOPE = {
  temp: 31,
  project: { id: "p1", name: "Greenhouse" },
  message: "Temp is {{temp}}°C in {{project.name}}",
};

// ---------------------------------------------------------------------------
// index.ts — the catalog: exactly eight well-formed manifests
// ---------------------------------------------------------------------------

describe("catalog: exactly the eight providers FR-INT-01 names", () => {
  it("has exactly 8 providers, and the id list matches the map", () => {
    expect(PROVIDER_IDS).toHaveLength(8);
    expect(Object.keys(PROVIDERS)).toHaveLength(8);
    // The list and the map are the same eight, not two drifting tables.
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDERS).sort());
    // …and no id repeats.
    expect(new Set(PROVIDER_IDS).size).toBe(8);
  });

  it("names them exactly as the requirement does", () => {
    expect([...PROVIDER_IDS].sort()).toEqual(
      [
        "http_service",
        "email",
        "telegram",
        "slack",
        "discord",
        "twilio",
        "ms_teams",
        "pagerduty",
      ].sort(),
    );
  });

  it("gives every provider a well-formed manifest", () => {
    for (const id of PROVIDER_IDS) {
      const manifest = PROVIDERS[id];
      expect(getProvider(id)).toBe(manifest);
      expect(manifest.id).toBe(id);
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.configFields.length).toBeGreaterThan(0);
      expect(manifest.actions.length).toBeGreaterThan(0);
      // Every action has a name, a description and a `{{var}}`-ready template.
      for (const action of manifest.actions) {
        expect(action.name.length).toBeGreaterThan(0);
        expect(action.description.length).toBeGreaterThan(0);
        expect(typeof action.template).toBe("string");
      }
    }
  });

  it("derives secretFields / required views exactly from configFields", () => {
    for (const manifest of listProviders()) {
      const secrets = manifest.configFields.filter((f) => f.secret).map((f) => f.key);
      const requiredConfig = manifest.configFields
        .filter((f) => !f.secret && f.required)
        .map((f) => f.key);
      const requiredSecret = manifest.configFields
        .filter((f) => f.secret && f.required)
        .map((f) => f.key);
      // The convenience views cannot drift from the field table.
      expect([...manifest.secretFields]).toEqual(secrets);
      expect([...manifest.requiredConfigFields]).toEqual(requiredConfig);
      expect([...manifest.requiredSecretFields]).toEqual(requiredSecret);
      // Every declared secret field is actually present as a field.
      for (const key of manifest.secretFields) {
        expect(manifest.configFields.some((f) => f.key === key && f.secret)).toBe(true);
      }
    }
  });

  it("recognises each provider's expected credential as a secret field", () => {
    const SECRET_OF: Readonly<Record<ProviderId, string>> = {
      http_service: "auth_header",
      email: "api_key",
      telegram: "bot_token",
      slack: "webhook_url",
      discord: "webhook_url",
      twilio: "auth_token",
      ms_teams: "webhook_url",
      pagerduty: "routing_key",
    };
    for (const id of PROVIDER_IDS) {
      expect(PROVIDERS[id].secretFields).toContain(SECRET_OF[id]);
    }
  });

  it("returns undefined for a provider that is not in the catalog", () => {
    expect(getProvider("carrier_pigeon")).toBeUndefined();
    expect(getProvider("")).toBeUndefined();
    // A prototype key does not resolve as a provider either.
    expect(getProvider("constructor")).toBeUndefined();
  });

  it("lets a caller author a field with an explicit secret flag", () => {
    expect(configField("chat_id", "Chat id")).toEqual({
      key: "chat_id",
      label: "Chat id",
      secret: false,
      required: true,
    });
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — execute over the injected transport
// ---------------------------------------------------------------------------

describe("runtime: executes an action, interpolating {{var}} and a decrypted secret", () => {
  it("renders the template and config against the scope, then sends once", async () => {
    const transport = new RecordingTransport();
    const result = await executeIntegration({
      providerId: "telegram",
      action: "send_message",
      // The config resolves `{{project.id}}`; the action template resolves
      // `{{message}}` (telegram's body *is* the message).
      config: { chat_id: "{{project.id}}" },
      secret: { bot_token: { plain: "123:AA" } },
      scope: SCOPE,
      transport,
    });

    // One request left, and it is the rendered one — not the template.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].body).toBe("Temp is {{temp}}°C in {{project.name}}");
    expect(transport.sent[0].config.chat_id).toBe("p1");
    expect(transport.sent[0].providerId).toBe("telegram");
    expect(transport.sent[0].action).toBe("send_message");
    expect(transport.sent[0].synthetic).toBe(false);
    expect(result.synthetic).toBe(false);
    expect(result.response.status).toBe(200);
  });

  it("interpolates the action's {{var}} template directly", async () => {
    // A JSON-templated action (slack) resolves its own `{{message}}`; the
    // substituted value is inserted as text and never re-scanned, so a value's
    // own braces stay literal — the interpolator's documented rule.
    const transport = new RecordingTransport();
    await executeIntegration({
      providerId: "slack",
      action: "send_message",
      secret: { webhook_url: { plain: "https://hooks.slack/x" } },
      scope: { message: "Temp is {{temp}}°C, threshold {{threshold}}" },
      transport,
    });
    expect(transport.sent[0].body).toBe('{"text":"Temp is {{temp}}°C, threshold {{threshold}}"}');
  });

  it("opens a stored secret envelope at the boundary and sends the plaintext", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret("123456:AAH-secret-token", key);

    const transport = new RecordingTransport();
    await executeIntegration({
      providerId: "telegram",
      action: "send_message",
      config: { chat_id: "-100200" },
      secret: { bot_token: { envelope, key } },
      scope: SCOPE,
      transport,
    });

    // The transport saw the opened secret, never the stored ciphertext…
    expect(transport.sent[0].auth.bot_token).toBe("123456:AAH-secret-token");
    expect(JSON.stringify(transport.sent[0])).not.toContain(envelope);
    // …and the ciphertext still opens to the same value (the round-trip held).
    await expect(decryptSecret(envelope, key)).resolves.toBe("123456:AAH-secret-token");
  });

  it("interpolates the opened secret like any other value", async () => {
    const transport = new RecordingTransport();
    await executeIntegration({
      providerId: "slack",
      action: "send_message",
      secret: { webhook_url: { plain: "https://hooks/{{project.id}}/{{temp}}" } },
      scope: SCOPE,
      transport,
    });
    expect(transport.sent[0].auth.webhook_url).toBe("https://hooks/p1/31");
  });

  it("never returns the opened secret in the result (only the transport sees it)", async () => {
    const transport = new RecordingTransport();
    const result = await executeIntegration({
      providerId: "pagerduty",
      action: "trigger_incident",
      secret: { routing_key: { plain: "R0UT1NG-KEY" } },
      scope: { summary: "temp high", severity: "critical" },
      transport,
    });
    // The result describes what was asked (safe to log), not the credential.
    expect(result.request.body).toBe('{"summary":"temp high","severity":"critical"}');
    // The transport was handed the opened secret…
    expect(transport.sent[0].auth.routing_key).toBe("R0UT1NG-KEY");
    // …but the result the caller gets back carries none of it.
    expect(result.request.auth).toEqual({});
    expect(JSON.stringify(result)).not.toContain("R0UT1NG-KEY");
  });

  it("fails closed when a required secret cannot be opened", async () => {
    const { key: sealingKey } = await generateSecretKey();
    const { key: wrongKey } = await generateSecretKey();
    const envelope = await encryptSecret("token", sealingKey);

    const transport = new RecordingTransport();
    await expect(
      executeIntegration({
        providerId: "telegram",
        action: "send_message",
        config: { chat_id: "1" },
        secret: { bot_token: { envelope, key: wrongKey } },
        transport,
      }),
    ).rejects.toMatchObject({ code: "key_or_data" });
    // Nothing was sent — a secret that cannot be opened sends nothing.
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses a config missing a required field, sending nothing", async () => {
    const transport = new RecordingTransport();
    await expect(
      executeIntegration({
        providerId: "telegram",
        action: "send_message",
        secret: { bot_token: { plain: "t" } },
        transport,
      }),
    ).rejects.toMatchObject({ code: "missing_config" });
    expect(transport.sent).toHaveLength(0);
  });

  it("renders an unresolved {{var}} to empty by default, and may be made strict", async () => {
    const lenient = new RecordingTransport();
    await executeIntegration({
      providerId: "telegram",
      action: "send_message",
      config: { chat_id: "{{absent}}" },
      secret: { bot_token: { plain: "t" } },
      transport: lenient,
    });
    expect(lenient.sent[0].config.chat_id).toBe("");

    const strict = new RecordingTransport();
    await expect(
      executeIntegration({
        providerId: "telegram",
        action: "send_message",
        config: { chat_id: "{{absent}}" },
        secret: { bot_token: { plain: "t" } },
        strict: true,
        transport: strict,
      }),
    ).rejects.toMatchObject({ code: "missing_variable" });
    expect(strict.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — /test is synthetic and has no real effect
// ---------------------------------------------------------------------------

describe("runtime: /test sends a synthetic request and causes no real effect", () => {
  it("renders the same body and config as a live call, but redacts every secret", async () => {
    const live = new RecordingTransport();
    const dry = new RecordingTransport();
    const common = {
      providerId: "discord",
      action: "send_message",
      scope: SCOPE,
      secret: { webhook_url: { plain: "https://discord/hook" } },
    } as const;

    await executeIntegration({ ...common, transport: live });
    const tested = await testIntegration({ ...common, transport: dry });

    // The body and config a `/test` offers are byte-for-byte the live ones — the
    // request is fully assertable…
    expect(dry.sent[0].body).toEqual(live.sent[0].body);
    expect(dry.sent[0].config).toEqual(live.sent[0].config);
    // …but the real secret rode only the live call. The `/test` transport saw the
    // redaction marker, never `https://discord/hook`.
    expect(live.sent[0].auth.webhook_url).toBe("https://discord/hook");
    expect(dry.sent[0].auth.webhook_url).toBe(REDACTED_SECRET);
    expect(JSON.stringify(dry.sent[0])).not.toContain("https://discord/hook");
    // …differing only in the synthetic marker (and the redaction above).
    expect(dry.sent[0].synthetic).toBe(true);
    expect(live.sent[0].synthetic).toBe(false);
    expect(tested.synthetic).toBe(true);
  });

  it("refuses a live transport: a /test can never reach a real egress", async () => {
    // The transport a deploy would actually dial with. The runtime must never
    // hand it a `/test` request — the refusal is the module's, not the
    // transport's cooperation.
    class LiveTransport implements IntegrationTransport {
      readonly kind = "live" as const;
      readonly sent: RenderedRequest[] = [];
      send(request: RenderedRequest): Promise<TransportResponse> {
        this.sent.push(request);
        return Promise.resolve({ status: 200, body: { delivered: true } });
      }
    }
    const live = new LiveTransport();

    // Smuggled in past the type (as a loosely-typed boundary could).
    await expect(
      testIntegration({
        providerId: "slack",
        action: "send_message",
        scope: SCOPE,
        secret: { webhook_url: { plain: "https://hooks.slack/x" } },
        transport: live as unknown as DryRunTransport,
      }),
    ).rejects.toMatchObject({ code: "live_transport_in_test" });
    // The live transport never ran: nothing was sent, real secret or otherwise.
    expect(live.sent).toHaveLength(0);
  });

  it("never opens a stored envelope on the test path", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret("123456:AAH-secret-token", key);
    const transport = new RecordingTransport();

    await testIntegration({
      providerId: "telegram",
      action: "send_message",
      config: { chat_id: "-100200" },
      secret: { bot_token: { envelope, key } },
      scope: SCOPE,
      transport,
    });

    // A `/test` renders the request, so the auth key is present…
    expect(transport.sent[0].auth.bot_token).toBe(REDACTED_SECRET);
    // …but the plaintext was never produced: it is nowhere in what was sent.
    expect(JSON.stringify(transport.sent[0])).not.toContain("123456:AAH-secret-token");
    expect(JSON.stringify(transport.sent[0])).not.toContain(envelope);
  });

  it("causes no real effect: the dry transport is the only thing that ran", async () => {
    // A transport that refuses to perform any live call, exactly so the test can
    // prove the *runtime* enforces the effectless path (and offers the request).
    class NoEffectTransport implements IntegrationTransport {
      readonly kind = "dry-run" as const;
      readonly sent: RenderedRequest[] = [];
      send(request: RenderedRequest): Promise<TransportResponse> {
        this.sent.push(request);
        // A synthetic request is never dialed by this transport.
        return Promise.resolve({ status: 0, body: { dryRun: request.synthetic } });
      }
    }
    const transport = new NoEffectTransport();
    const result = await testIntegration({
      providerId: "slack",
      action: "send_message",
      scope: SCOPE,
      secret: { webhook_url: { plain: "https://hooks.slack/x" } },
      transport,
    });

    // One synthetic request was *built and offered* (that is the assertion)…
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].synthetic).toBe(true);
    // …and no real effect followed: the transport never dialed.
    expect(result.response).toEqual({ status: 0, body: { dryRun: true } });
  });

  it("still validates the provider, action and required fields before a /test", async () => {
    const transport = new RecordingTransport();
    await expect(
      testIntegration({
        providerId: "telegram",
        action: "send_message",
        secret: { bot_token: { plain: "t" } },
        transport,
      }),
    ).rejects.toMatchObject({ code: "missing_config" });
    expect(transport.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runtime.ts — unknown provider / action are rejected
// ---------------------------------------------------------------------------

describe("runtime: unknown provider and action are rejected", () => {
  it("rejects a provider absent from the catalog, sending nothing", async () => {
    const transport = new RecordingTransport();
    try {
      await executeIntegration({
        providerId: "carrier_pigeon",
        action: "send",
        transport,
      });
      throw new Error("expected executeIntegration to throw");
    } catch (error) {
      expect(isIntegrationRuntimeError(error)).toBe(true);
      expect((error as IntegrationRuntimeError).code).toBe("unknown_provider");
      expect((error as IntegrationRuntimeError).name).toBe("IntegrationRuntimeError");
    }
    expect(transport.sent).toHaveLength(0);
  });

  it("rejects an action a known provider does not list", async () => {
    const transport = new RecordingTransport();
    await expect(
      executeIntegration({
        providerId: "telegram",
        action: "send_sms",
        config: { chat_id: "1" },
        secret: { bot_token: { plain: "t" } },
        transport,
      }),
    ).rejects.toBeInstanceOf(IntegrationRuntimeError);
    await expect(
      executeIntegration({
        providerId: "telegram",
        action: "send_sms",
        config: { chat_id: "1" },
        secret: { bot_token: { plain: "t" } },
        transport,
      }),
    ).rejects.toMatchObject({ code: "unknown_action" });
    expect(transport.sent).toHaveLength(0);
  });

  it("checks the provider before it ever opens a secret or builds a request", async () => {
    // A key that can never open anything: if the unknown-provider guard ran
    // *after* opening, this would fail with a crypto error instead.
    const { key } = await generateSecretKey();
    const transport = new RecordingTransport();
    await expect(
      executeIntegration({
        providerId: "nope",
        action: "send",
        secret: { bot_token: { envelope: "insight-secret:v1:x.y", key } },
        transport,
      }),
    ).rejects.toMatchObject({ code: "unknown_provider" });
    expect(transport.sent).toHaveLength(0);
  });

  it("rejects an unknown provider through the /test entry point too", async () => {
    const transport = new RecordingTransport();
    await expect(
      testIntegration({ providerId: "unknown", action: "send", transport }),
    ).rejects.toMatchObject({ code: "unknown_provider" });
    expect(transport.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A minimal "the catalog drives the runtime" check over every provider
// ---------------------------------------------------------------------------

describe("catalog + runtime: every provider's first action executes", () => {
  it("executes the first action of each provider over the fake transport", async () => {
    for (const id of PROVIDER_IDS) {
      const manifest: ProviderManifest = PROVIDERS[id];
      const action = manifest.actions[0];

      // Fill every required field: config with a literal, secrets with plaintext.
      const config: Record<string, string> = {};
      const secret: Record<string, { plain: string }> = {};
      for (const field of manifest.configFields) {
        if (!field.required) continue;
        if (field.secret) secret[field.key] = { plain: `secret-${field.key}` };
        else config[field.key] = `value-${field.key}`;
      }

      const transport = new RecordingTransport();
      const result = await executeIntegration({
        providerId: id,
        action: action.name,
        config,
        secret,
        scope: {},
        transport,
      });

      expect(result.providerId).toBe(id);
      expect(result.action).toBe(action.name);
      expect(transport.sent).toHaveLength(1);
      // The transport saw each required secret; the returned result saw none.
      for (const key of manifest.secretFields) {
        if (!Object.hasOwn(secret, key)) continue;
        expect(transport.sent[0].auth[key]).toBe(`secret-${key}`);
        expect(JSON.stringify(result)).not.toContain(`secret-${key}`);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  SECRET_ENVELOPE_PREFIX,
  SECRET_ENVELOPE_VERSION,
  SECRET_NONCE_BYTES,
  SecretCryptoError,
  base64urlToBytes,
  bytesToBase64url,
  decryptSecret,
  encryptSecret,
  generateSecretKey,
  importSecretKey,
  isSecretCryptoError,
} from "../../worker/src/shared/integrations/crypto";
import {
  InterpolationError,
  collectPaths,
  interpolate,
  interpolateStrict,
  isInterpolationError,
} from "../../worker/src/shared/integrations/interpolate";

/**
 * Spec tests for integration secret handling (task A29 / FR-INT-03 / NFR-SEC-05).
 *
 * Two modules meet here, over two seams:
 *
 *   * `crypto.ts` — the AES-GCM pair. The key is an *injected* {@link CryptoKey},
 *     so every test mints a fresh one with `generateSecretKey()` / re-imports it
 *     with `importSecretKey()`; nothing is mocked and the real platform
 *     `crypto.subtle` does the work. The contract asserted is the task's:
 *     encrypt→decrypt round-trips, the stored ciphertext does **not** contain
 *     the plaintext substring, and a *wrong* key cannot open it.
 *   * `interpolate.ts` — the `{{var}}` renderer. The scope is a plain object, so
 *     it is handed over literally. The contract asserted is that known vars
 *     substitute, an unknown var follows the *documented* rule (`empty` by
 *     default, `error` under the strict policy), and injection-ish input is
 *     treated as literal text — never re-evaluated.
 *
 * Denials are asserted through each module's documented convention: entry
 * points **throw** a coded error (`SecretCryptoError`,
 * `InterpolationError`), never an `{ ok: false }` result.
 */

// ---------------------------------------------------------------------------
// Shared secrets
// ---------------------------------------------------------------------------

/** A representative integration secret config, as a tenant would store it. */
const SECRET_CONFIG = JSON.stringify({
  provider: "telegram",
  bot_token: "123456:AAH-under-pressure-9xQ",
  chat_id: "-100200300",
});

/** A short, distinctive string we can scan the ciphertext for. */
const PASSWORD = "hunter2-correct-horse";

// ---------------------------------------------------------------------------
// crypto.ts — encrypt at rest / decrypt at the boundary
// ---------------------------------------------------------------------------

describe("crypto: encrypt→decrypt round-trips", () => {
  it("returns the exact plaintext a secret config was sealed with", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(SECRET_CONFIG, key);
    await expect(decryptSecret(envelope, key)).resolves.toBe(SECRET_CONFIG);
  });

  it("round-trips a short password, an empty string and multi-byte UTF-8", async () => {
    const { key } = await generateSecretKey();
    for (const plaintext of [PASSWORD, "", "temp 31°C — naïve café ✅"]) {
      const envelope = await encryptSecret(plaintext, key);
      await expect(decryptSecret(envelope, key)).resolves.toBe(plaintext);
    }
  });

  it("round-trips a key minted and re-imported from its encoded form", async () => {
    // The deploy path: mint once, store `encoded`, import it at runtime.
    const { encoded } = await generateSecretKey();
    const reimported = await importSecretKey(encoded);
    const envelope = await encryptSecret(PASSWORD, reimported);
    await expect(decryptSecret(envelope, reimported)).resolves.toBe(PASSWORD);
  });

  it("produces a fresh nonce per call, so the same secret seals differently", async () => {
    const { key } = await generateSecretKey();
    const first = await encryptSecret(PASSWORD, key);
    const second = await encryptSecret(PASSWORD, key);
    expect(first).not.toBe(second);
    // …and both still open to the same plaintext.
    await expect(decryptSecret(first, key)).resolves.toBe(PASSWORD);
    await expect(decryptSecret(second, key)).resolves.toBe(PASSWORD);
  });
});

describe("crypto: stored ciphertext does NOT contain the plaintext", () => {
  it("never leaks the plaintext substring into the stored envelope", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(SECRET_CONFIG, key);

    // The acceptance criterion, taken literally.
    expect(envelope).not.toContain(SECRET_CONFIG);
    // …and at the granularity that matters: no fragment of the config, no
    // token, no chat id survives as visible text.
    expect(envelope).not.toContain("under-pressure");
    expect(envelope).not.toContain("bot_token");
    expect(envelope).not.toContain("-100200300");
  });

  it("never leaks a short password into the stored envelope", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, key);
    expect(envelope).not.toContain(PASSWORD);
    expect(envelope).not.toContain("hunter2");
  });

  it("stores only the documented, self-describing v1 envelope", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, key);
    // `insight-secret:v1:<nonce>.<body>`
    expect(envelope.startsWith(`${SECRET_ENVELOPE_PREFIX}:${SECRET_ENVELOPE_VERSION}:`)).toBe(true);
    const [nonce, body] = envelope.split(":")[2].split(".");
    expect(base64urlToBytes(nonce)?.length).toBe(SECRET_NONCE_BYTES);
    // body = ciphertext + 16-byte (128-bit) tag, and non-empty.
    expect(base64urlToBytes(body)!.length).toBeGreaterThan(16);
  });
});

describe("crypto: a wrong key fails to decrypt", () => {
  it("refuses an envelope sealed under a different key", async () => {
    const { key: sealingKey } = await generateSecretKey();
    const { key: otherKey } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, sealingKey);

    await expect(decryptSecret(envelope, otherKey)).rejects.toBeInstanceOf(SecretCryptoError);
    await expect(decryptSecret(envelope, otherKey)).rejects.toMatchObject({ code: "key_or_data" });
  });

  it("fails closed on a tampered byte, with no partial plaintext", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, key);

    // Flip one character of the ciphertext body (segment 3: nonce.body).
    const segments = envelope.split(":");
    const [nonce, body] = segments[2].split(".");
    const flipped = `${nonce}.${(body[0] === "A" ? "B" : "A") + body.slice(1)}`;
    await expect(decryptSecret([segments[0], segments[1], flipped].join(":"), key)).rejects.toMatchObject({
      code: "key_or_data",
    });
  });

  it("refuses a truncated envelope rather than returning a truncated secret", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, key);
    const [head, nonce, body] = envelope.match(/^(.*?):(.*?)\.(.*)$/)!.slice(1);
    await expect(decryptSecret(`${head}:${nonce}.`, key)).rejects.toMatchObject({
      code: "malformed_ciphertext",
    });
    // A cut body still fails, at the crypto layer.
    await expect(decryptSecret(`${head}:${nonce}.${body.slice(0, 4)}`, key)).rejects.toBeInstanceOf(
      SecretCryptoError,
    );
  });

  it("refuses a foreign version or a non-envelope string, with distinct codes", async () => {
    const { key } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, key);

    await expect(decryptSecret(envelope.replace(":v1:", ":v2:"), key)).rejects.toMatchObject({
      code: "unsupported_version",
    });
    await expect(decryptSecret("not-an-envelope", key)).rejects.toMatchObject({
      code: "malformed_envelope",
    });
    await expect(decryptSecret("", key)).rejects.toMatchObject({ code: "malformed_envelope" });
  });
});

describe("crypto: optional AAD binds a blob to its row", () => {
  it("opens when the same AAD is supplied, and only then", async () => {
    const { key } = await generateSecretKey();
    const aad = "proj-1/telegram";
    const envelope = await encryptSecret(PASSWORD, key, { aad });

    await expect(decryptSecret(envelope, key, { aad })).resolves.toBe(PASSWORD);
    // A ciphertext lifted onto another integration, or opened with no AAD,
    // no longer authenticates — even though the key is right.
    await expect(decryptSecret(envelope, key)).rejects.toMatchObject({ code: "key_or_data" });
    await expect(decryptSecret(envelope, key, { aad: "proj-2/telegram" })).rejects.toMatchObject({
      code: "key_or_data",
    });
  });
});

describe("crypto: documented error surface", () => {
  it("tags errors with a stable name and is recognised by the type guard", async () => {
    const { key: a } = await generateSecretKey();
    const { key: b } = await generateSecretKey();
    const envelope = await encryptSecret(PASSWORD, a);
    try {
      await decryptSecret(envelope, b);
      throw new Error("expected decryptSecret to throw");
    } catch (error) {
      expect(isSecretCryptoError(error)).toBe(true);
      expect((error as SecretCryptoError).name).toBe("SecretCryptoError");
    }
  });

  it("rejects a malformed deployment key at import time", async () => {
    await expect(importSecretKey("not base64!!")).rejects.toBeInstanceOf(SecretCryptoError);
    await expect(importSecretKey(bytesToBase64url(new Uint8Array(16)))).rejects.toMatchObject({
      code: "key_or_data",
    });
  });
});

// ---------------------------------------------------------------------------
// interpolate.ts — {{var}} over a scope
// ---------------------------------------------------------------------------

/** The scope shape the task names: `{{temp}}` and `{{project.id}}`. */
const SCOPE = {
  temp: 31,
  online: true,
  threshold: 0,
  project: { id: "proj-1", name: "Greenhouse", meta: { region: "eu-west" } },
};

describe("interpolate: substitutes known vars", () => {
  it("renders a top-level var, a nested path and arbitrary depth", () => {
    expect(interpolate("Temp is {{temp}}°C", SCOPE)).toBe("Temp is 31°C");
    expect(interpolate("Project {{project.id}}", SCOPE)).toBe("Project proj-1");
    expect(interpolate("{{project.meta.region}}", SCOPE)).toBe("eu-west");
    expect(interpolate("{{project.name}} ({{project.id}})", SCOPE)).toBe("Greenhouse (proj-1)");
  });

  it("ignores whitespace inside the braces and substitutes every occurrence", () => {
    expect(interpolate("{{ temp }} and {{temp}}", SCOPE)).toBe("31 and 31");
  });

  it("renders falsy-but-present values as values, not as missing", () => {
    // 0 and false resolve; `threshold` = 0 must read as "0", not as a gap.
    expect(interpolate("thr={{threshold}} online={{online}}", SCOPE)).toBe("thr=0 online=true");
  });

  it("leaves text with no placeholders untouched and collects paths in order", () => {
    expect(interpolate("plain text", SCOPE)).toBe("plain text");
    expect(collectPaths("{{temp}} {{project.id}} {{temp}}")).toEqual(["temp", "project.id"]);
  });

  it("does not treat malformed braces as placeholders", () => {
    // No path, a space in the path, and a single brace: all literal.
    expect(interpolate("{{}} {{a b}} {temp} {{temp", SCOPE)).toBe("{{}} {{a b}} {temp} {{temp");
  });
});

describe("interpolate: unknown var follows the documented rule", () => {
  it("default policy is `empty`: an unresolved path becomes the empty string", () => {
    expect(interpolate("x={{missing}}", SCOPE)).toBe("x=");
    expect(interpolate("{{project.missing}}", SCOPE)).toBe("");
    // Walking *through* a non-object is missing too, not an error or a crash.
    expect(interpolate("{{temp.deeper}}", SCOPE)).toBe("");
    expect(interpolate("{{project.name.deeper}}", SCOPE)).toBe("");
  });

  it("never resolves inherited prototype members", () => {
    // `constructor`, `toString` and friends must read as missing.
    expect(interpolate("{{constructor}}", SCOPE)).toBe("");
    expect(interpolate("{{project.toString}}", SCOPE)).toBe("");
    expect(interpolate("{{__proto__}}", SCOPE)).toBe("");
  });

  it("strict policy `error` throws a coded, path-bearing error", () => {
    try {
      interpolateStrict("x={{project.nope}}", SCOPE);
      throw new Error("expected interpolateStrict to throw");
    } catch (error) {
      expect(isInterpolationError(error)).toBe(true);
      expect(error).toBeInstanceOf(InterpolationError);
      expect((error as InterpolationError).code).toBe("missing_variable");
      expect((error as InterpolationError).path).toBe("project.nope");
    }
  });

  it("is deterministic: the same input always yields the same output", () => {
    const cases: Array<[string, string]> = [
      ["{{temp}}", "31"],
      ["{{missing}}", ""],
      ["{{project.id}}-{{missing}}", "proj-1-"],
    ];
    for (const [template, expected] of cases) {
      expect(interpolate(template, SCOPE)).toBe(expected);
      expect(interpolate(template, SCOPE)).toBe(expected);
    }
  });
});

describe("interpolate: injection-ish input is treated literally", () => {
  it("does not re-scan a substituted value for placeholders", () => {
    // A value that *looks* like a placeholder is data, inserted verbatim.
    const tricky = { temp: "{{project.id}}", project: { id: "proj-1" } };
    expect(interpolate("value={{temp}}", tricky)).toBe("value={{project.id}}");
  });

  it("inserts HTML/script-ish and shell-ish values as plain text", () => {
    const payload = { temp: "</script><img src=x onerror=alert(1)>", cmd: "$(rm -rf /)" };
    expect(interpolate("{{temp}}|{{cmd}}", payload)).toBe(
      "</script><img src=x onerror=alert(1)>|$(rm -rf /)",
    );
  });

  it("does not evaluate paths inside braces with operators", () => {
    // Not a valid identifier path → literal, both in the template and in a value.
    expect(interpolate("{{a+b}} {{1 && 2}}", { a: 1, b: 2 })).toBe("{{a+b}} {{1 && 2}}");
  });

  it("still resolves real placeholders around a literal payload", () => {
    const payload = { user: "{{system}}", n: 3, system: "root" };
    expect(interpolate("n={{n}} user={{user}}", payload)).toBe("n=3 user={{system}}");
  });
});

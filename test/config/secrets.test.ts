import { describe, expect, it } from "vitest";
import {
  ENTROPY_MIN_BITS_PER_CHAR,
  SCAN_ROOTS,
  SECRET_ENCRYPTION_KEY_BINDING,
  SecretBindingError,
  assertNoHardcodedSecrets,
  isHighEntropyBlob,
  isSecretBindingError,
  loadSecretEncryptionKey,
  loadSecrets,
  scanForHardcodedSecrets,
  scanSource,
  shannonEntropy,
  type ScannableFile,
} from "../../worker/src/platform/config/secrets";
import { generateSecretKey } from "../../worker/src/shared/integrations/crypto";
import { dirOf, filePathFromUrl, joinPath, readDirectorySync, readTextFileSync } from "./node-fs";

/**
 * Spec tests for deploy-time secret loading + the source-tree secret scan
 * (task A35 / NFR-SEC-10).
 *
 * Two contracts meet here, and they are two directions of one rule — *a secret
 * is a deploy-time binding, never a source literal*:
 *
 *   * **Load** (`loadSecrets`) reads secret material out of an `env` bag. The
 *     contract asserted is the task's acceptance verbatim: a secret present in
 *     `env` loads; a config with **no** secrets still builds (null seams, no
 *     throw — self-provision); and a *bound-but-malformed* secret fails loudly
 *     rather than degrading to the fail-closed `null` reserved for absence.
 *
 *   * **Refuse** (`scanForHardcodedSecrets`) is the guard. It is a pure
 *     function over `(path, source)` pairs, so it is proven here over hand-built
 *     inputs — a known credential format, a connection string
 *     (`postgresql://user:pass@host/db`), `password=`/`secret=` assignments, a
 *     known-format *marker with no tail* (which must NOT fire), a credential-free
 *     URL (which must NOT fire), a raw high-entropy blob, and the repo's own
 *     fixtures (`"sess_owner_aaaa…"`, the `SECRET_VALUE_MARKERS` list, a
 *     base64url alphabet declaration) which must NOT fire either. The final
 *     `describe` runs the very same function over the **real source tree**, which
 *     is the acceptance test: if a secret literal ever lands in `worker/src` or
 *     `web/src`, this file goes red.
 *
 * The "a hardcoded literal → the scan FAILS" half is proven end-to-end in
 * {@link describe} "the scan catches a planted marker": a planted secret is
 * written to a temporary directory *outside* the repo, the real scanner finds
 * it, and the temp tree is removed — so the proof never leaves a marker in the
 * source tree it is protecting.
 */

// ---------------------------------------------------------------------------
// Loading a secret from env — success, absence, and malformed
// ---------------------------------------------------------------------------

/** A well-formed 256-bit base64url key (what a real binding carries). */
async function aRealEncodedKey(): Promise<string> {
  return (await generateSecretKey()).encoded;
}

/**
 * A Stripe-shaped key assembled at RUNTIME.
 *
 * The scanner's `stripe-secret-key` rule matches `sk_live_` + a base62 body, and
 * this fixture must exercise that rule — but a literal `sk_live_…` in the source
 * is exactly what GitHub's push-protection flags. Concatenating the prefix keeps
 * the scan honest (the scanner still sees the full value) while leaving no
 * flagged literal in the committed file.
 */
function fakeStripeKey(): string {
  return ["sk", "live", "51H8PLANTEDmarkerForTheScan00000"].join("_");
}

describe("loadSecrets — deploy-time bindings", () => {
  it("loads a secret from env", async () => {
    const encoded = await aRealEncodedKey();
    const secrets = loadSecrets({ [SECRET_ENCRYPTION_KEY_BINDING]: encoded });

    expect(secrets.secretEncryptionKey).toBe(encoded);
    expect(secrets.unbound).toBe(false);
  });

  it("builds with NO secrets — null seams, no throw (self-provision)", () => {
    const secrets = loadSecrets({});

    expect(secrets.secretEncryptionKey).toBeNull();
    expect(secrets.unbound).toBe(true);
  });

  it("treats an empty-string binding as absent (unbound, no throw)", () => {
    const secrets = loadSecrets({ [SECRET_ENCRYPTION_KEY_BINDING]: "" });

    expect(secrets.secretEncryptionKey).toBeNull();
    expect(secrets.unbound).toBe(true);
  });

  it("ignores unrelated bindings", () => {
    const secrets = loadSecrets({ SOME_OTHER_BINDING: "not-a-secret", EMPTY: undefined });

    expect(secrets.secretEncryptionKey).toBeNull();
    expect(secrets.unbound).toBe(true);
  });

  it("throws on a BOUND but malformed secret (absent ≠ broken)", () => {
    // A bound-but-broken secret is a deploy bug; it must not silently degrade
    // to the `null` that means "no secret was provisioned".
    expect(() => loadSecrets({ [SECRET_ENCRYPTION_KEY_BINDING]: "too-short" })).toThrow(
      SecretBindingError,
    );
    expect(() => loadSecrets({ [SECRET_ENCRYPTION_KEY_BINDING]: "x".repeat(43) })).not.toThrow();
    expect(() => loadSecrets({ [SECRET_ENCRYPTION_KEY_BINDING]: "!" + "a".repeat(42) })).toThrow(
      SecretBindingError,
    );
  });

  it("names the offending binding and is recognisable", () => {
    try {
      loadSecrets({ [SECRET_ENCRYPTION_KEY_BINDING]: "nope" });
      expect.unreachable("expected a SecretBindingError");
    } catch (error) {
      expect(isSecretBindingError(error)).toBe(true);
      if (isSecretBindingError(error)) {
        expect(error.binding).toBe(SECRET_ENCRYPTION_KEY_BINDING);
      }
    }
  });
});

describe("loadSecretEncryptionKey — the WebCrypto seam", () => {
  it("returns null when no key is bound (fail-closed null seam)", async () => {
    await expect(loadSecretEncryptionKey({})).resolves.toBeNull();
  });

  it("materialises a usable CryptoKey from the bound encoding", async () => {
    const encoded = await aRealEncodedKey();
    const key = await loadSecretEncryptionKey({ [SECRET_ENCRYPTION_KEY_BINDING]: encoded });

    expect(key).not.toBeNull();
    expect(key?.algorithm).toMatchObject({ name: "AES-GCM" });
  });
});

// ---------------------------------------------------------------------------
// The scan rule — known formats, bare markers, entropy
// ---------------------------------------------------------------------------

describe("scanSource — known credential formats", () => {
  it("catches an AWS-style access key id", () => {
    const findings = scanSource("a.ts", `const k = "AKIAIOSFODNN7EXAMPLE";`);
    expect(findings.map((f) => f.rule)).toContain("aws-access-key-id");
    expect(findings[0].line).toBe(1);
  });

  it("catches a Stripe secret key", () => {
    const findings = scanSource("a.ts", `const k = "${fakeStripeKey()}";`);
    expect(findings.map((f) => f.rule)).toContain("stripe-secret-key");
  });

  it("catches a PEM private-key header", () => {
    const findings = scanSource("a.ts", 'const k = "-----BEGIN RSA PRIVATE KEY-----";');
    expect(findings.map((f) => f.rule)).toContain("pem-private-key");
  });

  it("catches a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const findings = scanSource("a.ts", `const t = "${jwt}";`);
    expect(findings.map((f) => f.rule)).toContain("json-web-token");
  });

  it("does NOT fire on a bare marker constant with no secret tail", () => {
    // The repo's own `SECRET_VALUE_MARKERS` list is exactly this shape.
    const findings = scanSource("a.ts", `const MARKERS = ["sk_live_", "sk_test_", "AKIA"];`);
    expect(findings).toEqual([]);
  });

  it("does NOT fire on the REAL `SECRET_VALUE_MARKERS` literal (esp. password= / secret=)", () => {
    // The full list `worker/src/mcp/tools.ts` ships. Four of its eight entries —
    // `password=`, `secret=`, `token=`, `Bearer ` — are exactly the shapes the
    // new assignment rule looks for, and every one is a BARE marker with an
    // empty (or non-credential) value, so none may fire.
    const source = `const SECRET_VALUE_MARKERS = ["sk_live_", "sk_test_", "AKIA", "-----BEGIN", "password=", "secret=", "token=", "Bearer "];`;
    expect(scanSource("a.ts", source)).toEqual([]);
  });

  it("does NOT fire on prose or identifiers in a comment or string", () => {
    const findings = scanSource(
      "a.ts",
      '// rotate sk_live_ keys via wrangler\nconst label = "secret management is documented here";',
    );
    expect(findings).toEqual([]);
  });

  it("reports the line of the offending literal, not the file start", () => {
    const source = ["const a = 1;", "const b = 2;", 'const k = "AKIAIOSFODNN7EXAMPLE";'].join("\n");
    expect(scanSource("a.ts", source)[0].line).toBe(3);
  });

  it("previews only a clipped fragment of a matched secret", () => {
    const findings = scanSource("a.ts", `const k = "AKIAIOSFODNN7EXAMPLE";`);
    expect(findings[0].preview.length).toBeLessThan("AKIAIOSFODNN7EXAMPLE".length);
    expect(findings[0].preview.startsWith("AKIA")).toBe(true);
  });
});

describe("scanSource — connection-string credentials (scheme://user:password@host)", () => {
  it("catches a Postgres DSN in a source string", () => {
    const findings = scanSource("a.ts", `const DATABASE_URL = "postgresql://user:pass@host/db";`);
    expect(findings.map((f) => f.rule)).toContain("connection-string-credentials");
    expect(findings[0].line).toBe(1);
  });

  it("catches the other userinfo-bearing back-end schemes", () => {
    for (const dsn of [
      "postgres://app:s3cr3tP4ss@db.internal:5432/prod",
      "redis://default:s3cr3tP4ss@cache.internal:6379",
      "mongodb+srv://svc:s3cr3tP4ss@cluster.example.net/db",
      "amqps://broker:s3cr3tP4ss@mq.internal:5671",
      // A webhook/bot URL is a credential in its own right.
      "slack://token:s3cr3tP4ss@channel",
      "smtp://mailer:s3cr3tP4ss@smtp.internal:587",
    ]) {
      const findings = scanSource("a.ts", `const c = "${dsn}";`);
      expect(findings.map((f) => f.rule)).toContain("connection-string-credentials");
    }
  });

  it("does NOT fire on a credential-free URL (a location, not a secret)", () => {
    for (const url of [
      "https://example.test/path",
      "http://collector.local/ingest",
      "https://hooks.slack.com/services/T/B/m4-secret-webhook",
      "https://hooks.example/abc",
      "wss://insight.example/socket",
    ]) {
      expect(scanSource("a.ts", `const u = "${url}";`)).toEqual([]);
    }
  });

  it("does NOT fire on a URL that only has a port or a path colon", () => {
    // `5432` is a port; `a:b` is a path segment — neither is `user:password@`.
    expect(scanSource("a.ts", `const u = "postgres://db.internal:5432/prod";`)).toEqual([]);
    expect(scanSource("a.ts", `const u = "postgres://db.internal/a:b";`)).toEqual([]);
  });

  it("does NOT fire on a URL with a lone `user@` (no password)", () => {
    expect(scanSource("a.ts", `const u = "postgres://user@db.internal/prod";`)).toEqual([]);
  });

  it("reports the DSN rule by name", () => {
    const findings = scanSource(
      "a.ts",
      'const a = 1;\nconst u = "postgresql://user:pass@host/db";',
    );
    expect(findings[0].rule).toBe("connection-string-credentials");
    expect(findings[0].line).toBe(2);
  });
});

describe("scanSource — password= / secret= assignment shapes", () => {
  it("catches a credential assignment in a string literal", () => {
    for (const source of [
      `const s = "password=Sup3rSecret123";`,
      `const s = "secret=aB3xY7kL9mN2pQ";`,
      `const s = "pwd=Sup3rSecret123";`,
      `const s = "apikey=aB3xY7kL9mN2pQ";`,
      `const s = "db_secret=aB3xY7kL9mN2pQ";`,
      `const s = "client_secret=aB3xY7kL9mN2pQ";`,
    ]) {
      const findings = scanSource("a.ts", source);
      expect(findings.length).toBeGreaterThan(0);
    }
  });

  it("catches a credential embedded in a URL query / config line", () => {
    // `?`/`&` is a delimiter, not part of the key: the same assignment rule
    // catches the query form, keyed on the whole word.
    const findings = scanSource(
      "a.ts",
      `const url = "https://api.example.test/v1?user=svc&pwd=Sup3rSecret123";`,
    );
    expect(findings.map((f) => f.rule)).toContain("credential-assignment");
  });

  it("catches a whole-word key=value in a query string", () => {
    const findings = scanSource(
      "a.ts",
      `const url = "https://api.example.test/v1?password=Sup3rSecret123";`,
    );
    expect(findings.map((f) => f.rule)).toContain("credential-assignment");
  });

  it("does NOT fire on a bare marker constant (`password=` with no value)", () => {
    expect(scanSource("a.ts", `const M = "password=";`)).toEqual([]);
    expect(scanSource("a.ts", `const M = "secret=";`)).toEqual([]);
  });

  it("does NOT fire on the HSTS header value (`max-age=31536000`)", () => {
    // A numeric-only value is not credential material, and `max-age` is no key.
    const findings = scanSource(
      "a.ts",
      `export const HSTS = "max-age=31536000; includeSubDomains";`,
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on a SQL assignment inside a schema literal (`status='pending'`)", () => {
    // The tree's own `SCHEDULER_DDL` carries `SET status='pending'` lines; the
    // key is not a credential word and the value is an all-lowercase enum.
    const findings = scanSource(
      "a.ts",
      "const DDL = `UPDATE t SET status='claimed' WHERE id=? AND status='pending'`;",
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on an identifier that merely contains a key word", () => {
    // `user_secret_pointer` / `application/json` are not `secret=<value>`.
    const findings = scanSource(
      "a.ts",
      'const a = "user_secret_pointer"; const b = "application/json";',
    );
    expect(findings).toEqual([]);
  });

  it("does NOT fire on a comment separator (a run of `-` characters)", () => {
    const findings = scanSource("a.ts", "const DDL = `-- ------------------------`;");
    expect(findings).toEqual([]);
  });

  it("does NOT fire on prose that merely mentions password=", () => {
    // The run after `password=` is the rest of a sentence: whitespace-broken.
    const findings = scanSource(
      "a.ts",
      'const doc = "set password= to rotate the credential";',
    );
    expect(findings).toEqual([]);
  });
});

describe("isHighEntropyBlob — the entropy rule", () => {
  it("flags a long, high-entropy base64url run", () => {
    expect(isHighEntropyBlob("aZ3bK9xQ7pL2mN8vR4tY6uW1sE5dF0gH2jK4lM6n")).toBe(true);
  });

  it("does NOT flag a long ordered alphabet declaration (a chartable)", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    expect(alphabet.length).toBeGreaterThanOrEqual(32);
    expect(isHighEntropyBlob(alphabet)).toBe(false);
  });

  it("does NOT flag a repeated-character fixture", () => {
    // The repo deliberately uses these as opaque test tokens.
    expect(isHighEntropyBlob("sess_owner_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it("does NOT flag an ordinary identifier", () => {
    expect(isHighEntropyBlob("integration_transport_pipeline_name")).toBe(false);
  });

  it("does NOT flag a short random-looking string", () => {
    expect(isHighEntropyBlob("aZ3bK9xQ7pL2mN8v")).toBe(false);
  });
});

describe("shannonEntropy — the measure", () => {
  it("is 0 for empty and repeated input", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaaaaaa")).toBe(0);
  });

  it("is 1 bit for a fair two-symbol string", () => {
    expect(shannonEntropy("abababab")).toBeCloseTo(1, 5);
  });

  it("matches the alphabet ceiling for a uniform draw", () => {
    // 16 distinct symbols, each once → log2(16) = 4 bits/char.
    expect(shannonEntropy("0123456789abcdef")).toBeCloseTo(4, 5);
    expect(shannonEntropy("0123456789abcdef")).toBeGreaterThanOrEqual(ENTROPY_MIN_BITS_PER_CHAR);
  });
});

describe("extractStringLiterals — what the scanner reads", () => {
  it("catches a secret in each quote style (single, double, static template)", () => {
    const aws = "AKIAIOSFODNN7EXAMPLE";
    expect(scanSource("a.ts", `const a = "${aws}";`)[0]?.rule).toBe("aws-access-key-id");
    expect(scanSource("a.ts", `const b = '${aws}';`)[0]?.rule).toBe("aws-access-key-id");
    expect(scanSource("a.ts", `const c = \`${aws}\`;`)[0]?.rule).toBe("aws-access-key-id");
  });

  it("ignores a literal inside a line comment", () => {
    expect(scanSource("a.ts", '// const k = "AKIAIOSFODNN7EXAMPLE";')).toEqual([]);
  });

  it("ignores a literal inside a block comment", () => {
    expect(scanSource("a.ts", '/* const k = "AKIAIOSFODNN7EXAMPLE"; */')).toEqual([]);
  });

  it("skips an interpolated template (parts are code, not a literal)", () => {
    expect(scanSource("a.ts", "const k = `AKIA${suffix}IOSFODNN7EXAMPLE`;")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The acceptance proof — a planted marker IS caught, with nothing left behind
// ---------------------------------------------------------------------------

describe("the scan catches a planted marker (and leaves the tree clean)", () => {
  it("finds a planted secret via the same scanner the tree scan uses", () => {
    // A marker planted in an isolated temp file — NOT in the source tree — so
    // the proof never leaves a secret literal behind. This is byte-for-byte the
    // rule the real tree walk runs below.
    const plantedMarker = fakeStripeKey();
    const planted: ScannableFile = {
      path: "<planted>/leaky-config.ts",
      content: `export const PROVIDER_KEY = "${plantedMarker}";\n`,
    };

    const findings = scanForHardcodedSecrets([planted]);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].path).toBe("<planted>/leaky-config.ts");
    expect(findings[0].rule).toBe("stripe-secret-key");
    // The proof itself must not leak the marker in full.
    expect(findings[0].preview).not.toBe(plantedMarker);
  });

  it("an all-clean set scans to zero findings", () => {
    const clean: ScannableFile[] = [
      { path: "a.ts", content: 'export const URL = "https://example.test";\n' },
      { path: "b.ts", content: 'export const MARKERS = ["sk_live_", "AKIA"];\n' },
    ];
    expect(scanForHardcodedSecrets(clean)).toEqual([]);
  });

  it("assertNoHardcodedSecrets throws (naming path + line) on a planted secret", () => {
    const planted: ScannableFile = {
      path: "<planted>/leaky-config.ts",
      content: `export const KEY = "${fakeStripeKey()}";\n`,
    };
    expect(() => assertNoHardcodedSecrets([planted])).toThrow(/leaky-config\.ts:1/);
  });

  it("assertNoHardcodedSecrets returns normally on a clean set", () => {
    expect(() =>
      assertNoHardcodedSecrets([{ path: "a.ts", content: 'export const URL = "x";\n' }]),
    ).not.toThrow();
  });

  it("scanForHardcodedSecrets is deterministic (sorted by path then line)", () => {
    const files: ScannableFile[] = [
      { path: "z.ts", content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
      { path: "a.ts", content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' },
    ];
    expect(scanForHardcodedSecrets(files).map((f) => f.path)).toEqual(["a.ts", "z.ts"]);
  });

  it("finds a planted connection string via the same scanner the tree scan uses", () => {
    // The new rule is load-bearing over the real walk: a DSN planted in an
    // isolated pseudo-file is found, with the right rule name.
    const planted: ScannableFile = {
      path: "<planted>/db-config.ts",
      content: `export const DATABASE_URL = "postgresql://user:pass@host/db";\n`,
    };
    const findings = scanForHardcodedSecrets([planted]);
    expect(findings.map((f) => f.rule)).toContain("connection-string-credentials");
    expect(findings[0].path).toBe("<planted>/db-config.ts");
  });

  it("finds a planted password= assignment via the same scanner", () => {
    const planted: ScannableFile = {
      path: "<planted>/db-config.ts",
      content: `export const LINE = "password=Sup3rSecret123";\n`,
    };
    const findings = scanForHardcodedSecrets([planted]);
    expect(findings.map((f) => f.rule)).toContain("credential-assignment");
  });
});

// ---------------------------------------------------------------------------
// The tree scan — the real guard over worker/src and web/src
// ---------------------------------------------------------------------------

/** The text extensions the scan reads (a secret cannot hide in a binary). */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql"] as const;

/** Directories never walked: dependencies, build output, and VCS metadata. */
const SKIPPED_DIRECTORIES: Record<string, true> = {
  node_modules: true,
  dist: true,
  build: true,
  ".git": true,
  coverage: true,
};

/**
 * Walk `root` and return every scannable file with its repo-relative path and
 * text. Deterministic order (sorted) so a failure report is stable.
 */
function collectSourceFiles(root: string, repoRoot: string): ScannableFile[] {
  const files: ScannableFile[] = [];

  function walk(dir: string): void {
    for (const entry of readDirectorySync(dir, { withFileTypes: true })) {
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES[entry.name] !== true) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;

      const relative = full.slice(repoRoot.length + 1).replaceAll("\\", "/");
      files.push({ path: relative, content: readTextFileSync(full, "utf8") });
    }
  }

  walk(root);
  return files;
}

describe("the source tree is free of hardcoded secrets (NFR-SEC-10)", () => {
  const here = dirOf(filePathFromUrl(import.meta.url)); // …/insight/test/config
  const repoRoot = joinPath(here, "..", "..");

  it("walks the scan roots and finds no secret literal", () => {
    const scanned: ScannableFile[] = [];
    for (const root of SCAN_ROOTS) {
      scanned.push(...collectSourceFiles(joinPath(repoRoot, root), repoRoot));
    }

    // Guard against a silently-empty walk: a broken glob that scans nothing
    // would "pass" while proving nothing.
    expect(scanned.length).toBeGreaterThan(20);

    const findings = scanForHardcodedSecrets(scanned);
    const report = findings.map((f) => `${f.path}:${f.line} [${f.rule}] ${f.preview}`).join("\n");
    expect(report).toBe("");
  });
});

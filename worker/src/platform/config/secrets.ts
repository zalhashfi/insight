/**
 * platform/config/secrets — load deploy-time secret material from the
 * environment, and refuse secret *literals* in the source tree (A35 /
 * NFR-SEC-10).
 *
 * The rule this module exists to enforce is blunt and one-directional:
 *
 * > **A secret is a deploy-time binding, never a source literal.**
 *
 * There are two halves, and they are two halves of the *same* rule:
 *
 *   1. **Load.** {@link loadSecrets} reads secret material out of the runtime
 *      `env` — a Cloudflare Workers binding, a `.dev.vars` entry, a `wrangler
 *      secret put` value, an environment variable. This is the ONLY place a
 *      secret enters the process. Nothing downstream reads `env` for a secret
 *      directly, so "where do secrets come from" has one answer and one file to
 *      audit.
 *
 *   2. **Refuse.** {@link scanForHardcodedSecrets} is the *other* direction of
 *      the same rule: if a secret were ever pasted into the source tree, the
 *      build must fail rather than ship it. The scan is a pure function over
 *      `(path, source)` pairs so it is unit-testable, reusable by a CI guard
 *      (see `test/config/secrets.test.ts` and the M5 portability audit), and
 *      cannot itself depend on the environment it is auditing.
 *
 * ## Fail-closed null seams, never fail-shut
 *
 * A deploy that provides **no** secrets must still *compose*. This is the
 * self-provision case: a fresh clone, a CI job, a preview deploy with only the
 * non-secret bindings. {@link loadSecrets} therefore returns a config whose
 * secret slots are `null` — the honest "no secret was bound yet" value, which
 * every consumer already treats as fail-closed (an integration that cannot open
 * its secret refuses, `401`) — rather than throwing at construction time. A
 * Worker that refused to even build without a secret would be a deploy hazard,
 * not a security feature.
 *
 * The distinction that IS enforced loudly is **absent vs. malformed**: a secret
 * that is *present* but wrong (a `SECRET_ENCRYPTION_KEY` that is not a
 * base64url-encoded 256-bit key) throws, because silently degrading a bound-but-
 * bad secret to `null` would turn a deploy mistake into a silent, harder-to-find
 * "secrets mysteriously unavailable" outage. Absent is a state; broken is a bug.
 *
 * ## Why the scan lives in `worker/src`, not in the test
 *
 * The scan rule is *policy*, and policy should not be re-implemented inside the
 * assertion that checks it — a test that carries its own copy of the rule can
 * drift from production intent and still pass. Keeping {@link scanForHardcodedSecrets}
 * in source means the ticket's rule has one owner, the test consumes the same
 * function a CI guard would, and the rule itself is pinned by unit tests over
 * known positives and known negatives (including the repo's own fixtures, which
 * must NOT trip it).
 *
 * ## Precision over recall, deliberately
 *
 * A credential scanner that cries wolf gets switched off. This one therefore
 * matches two narrow classes and nothing else:
 *
 *   * **Known credential formats** — AWS `AKIA…`, Stripe `sk_live_…`, GitHub
 *     `ghp_…`/`github_pat_…`, Slack `xox…`, Google `AIza…`, PEM private-key
 *     blocks, and three-segment JWTs. Each pattern fixes the *whole* shape
 *     (prefix **and** required tail length), so a bare marker constant — such as
 *     this codebase's own `SECRET_VALUE_MARKERS` list, which literally contains
 *     `"sk_live_"` — is not a finding, while a real key pasted after the prefix
 *     is.
 *   * **High-entropy blobs** — a quoted literal that is one long run of
 *     base64/hex characters carrying at least {@link ENTROPY_MIN_BITS_PER_CHAR}
 *     bits per character. This catches a secret in a *format we have never seen*
 *     (a bespoke API key, a raw random token) without guessing its prefix.
 *
 * The entropy rule carries one essential guard: a **chartable** — a long
 * string whose characters are written (near-)sorted, as every alphabet
 * declaration is (`"ABC…XYZabc…xyz0123456789-_"`) — is not a secret, however
 * long and however "random-looking" its character set. Every base64/hex
 * alphabet in this repo is exactly such a chartable: 64 uniform characters from
 * the base64 set, so it is indistinguishable from a key on length and entropy
 * alone. What betrays it is *order* — it descends only at the few class
 * boundaries, while real key material descends constantly. Without this guard
 * the scanner would flag the repo's own encoding tables; with it, the ordering
 * structure that makes an alphabet an alphabet is precisely the feature that
 * distinguishes it from a key.
 */

import { importSecretKey } from "../../shared/integrations/crypto";

// ---------------------------------------------------------------------------
// Binding names — the vocabulary a deploy speaks
// ---------------------------------------------------------------------------

/**
 * The environment binding that holds the at-rest encryption key for integration
 * secrets (see `shared/integrations/crypto.ts`). A deploy mints this once with
 * `generateSecretKey()` and installs it as a Worker secret:
 *
 * ```sh
 * wrangler secret put SECRET_ENCRYPTION_KEY   # paste the base64url encoding
 * ```
 *
 * The name is a constant (not a string repeated at call sites) so the loader,
 * the docs and a future `wrangler.toml` all speak of the same binding.
 */
export const SECRET_ENCRYPTION_KEY_BINDING = "SECRET_ENCRYPTION_KEY" as const;

/** Every secret binding this module knows how to load. */
export type SecretBindingName = typeof SECRET_ENCRYPTION_KEY_BINDING;

/**
 * The shape {@link loadSecrets} reads from: a bag of string bindings, exactly as
 * a Worker receives `env`. Only the keys it asks for are ever consulted, so a
 * caller may pass the raw `env` object without narrowing it first. Every value
 * is `string | undefined`, because an unbound Workers secret is simply absent.
 */
export interface SecretEnv {
  readonly [binding: string]: string | undefined;
}

// ---------------------------------------------------------------------------
// Resolved config — the null-seam shape every consumer already understands
// ---------------------------------------------------------------------------

/**
 * The resolved secret configuration.
 *
 * Every slot is nullable **by design**: `null` is the deploy-time value that
 * means "no secret was bound", which consumers already interpret fail-closed
 * (refuse the operation, `401`). A non-null slot is a value that arrived from a
 * binding and nothing else — there is no code path in this module that could
 * have read it from the source.
 */
export interface Secrets {
  /**
   * The base64url-encoded at-rest encryption key, or `null` when unbound.
   * Kept as the *encoding*, not a `CryptoKey`, because that is what a binding
   * holds; {@link Secrets.encryptionKey} and {@link Secrets.secretEncryptionKey}
   * materialise it lazily.
   */
  readonly secretEncryptionKey: string | null;
  /** True when no secret binding was supplied at all (the self-provision case). */
  readonly unbound: boolean;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The error thrown when a secret binding is *present but malformed* — the one
 * failure mode that must not be silently downgraded to `null`.
 *
 * `binding` names which environment key was bad so the message points a deploy
 * at the exact binding to re-issue. It is not a subclass of a generic "config
 * error": a caller (or a deploy script) can branch on it specifically.
 */
export class SecretBindingError extends Error {
  /** The environment binding whose value was rejected. */
  readonly binding: string;

  constructor(binding: string, message: string) {
    super(`${binding}: ${message}`);
    this.name = "SecretBindingError";
    this.binding = binding;
  }
}

/** Type guard for {@link SecretBindingError}, safe across realms/bundlers. */
export function isSecretBindingError(value: unknown): value is SecretBindingError {
  return value instanceof SecretBindingError;
}

/**
 * A base64url-encoded 256-bit key is exactly 43 characters (32 bytes × 8 bits ÷
 * 6 bits per char, unpadded). Checked here so a truncated or mistyped binding is
 * rejected at load, not at first decrypt — the same fail-at-the-boundary
 * instinct `importSecretKey` applies, hoisted to the config edge.
 */
const BASE64URL_256_KEY_LENGTH = 43;

/** Does `value` look like a base64url-encoded 256-bit key? */
function isEncodedSecretKey(value: string): boolean {
  if (value.length !== BASE64URL_256_KEY_LENGTH) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Load the deploy-time secret configuration from `env`.
 *
 * Reads exactly the bindings it knows (see {@link SECRET_ENCRYPTION_KEY_BINDING})
 * and returns them resolved. The function is deliberately total over *absence*:
 *
 *   * **no secret bound** → a config with `null` slots and `unbound: true`. It
 *     does not throw. This is the self-provision path (a fresh clone, CI, a
 *     preview deploy) and the reason "a config with no secrets must still build"
 *     holds.
 *   * **a secret bound but malformed** → throws {@link SecretBindingError}. A
 *     bound-but-broken secret is a deploy bug; degrading it to `null` would hide
 *     it behind the very fail-closed path that exists for *absence*.
 *   * **a secret bound and well-formed** → that value in its slot.
 *
 * Nothing here reads a file, `import.meta.env`, `process.env` or a module-level
 * constant for a secret value: `env` is the sole input, so the module has no
 * second source (and the scan in the second half of this file keeps it that
 * way).
 */
export function loadSecrets(env: SecretEnv): Secrets {
  const raw = env[SECRET_ENCRYPTION_KEY_BINDING];

  if (raw === undefined || raw === "") {
    // Absent — the honest "not provisioned yet" state. Null seams, no throw.
    return { secretEncryptionKey: null, unbound: true };
  }

  if (!isEncodedSecretKey(raw)) {
    // Bound, but not a 256-bit base64url key. Loud, and specifically named.
    throw new SecretBindingError(
      SECRET_ENCRYPTION_KEY_BINDING,
      `expected a base64url-encoded ${BASE64URL_256_KEY_LENGTH}-character (256-bit) key, got ${raw.length} character(s)`,
    );
  }

  return { secretEncryptionKey: raw, unbound: false };
}

/**
 * Materialise the at-rest encryption key from `env` as a WebCrypto
 * {@link CryptoKey}, or `null` when no key is bound.
 *
 * This is the seam `shared/integrations/crypto.ts` names as its caller: the
 * key's *source* is a binding, and its *derivation* is `importSecretKey`. A
 * deploy that has bound the secret gets a usable key; a deploy that has not
 * (self-provision, tests) gets `null`, and every integration that needs it
 * refuses fail-closed. A bound-but-malformed key surfaces as
 * {@link SecretBindingError} from {@link loadSecrets} before this is reached.
 */
export async function loadSecretEncryptionKey(env: SecretEnv): Promise<CryptoKey | null> {
  const secrets = loadSecrets(env);
  if (secrets.secretEncryptionKey === null) return null;
  return importSecretKey(secrets.secretEncryptionKey);
}

// ---------------------------------------------------------------------------
// The scan rule — refuse secret literals in source (NFR-SEC-10)
// ---------------------------------------------------------------------------

/**
 * Minimum Shannon entropy, in bits per character, for a long base64/hex run to
 * be treated as a secret.
 *
 * Real key material (32 random bytes as base64url, a hex digest, an API key)
 * sits near the alphabet's ceiling — base64url is 6 bits/char, hex is 4 — and in
 * practice measures ≳4.5 after a handful of bytes. The floor is set at 4.0,
 * comfortably above English prose, identifiers, and the repeated-character
 * fixtures this repo deliberately uses (`"sess_owner_aaaa…"` measures 0). A
 * bespoke low-entropy *passphrase* is out of scope for entropy detection and is
 * the job of the known-format list plus, ultimately, the human review the scan
 * is a backstop for.
 */
export const ENTROPY_MIN_BITS_PER_CHAR = 4.0;

/**
 * Minimum length for the entropy rule. Below this, ordinary identifiers and
 * class names ("Uint8Array", "integration_transport") reach 4+ bits/char by
 * accident. At 32+, a high-entropy run is overwhelmingly key-sized.
 */
export const ENTROPY_MIN_LENGTH = 32;

/** The base64url hex/base64 character set, as a membership test. */
const BASE64URL_CHARS = /^[A-Za-z0-9+/_=-]+$/;

/**
 * A known credential format: a name (for the report), a regex that fixes the
 * **whole** shape, and nothing else. The tail-length requirement is what keeps a
 * bare marker constant (`"sk_live_"`) from matching.
 */
interface KnownSecretFormat {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * The known-format list. Ordered most-specific first purely for readable
 * reports; every entry is a full-shape match, so order does not affect which
 * fire.
 */
const KNOWN_SECRET_FORMATS: readonly KnownSecretFormat[] = Object.freeze([
  {
    name: "aws-access-key-id",
    // `AKIA`/`ASIA` + exactly 16 base32 chars = a 20-char AWS key id.
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: "stripe-secret-key",
    // `sk_live_`/`sk_test_` + ≥16 contiguous base62 chars (a real key body).
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  },
  {
    name: "github-token",
    // Classic PATs are `ghp_` + 36; fine-grained are `github_pat_` + ≥22.
    pattern: /\bghp_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    name: "google-api-key",
    // `AIza` + exactly 35 more characters = a 39-char Google API key.
    pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/,
  },
  {
    name: "pem-private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  },
  {
    name: "json-web-token",
    // Three base64url segments, each of non-trivial length.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
]);

/** One thing the scan found. `line` is 1-based; `text` is the matched fragment. */
export interface SecretFinding {
  /** Repo-relative path (as supplied to the scan). */
  readonly path: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** Rule that fired — a known format's name, or `"high-entropy-blob"`. */
  readonly rule: string;
  /**
   * The matched text, with any long run clipped so a report never re-prints the
   * whole secret. The first {@link FINDING_PREVIEW_CHARS} characters survive —
   * enough to recognise and locate, not enough to use.
   */
  readonly preview: string;
}

/** How much of a matched secret a {@link SecretFinding} reproduces. */
export const FINDING_PREVIEW_CHARS = 12;

/** Clip a matched fragment to {@link FINDING_PREVIEW_CHARS}, marking the cut. */
function previewOf(match: string): string {
  if (match.length <= FINDING_PREVIEW_CHARS) return match;
  return `${match.slice(0, FINDING_PREVIEW_CHARS)}…`;
}

/**
 * Shannon entropy of `s`, in bits per character. `0` for an empty string or a
 * single repeated character; the ceiling is `log2(distinct symbols)`.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * How many descending code-point steps within `s` are tolerated before `s` is
 * treated as *disordered enough* to be key material rather than a chartable.
 *
 * An alphabet declaration is a handful of ascending runs written in one of a few
 * canonical orders — `A…Z`, `a…z`, `0…9`, then the two symbols — so at each
 * class boundary the comparison is either "still ascending" or "wrapped to a
 * lower class", i.e. a small, fixed number of **descents**. `A…Z a…z 0…9 - _`
 * has exactly one descent (the `z` → `0` wrap). Random key material of the same
 * length has ~half as many descents as characters (≈20+ for a 43-char key);
 * the probability of a real secret landing at ≤{@link MAX_ORDERED_DESCENTS}
 * descents is negligible, while every ordering of the alphabet lands there.
 */
const MAX_ORDERED_DESCENTS = 3;

/**
 * Is `s` a **chartable** — a long string whose characters are (near-)sorted, as
 * every base64/hex *alphabet declaration* is?
 *
 * Distinguishing a table from a key is the whole reason this predicate exists: a
 * base64 alphabet is 64 characters from the base64 set, uniform, and therefore
 * carries the alphabet's full ~6 bits/char — indistinguishable from a key on
 * length and entropy alone. What betrays it is *order*: it is written sorted, so
 * its characters descend only at the few class boundaries. Real key material is
 * unordered and descends constantly.
 *
 * This one check is the difference between flagging every encoding table in a
 * codebase and flagging none of them.
 */
function isOrderedChartable(s: string): boolean {
  let descents = 0;
  for (let i = 1; i < s.length; i += 1) {
    if (s.charCodeAt(i) < s.charCodeAt(i - 1)) {
      descents += 1;
      if (descents > MAX_ORDERED_DESCENTS) return false;
    }
  }
  return true;
}

/**
 * Is `candidate` a high-entropy blob worth flagging?
 *
 * All four must hold: long enough, drawn only from the base64/hex set, *not* an
 * ordered chartable (see {@link isOrderedChartable}), and carrying at least
 * {@link ENTROPY_MIN_BITS_PER_CHAR} bits per character.
 */
export function isHighEntropyBlob(candidate: string): boolean {
  if (candidate.length < ENTROPY_MIN_LENGTH) return false;
  if (!BASE64URL_CHARS.test(candidate)) return false;
  if (isOrderedChartable(candidate)) return false;
  return shannonEntropy(candidate) >= ENTROPY_MIN_BITS_PER_CHAR;
}

// ---------------------------------------------------------------------------
// Source extraction — pull candidate literals out of one file's text
// ---------------------------------------------------------------------------

/**
 * A string literal as it appears in source: the decoded value plus where its
 * opening quote sat, so a finding can be reported in terms of the *file* the
 * human edited rather than an offset into a blob.
 *
 * Both single- and double-quoted literals are read, plus template literals that
 * carry no `${…}` interpolation (a static template is a string). A template with
 * interpolation is skipped: its parts are code, not a literal, and matching a
 * fragment of it would be guesswork.
 */
interface StringLiteral {
  readonly value: string;
  readonly line: number;
}

/**
 * Extract the string literals in `source`, tracking line numbers.
 *
 * A deliberately small, dependency-free scanner rather than a real parser: it
 * walks character by character, so it never mis-attributes a quote inside a
 * comment or a regex *as* a literal where a regex-literal heuristic would. It
 * does not attempt to be a JS parser — it is precise about the *quoted* strings
 * it reports and silent about everything else, which is exactly the contract the
 * scan needs (a string value is where a pasted secret lives).
 */
function extractStringLiterals(source: string): readonly StringLiteral[] {
  const literals: StringLiteral[] = [];
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }

    // Skip line comments outright — a secret *shown* in a comment (e.g. the
    // `wrangler secret put` example above) is documentation, and flagging it
    // would make the scanner unusable on its own explanatory text.
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    // Skip block comments for the same reason.
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }

    const quote = ch === '"' || ch === "'" || ch === "`" ? ch : null;
    if (quote === null) {
      i += 1;
      continue;
    }

    const startLine = line;
    const value: string[] = [];
    let hasInterpolation = false;
    i += 1;

    while (i < source.length && source[i] !== quote) {
      const c = source[i];
      if (c === "\\") {
        // Unescape the common escapes so an escaped quote/newline does not
        // terminate the literal early. Anything else passes through verbatim.
        const next = source[i + 1];
        if (next === "n") value.push("\n");
        else if (next === "t") value.push("\t");
        else if (next === "r") value.push("\r");
        else if (next !== undefined) value.push(next);
        if (next === "\n") line += 1;
        i += 2;
        continue;
      }
      if (c === "\n") line += 1;
      if (quote === "`" && c === "$" && source[i + 1] === "{") hasInterpolation = true;
      value.push(c);
      i += 1;
    }
    i += 1; // closing quote

    if (!hasInterpolation) {
      literals.push({ value: value.join(""), line: startLine });
    }
  }

  return literals;
}

/**
 * Scan one file's `source` for hardcoded secrets.
 *
 * Returns every finding — an empty array is the clean case. Pure: it reads only
 * its arguments, so it can be run over any file, in any process, with no
 * environment or filesystem access of its own (the *caller* walks the tree).
 */
export function scanSource(path: string, source: string): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  const literals = extractStringLiterals(source);

  for (const literal of literals) {
    for (const format of KNOWN_SECRET_FORMATS) {
      const match = format.pattern.exec(literal.value);
      if (match !== null) {
        findings.push({
          path,
          line: literal.line,
          rule: format.name,
          preview: previewOf(match[0]),
        });
      }
    }
    if (isHighEntropyBlob(literal.value)) {
      findings.push({
        path,
        line: literal.line,
        rule: "high-entropy-blob",
        preview: previewOf(literal.value),
      });
    }
  }

  return findings;
}

/** One file to scan: its report path and its full text. */
export interface ScannableFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Scan a set of files and return a flat, path-then-line-sorted list of findings.
 *
 * The caller owns discovery (which files, read how); this function owns only the
 * rule. That split keeps the rule pure and lets the same function back both the
 * unit tests here and a tree walk in `test/config/secrets.test.ts`.
 */
export function scanForHardcodedSecrets(files: readonly ScannableFile[]): readonly SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) findings.push(...scanSource(file.path, file.content));
  return findings.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
}

/**
 * Throw if any file carries a hardcoded secret.
 *
 * The assertion form for a build step or a CI guard: it turns findings into a
 * single, readable failure that names every path and line, so the fix is
 * obvious. A clean scan returns normally.
 */
export function assertNoHardcodedSecrets(files: readonly ScannableFile[]): void {
  const findings = scanForHardcodedSecrets(files);
  if (findings.length === 0) return;
  const lines = findings.map((f) => `  ${f.path}:${f.line}  [${f.rule}] ${f.preview}`);
  throw new Error(
    `hardcoded secret(s) found in source (NFR-SEC-10):\n${lines.join("\n")}\n` +
      `Move the value to a deploy-time binding (see loadSecrets) and rotate it.`,
  );
}

/** Where scanned paths live — kept here so the test and a CI guard share one set. */
export const SCAN_ROOTS: readonly string[] = Object.freeze(["worker/src", "web/src"]);

/**
 * shared/integrations/interpolate — `{{var}}` interpolation over a scope
 * (A29 / FR-INT-01).
 *
 * An integration config is a template, not a constant. A Telegram action wants
 * `"Temp is {{temp}}°C in {{project.name}}"`, a Slack payload wants
 * `"{{state.temp}} crossed {{threshold}}"`. This module is the one rule that
 * turns such a string into the concrete text a provider receives, by resolving
 * each `{{...}}` against a caller-supplied **scope** — a plain object of
 * available values.
 *
 * ```
 *   const out = interpolate("Temp is {{temp}}°C in {{project.name}}", {
 *     temp: 31,
 *     project: { id: "p1", name: "Greenhouse" },
 *   });
 *   // → "Temp is 31°C in Greenhouse"
 * ```
 *
 * ## The syntax, exactly
 *
 * A placeholder is an opening `{{`, a **path**, and a closing `}}`. Surrounding
 * whitespace is ignored, so `{{ temp }}` and `{{temp}}` are the same
 * placeholder. A path is one or more segments joined by `.`:
 *
 *   * `{{temp}}`             — the scope's own `temp`;
 *   * `{{project.id}}`       — the `id` of the scope's `project` object;
 *   * `{{project.meta.name}}`— arbitrarily deep.
 *
 * Segments are read as **own** properties only; an inherited key
 * (`constructor`, `toString`, `__proto__`, `hasOwnProperty`) never resolves, so
 * a scope cannot be walked into its prototype chain. A segment that is a valid
 * identifier character run (`[A-Za-z0-9_$]`) is required: `{{a b}}` is *not* a
 * placeholder and is left untouched, byte for byte.
 *
 * ## Missing variables are handled deterministically
 *
 * The task requires a *documented, deterministic* rule for an unknown variable,
 * and a policy is a decision a caller must be able to point at. There are two,
 * and the caller picks with {@link InterpolateOptions.onMissing}:
 *
 *   * {@link MissingPolicy} `"empty"` — the **default**. A placeholder whose
 *     path does not resolve (absent key, `null`, `undefined`, or a segment
 *     walked through a non-object) is replaced by the empty string. This is the
 *     forgiving mode: a half-filled config still renders, and a missing value
 *     degrades to a gap instead of an error. It is the default because a
 *     template rendered for a *notification* should not fail the whole action
 *     over one unstamped optional field.
 *   * {@link MissingPolicy} `"error"` — the call throws
 *     {@link InterpolationError} with code `missing_variable`, naming the
 *     unresolved path. This is the strict mode: a config that *depends* on a
 *     variable must fail loudly when the variable is absent, so a silent
 *     `""` can never be mistaken for a real value.
 *
 * The rule is per *path*, not per call: under `"empty"` a resolved `0`, `false`
 * or `""` is a **value** and is rendered (`{{temp}}` with `temp = 0` yields
 * `"0"`), while an *unresolved* path yields the empty string. "Missing" means
 * "the path did not resolve", never "the value looks falsy". The two policies
 * are total and non-overlapping: given a scope and a template, the output is
 * fully determined, and the property the tests pin is that the *same* input
 * always produces the *same* output.
 *
 * ## Everything that is not a placeholder is literal
 *
 * Interpolation is a **substitution**, not a template language. There is no
 * arithmetic, no conditionals, no nested template — the substituted value is
 * inserted as text and is never re-scanned. That single decision is what makes
 * injection-ish input safe: if `temp` holds the literal string
 * `"{{project.id}}"` or `"</script>"` or `"{{"`, it is placed into the output
 * **verbatim** and is not evaluated a second time. A value that *looks* like a
 * placeholder is data, and data is never executable here. (Escaping the result
 * for the *destination* — HTML, JSON, a URL — is the destination's job, not
 * this module's; this module only resolves paths.)
 *
 * Values are stringified by a fixed, documented rule (§ {@link stringifyValue}):
 * a string is itself, a finite number is its decimal form, a boolean is
 * `"true"`/`"false"`, `null`/`undefined` are "missing", and anything else
 * (object, array, function, symbol, bigint) is refused as unresolvable rather
 * than rendered as `"[object Object]"`. A value the module cannot honestly
 * represent therefore behaves exactly like a missing path — the *same*
 * `empty`/`error` policy applies, so there is no third, undocumented outcome.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Stable codes for the ways {@link interpolate} can refuse. */
export type InterpolationErrorCode = "missing_variable";

/**
 * Thrown only under the strict {@link MissingPolicy} `"error"`. Carries the
 * unresolved {@link path} so a caller (or a log line) can name the exact
 * placeholder that failed, rather than re-parsing the template.
 */
export class InterpolationError extends Error {
  readonly code: InterpolationErrorCode;
  /** The dotted path that failed to resolve, e.g. `"project.id"`. */
  readonly path: string;

  constructor(code: InterpolationErrorCode, path: string, message: string) {
    super(message);
    this.name = "InterpolationError";
    this.code = code;
    this.path = path;
  }
}

/** Type guard for {@link InterpolationError}, safe across realms/bundlers. */
export function isInterpolationError(value: unknown): value is InterpolationError {
  return value instanceof InterpolationError;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A scope is a plain object read by dotted path. Its leaves are strings,
 * numbers or booleans; its interior nodes are further objects. It is typed as
 * `unknown`-valued rather than a narrow map because the walk is defensive:
 * whatever a caller hands over, this module either resolves it to text or
 * treats the path as missing — it never trusts the shape.
 */
export interface InterpolationScope {
  readonly [key: string]: unknown;
}

/**
 * How an unresolved path is handled. See the module header for the full rule.
 *
 *   * `"empty"` (default) — substitute the empty string.
 *   * `"error"` — throw {@link InterpolationError}.
 */
export type MissingPolicy = "empty" | "error";

/** Options for {@link interpolate}. */
export interface InterpolateOptions {
  /** Policy for an unresolved path. Defaults to `"empty"`. */
  readonly onMissing?: MissingPolicy;
}

// ---------------------------------------------------------------------------
// Syntax
// ---------------------------------------------------------------------------

/**
 * A placeholder: `{{`, an optional-space-wrapped identifier path, `}}`.
 *
 * The path character class (`[A-Za-z0-9_$]` per segment, `.`-joined) is what
 * keeps this from being a general template language: `{{a b}}`, `{{a+b}}` and
 * `{{ }}` simply do not match, so they are output unchanged. `g` so every
 * placeholder is found; there is no `s`/`m` subtlety because a placeholder
 * never spans a newline by construction of the class.
 */
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+)*)\s*\}\}/g;

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Resolve every `{{path}}` in `template` against `scope` and return the result.
 *
 * Pure and synchronous: no I/O, no module state, no clock. The same
 * `(template, scope, options)` always yields the same string, which is what
 * makes a rendered payload reproducible and a test of it meaningful.
 *
 * Substituted values are inserted **as text and never re-scanned** — a value
 * that contains `{{…}}` is literal data, not a second interpolation pass (see
 * the module header for why this is the injection-safe choice). Non-placeholder
 * text, including malformed `{{`, is copied through byte for byte.
 *
 * @throws {InterpolationError} `missing_variable` when `onMissing` is
 *   `"error"` and a path does not resolve.
 */
export function interpolate(
  template: string,
  scope: InterpolationScope,
  options: InterpolateOptions = {},
): string {
  const onMissing = options.onMissing ?? "empty";
  return template.replace(PLACEHOLDER_PATTERN, (_match, path: string) => {
    const resolved = resolvePath(scope, path);
    if (resolved === MISSING) {
      if (onMissing === "error") {
        throw new InterpolationError(
          "missing_variable",
          path,
          `interpolate: no value for "{{${path}}}"`,
        );
      }
      return "";
    }
    return resolved;
  });
}

/**
 * {@link interpolate} under the strict policy: a missing path throws instead of
 * collapsing to `""`. Exists as a named entry point so a caller that *requires*
 * every placeholder has a call that says so, rather than repeating
 * `{ onMissing: "error" }` at each site.
 */
export function interpolateStrict(
  template: string,
  scope: InterpolationScope,
): string {
  return interpolate(template, scope, { onMissing: "error" });
}

/**
 * List the distinct paths a template references, in first-seen order. Useful to
 * pre-flight a config (does the tenant's scope carry everything this template
 * needs?) without rendering it, and to keep that answer and the renderer's view
 * of the syntax in lockstep — both read {@link PLACEHOLDER_PATTERN}.
 */
export function collectPaths(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) seen.add(match[1]);
  return [...seen];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Sentinel for "this path did not resolve". A unique symbol rather than
 * `undefined`, because `undefined` is a legitimate value a scope might hold and
 * the two must not be conflated — a scope keyed to `undefined` is *missing*,
 * but so is an absent key, and both must be distinguishable from the string
 * `"undefined"`.
 */
const MISSING: unique symbol = Symbol("interpolate.missing");

/**
 * Walk `scope` along `path`, returning the rendered leaf or {@link MISSING}.
 *
 * Each segment is read as an **own** property (`Object.hasOwn`), so the walk
 * can never reach `Object.prototype` — `{{constructor}}` and `{{__proto__}}`
 * are missing, not functions. A segment crossed on a non-object (a string, a
 * number, `null`) stops the walk and reports missing, because there is nothing
 * to index into.
 */
function resolvePath(scope: InterpolationScope, path: string): string | typeof MISSING {
  let cursor: unknown = scope;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return MISSING;
    if (!Object.hasOwn(cursor, segment)) return MISSING;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return stringifyValue(cursor);
}

/**
 * The documented value → text rule, or {@link MISSING} for a value this module
 * will not guess at.
 *
 * A string is itself; a finite number is its decimal form; `true`/`false` are
 * `"true"`/`"false"`. `null`, `undefined`, `NaN`, `±Infinity`, and every
 * structured value (object, array, function, symbol, bigint) are *missable*:
 * rendering them as `"[object Object]"` or `"NaN"` would invent text the tenant
 * never wrote, so they fall through to the same `empty`/`error` policy as an
 * absent key. One rule, one behaviour.
 */
function stringifyValue(value: unknown): string | typeof MISSING {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : MISSING;
  if (typeof value === "boolean") return value ? "true" : "false";
  return MISSING;
}

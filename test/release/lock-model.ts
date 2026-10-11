/**
 * release/lock-model — the pure half of the 1.0 release audit.
 *
 * The two suites in `test/release/` are deliberately shaped the same way as the
 * A35 secret scanner: a **pure rule** over plain data, plus a **thin walker**
 * that feeds it real files. This file is the pure rule for dependency licences.
 * Keeping it pure is what makes the audit provable rather than decorative:
 *
 *   * the *compatible* verdict is decided here from a documented allow-list (no
 *     network, no guessing) — {@link classify},
 *   * a package whose licence cannot be read from a local source is not
 *     silently dropped or assumed; it is reported as *unclassified* and the
 *     suite treats that as a failure (never a pass), which is the honest
 *     behaviour the ticket asks for.
 *
 * Nothing here touches the filesystem: the walkers (`license-audit.test.ts`)
 * own I/O and hand this module a parsed lockfile plus a licence-lookup function
 * backed by local files.
 */

// ---------------------------------------------------------------------------
// Licence policy — the allow-list (NFR-LEG-04)
// ---------------------------------------------------------------------------

/**
 * The permissive licences the product accepts for third-party code, as SPDX
 * identifiers. This is the *documented allow-list*: a dependency is compatible
 * iff its (possibly OR-combined) expression names at least one of these and
 * names **no** copyleft/unknown term in the alternative it selects.
 *
 * MIT is first because it is the product's own licence — a dependency under the
 * same terms adds no constraint at all.
 */
export const PERMISSIVE_LICENSES: readonly string[] = Object.freeze([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
]);

/**
 * Terms that make a licence **not** permissive for our purposes: strong/weak
 * copyleft (GPL/AGPL/LGPL/MPL/EPL/CDDL) and the "source-available"/non-commercial
 * families. A dependency whose expression contains one of these is only
 * acceptable if the OR-alternative actually chosen among them is on the
 * allow-list; if the copyleft term is the *only* option, the audit fails.
 *
 * Listed explicitly (rather than "anything not on the allow-list") so a typo in
 * a manifest surfaces as *unclassified*, not as a false "copyleft" verdict.
 */
export const DISALLOWED_LICENSES: readonly string[] = Object.freeze([
  "GPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "LGPL-2.1",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MPL-2.0",
  "EPL-1.0",
  "EPL-2.0",
  "CDDL-1.0",
  "CDDL-1.1",
  "SSPL-1.0",
  "BSL-1.1",
  "BUSL-1.1",
  "CC-BY-NC-4.0",
  "CC-BY-NC-SA-4.0",
  "Proprietary",
  "UNLICENSED",
]);

/** How a licence string names zero, one, or several candidate terms. */
export type LicenseVerdict =
  | { readonly kind: "permissive"; readonly matched: readonly string[] }
  | { readonly kind: "copyleft"; readonly matched: readonly string[] }
  | { readonly kind: "unclassified" };

/**
 * Split an SPDX-ish expression into its leaf identifiers.
 *
 * Handles the two shapes that actually occur offline: a plain id (`MIT`), and
 * an OR/AND combination (`MIT OR Apache-2.0`, `(MIT OR Apache-2.0) AND CC0-1.0`).
 * Parentheses, `+` suffixes and surrounding whitespace are stripped; keywords
 * (`OR`, `AND`, `WITH`) and empty fragments are dropped. No normalization is
 * invented — an unrecognised token is returned as-is so `classify` can call it
 * unclassified rather than round it to something plausible.
 */
function splitSpdx(expression: string): readonly string[] {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|WITH)\s+|\s+/i)
    .map((token) => token.trim().replace(/\+$/, ""))
    .filter((token) => token.length > 0 && !/^(or|and|with)$/i.test(token));
}

/**
 * Decide whether a licence expression is acceptable for a third-party
 * dependency, using only the allow-list and disallowed-list above.
 *
 * Rule: if **any** leaf term is on the allow-list, the expression is
 * permissive — the OR gives us a free choice, and we take a permissive branch.
 * (`MIT OR Apache-2.0` is permissive; so is `(MIT OR GPL-3.0)` — we choose MIT.)
 * A term on the disallowed list *with no permissive alternative* is copyleft.
 * Anything else is `unclassified` — never assumed clean.
 */
export function classify(expression: string | null | undefined): LicenseVerdict {
  if (expression === null || expression === undefined) return { kind: "unclassified" };
  const terms = splitSpdx(expression);
  if (terms.length === 0) return { kind: "unclassified" };

  const matched = terms.filter((t) => PERMISSIVE_LICENSES.includes(t));
  if (matched.length > 0) return { kind: "permissive", matched };

  const copyleft = terms.filter((t) => DISALLOWED_LICENSES.includes(t));
  if (copyleft.length > 0) return { kind: "copyleft", matched: copyleft };

  return { kind: "unclassified" };
}

// ---------------------------------------------------------------------------
// Lockfile model — reading `bun.lock` (a JSONC object) as dependency graphs
// ---------------------------------------------------------------------------

/** One entry of a `bun.lock` `packages` map: `[specifier, registry, element, integrity?]`. */
export type LockEntry = readonly [
  string | undefined,
  string | undefined,
  LockElement | undefined,
  string | undefined,
];

/** The third slot of a lock entry — the metadata bun records for a package. */
export interface LockElement {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalPeers?: readonly string[];
  readonly os?: string | readonly string[];
  readonly cpu?: string | readonly string[];
  readonly bin?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly version?: string;
}

/** A parsed `bun.lock`. */
export interface Lockfile {
  readonly lockfileVersion?: number;
  readonly workspaces?: Readonly<Record<string, LockWorkspace>>;
  readonly packages?: Readonly<Record<string, LockEntry>>;
}

/** One workspace (the root `""` plus each member) in a `bun.lock`. */
export interface LockWorkspace {
  readonly name?: string;
  readonly version?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** The bare package name of a lock key/specifier (`@scope/pkg@1.2.3` → `@scope/pkg`). */
export function packageNameOf(specifier: string): string {
  const at = specifier.lastIndexOf("@");
  return at > 0 ? specifier.slice(0, at) : specifier;
}

/** How a package is reached from a workspace manifest. */
export type DependencyKind = "production" | "development";

/** One resolved node of the dependency graph, with the edge that put it there. */
export interface GraphNode {
  readonly name: string;
  readonly kind: DependencyKind;
  /** The parent that pulled it in, or `null` for a workspace's direct dependency. */
  readonly via: string | null;
  /** `lockKey` of the parent, used to look the parent's licence up in the store. */
  readonly viaLockKey: string | null;
}

/** The full closure of a lockfile's workspaces. */
export interface DependencyGraph {
  /** Every node, deduplicated by `(name, kind)`, sorted by name then kind. */
  readonly nodes: readonly GraphNode[];
  /** Names reachable from a `dependencies` edge — what actually ships. */
  readonly production: ReadonlySet<string>;
  /** Names reachable only from a `devDependencies` edge. */
  readonly development: ReadonlySet<string>;
}

/** Resolve a package name to its `packages[...]` key (exact key, else first match). */
export function lockKeyOf(lock: Lockfile, name: string): string | null {
  const packages = lock.packages ?? {};
  if (packages[name] !== undefined) return name;
  const found = Object.keys(packages).find((key) => packageNameOf(key) === name);
  return found ?? null;
}

/**
 * Walk the workspaces of a `bun.lock` and return the transitive closure.
 *
 * **Production** means: reachable from some workspace's `dependencies` (or from
 * that of another production package). **Development** means: reachable only via
 * a `devDependencies` edge. Any edge underneath a node inherits the node's kind,
 * because a runtime dependency of a runtime dependency is runtime code.
 *
 * `peerDependencies` are deliberately *not* followed: a peer is not installed by
 * us — it is a contract on the host — and every peer here is optional or is
 * itself a dev dependency of the workspace. This is recorded, not hidden: the
 * audit's report names the rule.
 */
export function dependencyGraph(lock: Lockfile): DependencyGraph {
  const kinds = new Map<string, DependencyKind>();
  const nodes = new Map<string, GraphNode>();

  const stack: GraphNode[] = [];
  for (const workspace of Object.values(lock.workspaces ?? {})) {
    for (const name of Object.keys(workspace.dependencies ?? {})) {
      stack.push({ name, kind: "production", via: null, viaLockKey: null });
    }
    for (const name of Object.keys(workspace.devDependencies ?? {})) {
      stack.push({ name, kind: "development", via: null, viaLockKey: null });
    }
  }

  while (stack.length > 0) {
    const node = stack.pop() as GraphNode;
    const prior = kinds.get(node.name);
    // Production wins: reachable both ways ⇒ it ships.
    if (prior === "production" && node.kind === "development") continue;
    if (prior !== undefined && prior === node.kind) {
      // Already expanded with the same kind; only record a shorter path if this
      // is a direct dependency (nicer reports), otherwise skip re-expansion.
      if (node.via === null) nodes.set(node.name, node);
      continue;
    }
    if (prior !== undefined && node.kind === "development") continue;
    kinds.set(node.name, node.kind);
    nodes.set(node.name, node);

    const key = lockKeyOf(lock, node.name);
    if (key === null) continue;
    const element = lock.packages?.[key]?.[2] ?? {};
    const children: readonly string[] = [
      ...Object.keys(element.dependencies ?? {}),
      ...Object.keys(element.optionalDependencies ?? {}),
    ];
    for (const child of children) {
      stack.push({ name: child, kind: node.kind, via: node.name, viaLockKey: key });
    }
  }

  const sorted = [...nodes.values()].sort((a, b) =>
    a.name === b.name ? a.kind.localeCompare(b.kind) : a.name < b.name ? -1 : 1,
  );
  const production = new Set<string>();
  const development = new Set<string>();
  for (const node of sorted) {
    if (node.kind === "production") production.add(node.name);
    else if (!production.has(node.name)) development.add(node.name);
  }

  return { nodes: sorted, production, development };
}

// ---------------------------------------------------------------------------
// Licence resolution — actual field, store neighbour, then parent-inherited
// ---------------------------------------------------------------------------

/** Where a package's licence verdict came from — recorded so the report is auditable. */
export type LicenseSource =
  /** The package's own `package.json` `license` field (installed tree or Bun store). */
  | "package.json"
  /** A per-platform optional binary: same project+licence as its parent package. */
  | "inherited-from-parent"
  /** No local source declared a licence, so the audit must fail loudly on this row. */
  | "unresolved";

/** A dependency together with how its licence was determined. */
export interface LicensedDependency {
  readonly name: string;
  readonly kind: DependencyKind;
  /** Raw licence expression as declared, or `null` when inherited. */
  readonly expression: string | null;
  readonly source: LicenseSource;
  /** The parent whose licence was inherited / the workspace that owns local code. */
  readonly inheritedFrom?: string;
  readonly verdict: LicenseVerdict;
}

/**
 * Is this a per-platform optional binary whose licence is its parent's?
 *
 * The exact rule the ticket's "explicit offline source" requirement needs: a
 * lock entry carrying `os`/`cpu` platform metadata is a build artefact of a
 * declared parent (`esbuild` → `@esbuild/linux-x64`, `rollup` →
 * `@rollup/rollup-*`). Those binaries ship the same project's code under the
 * same licence, so when the platform binary isn't installed on this machine
 * their licence is *inherited* from the parent — not guessed, and not left
 * unclassified.
 */
function isPlatformBinary(element: LockElement | undefined): boolean {
  if (element === undefined) return false;
  // `cpu: "none"` is how sharp marks its portable WebAssembly build
  // (`@img/sharp-wasm32`) — still a per-platform artefact, still the parent's
  // licence, so it inherits the same way the `os`/`cpu` builds do.
  return element.os !== undefined || element.cpu !== undefined;
}

/** Everything the resolver may consult, all offline. */
export interface LicenseLookup {
  /** `(name) => expression | null`: a package.json `license` field, from any local source. */
  readonly declared: (name: string) => string | null;
  /** `(lockKey) => expression | null`: same, keyed by the parent's lock key. */
  readonly declaredByLockKey: (lockKey: string) => string | null;
}

/**
 * Classify every node of a dependency graph, using only local, offline sources.
 *
 * Resolution order, first hit wins (all offline):
 *   1. the package's own `package.json` `license` field (installed tree, else
 *      the Bun content store);
 *   2. for a per-platform optional binary (`os`/`cpu` metadata) that isn't
 *      installed here, its parent package's licence — the binary is that
 *      project's artefact;
 *   3. otherwise `unclassified` (source `unresolved`, expression `null`), so
 *      the audit fails loudly instead of assuming.
 */
export function resolveLicenses(
  lock: Lockfile,
  graph: DependencyGraph,
  lookup: LicenseLookup,
): readonly LicensedDependency[] {
  const resolved: LicensedDependency[] = [];

  for (const node of graph.nodes) {
    const own = lookup.declared(node.name);
    if (own !== null) {
      resolved.push({
        name: node.name,
        kind: node.kind,
        expression: own,
        source: "package.json",
        verdict: classify(own),
      });
      continue;
    }

    const key = lockKeyOf(lock, node.name);
    const element = key === null ? undefined : lock.packages?.[key]?.[2];
    const parentExpression =
      node.via !== null && isPlatformBinary(element)
        ? node.viaLockKey !== null
          ? lookup.declaredByLockKey(node.viaLockKey)
          : lookup.declared(node.via)
        : null;

    if (parentExpression !== null && parentExpression !== undefined) {
      resolved.push({
        name: node.name,
        kind: node.kind,
        expression: parentExpression,
        source: "inherited-from-parent",
        inheritedFrom: node.via ?? undefined,
        verdict: classify(parentExpression),
      });
      continue;
    }

    resolved.push({
      name: node.name,
      kind: node.kind,
      expression: null,
      source: "unresolved",
      verdict: classify(null),
    });
  }

  return resolved.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The subset of resolved dependencies the operator must look at: anything not permissive. */
export function offending(dependencies: readonly LicensedDependency[]): readonly LicensedDependency[] {
  return dependencies.filter((dependency) => dependency.verdict.kind !== "permissive");
}

/** A human-readable, deterministic one-line-per-dependency report. */
export function licenseReport(dependencies: readonly LicensedDependency[]): string {
  return dependencies
    .map((d) => {
      const verdict =
        d.verdict.kind === "permissive"
          ? `permissive (${d.verdict.matched.join(", ")})`
          : d.verdict.kind === "copyleft"
            ? `COPYLEFT (${d.verdict.matched.join(", ")})`
            : "UNCLASSIFIED";
      const expr = d.expression ?? "(no license field)";
      const origin = d.inheritedFrom ? ` [inherited from ${d.inheritedFrom}]` : ` [${d.source}]`;
      return `${d.kind === "production" ? "prod" : "dev "}  ${d.name}  ${expr}  ${verdict}${origin}`;
    })
    .join("\n");
}

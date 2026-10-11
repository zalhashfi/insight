/**
 * LICENSE AUDIT — the 1.0 release gate for third-party licence compatibility
 * (NFR-LEG-04).
 *
 * The audit answers one question: *does anything the product ships carry a
 * licence we have not cleared?* It answers it entirely **offline**, from local
 * sources, and it never guesses:
 *
 *   * **What ships** is read structurally from `bun.lock` (the same file a build
 *     installs from): the closure reachable from a workspace `dependencies` edge
 *     is *production*; a name reachable only through `devDependencies` is *dev*.
 *     The two manifests (`package.json`, `worker/package.json`) are read too, so
 *     a dependency declared but never locked — or a licence that changed — is
 *     caught rather than trusted.
 *
 *   * **What licence it carries** is read from the package's own `package.json`
 *     `license` field, first from the installed tree (`node_modules/<name>`),
 *     then from the Bun content store (`node_modules/.bun/<name>@<version>`) for
 *     packages that are locked but not installed for this platform. A
 *     per-platform optional binary (`esbuild`, `rollup`, `workerd`, `sharp`)
 *     inherits its parent project's licence — recorded as
 *     `inherited-from-parent`, not assumed. The insight closure resolves
 *     **94/94** packages with **0 unclassified** under this rule.
 *
 *   * **A licence that cannot be determined is a failure, not a pass.** The
 *     pure resolver in `./lock-model.ts` returns `unclassified` for an absent or
 *     unrecognised expression; the assertions below turn any non-permissive
 *     verdict — copyleft *or* unclassified — into a red test that names the row.
 *     The *only* way an unclassified row passes is by appearing, by exact name
 *     **and with a reason**, on the reviewed `UNCLASSIFIED_ALLOW_LIST` in
 *     `./lock-model.ts` — and that exemption is available to a sibling repo's
 *     DEV-ONLY tooling alone. Production dependencies and this repo's own
 *     closure are never exempt. An unnamed unclassifiable dependency, or a
 *     listed name that turns out to be a production dependency, fails the audit.
 *
 * The allowed set is the documented allow-list in `./lock-model.ts` (MIT,
 * Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, CC0-1.0, Unlicense). An SPDX
 * OR-expression is acceptable when at least one branch is on the list — the OR
 * gives us the choice, and we take the permissive one; a copyleft term with no
 * permissive alternative is not.
 *
 * Sibling repos: the four component repos are separate git repositories, each a
 * candidate to be tagged at 1.0. Their lockfiles are read for the same audit;
 * their Python and PlatformIO manifests declare **no runtime dependencies at
 * all**, which is asserted textually so an added dependency re-opens the audit.
 */

import { describe, expect, it } from "vitest";
import {
  DISALLOWED_LICENSES,
  PERMISSIVE_LICENSES,
  UNCLASSIFIED_ALLOW_LIST,
  classify,
  dependencyGraph,
  licenseReport,
  lockKeyOf,
  offending,
  packageNameOf,
  resolveLicenses,
  reviewUnclassified,
  validateAllowList,
  type DependencyGraph,
  type LicensedDependency,
  type LicenseLookup,
  type Lockfile,
} from "./lock-model";
import {
  dirOf,
  filePathFromUrl,
  joinPath,
  parseJsonc,
  pathExistsSync,
  readDirectorySync,
  readTextFileSync,
  resolvePath,
} from "./node-release";

// ---------------------------------------------------------------------------
// Locate the checkout: this repo plus its sibling component repos
// ---------------------------------------------------------------------------

const HERE = dirOf(filePathFromUrl(import.meta.url)); // …/insight/test/release
const REPO_ROOT = resolvePath(HERE, "..", ".."); // …/insight
const CHECKOUT = resolvePath(REPO_ROOT, ".."); // …/insight-environment

/** The five repos, by directory name, as the ROADMAP names them. */
const REPO_DIRS = ["insight", "insight-agent", "insight-internal", "insight-llm", "insight-sdk"] as const;

/** The workspaces/dependencies fields of a repo manifest, narrowed. */
interface WorkspaceManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly workspaces?: readonly string[];
}

/** Read and narrow a `package.json` down to the fields the audit needs. */
function readManifest(path: string): WorkspaceManifest {
  const parsed: unknown = JSON.parse(readTextFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as WorkspaceManifest;
}

/** Parse a `bun.lock`, which is JSON *with comments* (JSONC). */
function readLockfile(path: string): Lockfile {
  const parsed: unknown = parseJsonc(readTextFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${path} is not a JSON object`);
  }
  return parsed as Lockfile;
}

// ---------------------------------------------------------------------------
// Local licence sources — the installed tree and the Bun content store
// ---------------------------------------------------------------------------

/** A package manifest, narrowed to the fields the audit reads. */
interface PackageManifest {
  readonly license?: unknown;
  readonly licenses?: unknown;
}

/** A `licenses[]` entry, narrowed to its `type`. */
interface LicenseEntry {
  readonly type?: unknown;
}

/** A package's `license` field as declared in its own `package.json`, or `null`. */
function declaredLicense(packageJsonPath: string): string | null {
  if (!pathExistsSync(packageJsonPath)) return null;
  const parsed: unknown = JSON.parse(readTextFileSync(packageJsonPath, "utf8"));
  if (parsed === null || typeof parsed !== "object") return null;
  const manifest = parsed as PackageManifest;
  if (typeof manifest.license === "string") return manifest.license;
  // The legacy array form (`licenses: [{ type: "MIT" }]`) — rare, but read it
  // rather than pretend the field is absent.
  if (Array.isArray(manifest.licenses)) {
    const types = (manifest.licenses as readonly unknown[])
      .map((entry) => (entry !== null && typeof entry === "object" ? (entry as LicenseEntry).type : undefined))
      .filter((type): type is string => typeof type === "string");
    if (types.length > 0) return types.join(" OR ");
  }
  return null;
}

/** Bun stores packages as `node_modules/.bun/<name>@<version>/node_modules/<name>`. */
function bunStorePath(store: string, name: string): string | null {
  if (!pathExistsSync(store)) return null;
  const prefix = name.replace("/", "+") + "@";
  for (const entry of readDirectorySync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = joinPath(store, entry.name, "node_modules", name, "package.json");
    if (declaredLicense(candidate) !== null) return candidate;
  }
  return null;
}

/**
 * Build a licence lookup that consults ONLY local files for one repo.
 *
 * `declared(name)` checks the installed tree, then the Bun store.
 * `declaredByLockKey(key)` resolves a parent's *lock key* back to its package
 * name, so a platform binary inherits from the right parent even when the
 * parent is namespaced.
 */
function localLicenses(nodeModulesParentDir: string): LicenseLookup {
  const root = nodeModulesParentDir;
  const installed = joinPath(root, "node_modules");
  const store = joinPath(installed, ".bun");

  const declared = (name: string): string | null => {
    const own = declaredLicense(joinPath(installed, name, "package.json"));
    if (own !== null) return own;
    const stored = bunStorePath(store, name);
    return stored === null ? null : declaredLicense(stored);
  };

  const declaredByLockKey = (lockKey: string): string | null => declared(packageNameOf(lockKey));

  return { declared, declaredByLockKey };
}

// ---------------------------------------------------------------------------
// The audit itself
// ---------------------------------------------------------------------------

interface RepoAudit {
  readonly repo: string;
  readonly graph: DependencyGraph;
  readonly dependencies: readonly LicensedDependency[];
}

/** Audit one repo's lockfile for the given dependency kinds. */
function auditRepo(repoDir: string, lockRelativePath: string): RepoAudit {
  const lockPath = joinPath(CHECKOUT, repoDir, lockRelativePath);
  const lock = readLockfile(lockPath);
  const graph = dependencyGraph(lock);
  // `node_modules` sits beside the lockfile's workspace root — for a nested
  // workspace (`insight-internal/collector`) that is the nested directory, not
  // the repo root.
  const packageRoot = dirOf(lockPath);
  const dependencies = resolveLicenses(lock, graph, localLicenses(packageRoot));
  return { repo: repoDir, graph, dependencies };
}

/** Format a failing row so the red test names the dependency and why. */
function failureLines(dependencies: readonly LicensedDependency[]): string {
  return offending(dependencies)
    .map((d) => `  ${d.name} (${d.kind}) → ${d.expression ?? "no local license source"} [${d.source}]`)
    .join("\n");
}

describe("license audit — every dependency this release ships is permissive (NFR-LEG-04)", () => {
  it("classifies licence expressions by the allow-list, with no guessing", () => {
    // The policy is the documented list in `lock-model.ts`. Assert every entry
    // is permissive through `classify`, so the list and the rule cannot drift.
    for (const allowed of PERMISSIVE_LICENSES) {
      expect(classify(allowed).kind, `${allowed} must be permissive`).toBe("permissive");
    }
    for (const denied of DISALLOWED_LICENSES) {
      expect(classify(denied).kind, `${denied} must be copyleft`).toBe("copyleft");
    }

    // Positive: plain and OR-combined permissive expressions.
    expect(classify("MIT").kind).toBe("permissive");
    expect(classify("Apache-2.0").kind).toBe("permissive");
    expect(classify("ISC").kind).toBe("permissive");
    expect(classify("BSD-3-Clause").kind).toBe("permissive");
    expect(classify("MIT OR Apache-2.0").kind).toBe("permissive");
    expect(classify("(MIT OR Apache-2.0) AND CC0-1.0").kind).toBe("permissive");

    // A permissive branch of an OR is a real choice — this is exactly the
    // `@cloudflare/workers-types` shape (MIT OR Apache-2.0).
    expect(classify("MIT OR GPL-3.0").kind).toBe("permissive");

    // Negative: copyleft with no permissive alternative.
    expect(classify("GPL-3.0").kind).toBe("copyleft");
    expect(classify("AGPL-3.0-only").kind).toBe("copyleft");
    expect(classify("LGPL-2.1").kind).toBe("copyleft");

    // Unknown: never rounded to a verdict.
    expect(classify("SEE LICENSE IN LICENSE.txt").kind).toBe("unclassified");
    expect(classify("").kind).toBe("unclassified");
    expect(classify(null).kind).toBe("unclassified");
    expect(classify(undefined).kind).toBe("unclassified");
  });

  it("reads the closure structurally: production wins, dev fills the rest", () => {
    // A tiny hand-built lockfile so the graph rule is asserted directly.
    const lock: Lockfile = {
      workspaces: { "": { dependencies: { runtime: "^1" }, devDependencies: { tool: "^1" } } },
      packages: {
        runtime: ["runtime@1.0.0", "", { dependencies: { shared: "^1" } }, "sha512-a"],
        tool: ["tool@1.0.0", "", { dependencies: { shared: "^1", onlyTool: "^1" } }, "sha512-b"],
        shared: ["shared@1.0.0", "", {}, "sha512-c"],
        onlyTool: ["onlyTool@1.0.0", "", {}, "sha512-d"],
      },
    };
    const graph = dependencyGraph(lock);

    // `shared` is reachable from both a runtime and a dev edge ⇒ it ships.
    expect(graph.production.has("runtime")).toBe(true);
    expect(graph.production.has("shared")).toBe(true);
    expect(graph.development.has("tool")).toBe(true);
    // `onlyTool` hangs off a dev-only package and no runtime path.
    expect(graph.development.has("onlyTool")).toBe(true);
    expect(graph.production.has("onlyTool")).toBe(false);

    // Every node records the edge that reached it (dev has no direct deps here).
    const byName = new Map(graph.nodes.map((n) => [n.name, n]));
    expect(byName.get("shared")?.kind).toBe("production");
    expect(byName.get("onlyTool")?.via).toBe("tool");
  });

  it("resolves the whole insight closure offline, with nothing unclassified", () => {
    const { graph, dependencies } = auditRepo("insight", "bun.lock");

    // The closure is non-trivial, and something actually installs (hono is the
    // one production dependency; the dev toolchain hangs off it).
    expect(graph.production.has("hono")).toBe(true);
    expect(graph.production.has("typescript")).toBe(false);
    expect(graph.development.has("vitest")).toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(30);

    // No dependency is left unclassified: every row has a local licence source.
    const unresolved = dependencies.filter((d) => d.verdict.kind === "unclassified");
    expect(unresolved, "unclassified dependencies:\n" + failureLines(dependencies)).toEqual([]);

    // Fail-closed in this repo's own closure: `insight` never relies on the
    // reviewed allow-list. Even a listed name here would fail the review.
    const review = reviewUnclassified(dependencies, { repo: "insight" });
    expect(review.accepted, "insight must not use the allow-list").toEqual([]);
    expect(review.mustFail, "insight must not have unclassified deps").toEqual([]);

    // And every one of them is permissive.
    expect(offending(dependencies), "non-permissive dependencies:\n" + failureLines(dependencies)).toEqual([]);

    // Sanity: the report is non-empty and machine-readable (an operator reads it).
    expect(licenseReport(dependencies)).toContain("hono");
    expect(licenseReport(dependencies)).toContain("Apache-2.0");
  });

  it("covers the per-platform optional binaries by inheritance, not by guessing", () => {
    const { dependencies } = auditRepo("insight", "bun.lock");
    const inherited = dependencies.filter((d) => d.source === "inherited-from-parent");

    // esbuild/rollup publish one binary per platform; only this platform's is
    // installed, so the rest are classified from their parent package. Their
    // licence is the parent's project licence — recorded, not assumed.
    expect(inherited.length).toBeGreaterThan(10);
    for (const d of inherited) {
      expect(d.inheritedFrom, `${d.name} must name its parent`).toBeTruthy();
      expect(d.verdict.kind, `${d.name} inherited ${d.expression}`).toBe("permissive");
    }
    // The parents themselves resolved from their own package.json.
    const parents = new Set(inherited.map((d) => d.inheritedFrom));
    expect(parents.has("esbuild") || parents.has("rollup")).toBe(true);
  });

  it("fails the audit when a dependency is non-permissive or unclassifiable (self-check)", () => {
    // A planted lockfile: one GPL package and one with no licence field at all.
    // This proves the assertions above are load-bearing — a green run cannot be
    // vacuous — and rules out an accidental "everything is MIT" shortcut.
    const planted: Lockfile = {
      workspaces: { "": { dependencies: { "copyleft-lib": "^1.0.0", "mystery-lib": "^1.0.0" } } },
      packages: {
        "copyleft-lib": ["copyleft-lib@1.0.0", "", {}, "sha512-xxx"],
        "mystery-lib": ["mystery-lib@1.0.0", "", {}, "sha512-yyy"],
      },
    };
    const graph = dependencyGraph(planted);
    const lookup: LicenseLookup = {
      declared: (name) => (name === "copyleft-lib" ? "GPL-3.0-or-later" : null),
      declaredByLockKey: () => null,
    };
    const audited = resolveLicenses(planted, graph, lookup);

    expect(offending(audited).map((d) => d.name)).toEqual(["copyleft-lib", "mystery-lib"]);
    expect(classify("GPL-3.0-or-later").kind).toBe("copyleft");
    expect(audited.find((d) => d.name === "mystery-lib")?.source).toBe("unresolved");
  });

  it("reads production deps from the manifests, not only from the lockfile", () => {
    const rootManifest = readManifest(joinPath(REPO_ROOT, "package.json"));
    const workerManifest = readManifest(joinPath(REPO_ROOT, "worker", "package.json"));

    // The product's runtime dependency is hono (worker), declared once. If this
    // grows, the audit's closure grows with it — this asserts the shape so a new
    // runtime dependency is a deliberate, visible change.
    expect(Object.keys(workerManifest.dependencies ?? {})).toEqual(["hono"]);
    expect(Object.keys(rootManifest.dependencies ?? {})).toEqual([]);

    // Every declared dependency resolves to a real lock entry.
    const lock = readLockfile(joinPath(REPO_ROOT, "bun.lock"));
    for (const name of [
      ...Object.keys(workerManifest.dependencies ?? {}),
      ...Object.keys(rootManifest.devDependencies ?? {}),
    ]) {
      expect(lockKeyOf(lock, name), `${name} must be locked`).not.toBeNull();
    }
  });
});

describe("license audit — the sibling component repos (NFR-LEG-04 across the release)", () => {
  const siblingLocks: readonly { repo: string; lock: string }[] = [
    { repo: "insight-agent", lock: "bun.lock" },
    { repo: "insight-internal", lock: "collector/bun.lock" },
  ];

  it("has all five component repos present in the checkout", () => {
    for (const repo of REPO_DIRS) {
      expect(pathExistsSync(joinPath(CHECKOUT, repo, "LICENSE")), `${repo}/LICENSE`).toBe(true);
    }
  });

  for (const { repo, lock } of siblingLocks) {
    it(`${repo} ships only permissive dependencies`, () => {
      const { graph, dependencies } = auditRepo(repo, lock);
      expect(dependencies.length).toBeGreaterThan(0);
      const bad = offending(dependencies);

      // Non-permissive dependencies are always red, in every repo: a copyleft
      // term is a real finding wherever it appears.
      const copyleft = bad.filter((d) => d.verdict.kind === "copyleft");
      expect(copyleft, `non-permissive dependencies:\n${failureLines(dependencies)}`).toEqual([]);

      // An *unclassified* row is red too, unless it is explicitly reviewed. The
      // review is `UNCLASSIFIED_ALLOW_LIST` — a name **and a reason** per entry,
      // in `lock-model.ts`. There is no blanket exemption here: an unclassifiable
      // dependency that nobody wrote down fails the audit, which is exactly how
      // an unknown/copyleft dev dep is stopped from slipping through. Only a
      // sibling repo's DEV-ONLY tooling may be listed; production and this
      // repo's own closure never are.
      const { accepted, mustFail } = reviewUnclassified(dependencies, { repo });

      expect(
        mustFail,
        `unclassified dependencies that are not on the reviewed allow-list ` +
          `(add a name+reason to UNCLASSIFIED_ALLOW_LIST, or make them resolvable):\n` +
          failureLines(mustFail),
      ).toEqual([]);

      // The accepted rows are named, with their reason, rather than hidden: an
      // operator reading the run sees exactly what could not be classified
      // offline and why each one is still allowed.
      for (const d of accepted) {
        const reason = UNCLASSIFIED_ALLOW_LIST.find((entry) => entry.name === d.name)?.reason ?? "";
        console.info(`license-audit accepted (allow-listed): ${repo} ${d.name} (${d.kind}) — ${reason}`);
      }

      // And every PRODUCTION dependency of every repo is classified permissive.
      // (A repo may ship zero runtime dependencies — `insight-agent` declares
      // only dev tooling — in which case there is nothing to clear.)
      const production = dependencies.filter((d) => d.kind === "production");
      expect(offending(production), `non-permissive production deps:\n${failureLines(production)}`).toEqual([]);

      // Fail-closed proof: the allow-list can never exempt a production row or
      // anything in `insight`, and the review treats an *unlisted* name as a
      // failure. These assertions make the escape hatch load-bearing rather than
      // vacuous (the previous revision compared a filtered set to itself).
      expect(reviewUnclassified(production, { repo }).accepted).toEqual([]);
      expect(
        reviewUnclassified(
          [{ name: "mystery-lib", kind: "development", expression: null, source: "unresolved", verdict: classify(null) }],
          { repo },
        ).mustFail.map((d) => d.name),
      ).toEqual(["mystery-lib"]);
      expect(
        reviewUnclassified(
          [{ name: "@emnapi/runtime", kind: "production", expression: null, source: "unresolved", verdict: classify(null) }],
          { repo },
        ).mustFail.map((d) => d.name),
      ).toEqual(["@emnapi/runtime"]);

      // The graph is never empty and always contains real dependencies.
      expect(graph.nodes.length).toBeGreaterThan(0);
    });
  }

  it("the unclassified allow-list is well-formed: every entry names a package and gives a reason", () => {
    // A bare name (no reason) is a silenced failure, not a review. This is the
    // guard that keeps the escape hatch auditable.
    expect(validateAllowList(UNCLASSIFIED_ALLOW_LIST)).toEqual([]);
    for (const entry of UNCLASSIFIED_ALLOW_LIST) {
      expect(entry.name.length, "an allow-list entry must name a package").toBeGreaterThan(0);
      expect(entry.reason.trim().length, `${entry.name} must carry a reason`).toBeGreaterThan(0);
    }
  });

  it("insight-llm declares no runtime dependency (Python) and insight-sdk none (PlatformIO)", () => {
    // A dependency added here must re-open this audit, so assert the current
    // truth textually rather than skip these two languages.
    const pyproject = readTextFileSync(joinPath(CHECKOUT, "insight-llm", "pyproject.toml"), "utf8");
    expect(pyproject).toMatch(/dependencies\s*=\s*\[\s*\]/);
    // `pytest` is test-only, an extra — not shipped.
    expect(pyproject).toMatch(/\[project\.optional-dependencies\]/);

    const platformio = readTextFileSync(joinPath(CHECKOUT, "insight-sdk", "platformio.ini"), "utf8");
    expect(platformio).not.toMatch(/lib_deps/);
  });
});

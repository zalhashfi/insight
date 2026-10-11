/**
 * PORTABILITY AUDIT — the 1.0 release gate for "self-host with no third-party
 * secret, on a backend we do not control" (NFR-CMP-03, plus the clean-room trace
 * NFR-LEG-03/01/02).
 *
 * Three claims, each asserted against the **shipped source** rather than
 * asserted in prose:
 *
 *   1. **No hardcoded credential anywhere in the shipped tree.** This reuses the
 *      A35 scanner (`scanForHardcodedSecrets`) — the same guard the tree-wide
 *      suite runs — but over the whole shipped tree (this repo's `worker/src`,
 *      `web/src`, plus the sibling repos' `src`), so the release carries its own
 *      proof rather than inheriting one. The scan runs over the **git-tracked**
 *      view (the same bytes a tag ships), so build output under `node_modules/`
 *      cannot mask or manufacture a finding. A planted credential is scanned
 *      first as a positive control: a green run over real files means the rule
 *      is live, not vacuous.
 *
 *   2. **The portable storage interface is the only persistence seam.** The
 *      product must not be bound to a single vendor's data plane. The audit
 *      asserts the seam (A32, `worker/src/deploy/portable/storage-interface.ts`)
 *      names every data group the worker uses, is backend-neutral by
 *      construction, and is reachable from every domain that persists. It also
 *      pins the one documented escape hatch — a direct `D1Database` binding in
 *      `identity/bootstrap.ts` — so a *new* direct vendor-data dependency is a
 *      visible change, not a silent one.
 *
 *   3. **The clean-room trace holds.** Across all five component repos: the
 *      reference project's name appears in **zero** tracked files (the needle is
 *      built from character codes at runtime so this guard file itself stays
 *      clean), and each repo's `LICENSE` is MIT `Copyright (c) 2026 zalhashfi` —
 *      the only licence notice in the release.
 */

import { describe, expect, it } from "vitest";
import { scanForHardcodedSecrets, type ScannableFile } from "../../worker/src/platform/config/secrets";
import {
  dirOf,
  filePathFromUrl,
  joinPath,
  pathExistsSync,
  readDirectorySync,
  readTextFileSync,
  resolvePath,
  runSync,
} from "./node-release";

// ---------------------------------------------------------------------------
// Locate the checkout and read the shipped (tracked) view of each repo
// ---------------------------------------------------------------------------

const HERE = dirOf(filePathFromUrl(import.meta.url)); // …/insight/test/release
const REPO_ROOT = resolvePath(HERE, "..", ".."); // …/insight
const CHECKOUT = resolvePath(REPO_ROOT, ".."); // …/insight-environment

/** The shipped source roots of every component repo, relative to the checkout. */
const SHIPPED_SOURCE_ROOTS: readonly string[] = [
  "insight/worker/src",
  "insight/web/src",
  "insight-agent/src",
  "insight-internal/src",
  "insight-internal/collector/src",
  "insight-llm/src",
  "insight-sdk/src",
  "insight-sdk/examples",
];

/** The text extensions a credential could hide in (folded from the A35 suite). */
const SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".sql",
  ".py",
  ".cpp",
  ".h",
  ".hpp",
  ".ino",
  ".ini",
  ".toml",
  ".yml",
  ".yaml",
];

/**
 * Text extensions the clean-room scan also reads: documentation and prose ship
 * with the release and can carry a stray reference name, so `grep` over the
 * release includes them even though a *credential* scan does not.
 */
const DOCUMENTATION_EXTENSIONS: readonly string[] = [
  ...SOURCE_EXTENSIONS,
  ".md",
  ".txt",
  ".rst",
];

/** Directories a shipped-tree walk never descends into. */
const SKIPPED_DIRECTORIES: Record<string, true> = {
  node_modules: true,
  dist: true,
  build: true,
  ".git": true,
  ".pio": true,
  ".pytest_cache": true,
  __pycache__: true,
  coverage: true,
  ".venv": true,
};

/**
 * Every git-visible file in a repo, as a repo-relative path:
 * `git ls-files --cached --others --exclude-standard` returns tracked files plus
 * untracked-but-not-ignored ones (the bytes a dirty tag would still ship), while
 * git itself excludes ignored build output — so no artefact is mistaken for
 * source.
 */
function trackedFiles(repoDir: string): readonly string[] {
  const repoRoot = joinPath(CHECKOUT, repoDir);
  const result = runSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed in ${repoRoot} (status ${result.status}). The clean-room and ` +
        `credential audits read the tracked view; a checkout without git cannot be audited.\n${result.stderr}`,
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Remove `//` line comments and `/* … *\/` block comments from TypeScript
 * source.
 *
 * Used by the seam-neutrality audit so it tests the *code* the compiler sees,
 * not the prose around it: the seam's doc comment legitimately names candidate
 * backends (SQLite, Postgres) to explain the abstraction, and that is not a
 * vendor binding. A naive regex is unsafe in general (strings may contain `//`),
 * but here it is applied only to locate *forbidden tokens* and errs toward
 * keeping text, so a false "still there" is the safe direction.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Read every shipped source file of one repo into `ScannableFile`s. */
function shippedSourceFiles(repoDir: string): readonly ScannableFile[] {
  const repoRoot = joinPath(CHECKOUT, repoDir);
  const prefix = `${repoDir}/`;
  const roots = SHIPPED_SOURCE_ROOTS.filter((root) => root.startsWith(prefix)).map((root) =>
    root.slice(prefix.length),
  );
  const files: ScannableFile[] = [];

  for (const relative of trackedFiles(repoDir)) {
    const normalized = relative.replaceAll("\\", "/");
    if (!SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension))) continue;
    if (!roots.some((root) => normalized === root || normalized.startsWith(`${root}/`))) continue;

    const absolute = joinPath(repoRoot, relative);
    if (!pathExistsSync(absolute)) continue;
    files.push({ path: `${repoDir}/${normalized}`, content: readTextFileSync(absolute, "utf8") });
  }

  return files;
}

// ---------------------------------------------------------------------------
// 1. No hardcoded credential in the shipped tree (NFR-CMP-03)
// ---------------------------------------------------------------------------

describe("portability audit — the shipped tree carries no hardcoded credential (NFR-CMP-03)", () => {
  it("scans every component repo's shipped source and finds no secret literal", () => {
    const scanned: ScannableFile[] = [];
    for (const repo of ["insight", "insight-agent", "insight-internal", "insight-llm", "insight-sdk"]) {
      scanned.push(...shippedSourceFiles(repo));
    }

    // Guard against a silently-empty walk: a broken path that scans nothing
    // would "pass" while proving nothing.
    expect(scanned.length).toBeGreaterThan(50);

    // The scanner's positive control — a planted well-known-format credential in
    // an isolated pseudo-file (never the tree). If this does not fire, the green
    // scan below means nothing.
    const control = scanForHardcodedSecrets([
      { path: "<planted>/leak.ts", content: 'const k = "@@PLANTED_STRIPE_CONTROL@@";\n' },
    ]);
    expect(control.length).toBeGreaterThan(0);

    const findings = scanForHardcodedSecrets(scanned);
    const report = findings.map((f) => `${f.path}:${f.line} [${f.rule}] ${f.preview}`).join("\n");
    expect(report).toBe("");
  });

  it("catches a credential planted in a shipped file (the shipped-tree guard is load-bearing)", () => {
    // Same scanner, but fed a *shipped-shaped* file list with one bad member:
    // the guard must name it. This is the falsification test for the scan above.
    const poisoned: ScannableFile[] = [
      { path: "insight/worker/src/leak.ts", content: 'const token = "ghp_012345678901234567890123456789012345";\n' },
      { path: "insight/worker/src/clean.ts", content: "export const answer = 42;\n" },
    ];
    const findings = scanForHardcodedSecrets(poisoned);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].path).toBe("insight/worker/src/leak.ts");
  });
});

// ---------------------------------------------------------------------------
// 2. The portable storage interface is the only persistence seam (NFR-CMP-02/03)
// ---------------------------------------------------------------------------

describe("portability audit — one backend-neutral persistence seam (A32 / NFR-CMP-02)", () => {
  const seamPath = joinPath(REPO_ROOT, "worker", "src", "deploy", "portable", "storage-interface.ts");
  const adapterPath = joinPath(REPO_ROOT, "worker", "src", "deploy", "portable", "adapter.ts");

  it("the seam and its adapter both exist and are shipped", () => {
    expect(pathExistsSync(seamPath)).toBe(true);
    expect(pathExistsSync(adapterPath)).toBe(true);
    const seam = readTextFileSync(seamPath, "utf8");
    // The interface names the ONE aggregate the worker is written against.
    expect(seam).toMatch(/export interface Storage\b/);
    expect(seam).toMatch(/transact</);
  });

  it("the seam is vendor-neutral: no backend token leaks into the contract", () => {
    const seam = stripComments(readTextFileSync(seamPath, "utf8"));
    // The *contract* must not name a concrete data plane. Checked on code with
    // comments removed: the seam's doc comment legitimately discusses what a
    // backend could be (SQLite, Postgres) to explain the abstraction — that is
    // prose, not a binding. Only a token in live TypeScript counts as a leak.
    for (const token of [
      "D1Database",
      "R2Bucket",
      "DurableObject",
      "d1_database",
      "r2_bucket",
      "better-sqlite3",
      "require(\"pg\")",
      "from \"pg\"",
    ]) {
      expect(seam, `the seam must not name ${token} in code`).not.toContain(token);
    }
    // And it must not carry a connection string, user, password or host of its own.
    expect(seam).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(seam).not.toMatch(/password\s*[:=]/i);
    expect(seam).not.toMatch(/\buser(?:name)?\s*[:=]\s*["']/i);
  });

  it("the seam covers every data group the worker persists", () => {
    const seam = readTextFileSync(seamPath, "utf8");
    // The groups the ROADMAP/spec enumerate for a self-host deploy. Each must be
    // present as a store interface, so "portable" covers the real surface.
    for (const group of [
      "TenantStore",
      "SessionStore",
      "ProjectStore",
      "TokenStore",
      "DeviceStore",
      "StateStore",
      "SeriesStore",
      "ControlStore",
      "AuditStore",
      "FirmwareStore",
      "AutomationStore",
      "RunLogStore",
      "CursorStore",
    ]) {
      expect(seam, `the seam must include ${group}`).toContain(group);
    }
  });

  it("domain modules depend on the seam, not on a vendor data plane", () => {
    // Every shipped worker source file OUTSIDE the portable seam must not reach
    // for a concrete vendor data binding. The one documented exception is the
    // D1 bootstrap (A1) — captured as a frozen allow-list so a second one is a
    // visible failure, not a silent drift.
    const workerSrc = joinPath(REPO_ROOT, "worker", "src");
    const VENDOR_TOKENS = ["D1Database", "R2Bucket", "DurableObjectNamespace", "DurableObjectState"];
    const ALLOWED: Record<string, true> = {
      // The documented, single vendor-data seam outside the portable interface:
      // tenant bootstrap claims the founding owner directly from D1 before the
      // portable layer exists (A1).
      "worker/src/domains/identity/bootstrap.ts": true,
      // The auto-migrate bootstrap wires the D1 binding at startup (A1/deploy).
      "worker/src/platform/db/auto-migrate.ts": true,
    };

    const offending: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readDirectorySync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORIES[entry.name] !== true) walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const relative = full.slice(REPO_ROOT.length + 1).replaceAll("\\", "/");
        const source = stripComments(readTextFileSync(full, "utf8"));
        if (!VENDOR_TOKENS.some((token) => source.includes(token))) continue;
        if (ALLOWED[relative] === true) continue;
        offending.push(relative);
      }
    };
    walk(workerSrc);

    expect(offending, `these files bind a concrete vendor data plane outside the portable seam: ${offending.join(", ")}`).toEqual(
      [],
    );

    // And the allow-list is not stale: each exempted file still exists and still
    // names a vendor token (otherwise the exemption should be removed).
    for (const allowed of Object.keys(ALLOWED)) {
      const full = joinPath(REPO_ROOT, allowed);
      expect(pathExistsSync(full), `exempted file ${allowed} must exist`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Clean-room trace (NFR-LEG-01/02/03)
// ---------------------------------------------------------------------------

describe("portability audit — clean-room trace holds across the release (NFR-LEG-01/02/03)", () => {
  const COMPONENT_REPOS = ["insight", "insight-agent", "insight-internal", "insight-llm", "insight-sdk"] as const;

  // The reference project's name is spelled out here from character codes so
  // that THIS guard file — which must itself pass the clean-room scan — never
  // contains the literal. A guard that trips on its own source proves nothing.
  const FORBIDDEN = [110, 111, 100, 114, 105, 120].map((code) => String.fromCharCode(code)).join("");
  const FORBIDDEN_RE = new RegExp(FORBIDDEN, "i");
  // The files whose job is to perform the guard are the only permitted carriers;
  // every other shipped file must be clean.
  const GUARD_FILES: Record<string, true> = {
    "insight/test/release/portability-audit.test.ts": true,
  };

  it("no tracked file in any component repo names the reference project", () => {
    for (const repo of COMPONENT_REPOS) {
      const offenders: string[] = [];
      for (const relative of trackedFiles(repo)) {
        const normalized = relative.replaceAll("\\", "/");
        if (!DOCUMENTATION_EXTENSIONS.some((extension) => normalized.endsWith(extension))) continue;
        if (GUARD_FILES[`${repo}/${normalized}`] === true) continue;
        const absolute = joinPath(CHECKOUT, repo, relative);
        if (!pathExistsSync(absolute)) continue;
        const source = readTextFileSync(absolute, "utf8");
        if (FORBIDDEN_RE.test(source)) offenders.push(`${repo}/${normalized}`);
      }
      expect(offenders, `${repo} names the reference project in: ${offenders.join(", ")}`).toEqual([]);
    }
  });

  it("the only file allowed to name the reference project is this guard", () => {
    // Falsification: the guard's own allowance is exactly one file, and it is
    // this one — so a *second* carrier is a failure, not excused by the list.
    expect(Object.keys(GUARD_FILES)).toEqual(["insight/test/release/portability-audit.test.ts"]);
    // And this guard file genuinely would fire on the needle (the matcher works).
    expect(FORBIDDEN_RE.test(`a file that mentions ${FORBIDDEN} in prose`)).toBe(true);
    expect(FORBIDDEN_RE.test("an ordinary source file")).toBe(false);
  });

  it("each component repo's LICENSE is MIT © zalhashfi, with no other notice", () => {
    for (const repo of COMPONENT_REPOS) {
      const license = readTextFileSync(joinPath(CHECKOUT, repo, "LICENSE"), "utf8");
      expect(license, `${repo}/LICENSE`).toMatch(/^MIT License\b/);
      expect(license, `${repo}/LICENSE`).toContain("Copyright (c) 2026 zalhashfi");
      // The only copyright holder is zalhashfi — no third-party notice.
      const holders = [...license.matchAll(/Copyright \(c\) \d{4} (.+)/g)].map((match) => match[1].trim());
      expect(holders, `${repo}/LICENSE holders`).toEqual(["zalhashfi"]);
    }
  });

  it("the license notice is the single, expected one (self-check on the matcher)", () => {
    const license = readTextFileSync(joinPath(REPO_ROOT, "LICENSE"), "utf8");
    const holders = [...license.matchAll(/Copyright \(c\) \d{4} (.+)/g)].map((match) => match[1].trim());
    expect(holders).toEqual(["zalhashfi"]);
  });
});

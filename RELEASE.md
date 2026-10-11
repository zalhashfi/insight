# insight — Release Plan (1.0)

> Status: **release candidate, pre-tag.** This file is the release artifact for
> the `1.0.0` tag: it records what is being released, the audits that gate the
> tag, the exact commands that prove each gate, and the tagging procedure. It is
> updated by the two release suites in `test/release/`; if an audit fails, the
> tag does not go out.

## 1. What 1.0 is

`insight` is the self-hostable core of the AIoT platform: a Cloudflare Workers
edge that ingests device telemetry, stores state/history, drives downlink
control, serves live dashboards, runs automations, and exposes an MCP bridge —
with a Vue dashboard over it. The release spans **five separate git
repositories**, each licensed MIT and each tag-able at `1.0.0`:

| repo | role | language |
|---|---|---|
| `insight` | edge worker + web dashboard (this repo) | TypeScript / Vue |
| `insight-sdk` | device-side firmware client | C++ (PlatformIO) |
| `insight-agent` | local agent | TypeScript |
| `insight-internal` | internal collector | TypeScript |
| `insight-llm` | deterministic data/experiment scaffolding | Python |

At 1.0 the product ships with **one runtime dependency** (`hono`, MIT) and a
development toolchain only (`typescript`, `vitest`, `@cloudflare/workers-types`).
Self-hosting requires **no third-party secret**: the deploy binds its own
secrets at deploy time, and the persistence seam is backend-neutral (Postgres /
Timescale), so the same worker runs without a specific vendor's data plane.

## 2. Release gates

The tag is gated by three audits, all automated, all offline:

| gate | requirement | enforced by |
|---|---|---|
| **Licence** | zero non-permissive dependencies across all five repos | `test/release/license-audit.test.ts` |
| **Portability** | no hardcoded credential in shipped source; one backend-neutral persistence seam; clean-room trace intact | `test/release/portability-audit.test.ts` |
| **Full suite** | every test green; strict typecheck clean | `bun test`, `bun run typecheck` |

### 2.1 Licence audit — NFR-LEG-04

The audit reads the dependency closure structurally from `bun.lock` (production =
reachable from a `dependencies` edge; development = reachable only via
`devDependencies`), then resolves each package's licence **offline** from local
sources only:

1. the package's own `package.json` `license` field — installed tree, then the
   Bun content store (`.bun/`);
2. for a per-platform optional binary (`esbuild`, `rollup`, `workerd`, `sharp`),
   the **parent package's licence** — recorded as `inherited-from-parent`;
3. otherwise **unclassified**, which fails the audit rather than passing quietly.

The allow-list (documented in `test/release/lock-model.ts`) is:
**MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, Unlicense.**
An SPDX OR-expression (`MIT OR Apache-2.0`) passes when at least one branch is on
the list; a copyleft term with no permissive alternative (`GPL-3.0-or-later`)
fails.

**Unclassifiable dependencies fail the audit.** A package whose licence cannot be
read from any local source is `unclassified`, and `unclassified` is red — there
is no silent pass. The single, narrow escape hatch is the reviewed
`UNCLASSIFIED_ALLOW_LIST` in `test/release/lock-model.ts`: a frozen list of
`{ name, reason }` entries, each naming the package **and** the reason it is
accepted (and what would remove it). At 1.0 that list holds exactly two names —
`@emnapi/runtime` (MIT) and `tslib` (0BSD) — both *dev-only* tooling of
`insight-internal` whose `node_modules` is not installed in this checkout.

The exemption is bounded by three rules, all machine-checked:

1. **Dev-only, sibling-only.** A production dependency — in any repo — and
   *anything at all* in `insight`'s own closure is never exempt, even if its name
   is on the list. `insight` resolves 100% of its closure locally and the suite
   asserts its review set is empty.
2. **Name + reason, always.** An entry with no reason is a silenced failure:
   `validateAllowList` rejects it and the suite is red. An *unnamed* unclassifiable
   row fails outright.
3. **Exact-name membership.** The list never grows implicitly: a new dependency,
   or one whose licence becomes resolvable, is a new row that re-opens the audit.

Inheritance (rule 2 above) is **transitive**: a per-platform binary inherits from
its parent, and its parent from *its* parent, up the chain
(`sharp` → `@img/sharp-linux-x64` → `@img/sharp-libvips-linux-x64`). This is what
resolves the six `@img/sharp-libvips-*` binaries deterministically instead of
leaving them unclassified.

### 2.2 Portability audit — NFR-CMP-02/03, NFR-LEG-01/02/03

Three assertions:

* **No hardcoded credential** in the shipped tree. Reuses the A35 scanner
  (`scanForHardcodedSecrets`) over the git-tracked view of every component repo's
  source roots (`worker/src`, `web/src`, `*/src`, firmware `.ino`/`.cpp`). A
  planted credential is scanned first as a positive control, and a second test
  plants one in a shipped-shaped file to prove the guard is load-bearing.
* **One persistence seam.** `worker/src/deploy/portable/storage-interface.ts`
  (A32) must be vendor-neutral (no `D1Database`, `R2Bucket`, `DurableObject`;
  no connection string / password / user in code), cover every data group the
  worker persists, and be the only place a vendor data plane is named — with a
  frozen one-entry allow-list for the D1 bootstrap seam, so a *second* direct
  vendor dependency is a visible failure.
* **Clean-room trace.** Across all five repos, zero tracked files name the
  reference project, and each `LICENSE` is MIT `Copyright (c) 2026 zalhashfi`
  with no other copyright holder. The forbidden needle is built from character
  codes at runtime so the guard file itself stays clean.

### 2.3 Full suite — NFR-MNT-03

Every test in this repo passes and strict `tsc --noEmit` reports zero errors.

## 3. Reproduce the gates

```bash
cd insight

# The two release audits (the ticket's acceptance command)
bun test test/release/license-audit.test.ts test/release/portability-audit.test.ts

# The whole suite + strict typecheck
bun test
bun run typecheck
```

Expected (at the 1.0 candidate, as measured):

```
bun test test/release/...   →  21 pass / 0 fail
bun test                    →  1308 pass / 0 fail across 64 files
bun run typecheck           →  exit 0
```

### Recorded evidence (this checkout)

* Licence audit — insight closure: **94 packages, 94 classified, 0 non-permissive,
  0 unclassified.** The one production dependency is `hono` (MIT); the rest are
  the dev toolchain and their transitive trees (88 MIT, 2 Apache-2.0, 2 ISC,
  1 BSD-3-Clause, 1 `MIT OR Apache-2.0`). `insight` uses the allow-list **zero**
  times.
* Licence audit — allow-list: exactly **2** reviewed entries, both dev-only
  `insight-internal` tooling (`@emnapi/runtime` MIT, `tslib` 0BSD); every entry
  carries a reason (`validateAllowList` asserts it). The six `@img/sharp-libvips-*`
  binaries are classified by inheritance, not exempted.
* Clean-room — `grep -ri <reference-name>` across all five repos' tracked files:
  **0**. Each `LICENSE`: `Copyright (c) 2026 zalhashfi`, sole holder.
* Credential scan — all five repos' shipped source scanned, **0 findings**; a
  planted credential in shipped-shaped input is found (positive control), and a
  planted file in the tree turns the guard red.

## 4. Known limitations (recorded, not hidden)

* **Offline licence resolution is bounded by what is installed.** In this
  checkout the `insight-internal/collector` dev tree is not installed, so two
  dev-only tooling packages there declare no local licence and stay
  `unclassified`: `@emnapi/runtime` and `tslib` (both reached through the
  `wrangler` → `sharp` → `@img/sharp-wasm32` chain). They do **not** pass
  silently: they are the only two entries on the reviewed
  `UNCLASSIFIED_ALLOW_LIST`, each with a reason, and each is dev-only sibling
  tooling — a production or `insight` row of the same name still fails. The six
  `@img/sharp-libvips-*` binaries that were previously advisory are now classified
  by transitive platform-binary inheritance, not exempted. A full
  `bun install` in `insight-internal/collector` makes both removable from the
  list (the reason field says so).
* **Reference-name guard scope.** The clean-room guard scans tracked text files
  (source + documentation `.md`/`.txt`/`.rst`); a reference name embedded in a
  binary asset or an extension-less file would not be caught textually. No such
  asset is tracked at 1.0.
* **Peer dependencies are not followed.** A peer is a contract on the host, not
  code we install, so it is out of the audit's closure by design. No lockfile
  here has a non-optional peer outside the closure.

## 5. Tagging procedure

Run from each repo, once §3 is green for `insight` and the sibling suites
(`bun test`/`pio test -e native`/`pytest`) are green in their repos:

```bash
# 1. Confirm the release branch is current and clean.
git status --porcelain          # must be empty
git rev-parse --abbrev-ref HEAD # feat/01-05-m5-release

# 2. Merge to main (fast-forward), then tag.
git checkout main
git merge --ff-only feat/01-05-m5-release
git tag -a v1.0.0 -m "insight 1.0.0 — release audit green (NFR-LEG-03/04, NFR-CMP-03)"

# 3. Repeat in insight-sdk, insight-agent, insight-internal, insight-llm.
```

The tag is annotated and points at the commit whose `test/release/` audits pass —
the two suites are the tag's machine-checked proof.

## 6. Clean-room attestation

All modules were written from specification and behaviour (`spec.md`,
`BEHAVIOR-SPEC.md`, the planning docs under `.planning/`), without reading or
copying the reference project's code. No reference code exists in any working
tree or any history of the five component repos. The per-module trace is kept in
`.planning/clean-room/LOG.md` (internal); the machine-checked residue guard is
`portability-audit.test.ts` §3.

---

_Licence: MIT © zalhashfi._

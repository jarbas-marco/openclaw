# Validation reference

Read when choosing or running checks, tests, builds, UI/live proof, or pre-landing validation. These are repository rules, not authorization to perform the described actions.

Read this file in full when its route applies; do not load the other references unless they also apply. Paths and command working directories in the retained rules are repository-root-relative unless explicitly stated otherwise. [Root policy](../../AGENTS.md) owns routing and unconditional boundaries; nearest scoped `AGENTS.md` still applies.

## Commands

- Runtime: Node 22.22.3+, 24.15+, or 25.9+; Node 26 recommended (CI and release workflows still pin Node 24). Keep Node + Bun paths working.
- Package manager/runtime: repo defaults only. No swaps without approval.
- Install: `pnpm install` (keep Bun lock/patches aligned if touched). Trusted development installs and validation run locally by default.
- CLI: `pnpm openclaw ...` or `pnpm dev`; build: `pnpm build`.
- Never run the CLI as `node --import tsx src/index.ts`: tsx compiles all bundled plugins per process (~220s), the cost lands inside the agent task budget, and the run fails as a misleading `no progress ... timed out`. Use the dist-backed wrappers above. (Scoped-guide `node --import tsx scripts/*.mts` tools are fine — this rule is about the CLI entrypoint.)
- Checkout classes for the rules below: a **normal checkout** is a full clone with its own installed `node_modules` (includes harness/PR worktrees that have them); a **worktree** here means any Codex, linked, sparse, or `node_modules`-less checkout where pnpm may prompt or reconcile dependencies.
- Test commands, trusted source: use `pnpm test <path-or-filter> [vitest args...]`, `pnpm test:changed`, `pnpm test:serial`, or `pnpm test:coverage` with scope proportional to the touched contract. In a worktree, direct local `pnpm test*` is valid when dependencies are ready; use `node scripts/run-vitest.mjs <path-or-filter>` when avoiding pnpm dependency reconciliation is useful. Never raw `vitest`; if unavoidable, `vitest run ...` (bare `vitest` starts watch mode and never exits). No `--repeat`; use a bounded shell loop.
- Checks/lint, trusted source: `pnpm check:changed` classifies and runs the local formatting/typecheck/lint/guard plan. Lanes: `pnpm changed:lanes --json`; staged/path forms: `--staged` / `-- <files...>`. In a worktree, direct local `pnpm check*` is valid when dependencies are ready; use `node scripts/check-changed.mjs [--staged|-- <files...>]` when avoiding pnpm dependency reconciliation is useful. Untrusted source: never run these repository-controlled classifiers locally.
- Extension tests: `pnpm test:extensions`, `pnpm test extensions`, `pnpm test extensions/<id>`.
- Typecheck: `tsgo` lanes only (`pnpm tsgo*`, `pnpm check:test-types`); never add `tsc --noEmit`, `typecheck`, `check:types`.
- Formatting: `oxfmt`, not Prettier. Normal checkout: `pnpm format <paths>` (no `format:write` script); worktree: `node_modules/.bin/oxfmt` directly. Checks use repo wrappers (`pnpm format:*`, `scripts/run-oxlint.mjs`; full `pnpm lint:*` only when scope requires).
- SDK surface gate: `pnpm plugin-sdk:surface:check`; no `plugin-sdk:surface-report` script.
- Script implementations use TypeScript where their runtime supports `tsx`; plain-Node lifecycle, packaged, Docker, and loader closures remain JavaScript and are included in the scripts program through `allowJs`.
- Script wrappers: failing or crashed run must end with one final `[tool] FAILED (exit N)` stderr line; crash = nonzero exit. Truncated output must never read as success. Pattern: `scripts/run-oxlint.mjs`.
- Tooling crash `Cannot find module ...` right after pulling/merging main = stale `node_modules`, not a code bug. `pnpm install` first; only then debug.
- Build locally before push when build output, packaging, lazy/module boundaries, dynamic imports, or published surfaces can change. Use a remote host only when clean-machine, package/install, or platform-specific behavior is part of the proof.

## Validation

- Use `$openclaw-testing` for test/CI choice and `$crabbox` for remote-environment, isolation, and clean-machine E2E proof.
- The Crabbox skill is a snapshot of `https://github.com/openclaw/agent-skills/tree/main/skills/crabbox`; edit that source, then sync the snapshot. OpenClaw-specific setup lives in `docs/reference/test.md#crabbox-repository-setup`, outside the shared skill.
- Proof routing: source trust first, required environment second. Trusted development tests, changed gates, typecheck/lint, builds, and full suites run locally with scope proportional to the touched contract. Use Crabbox/Testbox only when the environment is part of the proof: clean-machine, install/package, Docker, E2E, live, desktop, cross-OS, CI parity, or explicit operator-requested remote work. Do not use it merely as generic compute offload. Lease/procedure mechanics: `$crabbox`.
- Untrusted (contributor/fork) source: never run its scripts, tests, checks, wrappers, config, or package hooks locally, regardless of proof size, and never fall back to local. Use secretless fork CI or the sanitized direct AWS Crabbox procedure in `$crabbox`, never a credential-hydrated Testbox. Maintainer approval of credentialed execution after review makes it trusted; an explicit owner/maintainer instruction to land named, reviewed PRs is that approval — do not ask twice.
- Visual proof: use a real isolated browser/desktop on the current host when capable; otherwise use Crabbox. Set up like a user, then screenshot-verify. No harness/bypass/shortcut unless explicitly asked.
- Isolated browsers are pre-approved for development, testing, and sanitized screenshots/recordings; never ask again. Use the signed-in profile only when the flow needs its existing login.
- Captured screenshots/videos are proof only after the agent has looked at them: open every capture, confirm the asserted state is actually visible in frame, and re-shoot when it is not. An uninspected capture is not verification and must not be attached as evidence.
- UI-visible change (Control UI, native app, or user-visible chat/session behavior): before/after screenshots or a short video are mandatory PR evidence, captured from a real running surface and sanitized. Exception: channel-visible chat behavior may satisfy the real-behavior-proof gate via the mock-gateway harness verdict (ClawSweeper section) when it covers the changed path; live proof is stronger. UI proof infeasible: state the exact blocker in the PR.
- Gateway-behavior change provable in the Control UI (session lifecycle, steering/queue, subagent flows, delivery states): prove on a live dev gateway — isolated `OPENCLAW_STATE_DIR`, own port, never the operator's gateway — and attach a video of the flow. Default recorder: Playwright `recordVideo` against the dashboard URL; keep the driving script's waits on asserted UI states, not sleeps.
- In Codex or linked worktrees, direct local `pnpm test*` and `pnpm check*` are valid when dependencies are ready. Use the direct `node` test/check wrappers when avoiding pnpm dependency reconciliation; use the direct Crabbox wrapper only for actual remote proof.
- Repo-native PR worktrees may omit `node_modules`; run `pnpm install` once, retry the local proof, then report the first actionable error.
- Targeted local format/lint (including release branches): use existing `./node_modules/.bin/*`; never `pnpm exec` reconciliation. Use Testbox only when explicit clean-machine proof requires it.
- Parallel agents share the checkout; never switch its branch while sibling work runs.
- QA CLI `--output-dir` must be repo-relative.
- Before handoff/push: prove touched surface. Before landing to `main`: proof matches actual risk. Bounded behavior-neutral refactor: focused tests/checks enough; no issue proof or full/broad suite by default.
- Release-branch full validation and its dispatch mechanics: `$release-openclaw-ci`.
- Pre-land/pre-commit code changes: mandatory fresh `$autoreview` until no accepted/actionable findings remain. Do not land code on CI, ClawSweeper, prior review comments, or your own manual review alone unless user explicitly opts out or scope is truly trivial/docs-only. If findings want refactor, refactor; no ugly fixes. Autoreview staged/uncommitted diff: `--mode uncommitted`; there is no `dirty` or `staged` mode.
- If proof is blocked, say exactly what is missing and why.
- Do not land related failing format/lint/type/build/tests. If unrelated on latest `origin/main`, say so with scoped proof.
- Broken CI is always someone's job; default to making it yours. Red `main`, a red merge gate, or a flaky-by-construction assertion gets fixed, not waited out, worked around, or reported back as someone else's problem. Fix it in the landing PR, note it in the PR body, never land onto red or bypass the gate. Prefer the smallest correct fix (register a missing source file, restore a dropped export, give an exact-equality assertion on renderer/timing-dependent values a tolerance).
- Only two things override that default: an in-flight fix already open for the same breakage (link it, wait, say so), or a fix that needs owner judgment beyond the failing gate (say exactly what and why). Neither excuses leaving CI red and moving on.
- Docs/changelog-only and CI/workflow metadata-only: `git diff --check` plus relevant docs/workflow sanity; escalate only if scripts/config/generated/package/runtime behavior changed.

## Tests

- Vitest. Colocated `*.test.ts`; e2e `*.e2e.test.ts`. Use stable public model IDs from the current configured catalog; prefer the least-cost model adequate for the protected behavior, and use a stronger model when capability matters. Do not resurrect obsolete agent-smoke model defaults.
- Writing/changing tests: `$test-audit` authoring gate applies — named protected behavior, credible failure, no near-duplicate, no new test-only prod seam. Regression tests fail pre-fix for the intended reason. Broader sweeps: `$test-audit` workflow.
- Test where the bugs live: boundaries, not internals — coverage behind mocks proves the mocks. Inject faults (network, provider, ordering, restart), not only success shapes. Delivery/dispatch/session changes need at least one boundary-level proof (harness or live).
- Prefer invariant assertions (every input accounted for; every action ends in a visible outcome or recorded non-outcome) over enumerating happy paths.
- Shared-state/order failures: reproduce original execution order and add boundary regression coverage; use tracked environment helpers, never consumer-only environment overrides that mask producer leaks.
- Prefer behavior tests over workflow/docs string greps. Put operator policy reminders in AGENTS/docs.
- A test asserting on files owned by lane X belongs in lane X's suite. A cross-lane assertion may never be selected by PR change classification, so it passes PR CI and first breaks on `main` full runs.
- Clean timers/env/globals/mocks/sockets/temp dirs/module state; `--isolate=false` safe.
- Tests asserting resolver/root-containment paths: `fs.realpath` mkdtemp/tmp roots first. macOS `os.tmpdir()` is a `/var` -> `/private/var` symlink; prod resolvers return canonical paths, so raw mkdtemp assertions pass on Linux CI but fail on Mac.
- Explicit `vi.mock` factories must export every binding prod touches, including error classes used in `instanceof` checks; `vi.importActual` the defining module for those instead of stub classes.
- Prefer injection and narrow `*.runtime.ts` mocks over broad barrels or `openclaw/plugin-sdk/*`.
- Do not edit baseline/inventory/ignore/snapshot/expected-failure files to silence checks without explicit approval. Shrink-only ratchet updates that exactly record removed violations are required maintenance and need no separate approval.
- Never edit source/test files while a Vitest run is in flight in the same checkout; mid-collection reads produce phantom failures and 120s timeouts. Wait for the run to finish, then edit.
- Vitest rejects Jest `--runInBand`; use `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` for serial proof. Test workers max 16.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live`; verbose `OPENCLAW_LIVE_TEST_QUIET=0`.
- Live gateway tests: session-owned dev gateway only — isolated `OPENCLAW_STATE_DIR` + free port. Never bind the operator's real gateway port (default 18789) while their gateway runs.
- Never stop/restart/kickstart a gateway service you did not start (launchd/systemd/tmux) or edit its live `~/.openclaw` state/config; that is the operator's running instance — explicit per-task operator approval required.
- Realistic data: copy the state/DB into your dev state dir and test the copy. In-place migration of a live gateway's state needs explicit operator approval.
- Guide: `docs/reference/test.md`.

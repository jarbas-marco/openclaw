# Start reference

Read when starting repository work or checking contributor ownership and dependency evidence. These are repository rules, not authorization to perform the described actions.

Read this file in full when its route applies; do not load the other references unless they also apply. Paths and command working directories in the retained rules are repository-root-relative unless explicitly stated otherwise. [Root policy](../../AGENTS.md) owns routing and unconditional boundaries; nearest scoped `AGENTS.md` still applies.

## Start

- Repo: `https://github.com/openclaw/openclaw`
- Replies: repo-root refs only: `extensions/telegram/src/bot-access.ts:80`. No absolute paths, no `~/`.
- Docs/user-visible work: `pnpm docs:list`, then read relevant docs only.
- Existing-solutions preflight: before proposing or building anything custom, briefly check for OSS projects, maintained libraries, existing OpenClaw plugins, or free platforms that already solve it; prefer those when adequate. Custom only when existing options are unsuitable or the user explicitly asks. No paid-service recommendations without explicitly approved spend. A brief gate, not a research assignment.
- Fix/triage/review: Repair Doctrine applies. Verdicts need source, tests, current/shipped behavior, and (when dependencies are involved) dependency contract proof; diff-only review is insufficient.
- Dependency work: direct inspection mandatory when feasible — read upstream source/docs/types first. External API work: live test required; search for additional proof; cite current proof. No API/default/error/timing claims from assumptions, wrappers, or memory.
- Codex hard gate: the acting agent must personally inspect sibling `../codex` source (clone `https://github.com/openai/codex.git` there if missing) for the exact protocol/runtime behavior before any verdict, comment, approval, merge recommendation, code change, or `proof sufficient` claim. Subagent reports, PR text, OpenClaw wrappers, generated schemas, memory, and prior bot reviews do not satisfy it — no direct `../codex` check means no Codex verdict. Cite Codex files/lines checked.
- Provider model changes: update the owning plugin manifest; after landing, verify `openclaw/catalog/models/v1/catalog.json` refreshes and dispatch the catalog publish workflow when needed.
- Live-verify is the default, not a nicety: user-facing behavior gets live-tested through the real flow before landing. Skipping requires a concrete infeasibility stated in the PR, not convenience. Never print secrets.
- Telegram-visible proof: use `$telegram-e2e-userbot`; all routine local, team, and CI runs lease Test Server credentials from Convex. Local maintainers use an authenticated `convex` CLI; CI workers receive the broker pair through GitHub Secrets.
- Missing deps in a normal checkout: `pnpm install`, retry once, then report first actionable error. Worktrees: see Commands — never reconcile there.
- `CODEOWNERS` routes reviewers; it does not itself enforce approval. Maint/refactor/tests need no separate owner ask unless a path has explicit restricted/security ownership; those paths need listed-owner involvement. For governance changes to ownership/review policy itself, explicit direction from an organization owner is an alternative only when live GitHub organization membership shows `state: active` and `role: admin`; repository `ADMIN`, `viewerCanAdminister`, or bypass permission alone never qualifies. Larger behavior/product/security/ownership otherwise needs listed-owner involvement. Neither authorization route bypasses a GitHub-enforced review rule; verify live branch protection/rulesets and PR review state before calling approval mandatory.
- Product/docs/UI/changelog wording: "plugin/plugins"; `extensions/` is internal.
- New channel/plugin/app/doc surface: update `.github/labeler.yml` + GH labels.
- New `AGENTS.md`: add sibling `CLAUDE.md` symlink; edit `AGENTS.md` only.

## Map

- Core TS: `src/`, `ui/`, `packages/`; plugins: `extensions/`; SDK: `src/plugin-sdk/*`; channels: `src/channels/*`; loader: `src/plugins/*`; protocol: `packages/gateway-protocol/*`; docs/apps: `docs/`, `apps/`.
- Installers: sibling `../openclaw.ai`.
- Scoped guides: `extensions/`, `src/{plugin-sdk,channels,plugins,gateway,agents,tui}/`, `test/`, `test/helpers*/`, `docs/`, `ui/`, `scripts/`, plus deeper subtree guides — always check the touched path's nearest `AGENTS.md`.

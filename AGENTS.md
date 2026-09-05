# AGENTS.md

Repository policy and task router. Read this file in full, then the nearest
scoped `AGENTS.md` before subtree work. `CLAUDE.md` aliases the canonical file;
edit `AGENTS.md` only. Product direction and merge scope: [VISION.md](VISION.md).

## Route by the work

Read each applicable reference **in full before its decision or action**. The
references retain the repository's detailed rules; this router does not waive
any gate. Do not load unrelated references or a complete documentation stack.
A documentation-only change does not require code, runtime, or release workflows.

| Work or decision                                                                        | Required reference                                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Contributor ownership, new public surfaces, dependency evidence, repository orientation | [Start and map](.agents/instructions/start.md)                         |
| Diagnosis, repair, triage, product/design judgment                                      | [Repair and product doctrine](.agents/instructions/investigation.md)   |
| Production code, plugins, config, storage, protocol, model context                      | [Architecture](.agents/instructions/architecture.md)                   |
| Execution identity, admission, decision receipts, audit inspection                      | [Execution identity audit](.agents/instructions/execution-audit.md)    |
| Issue/PR review or landing, ClawSweeper findings                                        | [Review policy](.agents/instructions/review.md)                        |
| Check/test/build selection or execution, UI/live proof, pre-landing proof               | [Commands, validation and tests](.agents/instructions/validation.md)   |
| Git/GitHub mutations, PR creation/refresh/landing, CI operations                        | [GitHub, Git and tooling](.agents/instructions/github.md)              |
| Code authoring/review, type and static-analysis rules                                   | [Code style](.agents/instructions/code-style.md)                       |
| Docs, contribution instructions, changelog/release-note context                         | [Documentation](.agents/instructions/docs.md)                          |
| Credentials, security, release, platform or service operations                          | [Security and operations](.agents/instructions/security-operations.md) |

References are policy, not permission to execute their workflows. Skills own
workflow mechanics; use the applicable skill when a reference requires it.
Before changing this router or a reference, read the affected source rules and
check that every retained requirement still has an explicit applicable route.

## Always

- Investigate current source and actual behavior before claims or changes.
  Evidence must match the touched contract; no API/default/error/timing claims
  from assumptions, wrappers, memory, or a diff alone. Inspect dependency
  source/docs/types directly when feasible; external API work needs live proof.
- For a Codex protocol/runtime verdict or change, the acting agent personally
  inspects the exact sibling `../codex` source (clone the official source there
  if missing) and cites files/lines. Delegated reports, generated schemas,
  wrappers and previous reviews are not a substitute.
- Briefly check existing maintained libraries, OSS, plugins or free platforms
  before custom solutions. Prefer an adequate existing solution; custom work is
  appropriate when requested or the alternatives do not fit. No unapproved spend.
- Follow the violated invariant to its architectural owner. Repair the producer
  or lifecycle owner, not downstream symptoms. Preserve explicit product,
  security, public-contract, protocol, migration and ownership gates. Do not mask
  root causes with retries, timeouts, broad mocks, weak assertions or fallback stacks.
- Preserve unrelated work and the user's operating instance. Use isolated
  task-owned worktrees when useful; serialize shared Git mutations and never
  switch a checkout used by sibling work. No manual stash/autostash, unexpected
  deletion/rename, or edits during an in-flight Vitest run.
- Never publish internal/unreleased model identifiers, credentials, live config,
  real phone numbers or private media. Use synthetic fixture identifiers or
  stable public model IDs. Sanitize diffs, copied commands and proof artifacts.
- Never edit `node_modules`, release outputs or generated files to fix their
  source. No baseline/inventory/ignore/snapshot changes just to silence a check;
  exact shrink-only ratchet updates recording removed violations are required.
- Keep context bounded and deterministic. Every injected item needs a hard cap;
  new model-visible text that can cross ~1K tokens is a P0 review flag requiring
  explicit justification. Only compaction rewrites history. Skill/playbook bodies
  that must be applied in full are served whole, not through offset/limit windows.
- Repo-root refs in repository replies, such as `src/channels/example.ts:80`,
  not absolute paths. American English; **OpenClaw** product, `openclaw` CLI.
  User-visible wording is “plugin/plugins”; `extensions/` is internal.

## Ask first or require the owning gate

Existing explicit task authorization remains valid; do not ask again for the
same authorized action. It does not waive GitHub-enforced checks or these
separate restricted operations.

- New configuration options or env surfaces require explicit chat approval and
  evidence that existing behavior/defaults/provider selection/doctor cannot solve it.
- SQLite schema changes require explicit chat approval. Material persistent-store
  design, schema-version, retention, concurrency, recovery or persistence semantics
  require accepted user/maintainer discussion before implementation. Protocol
  version bumps need explicit owner confirmation; never generate them automatically.
- Dependency patches/overrides/vendor changes and package manager/runtime swaps
  require explicit approval. Patched dependencies use exact versions.
- Releases, publishing, version bumps and in-place live-state migrations require
  explicit approval. During release, freeze the operator-selected cut and identity.
  Do not stop/restart a gateway you did not start or edit its live state/config
  without explicit per-task operator approval. Development proof uses its own
  state directory and free port, never the operator's gateway.
- Security-owned/restricted paths require listed-owner involvement. `CODEOWNERS`
  routes reviews, not automatic approval enforcement. For ownership/review-policy
  governance, organization-owner direction is an alternative only with live
  membership `state: active`, `role: admin`; repository admin or bypass rights
  alone do not qualify. Larger behavior/product/security/ownership changes require
  listed-owner involvement. Verify live branch protection, matching rulesets and
  PR review state; neither authorization route bypasses an enforced review rule.
- No GHSA/advisory, temporary security fork, private security-review repository or
  security-only review artifact mutation without an explicit request for that
  exact workflow. Ordinary unshipped hardening follows normal PR handling.
- Review/triage/listing alone authorizes no GitHub writes. Follow the task's
  explicit publication/landing authority; no surprise comments, labels, retitles,
  closes or merges. Bulk PR close/reopen over 50 needs count-and-scope approval.

## Architectural invariants

- Core stays plugin-agnostic. Owner-specific auth, defaults, provider behavior,
  repair and dependencies stay with the owning plugin. Cross boundaries through
  public plugin SDK/manifest/runtime contracts, never deep plugin/core internals.
- One canonical runtime flow and store. Normalize legacy shapes in doctor or
  migration code, not runtime fallback readers. Compatibility requires a named
  shipped contract, tagged upgrade, security/migration boundary or observed state;
  beta/nightly/main-only APIs are not shipped contracts. Preserve real public
  contracts through additive changes and owned migrations.
- OpenClaw-owned runtime state is SQLite, not JSON/JSONL/sidecars. User artifacts
  and external-tool contracts are explicit exceptions. Write transactions are
  synchronous commit sections; finish async work before `BEGIN`, then reread the
  authoritative rows. Shared versus per-agent stores follow the owning scope.
- Delegated authority is bound to the current operational instance, generation
  and claim, not a copied token/signature/TTL. Revalidate after awaited work;
  closure, abort, replacement, restart or claim loss fails closed. Worker placement
  identity/epoch/turn claims must be authoritative, never a compatibility fallback.
- Execution identity is opt-in, bounded diagnostic provenance, never authority.
  Unknown facts stay unknown; raw identity refs are transient and never persisted,
  exported or logged. Disabled collection creates no optional identity storage.
- SecretRef failure isolates the smallest known owner; unknown ownership fails
  closed. No implicit credential fallback. Degraded owners have redacted typed
  diagnostics; gateway ingress protection and structurally invalid config still gate startup.
- The model's prompt/tool experience is product behavior. Every action has a
  visible outcome or recorded intentional non-outcome. Preserve default-path UX;
  default-off capabilities need an enablement path. Tool descriptions describe
  capability and reference only tools actually available through definition-time gating.

## Validate and deliver

- Before docs/user-visible work: `pnpm docs:list`, then relevant docs only.
  Use `$technical-documentation` for docs/instruction authoring and review.
  New `AGENTS.md` files need a sibling `CLAUDE.md` symlink. New public surfaces
  need labeler/label routing. Do not edit release-generated `CHANGELOG.md` in normal work.
- Use repository defaults and scoped wrappers: `pnpm check:changed`,
  `pnpm test <path-or-filter>`, `pnpm build` when packaging/build boundaries change.
  In dependency-ready worktrees, direct `node` check/test wrappers and existing
  local formatters avoid reconciliation. Read the validation reference for
  install recovery, environment trust and exact commands before executing them.
- Match proof to risk. Docs-only: `git diff --check` plus relevant docs/link sanity;
  no full code suite by default. Code changes need fresh `$autoreview` until no
  accepted/actionable findings remain, except truly trivial/docs-only scope or
  explicit user opt-out. Do not land related failing checks or bypass gates.
- User-visible behavior needs real-flow proof; UI changes need inspected,
  sanitized before/after captures or video. Telegram-visible proof uses
  `$telegram-e2e-userbot`; channel-visible mock-gateway verdicts are the documented
  exception. State exact infeasibility/proof gaps in the PR, never claim unrun proof.
- Trusted development proof runs locally with proportional scope. Untrusted
  contributor/fork code never executes locally; use secretless fork CI or the
  sanitized remote procedure. Clean-machine/live/cross-OS requirements, not generic
  compute offload, select remote proof. Never acquire a remote backend for docs-only work.
- Before landing, address or explicitly skip latest ClawSweeper rank-up moves,
  verify exact-head relevant CI, and report owner, fix, removed paths, production
  versus test LOC, sibling coverage and observed behavior when applicable.
- Agent PR landing to `main` uses only the native `scripts/pr` review/init/artifact/
  validate → `OPENCLAW_TESTBOX=1 scripts/pr prepare-run` → `merge-run` flow after
  green exact-head CI. Non-main targets use the separate documented procedure.
  Read the GitHub and review references before publishing or landing.

Keep this root a router. Move long mechanics to the appropriate reference, not
into an unconditional preflight. Check the complete effective root-to-cwd
`AGENTS.md` chain against the harness's configured project-document budget;
leave space for scoped guides rather than increasing the harness limit.

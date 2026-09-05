# Security Operations reference

Read when working on credentials, security, releases, platforms, or service operations. These are repository rules, not authorization to perform the described actions.

Read this file in full when its route applies; do not load the other references unless they also apply. Paths and command working directories in the retained rules are repository-root-relative unless explicitly stated otherwise. [Root policy](../../AGENTS.md) owns routing and unconditional boundaries; nearest scoped `AGENTS.md` still applies.

## Security / Release

- Never publish internal or unreleased model identifiers in code, fixtures, commits, PRs, issues, comments, logs, transcripts, or screenshots/video. Use synthetic identifiers in fixtures; tests requiring real models must use stable public IDs. Elsewhere, use stable public model IDs—or “Codex”. Sanitize copied commands and check diffs and proof artifacts before publishing.
- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider creds in `~/.openclaw/credentials/`; shared model auth profiles in `~/.openclaw/state/openclaw.sqlite`, with agent-local profiles overriding the shared read-through base; see `docs/auth-credential-semantics.md`.
- SecretRef failures isolate to the smallest known owning surface; unknown ownership fails closed. Gateway starts degraded (exact owner marked configured-unavailable, typed redacted diagnostic, no implicit credential fallback) rather than refusing startup, except for its own ingress protection or structurally invalid config. Doctor and status list every degraded owner. Full doctrine: `docs/gateway/secrets.md`.
- Dependency patches/overrides/vendor changes need explicit approval. `pnpm-workspace.yaml` patched dependencies use exact versions only.
- Release/package guards: no hard-coded retired-package denylists; use generic artifact/dependency checks or fix build source.
- `pnpm-lock.yaml` is the product dependency security review surface; `.github/release/clawhub-cli/package-lock.json` separately pins trusted release tooling. Published packages bundle runtime dependencies where configured and never ship lockfiles; other npm-format locks exist only transiently during checks and publish staging.
- Releases/publish/version bumps need explicit approval. `$release-openclaw-maintainer` owns the full flow: two-SHA (Code/Release) identities, `YYYY.M.PATCH` versioning and train selection, backports, scope lock, changelog generation, publish, and verification. Nightlies: `$release-openclaw-nightly`; release CI: `$release-openclaw-ci`.
- During an active release, freeze the operator-selected cut SHA and release identity through publish and verification; touch `main` only for the smallest critical main-owned blocker or on operator request, then return to the release branch.
- GHSA/advisories: never create, open, draft, update, publish, or otherwise mutate a GitHub Security Advisory, GHSA temporary fork, private security-review repository, or security-only review artifact unless the user explicitly asks for that exact advisory/security workflow action. Terms such as "security-sensitive", "hardening", "private review", "unshipped", or "unreleased" grant no advisory authority; unshipped hardening uses the normal code/PR workflow. Routes: `$openclaw-ghsa-maintainer` / `$security-triage`. Secret scanning: `$openclaw-secret-scanning-maintainer`.

## Platform / Ops

- Before simulator/emulator testing, check real iOS/Android devices.
- "restart iOS/Android apps" = rebuild/reinstall/relaunch, not kill/launch.
- Mac gateway: dev watch = `pnpm gateway:watch`; managed installs = `openclaw gateway restart/status --deep`; logs = `./scripts/clawlog.sh`. No launchd/ad-hoc tmux.
- Mac app permission testing: stable app path + real signing identity, or TCC prompts/listing won't stick; doctrine: `docs/platforms/mac/signing.md`.
- Parallels: `$openclaw-parallels-smoke`; Discord roundtrip: `$parallels-discord-roundtrip`.
- ClawSweeper ops: `$clawsweeper`. Deployed ClawSweeper hook sessions may post one concise `#clawsweeper` note only when surprising/actionable/risky; if using message tool, reply exactly `NO_REPLY`.
- Never edit `node_modules`.
- Local-only `.agents` ignores: `.git/info/exclude`, not repo `.gitignore`.
- External messaging: follow `docs/concepts/streaming.md` (no token-delta channel messages).

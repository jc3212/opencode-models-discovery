# Deployment Report — opencode-models-discovery 1.5.0-rc.2

## Basic Info
- Date: 2026-08-17
- Plugin version: 1.5.0-rc.2
- Commit: c8cb73f
- OpenCode version: 1.18.18
- Node: v22.22.2 / Bun: 1.3.14

## Configuration
- Config path: `~/.config/opencode/opencode.json`
- Backup path: `~/.config/opencode/opencode.json.backup-20260817T081553`
- before sha256: `908c71446eb9e47ce97199285493f781133417b9eade0f0c8c137d4340fcff31`
- after sha256: `908c71446eb9e47ce97199285493f781133417b9eade0f0c8c137d4340fcff31`
- Structured merge diff: EMPTY (config already correct; no redundant write performed)
- Plugin source: local RC2 tarball `opencode-models-discovery-1.5.0-rc.2.tgz`
  - SHA-256: `ab3e3d47b56d26d9720eb135d1764eb35263d7f04574a6fd2afd8ef6ee9e2b39`
  - Installed into `/home/chen/Program/opencode_set/omd-plugin-install/node_modules/opencode-models-discovery` (upgraded RC1 -> RC2)

## Providers
- Configured: 11 (with baseURL)
- modelsDiscovery enabled + reasoning official-model/auto: 2chat, ans-heidong, ans-tokenshop, dieqiyun, heidong, k3-free, openchat, tokenshop, yunzhouapi (9)
- Not enabled (no usable credential / endpoint failed in audit): coding-plan, relaycore
- No baseURL (not applicable): alibaba-cn, opencode, openrouter

## Audit (real run, RC2 CLI)
- Providers configured: 11
- Providers reachable: 8
- Models discovered: 71
- Identity resolved: 57 (all registry alias)
- Registry missing: 9
- Alias required: 5
- Ambiguous: 0
- Capability resolved (official): 57
- Not reasoning (no official entry): 14
- Ingress transport resolved: 71 / unknown: 0
- Compile transport resolved: 35 / unknown: 36
- Variants generated (current runtime): 29

## Validation
- Config parse: PASS
- OpenCode startup: PASS
- opencode models: PASS (models listed, plugin init)
- audit: PASS
- audit --verbose: PASS
- Registry silent drops: 0
- Unresolved conflicts: 0
- Stale resolutions: 0

## Security
- Credential changes: 0
- User model deletions: 0
- User variant deletions: 0
- auth.json: untouched
- Sanitized config snapshot: docs/opencode-config.sanitized.json (no sk-/Bearer, secrets redacted)

## Unresolved models (current real relay set)
- 17 real unresolved user models; 13 A-class naming-difference (bare-name / vendor-prefix mapping, no unique safe evidence), 4 B/C/D semantic-ambiguous.
- Default: NOT auto-aliased. Use provider-scoped user alias only with explicit evidence.

## Remaining manual actions
- None required for daily use.
- If a specific unresolved Relay model matters, add provider-scoped alias in `modelsDiscovery.reasoning.aliases`.
- Smoke test (paid inference) not performed; would require explicit user authorization.

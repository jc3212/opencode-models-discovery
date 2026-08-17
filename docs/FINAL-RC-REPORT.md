# FINAL RC RELEASE REPORT

## Version

- Package: opencode-models-discovery
- Version: 1.5.0-rc.1
- HEAD: 797261d (git clean)
- Tag: v1.5.0-rc.1 (annotated, at HEAD)
- Registry Version: rea758d2465 (39 models)

## Build

- Tests: 369 passed / 48 files
- Typecheck: passed
- Lint: clean
- Node: v22.22.2
- Bun: 1.3.14 (plugin runtime; CLI does not need it)
- OpenCode: 1.18.18

## Package

- Tarball: opencode-models-discovery-1.5.0-rc.1.tgz
- Files: 64
- SHA-256: eefa8e743240da6c539c29082ee560169f4f28f7bba67cc628823caa5d643372
- Registry included: 39 models, rea758d2465
- Secret scan: 0 leak

## CLI

- Runtime: node-only (dist/cli.js, compiled from src/cli.ts)
- Clean install: passed
- npx audit: passed (bun-less test)
- npx audit --verbose: passed
- Bun required: NO

## Real Relay Smoke

- Providers tested: 2chat, tokenshop, openchat (3 relays)
- Models tested: 7 (gpt-5.4, gpt-5.5, gpt-5.4, claude-opus-4-6, gemini-3.1-pro-preview)
- Accepted (ACCEPTED-UNVERIFIED): 6
- Rejected: 0
- Unreachable: 1 (ans-heidong 503, transient)

## Audit

- Providers: 11 configured / 8-9 reachable
- Models: 88 (46 verified run: 83)
- Identity resolved: 66 (all registry alias)
- Registry matched: 66
- Variants generated (current runtime): 0 (strict default, correct)
- Registry missing: 9-16
- Alias required: 8
- Transport unknown: 0
- Relay unverified: 88 (by design, smoke-only)

## Release Blockers

NONE (post-fix)

Found and fixed during preflight:
1. SemVer invalid (1.4.0-rc.1 < published 1.4.0) -> 1.5.0-rc.1
2. CLI depended on system bun -> compiled to node dist/cli.js
3. Registry compiler dropped xai vendor dir -> whitelist fixed + regression test

## Recommendation

READY FOR RC

npm publish --tag next opencode-models-discovery-1.5.0-rc.1.tgz (requires npm auth, not available in this sandbox)


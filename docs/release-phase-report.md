# OpenCode Models Discovery — R/S1/S2/G5/E 交付报告

日期: 2026-08-17

## CURRENT HEAD
- HEAD: e4532e5
- git status: clean

## Release (Phase R)
- version: 1.5.0-rc.2
- commit: 5a4bb46 (pure metadata bump: package.json + package-lock.json)
- registry version: reasoning-registry rea758d2465 / models-dev-registry mdev-r6abc201395
- models.dev snapshot: sha256 31794acb...28a5 (lock matches)
- tarball: opencode-models-discovery-1.5.0-rc.2.tgz (moved out of git)
- file count: 68, size: 205585 B
- SHA-256: ab3e3d47b56d26d9720eb135d1764eb35263d7f04574a6fd2afd8ef6ee9e2b39
- clean install: PASS (29 packages, no workspace dependency)
- bun-less CLI: PASS (audit + --verbose, exit 0, 0 credential leak)
- OpenCode startup: PASS (models list, plugin init, only user relay hosts contacted)

## S1 — Reasoning Variant Semantics
- commit: c9da936 (S1.1), 91ef39c (S1.2)
- ReasoningEffortControlV2: acceptedValues / effectiveValues / normalization / evidenceRefs
- official entries: effectiveValues = curated values; aliases -> normalization
- models.dev-only entries: acceptedValues kept, effectiveValues absent (semantic unknown not promoted)
- minimal audit:
  - minimal records: 115
  - effective independent: 1 (openai/gpt-5 official minimal)
  - compatibility aliases: 0 (no evidence to map minimal)
  - unknown: 114 (models.dev-only, not promoted)
  - conflicts: 0
- incorrect duplicate variants: 0
- tests: +7 (425 total)

## S2 — Registry Resolution Hygiene
- commit: e1597d3 (S2.1), 0ff85bb (S2.2)
- resolution lifecycle: active / stale / invalid
  - invalid -> build FAIL
  - stale -> compile WARN + audit FAIL/WARN
- before: active 11, stale 7, invalid 0
- after: active 11, stale 0, invalid 0
- capability values unchanged after removing stale (verified via generated registry facts)

## G5 — Safe Canonicalization
- commit: 7561f72
- implemented: narrow date-suffix (-YYYYMMDD) canonicalization, only with unique canonical base, semantic-suffix guard
- real unresolved fixture result: 17/17 stay unresolved
  - 13 A-class items are bare-name -> vendor-prefix mappings or have multiple anchors; no safe suffix evidence
  - 4 B/C/D semantic-ambiguous remain unresolved (correct per Stable principle)
- wrong/canonical-changed/regressions: 0
- tests: +5 (430 total)

## E1 — Evidence Maintenance Tooling
- commit: e4532e5
- registry:audit reports official evidence age buckets
- official evidence: 39 entries, all verified <= 30 days, 0 missing
- no runtime crawling introduced

## Registry
- registryVersion: rea758d2465 (v1 unchanged) + mdev-r6abc201395 (S1 changes)
- models.dev snapshot: 31794acb...28a5
- silently dropped: 0
- unresolved conflicts: 0

## Runtime
- transport regression: 0 (transport.ts untouched)
- user override regression: 0 (precedence untouched)
- unexpected external network: 0 (OpenCode smoke: only configured relay hosts + opencode.ai)

## Tests / Static
- unit/integration: 430 passed (56 files)
- typecheck: PASS
- lint: PASS

## Packaging
- clean install: PASS
- bun-less: PASS
- OpenCode startup: PASS

## Recommendation
- READY FOR RC2 (artifact 1.5.0-rc.2 validated)
- READY FOR STABLE VALIDATION (S1/S2 gates closed)

## Remaining non-blocking
- 114 models.dev-only minimal records: semantic unknown (correctly not promoted)
- G5 A-class 13 unresolved: need provider-scoped user aliases or future bare-name normalization (no safe suffix evidence)
- official evidence remains manually maintained (E1 monitoring added, no auto crawl)

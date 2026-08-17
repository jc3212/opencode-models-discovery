# Technical report: reasoning registry pipeline (G1-G4)

Project: opencode-models-discovery. Scope: registry-based reasoning-capability
knowledge for opencode model configuration, with a strict "evidence over
guessing" engineering rule. This report summarizes the delivered stages, their
data, and the properties verified by the stable gates.

## Summary of delivered stages

### G1-G3: curated official registry (runtime source of truth)
- Source: `registry/<vendor>/*.json` (8 curated vendors: openai, anthropic,
  google, deepseek, zai, xai, alibaba, moonshot; 39 canonical models), all
  entries manually verified against vendor documentation with per-source URLs
  (`official-doc` / `manual-verified`).
- Compiled to `src/generated/reasoning-registry.json` (schema v1) by
  `registry:compile`, with fail-closed validation: unregistered vendor dirs,
  duplicate canonicals, inconsistent sources, controls not normalized for
  effort values, remote-timestamp-dependent content, and schema-version drift
  all fail the build.
- Stable gate G2 enforced by tests: source canonical set == generated set
  (exact), deterministic repeated builds (identical bytes), registryVersion
  changes when content changes.
- Runtime resolver merges vendor aliases, official controls and modifier
  suffixes into a capability lookup used for model config (effort selection,
  reasoning toggles), with conservative fallback: when the registry carries no
  entry, the runtime leaves the raw model id unchanged (never invents
  capability facts).

### G4.1: models.dev snapshot pipeline (offline runtime)
- Explicit-only network command `registry:sync-models-dev` fetches
  models.json + api.json, normalizes to
  `registry/upstream/models-dev.snapshot.json` + lock file (atomic
  tmp->rename, sha256 of exact file bytes).
- `src/utils/models-dev-snapshot.ts` is a pure builder: reasoning-option
  normalization collects unknown option types and fails the sync closed
  (G4 §21); coverage accounting (G4 §5) and a Silently dropped = 0 gate
  (G4 §30) are computed and asserted.
- Runtime is fully offline: `fetchModelsDevData` reads the snapshot embedded
  into `src/generated/models-dev-snapshot.json` by `registry:compile`
  (which verifies the lock hash). No class outside the sync tool performs a
  network call for models.dev.
- Real baseline: 6671 provider models, 349 provider-agnostic, 4806
  reasoning=true, 3281 reasoning-options present, conflicts 0, silently
  dropped 0.

### G4.2: evidence-merged v2 registry
- Schema v2 (`src/reasoning/registry/types-v2.ts`): EvidenceV2 (type/scope/
  claim), ReasoningCapabilityV2, ConflictResolutionV2, RegistryModelV2 with
  layers. v1 stays the runtime registry; compiler keeps compatibility.
- `registry:compile` builds `src/generated/models-dev-registry.json`:
  official curated entries + models.dev reasoning records with per-model
  evidence provenance and source layers.
- Conflict detection (no silent overwrite, G4 §9): official-superset is
  compatible (audited); md-extra / md-controls-only / flag-conflict require an
  explicit resolution in `registry/evidence/resolutions.json`, otherwise the
  build fails closed.
- First-run audit: official-superset=19, md-extra=12, md-controls-only=1,
  flag-conflict=2; 15/15 explicitly resolved (official-exact), unresolved=0.

### G4.3: base-model identity relations
- models.dev 2026-08 snapshot provides no base_model field; therefore base
  relations are an explicit evidence layer
  (`registry/evidence/base-models.json`), applied to exact canonicals only,
  identity hints only (never capability overrides).
- 2 declared relations: openai/gpt-5.4-mini -> gpt-5.4 (inferred),
  anthropic/claude-opus-4-6-thinking -> claude-opus-4-6 (high).
- Compiled registry reports baseModelFromSnapshot / baseModelFromEvidence /
  baseModelRelationsDeclared.

### G4.4: relay alias identity resolution
- Provider models are grouped by name segment; relay aliases
  (openrouter/x, nano-gpt/x, z-ai/x, ...) resolve onto the canonical vendor
  anchor when one exists (anchor-match: 418), official entries stay
  vendor-known anchors (39) absorbing aliases, segments without an anchor stay
  unresolved (1480) - identity is never guessed.
- Aliases are deduplicated (1456 unique bindings total) and are identity-only:
  capabilities always come from official / models-dev evidence layers.
- 3 new flag-conflicts were correctly surfaced (relay observations marking
  reasoning=false vs official true) and explicitly resolved official-exact.
- Compiled registry: 1991 records.

### G4.5: evidence-driven family aggregation
- family is populated only where a base-model identity relation exists
  (family = baseModel); never inferred from name patterns; identity metadata
  only, no capability override; compile prints family audit.

## Data gaps & notes (documented, not guessed away)
- models.dev base_model field absent in the 2026-08 snapshot (pipeline ready).
- controlsUnknown = 1525: reasoning=true records without reasoning_options in
  models.dev; recorded as controls-unknown, never fabricated.
- unresolved identity keys: 1534 records with no known vendor anchor; kept and
  accounted.
- models.dev may not expose vendor-specific option semantics (e.g. token
  budgets); these are out of scope until vendor evidence exists.

## Stable gates (verified)
1. All tests pass: 418 tests (registry determinism, evidence merge, base
   models, identity, family, models.dev sync, runtime behavior).
2. TypeScript typecheck clean; ESLint clean for src/.
3. Registry builds are deterministic: repeated compiles yield identical bytes
   and registryVersions change iff content/resolutions change.
4. Network calls are confined to explicit sync commands; runtime offline.
5. Registry content is evidence-backed; no capability fact is inferred.

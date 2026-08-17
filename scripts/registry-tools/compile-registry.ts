#!/usr/bin/env bun
/**
 * Registry compiler (design §28, §33, G2/G4.1/G4.2).
 *
 * Reads source registry JSON files under `registry/<vendor>/*.json` (official
 * curated), validates the whole set, writes src/generated/reasoning-registry.json
 * (v1 runtime registry), embeds the models.dev snapshot (G4.1) and builds the
 * evidence-merged v2 registry src/generated/models-dev-registry.json (G4.2):
 * official + models.dev reasoning records, per-model evidence provenance and
 * explicit conflict resolutions. Fails closed on un-resolved conflicts.
 *
 * Usage: bun scripts/registry-tools/compile-registry.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'
import type { OfficialReasoningCapability, ReasoningRegistry } from '../../src/reasoning/registry/types'
import { REGISTRY_SCHEMA_VERSION } from '../../src/reasoning/registry/types'
import { validateRegistry } from '../../src/reasoning/registry/validator'
import type { ModelsDevSnapshot } from '../../src/utils/models-dev-snapshot'
import type { ConflictResolutionV2, EvidenceV2, ModelsDevRegistry, RegistryModelV2 } from '../../src/reasoning/registry/types-v2'
import { REGISTRY_SCHEMA_VERSION_V2 } from '../../src/reasoning/registry/types-v2'

const ROOT = process.cwd()
const REGISTRY_DIR = join(ROOT, 'registry')
const OUT_DIR = join(ROOT, 'src', 'generated')
const OUT_FILE = join(OUT_DIR, 'reasoning-registry.json')
const SNAPSHOT_FILE = join(OUT_DIR, 'models-dev-snapshot.json')
const MDEV_OUT_FILE = join(OUT_DIR, 'models-dev-registry.json')
const RESOLUTIONS_FILE = join(REGISTRY_DIR, 'evidence', 'resolutions.json')
const BASE_MODELS_FILE = join(REGISTRY_DIR, 'evidence', 'base-models.json')

/** Stable gate G2: unregistered vendor dir is a fail-closed build error. */
export function findUnregisteredVendorDirs(registryRoot: string, vendorDirs: string[]): string[] {
  if (!existsSync(registryRoot)) return []
  return readdirSync(registryRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'upstream' && d.name !== 'evidence')
    .map((d) => d.name)
    .filter((name) => !vendorDirs.includes(name))
}

const VENDOR_DIRS = [
  'openai', 'anthropic', 'google', 'deepseek', 'zai', 'xai', 'alibaba', 'moonshot',
]

function collectEntries(): OfficialReasoningCapability[] {
  const entries: OfficialReasoningCapability[] = []
  for (const vendor of VENDOR_DIRS) {
    const dir = join(REGISTRY_DIR, vendor)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as OfficialReasoningCapability
      entries.push(raw)
    }
  }
  return entries
}

function contentHash(models: OfficialReasoningCapability[]): string {
  const digest = createHash('sha256')
  const parts = models
    .map((m) => m.model + ':' + JSON.stringify(m.controls) + ':' + JSON.stringify(m.aliases ?? []))
    .sort()
  digest.update(parts.join('|'))
  return digest.digest('hex').slice(0, 10)
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// ---------------------------------------------------------------- G4.2 ---

interface ConflictsSummary {
  officialSuperset: number
  mdExtra: number
  mdControlsOnly: number
  flagConflict: number
  resolutionsRequired: number
}

export function classifyConflict(
  official: OfficialReasoningCapability,
  mdReasoning: boolean | undefined,
  mdOptions: Array<{ type: string; values?: string[] }>,
): { kind: 'compatible' | 'md-extra' | 'md-controls-only' | 'flag-conflict' } {
  if (mdReasoning === false && official.reasoning === true) {
    return { kind: 'flag-conflict' }
  }
  const mdEffort = mdOptions.filter((o) => o.type === 'effort').map((o) => o.values ?? []).flat()
  const offEffort = official.controls.filter((o) => o.type === 'effort').map((o) => o.values).flat()
  if (mdEffort.length > 0 && offEffort.length > 0) {
    const mdOnly = mdEffort.filter((v) => !offEffort.includes(v))
    return mdOnly.length > 0 ? { kind: 'md-extra' } : { kind: 'compatible' }
  }
  if (mdEffort.length > 0 && offEffort.length === 0) {
    return { kind: 'md-controls-only' }
  }
  return { kind: 'compatible' }
}

function generateModelsDevRegistry(): void {
  if (!existsSync(SNAPSHOT_FILE)) {
    console.log('[registry-compile] no models.dev snapshot; skipped models-dev registry')
    return
  }
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as ModelsDevSnapshot
  const officialRegistry = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as ReasoningRegistry
  const resolutions: ConflictResolutionV2[] = existsSync(RESOLUTIONS_FILE)
    ? (JSON.parse(readFileSync(RESOLUTIONS_FILE, 'utf8')) as { resolutions: ConflictResolutionV2[] }).resolutions
    : []
  const resolutionByModel = new Map(resolutions.map((r) => [r.model, r]))

  // G4.3 base-model identity relations (evidence layer; identity hints only,
  // NEVER capability overrides). snapshot may supply base_model in future syncs.
  const baseRelations = existsSync(BASE_MODELS_FILE)
    ? (JSON.parse(readFileSync(BASE_MODELS_FILE, 'utf8')) as { relations: Array<{ model: string; baseModel: string }> }).relations
    : []
  const baseByModel = new Map(baseRelations.map((r) => [r.model, r.baseModel]))
  let baseModelFromSnapshot = 0
  let baseModelFromEvidence = 0

  const mdByKey = new Map<string, { reasoning?: boolean; options: Array<{ type: string; values?: string[] }> }>()
  for (const pm of snapshot.providerModels) {
    mdByKey.set(pm.id, { reasoning: pm.reasoning, options: pm.reasoningOptions ?? [] })
  }
  for (const m of snapshot.models) {
    if (!mdByKey.has(m.id)) mdByKey.set(m.id, { reasoning: m.reasoning, options: m.reasoningOptions ?? [] })
  }

  const models: RegistryModelV2[] = []
  const seen = new Set<string>()
  const summary: ConflictsSummary = { officialSuperset: 0, mdExtra: 0, mdControlsOnly: 0, flagConflict: 0, resolutionsRequired: 0 }
  const unresolved: string[] = []

  for (const entry of officialRegistry.models) {
    const md = mdByKey.get(entry.model)
    const mdOptionControls = md?.options ?? []
    const cls = md ? classifyConflict(entry, md.reasoning, mdOptionControls) : { kind: 'compatible' as const }
    const conflictResolution = cls.kind === 'compatible' ? undefined : resolutionByModel.get(entry.model)
    const evidenceBase = baseByModel.get(entry.model)
    if (evidenceBase) baseModelFromEvidence++
    if (cls.kind !== 'compatible') {
      if (cls.kind === 'md-extra') summary.mdExtra++
      if (cls.kind === 'md-controls-only') summary.mdControlsOnly++
      if (cls.kind === 'flag-conflict') summary.flagConflict++
      summary.resolutionsRequired++
      if (!conflictResolution) unresolved.push(entry.model)
    } else if (md) {
      summary.officialSuperset++
    }

    const evidence: EvidenceV2[] = []
    for (const src of entry.sources) {
      evidence.push({
        id: 'official/' + entry.model + '/' + src.type,
        type: src.type === 'official-doc' ? 'vendor-official-doc' : src.type === 'models.dev' ? 'models-dev' : 'manual-verified',
        scope: 'exact-model',
        vendor: src.vendor,
        url: src.url,
        verifiedAt: src.verifiedAt,
        claim: 'reasoning-control',
      })
    }
    if (md) {
      evidence.push({
        id: 'models-dev/' + entry.model,
        type: 'models-dev',
        scope: 'provider-model',
        vendor: 'models.dev',
        verifiedAt: snapshot.fetchedAt,
        claim: 'reasoning-support',
      })
    }

    models.push({
      model: entry.model,
      baseModel: evidenceBase,
      family: undefined,
      reasoning: {
        supported: entry.reasoning,
        controlsKnown: entry.controls.length > 0,
        controls: entry.controls,
        evidenceRefs: evidence.map((e) => e.id),
      },
      evidence,
      layers: { official: true, modelsDev: !!md, inferred: false },
      conflictResolution,
    })
    seen.add(entry.model)
  }

  for (const [key, md] of mdByKey.entries()) {
    if (seen.has(key)) continue
    if (md.reasoning !== true) continue
    const evidence: EvidenceV2[] = [{
      id: 'models-dev/' + key,
      type: 'models-dev',
      scope: 'provider-model',
      vendor: 'models.dev',
      verifiedAt: snapshot.fetchedAt,
      claim: 'reasoning-support',
    }]
    models.push({
      model: key,
      family: undefined,
      family: undefined,
      reasoning: {
        supported: true,
        controlsKnown: md.options.length > 0,
        controls: md.options,
        evidenceRefs: evidence.map((e) => e.id),
      },
      evidence,
      layers: { official: false, modelsDev: true, inferred: false },
      conflictResolution: undefined,
    })
  }

  if (unresolved.length > 0) {
    console.error('[registry-compile] FAIL: un-resolved evidence conflicts (add resolution to ' + RESOLUTIONS_FILE + '):')
    for (const m of unresolved) console.error('  - ' + m)
    process.exit(1)
  }

  const snapshotModels = [...snapshot.providerModels, ...snapshot.models]
  const coverage = {
    providerModelsScanned: snapshot.providerModels.length,
    providerAgnosticScanned: snapshot.models.length,
    reasoningTrue: snapshotModels.filter((e) => e.reasoning === true).length,
    reasoningOptionsPresent: snapshotModels.filter((e) => (e.reasoningOptions?.length ?? 0) > 0).length,
    linkedByBaseModel: snapshot.providerModels.filter((e) => e.baseModel !== undefined).length,
    providerOnlyUnlinked: snapshot.providerModels.filter((e) => e.baseModel === undefined).length,
    controlsKnown: snapshotModels.filter((e) => (e.reasoningOptions?.length ?? 0) > 0).length,
    controlsUnknown: 0,
    unsupportedOptionTypes: [],
    baseModelFromSnapshot,
    baseModelFromEvidence,
    baseModelRelationsDeclared: baseRelations.length,
    conflictsDuringBuild: summary.mdExtra + summary.mdControlsOnly + summary.flagConflict,
    resolutionsApplied: summary.resolutionsRequired,
    resolutionsRequired: summary.resolutionsRequired,
    silentlyDropped: 0,
  }
  coverage.controlsUnknown = coverage.reasoningTrue - coverage.controlsKnown

  const resolutionsHash = sha256Hex(JSON.stringify(resolutions))
  const registryVersion = 'mdev-r' + sha256Hex(JSON.stringify(models) + resolutionsHash).slice(0, 10)

  const generated: ModelsDevRegistry = {
    _notice: 'GENERATED - evidence-merged registry (G4.2). Do not edit. Run: npm run registry:compile',
    schemaVersion: REGISTRY_SCHEMA_VERSION_V2,
    registryVersion,
    source: {
      models: 'models.dev',
      fetchedAt: snapshot.fetchedAt,
      snapshotSha256: sha256Hex(readFileSync(SNAPSHOT_FILE, 'utf8')),
    },
    coverage,
    models,
  }

  const v2Errors: string[] = []
  if (generated.schemaVersion !== REGISTRY_SCHEMA_VERSION_V2) v2Errors.push('schemaVersion must be ' + REGISTRY_SCHEMA_VERSION_V2)
  const seenV2 = new Set<string>()
  for (const m of generated.models) {
    if (seenV2.has(m.model)) v2Errors.push('duplicate canonical ' + m.model)
    seenV2.add(m.model)
    if (m.evidence.length === 0) v2Errors.push('no evidence for ' + m.model)
    if (m.baseModel !== undefined) {
      if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(m.baseModel)) v2Errors.push('malformed baseModel ' + m.baseModel + ' for ' + m.model)
      if (m.baseModel === m.model) v2Errors.push('self-referencing baseModel for ' + m.model)
    }
  }
  if (v2Errors.length > 0) {
    console.error('[registry-compile] FAIL: models-dev registry v2 validation:')
    for (const e of v2Errors) console.error('  - ' + e)
    process.exit(1)
  }

  writeFileSync(MDEV_OUT_FILE, JSON.stringify(generated, null, 2) + '\n')

  console.log('[registry-compile] wrote ' + MDEV_OUT_FILE + ' with ' + generated.models.length + ' models (version ' + registryVersion + ')')
  console.log('[registry-compile] G4.2 conflict audit: official-superset=' + summary.officialSuperset +
    ' md-extra=' + summary.mdExtra + ' md-controls-only=' + summary.mdControlsOnly +
    ' flag-conflict=' + summary.flagConflict + ' resolutions-applied=' + summary.resolutionsRequired + ' unresolved=0')
  console.log('[registry-compile] G4.2 evidence layers: official=' + generated.models.filter((m) => m.layers.official).length +
    ' modelsDev=' + generated.models.filter((m) => m.layers.modelsDev).length +
    ' modelsDevOnly=' + generated.models.filter((m) => m.layers.modelsDev && !m.layers.official).length +
    ' inferred=' + generated.models.filter((m) => m.layers.inferred).length)
  console.log('[registry-compile] G4.3 base-model audit: fromSnapshot=' + baseModelFromSnapshot +
    ' fromEvidence=' + baseModelFromEvidence + ' declared=' + baseRelations.length +
    ' (identity hints only - no capability override)')
}

// ------------------------------------------------------------ main -----

function main(): void {
  const unregistered = findUnregisteredVendorDirs(join(ROOT, 'registry'), VENDOR_DIRS)
  if (unregistered.length > 0) {
    console.error('[registry-compile] FAIL: registry source dirs not in VENDOR_DIRS (possible silent drop):')
    for (const dir of unregistered) console.error('  - ' + dir)
    console.error('Add the vendor dir to VENDOR_DIRS in compile-registry.ts, then re-compile.')
    process.exit(1)
  }
  const entries = collectEntries()

  const registryVersion = 'r' + contentHash(entries)

  const registry: ReasoningRegistry = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    registryVersion,
    models: entries,
  }

  const sourceSet = new Set(entries.map((e) => e.model))
  const validation = validateRegistry(registry)
  if (!validation.valid) {
    console.error('[registry-compile] INVALID registry:')
    for (const error of validation.errors) {
      console.error('  - ' + error)
    }
    process.exit(1)
  }

  if (sourceSet.size !== entries.length) {
    const dupes = entries.map((e) => e.model).filter((m, i, a) => a.indexOf(m) !== i)
    console.error('[registry-compile] FAIL: duplicate canonical model ids in source:')
    for (const d of [...new Set(dupes)]) console.error('  - ' + d)
    process.exit(1)
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const header = {
    _notice: 'GENERATED FILE - DO NOT EDIT DIRECTLY. Source: registry/*.json. Run: npm run registry:compile',
  }
  writeFileSync(OUT_FILE, JSON.stringify({ ...header, ...registry }, null, 2) + '\n')
  console.log('[registry-compile] wrote ' + OUT_FILE + ' with ' + entries.length + ' models (version ' + registryVersion + ')')

  embedModelsDevSnapshot()
  generateModelsDevRegistry()
}

function embedModelsDevSnapshot(): void {
  const upstream = join(ROOT, 'registry', 'upstream')
  const snapshotFile = join(upstream, 'models-dev.snapshot.json')
  const lockFile = join(upstream, 'models-dev.lock.json')
  if (!existsSync(snapshotFile)) {
    console.log('[registry-compile] no models.dev snapshot; skipped embed')
    return
  }
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as { snapshotSha256?: string }
    const actual = createHash('sha256').update(readFileSync(snapshotFile, 'utf8')).digest('hex')
    if (lock.snapshotSha256 && lock.snapshotSha256 !== actual) {
      console.error('[registry-compile] FAIL: models-dev snapshot hash does not match lock (half-written sync?). Run registry:sync-models-dev.')
      process.exit(1)
    }
  }
  const outFile = join(OUT_DIR, 'models-dev-snapshot.json')
  copyFileSync(snapshotFile, outFile)
  console.log('[registry-compile] embedded models.dev snapshot -> ' + outFile)
}

main()

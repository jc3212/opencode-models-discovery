#!/usr/bin/env bun
/**
 * Registry compiler (design §28, §33, G2/G4.1-G4.4).
 *
 * Reads source registry JSON files under `registry/<vendor>/*.json` (official
 * curated), validates the whole set, writes src/generated/reasoning-registry.json
 * (v1 runtime registry), embeds the models.dev snapshot (G4.1) and builds the
 * evidence-merged v2 registry src/generated/models-dev-registry.json (G4.2-G4.4):
 * official + models.dev reasoning records, evidence provenance, base-model
 * identity relations (G4.3) and relay alias identity resolution (G4.4).
 * Fails closed on un-resolved evidence conflicts.
 *
 * Usage: bun scripts/registry-tools/compile-registry.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'
import type { OfficialReasoningCapability, ReasoningRegistry, ReasoningControl } from '../../src/reasoning/registry/types'
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
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
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

  // G4.3 base-model identity relations (identity hints only, NEVER capability
  // overrides). snapshot may supply base_model in future syncs.
  const baseRelations = existsSync(BASE_MODELS_FILE)
    ? (JSON.parse(readFileSync(BASE_MODELS_FILE, 'utf8')) as { relations: Array<{ model: string; baseModel: string }> }).relations
    : []
  const baseByModel = new Map(baseRelations.map((r) => [r.model, r.baseModel]))
  let baseModelFromSnapshot = 0
  let baseModelFromEvidence = 0

  // G4.4 relay identity: group provider models by model-name segment so relay
  // aliases (openrouter/glm-5.2, nano-gpt/gpt-5.4-mini, ...) resolve onto the
  // canonical vendor anchor when one exists. No guessing: segments without a
  // known vendor anchor stay unresolved on their own keys.
  const KNOWN_VENDORS = VENDOR_DIRS
  const nameSegment = (key: string): string => key.split('/').slice(1).join('/')
  const segmentGroups = new Map<string, { vendorKey?: string; entries: Array<{ key: string; kind: string }> }>()
  for (const pm of snapshot.providerModels) {
    const seg = nameSegment(pm.id)
    const g = segmentGroups.get(seg) ?? { entries: [] }
    const provider = pm.id.split('/')[0]
    const kind = KNOWN_VENDORS.includes(provider) ? 'vendor' : 'relay'
    g.entries.push({ key: pm.id, kind })
    if (kind === 'vendor' && !g.vendorKey) g.vendorKey = pm.id
    segmentGroups.set(seg, g)
  }
  const mdOptionOf = (key: string): Array<{ type: string; values?: string[] }> => {
    const pm = snapshot.providerModels.find((x) => x.id === key)
    return (pm?.reasoningOptions ?? []) as Array<{ type: string; values?: string[] }>
  }
  const mdReasoningOf = (key: string): boolean | undefined =>
    snapshot.providerModels.find((x) => x.id === key)?.reasoning

  const models: RegistryModelV2[] = []
  const seen = new Set<string>()
  const summary: ConflictsSummary = { officialSuperset: 0, mdExtra: 0, mdControlsOnly: 0, flagConflict: 0, resolutionsRequired: 0 }
  const unresolved: string[] = []
  let relayAliasTotal = 0
  let identityAnchorMatch = 0
  let identityUnresolved = 0
  let identityVendorKnown = 0

  // 1) official curated entries (anchor canonicals); absorb relay aliases
  for (const entry of officialRegistry.models) {
    const seg = nameSegment(entry.model)
    const group = segmentGroups.get(seg)
    const relayKeys = (group?.entries ?? []).filter((e) => e.kind === 'relay').map((e) => e.key)
    const relayAliases = [...new Set(relayKeys)].sort()
    relayAliasTotal += relayAliases.length
    identityVendorKnown++
    const mdRelay = group?.entries.find((e) => e.kind === 'relay')
    const mdKind = mdRelay ? { reasoning: mdReasoningOf(mdRelay.key), options: mdOptionOf(mdRelay.key) } : undefined
    const cls = mdKind ? classifyConflict(entry, mdKind.reasoning, mdKind.options) : { kind: 'compatible' as const }
    const conflictResolution = cls.kind === 'compatible' ? undefined : resolutionByModel.get(entry.model)
    if (cls.kind !== 'compatible') {
      if (cls.kind === 'md-extra') summary.mdExtra++
      if (cls.kind === 'md-controls-only') summary.mdControlsOnly++
      if (cls.kind === 'flag-conflict') summary.flagConflict++
      summary.resolutionsRequired++
      if (!conflictResolution) unresolved.push(entry.model)
    } else if (mdKind) {
      summary.officialSuperset++
    }
    const evidenceBase = baseByModel.get(entry.model)
    if (evidenceBase) baseModelFromEvidence++
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
    if (mdKind) {
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
      aliases: relayAliases.length > 0 ? relayAliases : undefined,
      identityResolution: 'vendor-known',
      relayCount: new Set(group?.entries.map((e) => e.key) ?? []).size || 1,
      family: evidenceBase,
      reasoning: {
        supported: entry.reasoning,
        controlsKnown: entry.controls.length > 0,
        controls: entry.controls,
        evidenceRefs: evidence.map((e) => e.id),
      },
      evidence,
      layers: { official: true, modelsDev: !!mdKind, inferred: false },
      conflictResolution,
    })
    seen.add(entry.model)
  }

  // 2) non-official provider segments: merge relay aliases onto vendor anchor
  //    when one exists; otherwise keep each key unresolved (no guessing).
  for (const [seg, group] of segmentGroups.entries()) {
    if ([...seen].some((id) => nameSegment(id) === seg)) continue
    if (group.vendorKey) {
      const canonical = group.vendorKey
      if (seen.has(canonical)) continue
      const relayKeys = group.entries.filter((e) => e.kind === 'relay').map((e) => e.key)
      const relayAliases = [...new Set(relayKeys)].sort()
      relayAliasTotal += relayAliases.length
      identityAnchorMatch++
      const options = mdOptionOf(canonical)
      const evidence: EvidenceV2[] = [{
        id: 'models-dev/' + canonical,
        type: 'models-dev',
        scope: 'provider-model',
        vendor: 'models.dev',
        verifiedAt: snapshot.fetchedAt,
        claim: 'reasoning-support',
      }]
      models.push({
        model: canonical,
        baseModel: baseByModel.get(canonical),
        aliases: relayAliases.length > 0 ? relayAliases : undefined,
        identityResolution: 'anchor-match',
        relayCount: new Set(group.entries.map((e) => e.key)).size,
        family: baseByModel.get(canonical),
        reasoning: {
          supported: mdReasoningOf(canonical) === true,
          controlsKnown: options.length > 0,
          controls: options,
          evidenceRefs: evidence.map((e) => e.id),
        },
        evidence,
        layers: { official: false, modelsDev: true, inferred: false },
        conflictResolution: undefined,
      })
      seen.add(canonical)
    } else {
      for (const e of group.entries) {
        if (seen.has(e.key)) continue
        if (mdReasoningOf(e.key) !== true) continue
        identityUnresolved++
        const options = mdOptionOf(e.key)
        const evidence: EvidenceV2[] = [{
          id: 'models-dev/' + e.key,
          type: 'models-dev',
          scope: 'provider-model',
          vendor: 'models.dev',
          verifiedAt: snapshot.fetchedAt,
          claim: 'reasoning-support',
        }]
        models.push({
          model: e.key,
          baseModel: baseByModel.get(e.key),
          aliases: undefined,
          identityResolution: 'unresolved',
          relayCount: 1,
          family: undefined,
          reasoning: {
            supported: true,
            controlsKnown: options.length > 0,
            controls: options,
            evidenceRefs: evidence.map((e2) => e2.id),
          },
          evidence,
          layers: { official: false, modelsDev: true, inferred: false },
          conflictResolution: undefined,
        })
        seen.add(e.key)
      }
    }
  }

  // 3) provider-agnostic models keep their own key (not relay-scoped)
  for (const m of snapshot.models) {
    if (seen.has(m.id)) continue
    if (m.reasoning !== true) continue
    const evidence: EvidenceV2[] = [{
      id: 'models-dev/' + m.id,
      type: 'models-dev',
      scope: 'exact-model',
      vendor: 'models.dev',
      verifiedAt: snapshot.fetchedAt,
      claim: 'reasoning-support',
    }]
    models.push({
      model: m.id,
      baseModel: baseByModel.get(m.id),
      aliases: undefined,
      identityResolution: 'unresolved',
      relayCount: 1,
      family: undefined,
      reasoning: {
        supported: true,
        controlsKnown: (m.reasoningOptions?.length ?? 0) > 0,
        controls: (m.reasoningOptions ?? []) as ReasoningControl[],
        evidenceRefs: evidence.map((e) => e.id),
      },
      evidence,
      layers: { official: false, modelsDev: true, inferred: false },
      conflictResolution: undefined,
    })
    seen.add(m.id)
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
    _notice: 'GENERATED - evidence-merged registry (G4.2-G4.4). Do not edit. Run: npm run registry:compile',
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
      if (!new RegExp('^[a-z0-9-]+/[a-z0-9._-]+$','i').test(m.baseModel)) v2Errors.push('malformed baseModel ' + m.baseModel + ' for ' + m.model)
      if (m.baseModel === m.model) v2Errors.push('self-referencing baseModel for ' + m.model)
    }
    if (m.identityResolution === undefined) v2Errors.push('no identityResolution for ' + m.model)
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
  const familyGroups = new Map<string, number>()
  for (const m of models) if (m.family) familyGroups.set(m.family, (familyGroups.get(m.family) ?? 0) + 1)
  const familyList = [...familyGroups.entries()].map(([f, c]) => f + ' x' + c).join(', ')
  console.log('[registry-compile] G4.5 family audit: members=' + [...familyGroups.values()].reduce((a, b) => a + b, 0) + ' groups=' + familyGroups.size + ((familyList && ' (' + familyList + ')') || ''))
  console.log('[registry-compile] G4.4 identity audit: vendor-known=' + identityVendorKnown +
    ' anchor-match=' + identityAnchorMatch + ' unresolved=' + identityUnresolved +
    ' relay-alias-entries=' + relayAliasTotal)
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

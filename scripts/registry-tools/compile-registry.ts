#!/usr/bin/env bun
/**
 * Registry compiler (design §28, §33, G2/G4.1).
 *
 * Reads source registry JSON files under `registry/<vendor>/*.json`, each
 * holding one OfficialReasoningCapability, validates the whole set, writes
 * the generated bundled registry to src/generated/reasoning-registry.json,
 * and embeds the models.dev snapshot (G4.1) into
 * src/generated/models-dev-snapshot.json.
 *
 * Usage: bun scripts/registry-tools/compile-registry.ts
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { join } from 'path'
import type { OfficialReasoningCapability, ReasoningRegistry } from '../../src/reasoning/registry/types'
import { REGISTRY_SCHEMA_VERSION } from '../../src/reasoning/registry/types'
import { validateRegistry } from '../../src/reasoning/registry/validator'

const ROOT = process.cwd()
const REGISTRY_DIR = join(ROOT, 'registry')
const OUT_DIR = join(ROOT, 'src', 'generated')
const OUT_FILE = join(OUT_DIR, 'reasoning-registry.json')

/**
 * Release invariant (Stable gate G2): a Registry source directory that is
 * NOT in VENDOR_DIRS is a fail-closed build error. This catches the xai
 * class of bug (source present, compiler silently never reads it) at
 * compile time instead of at runtime via missing variants.
 */
export function findUnregisteredVendorDirs(registryRoot: string, vendorDirs: string[]): string[] {
  if (!existsSync(registryRoot)) return []
  return readdirSync(registryRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'upstream')
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
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as OfficialReasoningCapability
      entries.push(raw)
    }
  }
  return entries
}

function contentHash(models: OfficialReasoningCapability[]): string {
  // Deterministic: hash of the canonical + controls of every entry, sorted.
  // registryVersion is derived from content so the build is deterministic
  // AND any content change invalidates cached variants.
  const digest = createHash('sha256')
  const parts = models
    .map((m) => m.model + ':' + JSON.stringify(m.controls) + ':' + JSON.stringify(m.aliases ?? []))
    .sort()
  digest.update(parts.join('|'))
  return digest.digest('hex').slice(0, 10)
}

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
}

/**
 * G4.1 - embeds the normalized models.dev snapshot into src/generated so the
 * runtime reads a bundled file and never contacts models.dev (G4 §3.4).
 * Fails closed if the snapshot and lock do not match (a half-written sync).
 */
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

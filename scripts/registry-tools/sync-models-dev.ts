#!/usr/bin/env bun
/**
 * G4.1 - models.dev sync (explicit network command).
 *
 *   bun run registry:sync-models-dev
 *
 * This is the ONLY command that contacts models.dev. It:
 *   1. fetches https://models.dev/models.json + https://models.dev/api.json
 *   2. builds a normalized snapshot + lock under registry/upstream/
 *   3. validates + hashes + writes atomically (tmp -> rename)
 *   4. prints coverage accounting (G4 §5); silentlyDropped must be 0
 *   5. fails closed if any upstream reasoning option type is unsupported (G4 §21)
 *
 * Runtime never calls this; runtime reads the bundled snapshot.
 */

import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { buildSnapshot, computeLock, snapshotContentHash } from '../../src/utils/models-dev-snapshot'

const MODELS_URL = 'https://models.dev/models.json'
const API_URL = 'https://models.dev/api.json'
const OUT_DIR = join(resolve(__dirname, '../..'), 'registry/upstream')
const SNAPSHOT_FILE = join(OUT_DIR, 'models-dev.snapshot.json')
const LOCK_FILE = join(OUT_DIR, 'models-dev.lock.json')

async function fetchJson(url: string): Promise<{ text: string; json: unknown }> {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + url)
  const text = await res.text()
  const json = JSON.parse(text) as unknown
  return { text, json }
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('[sync-models-dev] fetching models.dev...')
  fetchJson(MODELS_URL)
    .then(async (models) => {
      const api = await fetchJson(API_URL)
      return { models, api }
    })
    .then(({ models, api }) => {
      const { snapshot, coverage } = buildSnapshot(models.json, api.json)
      const snapshotJson = JSON.stringify(snapshot, null, 2) + '\n'
      const lock = computeLock(models.text, api.text, snapshotJson)

      if (coverage.unsupportedOptionTypes.length > 0) {
        console.error('[sync-models-dev] FAIL: unsupported models.dev reasoning option type(s):')
        for (const t of coverage.unsupportedOptionTypes) console.error('  - ' + t)
        process.exit(1)
      }
      if (coverage.silentlyDropped > 0) {
        console.error('[sync-models-dev] FAIL: silently dropped ' + coverage.silentlyDropped + ' records (must be 0)')
        process.exit(1)
      }
      if (coverage.conflicts.length > 0) {
        console.error('[sync-models-dev] FAIL: conflicts:')
        for (const c of coverage.conflicts) console.error('  - ' + c)
        process.exit(1)
      }

      const lockJson = JSON.stringify(lock, null, 2) + '\n'

      // Atomic: write temp files, rename into place. Any failure before
      // rename leaves the previous snapshot/lock untouched.
      writeFileSync(SNAPSHOT_FILE + '.tmp', snapshotJson)
      writeFileSync(LOCK_FILE + '.tmp', lockJson)
      renameSync(SNAPSHOT_FILE + '.tmp', SNAPSHOT_FILE)
      renameSync(LOCK_FILE + '.tmp', LOCK_FILE)

      console.log('')
      console.log('Models.dev provider models scanned: ' + coverage.providerModelsScanned)
      console.log('Models.dev provider-agnostic models scanned: ' + coverage.providerAgnosticScanned)
      console.log('Reasoning=true: ' + coverage.reasoningTrue)
      console.log('Reasoning options present: ' + coverage.reasoningOptionsPresent)
      console.log('Reasoning options imported: ' + coverage.reasoningOptionsImported)
      console.log('Linked by base_model: ' + coverage.linkedByBaseModel)
      console.log('Provider-only unlinked: ' + coverage.providerOnlyUnlinked)
      console.log('Controls known: ' + coverage.controlsKnown)
      console.log('Controls unknown: ' + coverage.controlsUnknown)
      console.log('Unsupported reasoning option schema: ' + coverage.unsupportedOptionTypes.length)
      console.log('Conflicts: ' + coverage.conflicts.length)
      console.log('Silently dropped: ' + coverage.silentlyDropped)
      console.log('')
      console.log('[sync-models-dev] wrote ' + SNAPSHOT_FILE)
      console.log('[sync-models-dev] wrote ' + LOCK_FILE)
      console.log('Snapshot content hash: ' + snapshotContentHash(snapshot))
      console.log('Lock snapshot sha256:   ' + lock.snapshotSha256)
    })
    .catch((err) => {
      console.error('[sync-models-dev] FAILED: ' + (err instanceof Error ? err.message : String(err)))
      console.error('Previous snapshot (if any) is unchanged.')
      process.exit(1)
    })
}

void main()

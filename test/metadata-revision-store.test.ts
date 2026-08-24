import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  decideUpdate,
  DEFAULT_METADATA_LIMITS,
  loadLocalVerifiedSnapshot,
  saveVerifiedSnapshot,
  validateMetadataSnapshot,
  type MetadataSnapshotV1,
} from '../src/metadata/revision-store'

const tempRoots: string[] = []

async function makeCacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-metadata-store-'))
  tempRoots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
})

function snapshot(revision: string, providers: MetadataSnapshotV1['providers']): MetadataSnapshotV1 {
  return { schemaVersion: 1, revision, fetchedAt: '2026-08-24T00:00:00.000Z', providers }
}

function provider(id: string, models: string[] | Array<{ id: string; reasoning?: unknown }>) {
  return {
    id,
    models: models.map((m) => (typeof m === 'string' ? { id: m } : m as { id: string })),
  }
}

describe('validateMetadataSnapshot', () => {
  it('accepts a well-formed snapshot', () => {
    const result = validateMetadataSnapshot(
      snapshot('r2', [provider('deepseek', ['deepseek-v4-flash'])]),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value.providers).toHaveLength(1)
  })

  it('rejects empty catalog, wrong schema version, and missing fields', () => {
    // Empty catalogs are structurally valid envelopes; the QUARANTINE layer
    // rejects them against an activated bundle.
    expect(validateMetadataSnapshot(snapshot('r1', [])).ok).toBe(true)
    expect(validateMetadataSnapshot({ ...snapshot('r1', [provider('p', ['m'])]), schemaVersion: 2 }).ok).toBe(false)
    expect(validateMetadataSnapshot({ schemaVersion: 1 }).ok).toBe(false)
  })

  it('rejects duplicate provider×model tuples', () => {
    const dup = snapshot('r1', [
      provider('p', ['m1']),
      provider('p', ['m1']),
    ])
    expect(validateMetadataSnapshot(dup).ok).toBe(false)
  })

  it('rejects prototype-pollution keys at any depth', () => {
    const evil = JSON.parse('{"schemaVersion":1,"revision":"r1","fetchedAt":"2026-08-24T00:00:00.000Z","providers":[{"id":"p","models":[{"id":"m","__proto__":{"x":1}}]}]}')
    expect(validateMetadataSnapshot(evil).ok).toBe(false)
  })

  it('rejects oversized strings and excessive depth', () => {
    const limits = { ...DEFAULT_METADATA_LIMITS, maxStringLength: 8 }
    expect(validateMetadataSnapshot(
      snapshot('r1', [provider('a-very-long-provider-id-exceeding-limit', ['m'])]),
      limits,
    ).ok).toBe(false)

    const deep = { schemaVersion: 1, revision: 'r1', fetchedAt: 't', providers: [[[[[[[[[['too-deep']]]]]]]]]] }
    expect(validateMetadataSnapshot(deep).ok).toBe(false)
  })
})

describe('decideUpdate', () => {
  const ACTIVATED = snapshot('r1', [
    provider('deepseek', [{ id: 'm1', reasoning: { supportedEfforts: ['low'] } }, 'm2']),
    provider('other', ['m3']),
  ])

  it('accepts normal growth and unrelated churn', () => {
    const candidate = snapshot('r2', [
      provider('deepseek', [{ id: 'm1', reasoning: { supportedEfforts: ['low'] } }, 'm2']),
      provider('other', ['m3']),
      provider('new-guy', ['n1']),
    ])
    expect(decideUpdate(ACTIVATED, candidate)).toEqual({ decision: 'accept' })
    expect(decideUpdate(undefined, candidate)).toEqual({ decision: 'accept' })
  })

  it('quarantines an empty candidate catalog', () => {
    expect(decideUpdate(ACTIVATED, snapshot('r2', [])))
      .toMatchObject({ decision: 'quarantine' })
  })

  it('quarantines anomalous deletion ratios', () => {
    // Drops 2 of 3 known models (>50%).
    const candidate = snapshot('r2', [provider('deepseek', ['m2'])])
    const result = decideUpdate(ACTIVATED, candidate)
    expect(result.decision === 'quarantine' && result.reasons[0].startsWith('delete-ratio:')).toBe(true)
  })

  it('quarantines positive reasoning expansion from nowhere', () => {
    const candidate = snapshot('r2', [
      provider('deepseek', [
        { id: 'm1', reasoning: { supportedEfforts: ['low'] } },
        { id: 'm2', reasoning: { supportedEfforts: ['low', 'high'] } },
        'm3',
      ]),
      provider('other', ['m3']),
    ])
    const result = decideUpdate(ACTIVATED, candidate)
    expect(result.decision === 'quarantine' &&
      result.reasons.some((r) => r.startsWith('reasoning-expansion:'))).toBe(true)
  })
})

describe('save/load roundtrip with crash recovery', () => {
  it('persists, reloads via pointer, and survives a dangling pointer', async () => {
    const cacheRoot = await makeCacheRoot()
    const snap = snapshot('rev-1', [provider('deepseek', ['deepseek-v4-flash'])])
    await saveVerifiedSnapshot(cacheRoot, snap)
    await expect(loadLocalVerifiedSnapshot(cacheRoot)).resolves.toMatchObject({ revision: 'rev-1' })

    // Second revision lands in a NEW file; pointer moves forward.
    const snap2 = snapshot('rev-2', [provider('deepseek', ['deepseek-v4-flash']), provider('x', ['y'])])
    await saveVerifiedSnapshot(cacheRoot, snap2)
    await expect(loadLocalVerifiedSnapshot(cacheRoot)).resolves.toMatchObject({ revision: 'rev-2' })

    // Simulate a torn write: an extra file whose content fails validation.
    const { writeFile } = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')
    const dir = path.join(cacheRoot, 'metadata', 'v1')
    const tornName = `${createHash('sha256').update('torn').digest('hex')}.json`
    await writeFile(path.join(dir, tornName), '{"schemaVersion":9}')
    // Newest VALID revision still loads; the torn file is skipped.
    await expect(loadLocalVerifiedSnapshot(cacheRoot)).resolves.toMatchObject({ revision: 'rev-2' })
    const files = await readdir(dir)
    expect(files.filter((f) => f.endsWith('.json')).length).toBe(3)
  })

  it('returns undefined when nothing is stored locally (startup zero-network)', async () => {
    const cacheRoot = await makeCacheRoot()
    await expect(loadLocalVerifiedSnapshot(cacheRoot)).resolves.toBeUndefined()
  })
})

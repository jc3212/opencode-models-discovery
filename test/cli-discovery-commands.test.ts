import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  parseDiscoveryCommand,
  renderAudit,
  runStatus,
} from '../src/cli/discovery-commands'
import { saveVerifiedSnapshot, type MetadataSnapshotV1 } from '../src/metadata/revision-store'
import { buildVariantPlan } from '../src/reasoning/variant-plan'
import type { ReasoningCapabilityEvidence } from '../src/capabilities/types'

const tempRoots: string[] = []

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
})

describe('parseDiscoveryCommand', () => {
  it('parses status/audit/refresh flags', () => {
    expect(parseDiscoveryCommand(['status', '--json'])).toEqual({ name: 'status', json: true })
    expect(parseDiscoveryCommand([
      'audit', '--provider', 'deepseek', '--model', 'm1', '--json',
    ])).toEqual({ name: 'audit', providerId: 'deepseek', modelId: 'm1', json: true })
    expect(parseDiscoveryCommand(['refresh', '--metadata', '--force']))
      .toEqual({ name: 'refresh', metadata: true, force: true })
    expect(parseDiscoveryCommand([]).name).toBe('unknown')
  })
})

const SNAP: MetadataSnapshotV1 = {
  schemaVersion: 1,
  revision: 'rev-9',
  fetchedAt: '2026-08-24T00:00:00.000Z',
  providers: [{ id: 'p1', models: [{ id: 'm1' }, { id: 'm2' }] }],
}

describe('runStatus', () => {
  it('reports local metadata without fingerprints, in text and json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'omd-cli-status-'))
    tempRoots.push(root)
    await saveVerifiedSnapshot(root, SNAP)

    const json = await runStatus({ json: true, cacheRoot: root })
    const parsed = JSON.parse(json)
    expect(parsed.metadata.revision).toBe('rev-9')
    expect(parsed.metadata.models).toBe(2)
    // No ACTUAL fingerprint material may appear (the boolean guarantee flag
    // itself is fine): no 64-hex hashes and no non-boolean fingerprint values.
    expect(json).not.toMatch(/[0-9a-f]{64}/)
    expect(parsed.fingerprintExposed).toBe(false)

    const text = await runStatus({ cacheRoot: root })
    expect(text).toContain('rev-9')
    expect(text).toContain('fingerprints never displayed')

    const empty = await runStatus({ json: true })
    expect(JSON.parse(empty).metadata).toBeNull()
  })
})

describe('renderAudit', () => {
  const SCOPE = {
    inventoryIdentityHash: 'a'.repeat(64),
    routeKey: 'm1',
    providerKind: 'openai-compatible',
    origin: 'https://relay.example.com',
    remoteModelId: 'm1',
    apiSurface: 'chat-completions',
  } as const
  const T = { receivedAt: 't0', activatedAt: 't0' }

  function rec(overrides?: Partial<ReasoningCapabilityEvidence>): ReasoningCapabilityEvidence {
    return {
      claim: 'reasoning.support',
      scope: { ...SCOPE },
      support: 'supported',
      completeness: 'exhaustive',
      authority: 'exact',
      source: { id: 'src-1', ...T },
      ...overrides,
    }
  }

  it('renders planned variants with provenance lines', () => {
    const plan = buildVariantPlan({
      accessEligible: true,
      requestedSurface: 'chat-completions',
      records: [
        rec(),
        rec({ claim: 'effort.effective', values: ['low'], source: { id: 'eff-src', ...T } }),
      ],
    })
    const out = renderAudit({ providerId: 'relay', modelId: 'm1', plan, evidenceCount: 2 })
    expect(out).toContain('route: relay/m1')
    expect(out).toContain('variants: low→low')
    expect(out).toContain('provenance[low]: support=src-1 accepted=- effective=eff-src')
  })

  it('renders the suppression reason when variants are withheld', () => {
    const plan = buildVariantPlan({
      accessEligible: false,
      requestedSurface: 'chat-completions',
      records: [rec()],
    })
    const out = renderAudit({ providerId: 'relay', modelId: 'm1', plan, evidenceCount: 1 })
    expect(out).toContain('variants suppressed: not-access-eligible')
  })
})

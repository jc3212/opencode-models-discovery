import { describe, expect, it } from 'vitest'

import {
  buildSnapshotDraftFromModelsDev,
  effortsFromOptions,
} from '../src/metadata/models-dev-adapter'
import { decideUpdate, validateMetadataSnapshot } from '../src/metadata/revision-store'

const RAW = {
  'deepseek': {
    id: 'deepseek',
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        reasoning_options: [
          { type: 'effort', values: ['low', 'high', 'max'] },
          { type: 'toggle' },
        ],
      },
      'plain-model': { id: 'plain-model', name: 'Plain' },
    },
  },
  'empty-provider': { id: 'empty-provider', models: {} },
}

describe('effortsFromOptions', () => {
  it('collects declared effort values sorted and deduped', () => {
    expect(effortsFromOptions([
      { type: 'effort', values: ['high', 'low'] },
      { type: 'toggle' },
      { type: 'effort', values: ['low', 'max'] },
    ])).toEqual(['high', 'low', 'max'])
    expect(effortsFromOptions([{ type: 'toggle' }])).toBeUndefined()
    expect(effortsFromOptions(undefined)).toBeUndefined()
  })
})

describe('buildSnapshotDraftFromModelsDev', () => {
  const draft = buildSnapshotDraftFromModelsDev(RAW, 'rev-1', '2026-08-24T00:00:00.000Z')
  if ('error' in draft) throw new Error(`unexpected error: ${draft.error}`)

  it('skips providers without models and keeps exact ids', () => {
    expect(draft.providers.map((p) => p.id)).toEqual(['deepseek'])
  })

  it('maps explicit option efforts, and boolean reasoning to open-ended null', () => {
    const flash = draft.providers[0].models.find((m) => m.id === 'deepseek-v4-flash')
    expect(flash?.reasoning?.supportedEfforts).toEqual(['high', 'low', 'max'])
    expect(flash?.canonicalModelId).toBe('DeepSeek V4 Flash')

    // Boolean-only hint must NOT invent tiers.
    expect(draft.providers[0].models.find((m) => m.id === 'plain-model')?.reasoning).toBeUndefined()
  })

  it('produces a candidate that survives fail-closed validation', () => {
    const validation = validateMetadataSnapshot(draft)
    expect(validation.ok).toBe(true)
  })

  it('first sync against no baseline is accepted; growth from baseline too', () => {
    const validation = validateMetadataSnapshot(draft)
    if (!validation.ok) throw new Error('unreachable')
    expect(decideUpdate(undefined, validation.value)).toEqual({ decision: 'accept' })

    const grownRaw = {
      deepseek: {
        models: {
          'deepseek-v4-flash': RAW.deepseek.models['deepseek-v4-flash'],
          'new-model': { id: 'new-model', name: 'New' },
        },
      },
    }
    const grown = buildSnapshotDraftFromModelsDev(grownRaw, 'rev-2', '2026-08-24T01:00:00.000Z')
    if ('error' in grown) throw new Error(grown.error)
    expect(decideUpdate(validation.value, grown as never)).toEqual({ decision: 'accept' })
  })
})

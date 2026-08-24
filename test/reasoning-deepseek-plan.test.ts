import { describe, expect, it } from 'vitest'

import {
  DEEPSEEK_ACCEPTED_INPUTS,
  DEEPSEEK_EFFECTIVE_VALUES,
  DEEPSEEK_EXACT_MODEL_IDS,
  DEEPSEEK_NORMALIZATION,
  DEEPSEEK_OFF_WIRE,
  deepSeekAcceptedInputsEvidence,
  deepSeekNormalizationEvidence,
  deepSeekOffToggleEvidence,
  deepSeekReasoningSupportEvidence,
} from '../src/reasoning/deepseek-plan'
import { CapabilityCatalog } from '../src/capabilities/catalog'
import { buildVariantPlan } from '../src/reasoning/variant-plan'

const T = { receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' }

describe('DeepSeek normalization contract', () => {
  it('freezes the official §11 table verbatim', () => {
    expect([...DEEPSEEK_ACCEPTED_INPUTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(DEEPSEEK_NORMALIZATION).toEqual({
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'high',
      max: 'max',
    })
    expect([...DEEPSEEK_EFFECTIVE_VALUES]).toEqual(['low', 'high', 'max'])
  })

  it('dedupes compatibility inputs into existing UI tiers only', () => {
    const effective = new Set(
      DEEPSEEK_ACCEPTED_INPUTS.map((input) => DEEPSEEK_NORMALIZATION[input]),
    )
    expect([...effective].sort()).toEqual(['high', 'low', 'max'])
    expect(effective.size).toBe(DEEPSEEK_EFFECTIVE_VALUES.length)
  })

  it('keeps dated ids as separate exact records and forbids suffix stripping', () => {
    expect([...DEEPSEEK_EXACT_MODEL_IDS]).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-0731',
    ])
    expect(() =>
      deepSeekAcceptedInputsEvidence({ remoteModelId: 'deepseek-v4-flash-0730', ...T }),
    ).toThrow(TypeError)
    expect(() =>
      deepSeekNormalizationEvidence({ remoteModelId: 'v4-flash', ...T }),
    ).toThrow(TypeError)
  })

  it('encodes distinct off-toggle wires per surface', () => {
    expect(JSON.parse(DEEPSEEK_OFF_WIRE['chat-completions'])).toEqual({
      thinking: { type: 'disabled' },
    })
    expect(JSON.parse(DEEPSEEK_OFF_WIRE.responses)).toEqual({
      reasoning: { effort: 'none' },
    })
    const chat = deepSeekOffToggleEvidence({ remoteModelId: 'deepseek-v4-flash', surface: 'chat-completions', ...T })
    const responses = deepSeekOffToggleEvidence({ remoteModelId: 'deepseek-v4-flash', surface: 'responses', ...T })
    expect(chat.scope.apiSurface).toBe('chat-completions')
    expect(responses.scope.apiSurface).toBe('responses')
    expect(chat.scalar).not.toBe(responses.scalar)
  })

  it('produces catalog-valid records and a compilable variant plan', () => {
    const records = [
      deepSeekReasoningSupportEvidence({ remoteModelId: 'deepseek-v4-flash-0731', ...T }),
      deepSeekAcceptedInputsEvidence({ remoteModelId: 'deepseek-v4-flash-0731', ...T }),
      deepSeekNormalizationEvidence({ remoteModelId: 'deepseek-v4-flash-0731', ...T }),
    ]
    const catalog = new CapabilityCatalog()
    for (const record of records) {
      expect(catalog.add(record)).toEqual({ ok: true })
    }

    // The normalization evidence carries preferred wire mappings; feed the
    // accepted+normalization pair through the variant compiler.
    const plan = buildVariantPlan({
      accessEligible: true,
      requestedSurface: 'chat-completions',
      records,
    })
    if (plan.kind !== 'planned') throw new Error(`unexpected: ${JSON.stringify(plan)}`)
    expect(plan.variants.map((v) => v.effective)).toEqual(['low', 'high', 'max'])
    expect(plan.variants.every((v) => v.explicitWire)).toBe(true)
    expect(plan.variants[2]).toMatchObject({ effective: 'max', wireValue: 'max' })
  })

  it('does not leak direct-surface records across surfaces or providers', () => {
    const chatRecord = deepSeekAcceptedInputsEvidence({ remoteModelId: 'deepseek-v4-flash', ...T })
    expect(chatRecord.scope.providerKind).toBe('deepseek-direct')
    // A responses-surface record is a different tuple.
    const responsesRecord = deepSeekAcceptedInputsEvidence({
      remoteModelId: 'deepseek-v4-flash',
      surface: 'responses',
      ...T,
    })
    expect(responsesRecord.scope.apiSurface).toBe('responses')
    expect(chatRecord.source.id).not.toBe(responsesRecord.source.id)
  })
})

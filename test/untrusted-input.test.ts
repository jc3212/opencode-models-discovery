import { describe, it, expect } from 'vitest'
import {
  sanitizeDiscoveredModels,
  isValidModel,
  MAX_MODEL_ID_LENGTH,
  MAX_DISCOVERED_MODELS,
} from '../src/utils/openai-compatible-api'

/**
 * Untrusted /v1/models hardening (Stable gate G3).
 *
 * Relay model lists are hostile input: the plugin must fail-open, bound
 * memory, and never let a relay model id corrupt the injected config map
 * via prototype pollution.
 */
describe('untrusted /v1/models input hardening', () => {
  it('accepts a normal model list unchanged', () => {
    const out = sanitizeDiscoveredModels([{ id: 'gpt-5.4' }, { id: 'claude-opus-4-6' }])
    expect(out.map((m) => m.id)).toEqual(['gpt-5.4', 'claude-opus-4-6'])
  })

  it('drops non-object entries and non-string ids', () => {
    const out = sanitizeDiscoveredModels([null, 42, 'gpt-5.4', { id: 7 }, { id: undefined }, { id: '' }, { id: '   ' }, { id: 'gemini-3.1-pro-preview' }])
    expect(out.map((m) => m.id)).toEqual(['gemini-3.1-pro-preview'])
  })

  it('trims ids and drops ids exceeding the length cap', () => {
    const out = sanitizeDiscoveredModels([{ id: ' gpt-5.4 ' }, { id: 'x'.repeat(MAX_MODEL_ID_LENGTH + 1) }])
    expect(out.map((m) => m.id)).toEqual(['gpt-5.4'])
    expect(out[0].id).toBe('gpt-5.4')
  })

  it('de-duplicates identical ids deterministically (first wins)', () => {
    const out = sanitizeDiscoveredModels([
      { id: 'gpt-5.4' },
      { id: 'gpt-5.4' },
      { id: 'gpt-5.4' },
      { id: 'claude-opus-4-6' },
      { id: 'claude-opus-4-6' },
    ])
    expect(out.map((m) => m.id)).toEqual(['gpt-5.4', 'claude-opus-4-6'])
  })

  it('caps the list at MAX_DISCOVERED_MODELS (fail-open excess drop)', () => {
    const big = Array.from({ length: MAX_DISCOVERED_MODELS + 500 }, (_, i) => ({ id: 'model-' + i }))
    const out = sanitizeDiscoveredModels(big)
    expect(out.length).toBe(MAX_DISCOVERED_MODELS)
  })

  it('drops prototype-pollution keys __proto__ / constructor / prototype', () => {
    const out = sanitizeDiscoveredModels([
      { id: '__proto__' },
      { id: 'constructor' },
      { id: 'prototype' },
      { id: 'gpt-5.4' },
    ])
    expect(out.map((m) => m.id)).toEqual(['gpt-5.4'])
    // Stringify round-trip must not introduce an inherited key.
    const keyed: Record<string, unknown> = {}
    for (const m of out) keyed[m.id] = m
    expect(Object.keys(keyed)).toEqual(['gpt-5.4'])
  })

  it('never throws on hostile shapes', () => {
    expect(() => sanitizeDiscoveredModels(undefined as unknown)).not.toThrow()
    expect(() => sanitizeDiscoveredModels(null as unknown)).not.toThrow()
    expect(() => sanitizeDiscoveredModels({} as unknown)).not.toThrow()
    expect(() => sanitizeDiscoveredModels('gpt-5.4' as unknown)).not.toThrow()
    expect(() => sanitizeDiscoveredModels([new Map()])).not.toThrow()
  })

  it('isValidModel stays the per-entry guard used by callers', () => {
    expect(isValidModel({ id: 'gpt-5.4' })).toBe(true)
    expect(isValidModel({ id: '' })).toBe(false)
    expect(isValidModel({ id: 5 })).toBe(false)
    expect(isValidModel(null)).toBe(false)
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import { generateText } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { compileReasoningVariants } from '../src/reasoning/compiler'
import { FakeProvider } from './helpers/fake-provider'
import type { ReasoningOption } from '../src/reasoning/types'

/**
 * Phase J: Gemini wire-level verification (design §29-30).
 *
 * Verified against the REAL @ai-sdk/google provider:
 * - effort -> generationConfig.thinkingConfig.thinkingLevel
 * - budget_tokens -> generationConfig.thinkingConfig.thinkingBudget
 *
 * Hard requirement (design §29): the compiler must NEVER emit a variant that
 * sends thinkingLevel AND thinkingBudget together (mutually exclusive).
 */

let provider: FakeProvider | undefined

afterEach(async () => {
  if (provider) {
    await provider.close()
    provider = undefined
  }
})

async function sendGoogle(settings: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  provider = await FakeProvider.create()
  const client = createGoogleGenerativeAI({ apiKey: 'test', baseURL: provider.baseURL })
  await generateText({
    model: client('gemini-test'),
    prompt: 'hello',
    providerOptions: { google: settings },
  })
  return provider.lastBody(':generateContent')
}

function thinkingConfig(body: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const generation = body?.generationConfig as Record<string, unknown> | undefined
  return generation?.thinkingConfig as Record<string, unknown> | undefined
}

describe('Gemini wire body', () => {
  it('effort variant sends thinkingConfig.thinkingLevel', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'google' })
    const body = await sendGoogle(compiled.variants.high!)
    expect(thinkingConfig(body)).toMatchObject({ includeThoughts: true, thinkingLevel: 'high' })
  })

  it('budget variant sends thinkingConfig.thinkingBudget', async () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 32768 }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'google' })
    const body = await sendGoogle(compiled.variants.max!)
    expect(thinkingConfig(body)).toMatchObject({ includeThoughts: true, thinkingBudget: 32768 })
  })

  it('never sends thinkingLevel and thinkingBudget together', () => {
    const effort: ReasoningOption[] = [{ type: 'effort', values: ['low', 'high'] }]
    const budget: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 32768 }]

    const effortResult = compileReasoningVariants({ capabilityOptions: effort, transport: 'google' })
    const budgetResult = compileReasoningVariants({ capabilityOptions: budget, transport: 'google' })

    const allVariants = { ...effortResult.variants, ...budgetResult.variants }
    for (const settings of Object.values(allVariants)) {
      const cfg = settings.thinkingConfig as Record<string, unknown> | undefined
      expect(cfg).toBeDefined()
      expect('thinkingLevel' in (cfg ?? {}) && 'thinkingBudget' in (cfg ?? {})).toBe(false)
    }
  })

  it('effort and budget are never merged into one variant by the compiler', () => {
    const options: ReasoningOption[] = [
      { type: 'effort', values: ['low', 'high'] },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'google' })
    // Effort wins the branch; budget must not be merged.
    for (const settings of Object.values(result.variants)) {
      const cfg = settings.thinkingConfig as Record<string, unknown> | undefined
      expect(cfg).toBeDefined()
      expect('thinkingBudget' in (cfg ?? {})).toBe(false)
    }
  })
})

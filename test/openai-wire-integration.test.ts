import { describe, it, expect, afterEach } from 'vitest'
import { generateText } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { compileReasoningVariants } from '../src/reasoning/compiler'
import { FakeProvider } from './helpers/fake-provider'
import type { ReasoningOption } from '../src/reasoning/types'

/**
 * Official first-party OpenAI transport (Responses API) wire verification.
 *
 * Empirically verified: @ai-sdk/openai forwards `reasoningEffort` as a
 * nested `reasoning: { effort, summary }` object on the Responses API wire
 * (NOT the top-level reasoning_effort used by openai-compatible relays).
 * The SDK only sends reasoning for models it recognizes as reasoning models.
 */

let provider: FakeProvider | undefined

afterEach(async () => {
  if (provider) {
    await provider.close()
    provider = undefined
  }
})

async function sendOpenAI(settings: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  provider = await FakeProvider.create()
  const client = createOpenAI({ apiKey: 'test', baseURL: provider.baseURL })
  await generateText({
    model: client('gpt-5.4'),
    prompt: 'hello',
    providerOptions: { openai: settings },
  })
  return provider.lastBody('/v1/responses')
}

describe('official OpenAI Responses API wire body', () => {
  it('high effort variant sends reasoning.effort high + summary', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai' })
    const body = await sendOpenAI(compiled.variants.high!)
    expect(body).toMatchObject({ reasoning: { effort: 'high', summary: 'detailed' } })
  })

  it('low effort variant sends reasoning.effort low', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai' })
    const body = await sendOpenAI(compiled.variants.low!)
    expect(body).toMatchObject({ reasoning: { effort: 'low' } })
  })

  it('none effort variant sends reasoning.effort none without summary', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['none', 'low', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai' })
    const body = await sendOpenAI(compiled.variants.none!)
    expect(body).toMatchObject({ reasoning: { effort: 'none' } })
    expect(body?.reasoning).not.toHaveProperty('summary')
  })

  it('preserves the metadata effort set exactly (no invented tiers)', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'high', 'xhigh'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai' })
    expect(Object.keys(compiled.variants)).toEqual(['low', 'high', 'xhigh'])
    expect(compiled.variants.high).toEqual({ reasoningEffort: 'high' })
  })
})

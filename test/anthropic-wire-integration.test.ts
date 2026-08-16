import { describe, it, expect, afterEach } from 'vitest'
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { compileReasoningVariants } from '../src/reasoning/compiler'
import { FakeProvider } from './helpers/fake-provider'
import type { ReasoningOption } from '../src/reasoning/types'

/**
 * Phase I: Anthropic wire-level verification (design §27-28).
 *
 * The plugin compiles anthropic variants and the REAL @ai-sdk/anthropic
 * provider forwards them to the actual HTTP body. Verified:
 * - effort -> output_config.effort
 * - budget_tokens -> thinking.budget_tokens
 * - toggle -> thinking.type enabled/disabled
 */

let provider: FakeProvider | undefined

afterEach(async () => {
  if (provider) {
    await provider.close()
    provider = undefined
  }
})

async function sendAnthropic(settings: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  provider = await FakeProvider.create()
  const client = createAnthropic({ name: 'probe', baseURL: provider.baseURL, apiKey: 'test' })
  await generateText({
    model: client('claude-test'),
    prompt: 'hello',
    providerOptions: { probe: settings },
  })
  return provider.lastBody('/v1/messages')
}

describe('Anthropic wire body', () => {
  it('effort variant sends output_config.effort', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    const body = await sendAnthropic(compiled.variants.high!)
    expect(body).toMatchObject({ output_config: { effort: 'high' } })
  })

  it('budget variant sends thinking.budget_tokens', async () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 64000 }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    const body = await sendAnthropic(compiled.variants.max!)
    expect(body).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 32768 } })
  })

  it('toggle off sends thinking.type disabled', async () => {
    const options: ReasoningOption[] = [{ type: 'toggle' }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    const body = await sendAnthropic(compiled.variants.none!)
    expect(body).toMatchObject({ thinking: { type: 'disabled' } })
  })

  it('toggle on sends thinking.type enabled', async () => {
    const options: ReasoningOption[] = [{ type: 'toggle' }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    const body = await sendAnthropic(compiled.variants.high!)
    expect(body).toMatchObject({ thinking: { type: 'enabled' } })
  })
})

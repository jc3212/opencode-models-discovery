import { describe, it, expect, afterEach } from 'vitest'
import { generateText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAlibaba } from '@ai-sdk/alibaba'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { compileReasoningVariants } from '../src/reasoning/compiler'
import { FakeProvider } from './helpers/fake-provider'
import type { ReasoningOption } from '../src/reasoning/types'

/**
 * Wire-level verification (design §57-60): the plugin compiles
 * `model.variants`, OpenCode applies the selected variant as AI SDK model
 * options, and the SDK sends the HTTP body. These tests drive the REAL SDK
 * packages against a fake provider and assert the ACTUAL request body.
 */

let provider: FakeProvider | undefined

afterEach(async () => {
  if (provider) {
    await provider.close()
    provider = undefined
  }
})

async function sendOpenAICompatible(settings: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  provider = await FakeProvider.create()
  const client = createOpenAICompatible({ name: 'probe', baseURL: provider.baseURL, apiKey: 'test' })
  await generateText({
    model: client('gpt-test'),
    prompt: 'hello',
    providerOptions: { probe: settings },
  })
  return provider.lastBody('/v1/chat/completions')
}

describe('Case A: OpenAI-compatible effort wire body', () => {
  it('emits reasoning_effort for a high effort variant', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai-compatible-effort' })
    const body = await sendOpenAICompatible(compiled.variants.high!)
    expect(body).toMatchObject({ model: 'gpt-test', reasoning_effort: 'high' })
  })

  it('emits reasoning_effort for a low effort variant', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai-compatible-effort' })
    const body = await sendOpenAICompatible(compiled.variants.low!)
    expect(body).toMatchObject({ reasoning_effort: 'low' })
  })

  it('emits reasoning_effort none for the none variant', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openai-compatible-effort' })
    const body = await sendOpenAICompatible(compiled.variants.none!)
    expect(body).toMatchObject({ reasoning_effort: 'none' })
  })
})

describe('Case B: DashScope / Qwen toggle+budget wire body', () => {
  async function sendQwenVariant(id: 'none' | 'high' | 'max'): Promise<Record<string, unknown> | undefined> {
    const options: ReasoningOption[] = [
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'dashscope-chat' })
    const settings = compiled.variants[id]!
    provider = await FakeProvider.create()
    const client = createOpenAICompatible({ name: 'probe', baseURL: provider.baseURL, apiKey: 'test' })
    await generateText({
      model: client('qwen-test'),
      prompt: 'hello',
      providerOptions: { probe: settings },
    })
    return provider.lastBody('/v1/chat/completions')
  }

  it('high variant sends enable_thinking + thinking_budget', async () => {
    const body = await sendQwenVariant('high')
    expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 16000 })
  })

  it('max variant sends enable_thinking + max thinking_budget', async () => {
    const body = await sendQwenVariant('max')
    expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 32768 })
  })

  it('none variant sends enable_thinking false and no budget', async () => {
    const body = await sendQwenVariant('none')
    expect(body).toMatchObject({ enable_thinking: false })
    expect(body?.thinking_budget).toBeUndefined()
  })
})

describe('Case B-alt: @ai-sdk/alibaba camelCase wire body', () => {
  it('high variant maps enableThinking to enable_thinking on the wire', async () => {
    const options: ReasoningOption[] = [
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'alibaba-sdk' })
    provider = await FakeProvider.create()
    const client = createAlibaba({ name: 'alibaba', baseURL: provider.baseURL, apiKey: 'test' })
    await generateText({
      model: client('qwen-test'),
      prompt: 'hello',
      providerOptions: { alibaba: compiled.variants.high! },
    })
    const body = provider.lastBody('/v1/chat/completions')
    expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 16000 })
  })
})

describe('OpenRouter wire body', () => {
  it('sends reasoning.effort for an effort variant', async () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['high', 'xhigh'] }]
    const compiled = compileReasoningVariants({ capabilityOptions: options, transport: 'openrouter' })
    provider = await FakeProvider.create()
    const client = createOpenRouter({ apiKey: 'test', baseURL: provider.baseURL })
    await generateText({
      model: client('qwen-test'),
      prompt: 'hello',
      providerOptions: { openrouter: compiled.variants.high! },
    })
    const body = provider.lastBody('/v1/chat/completions')
    expect(body).toMatchObject({ reasoning: { effort: 'high' } })
  })
})

import { fetchModelsDevData } from './src/utils/models-dev-fetcher.ts'
import { resolveCanonicalModel } from './src/reasoning/canonical-model.ts'
import { resolveReasoningCapability } from './src/reasoning/resolver.ts'
import { resolveReasoningForModel } from './src/reasoning/enricher.ts'

const index = await fetchModelsDevData()
for (const id of ['grok-3', 'gpt-image-2', 'claude-opus-4-6', 'gpt-5.4']) {
  const canonical = resolveCanonicalModel({ modelId: id, modelsDevIndex: index })
  const modelsDevModel = canonical.canonicalModelId ? index.get(canonical.canonicalModelId) : undefined
  const capability = resolveReasoningCapability({ canonical, modelsDevModel })
  const resolution = resolveReasoningForModel({
    modelId: id,
    providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
    discoveryConfig: { reasoning: { enabled: true, transport: 'openai-compatible-effort' } },
    modelsDevIndex: index,
  })
  console.log(id.padEnd(16),
    '| canonical:', canonical.canonicalModelId ?? 'NONE',
    '| conf:', canonical.confidence,
    '| cap.options:', JSON.stringify(capability.options),
    '| variants:', Object.keys(resolution?.variants || {}).join(',') || 'none')
}

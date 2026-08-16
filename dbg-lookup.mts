import { fetchModelsDevData, lookupModelsDevData } from './src/utils/models-dev-fetcher.ts'
import { resolveCanonicalModel } from './src/reasoning/canonical-model.ts'

const index = await fetchModelsDevData()
console.log('index size:', index.size)
const tests = ['gpt-5.4', 'openai/gpt-5.4', 'gpt-5', 'openai/gpt-5', 'claude-opus-4-6', 'anthropic/claude-opus-4-6', 'gemini-3-flash', 'google/gemini-3-flash', 'grok-3', 'x-ai/grok-3', 'deepseek/deepseek-v4-flash']
for (const id of tests) {
  const direct = index.get(id)
  const lookup = lookupModelsDevData(id, index)
  const canonical = resolveCanonicalModel({ modelId: id, modelsDevIndex: index })
  console.log(id.padEnd(28),
    '| direct:', direct ? 'YES ro=' + JSON.stringify(direct.reasoning_options) : 'no',
    '| lookup:', lookup ? lookup.id + ' ro=' + JSON.stringify(lookup.reasoning_options) : 'no',
    '| canonical:', canonical.canonicalModelId ?? 'NONE', canonical.confidence)
}

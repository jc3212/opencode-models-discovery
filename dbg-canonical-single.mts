import { fetchModelsDevData } from './src/utils/models-dev-fetcher.ts'
import { resolveCanonicalModel } from './src/reasoning/canonical-model.ts'
import { resolveReasoningCapability } from './src/reasoning/resolver.ts'

const index = await fetchModelsDevData()
// Why does claude-opus-4-6-thinking (1 host) still fail?
for (const id of ['claude-opus-4-6-thinking', 'grok-3', 'gpt-image-2', 'gpt-5.4']) {
  const canonical = resolveCanonicalModel({ modelId: id, modelsDevIndex: index })
  console.log(id, '-> canonical:', JSON.stringify(canonical))
  const modelsDevModel = canonical.canonicalModelId ? index.get(canonical.canonicalModelId) : undefined
  const capability = resolveReasoningCapability({ canonical, modelsDevModel })
  console.log('   capability:', JSON.stringify(capability))
}

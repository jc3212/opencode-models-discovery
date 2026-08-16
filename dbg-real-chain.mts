import { fetchModelsDevData, lookupModelsDevData } from './src/utils/models-dev-fetcher.ts'
import { resolveReasoningForModel } from './src/reasoning/enricher.ts'
import { classifyReasoningEntry } from './src/reasoning/coverage.ts'
import { discoverModelsFromProvider } from './src/utils/openai-compatible-api.ts'
import { readFileSync } from 'node:fs'

const auth = JSON.parse(readFileSync('/home/chen/.local/share/opencode/auth.json', 'utf8'))
const apiKey = auth['openchat']?.key
const index = await fetchModelsDevData()
const res = await discoverModelsFromProvider('https://api.openclawplan.com/v1', apiKey, '/v1/models', 5000)
console.log('discovery ok:', res.ok, 'models:', res.models.length)
let notReasoning = 0, capUnknown = 0, transportUnknown = 0, verified = 0, resolved = 0
for (const m of res.models) {
  const resolution = resolveReasoningForModel({
    modelId: m.id,
    providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.openclawplan.com/v1' } },
    discoveryConfig: { reasoning: { enabled: true } },
    modelsDevIndex: index,
    providerMetadata: m,
  })
  if (!resolution) { console.log(m.id, '| NO RESOLUTION'); continue }
  const entry = classifyReasoningEntry('openchat', resolution)
  if (entry.status === 'NOT_REASONING') notReasoning++
  if (entry.status === 'CAPABILITY_UNKNOWN') capUnknown++
  if (entry.status === 'TRANSPORT_UNKNOWN') transportUnknown++
  if (entry.status === 'VERIFIED') verified++
  if (entry.status === 'RESOLVED') resolved++
  console.log(m.id, '| canonical:', resolution.model.canonicalModelId ?? 'NONE', '| mdReasoning:', lookupModelsDevData(m.id, index)?.reasoning ?? 'n/a', '| status:', entry.status, '| cap.src:', resolution.capability.source, '| cap.conf:', resolution.capability.confidence)
}
console.log('--- summary: notReasoning:', notReasoning, 'capUnknown:', capUnknown, 'transportUnknown:', transportUnknown, 'verified:', verified, 'resolved:', resolved)

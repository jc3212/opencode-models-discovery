import { fetchModelsDevData } from './src/utils/models-dev-fetcher.ts'
import { discoverModelsFromProvider } from './src/utils/openai-compatible-api.ts'
import { readFileSync } from 'node:fs'

const auth = JSON.parse(readFileSync('/home/chen/.local/share/opencode/auth.json', 'utf8'))
const index = await fetchModelsDevData()

// Analyze: for each real provider, how many models would resolve if we had
// the full model list. Show host-count distribution for openchat's models.
const res = await discoverModelsFromProvider('https://api.openclawplan.com/v1', auth['openchat']?.key, '/v1/models', 5000)
const modelParts = new Map()
for (const key of index.keys()) {
  const parts = key.split('/')
  const modelPart = parts.slice(1).join('/').toLowerCase()
  if (!modelParts.has(modelPart)) modelParts.set(modelPart, [])
  modelParts.get(modelPart).push(key)
}
console.log('openchat models -> hosts in api.json:')
for (const m of res.models) {
  const part = m.id.split('/').slice(-1)[0].toLowerCase()
  const hosts = modelParts.get(part) || []
  const distinctRO = new Set(hosts.map(h => JSON.stringify(index.get(h)?.reasoning_options)))
  console.log(m.id.padEnd(22), '| hosts:', String(hosts.length).padEnd(3), '| distinct reasoning_options sets:', distinctRO.size)
}

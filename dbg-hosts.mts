import { fetchModelsDevData } from './src/utils/models-dev-fetcher.ts'

const index = await fetchModelsDevData()
// How many providers host each model-part (for the relay's bare names)?
const names = ['gpt-5.4', 'gpt-5', 'claude-opus-4-6', 'gemini-3-flash', 'grok-3', 'gpt-5.5', 'gpt-5.6-luna']
for (const name of names) {
  const hosts = []
  for (const [key, model] of index.entries()) {
    const parts = key.split('/')
    const modelPart = parts.slice(1).join('/')
    if (modelPart.toLowerCase() === name.toLowerCase()) {
      hosts.push(key + ' ro=' + JSON.stringify(model.reasoning_options?.slice(0, 1)))
    }
  }
  console.log(name.padEnd(16), '->', hosts.length, 'hosts')
  for (const h of hosts.slice(0, 6)) console.log('   ', h)
}

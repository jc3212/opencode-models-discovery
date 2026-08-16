import { fetchModelsDevData } from './src/utils/models-dev-fetcher.ts'

const index = await fetchModelsDevData()
// Build map of modelPart -> [{key, ro}]
const byPart = new Map()
for (const [key, model] of index.entries()) {
  const part = key.split('/').slice(1).join('/').toLowerCase()
  if (!byPart.has(part)) byPart.set(part, [])
  byPart.get(part).push({ key, ro: model.reasoning_options ?? [] })
}
// Find parts with >1 host, identical NON-EMPTY reasoning_options
let examples = 0
for (const [part, hosts] of byPart.entries()) {
  if (hosts.length < 2) continue
  const nonEmpty = hosts.filter(h => h.ro.length > 0)
  if (nonEmpty.length !== hosts.length) continue
  const first = JSON.stringify(hosts[0].ro)
  const allSame = hosts.every(h => JSON.stringify(h.ro) === first)
  if (allSame && examples < 10) {
    console.log(part.padEnd(30), '| hosts:', hosts.length, '| ro:', first.slice(0, 80))
    examples++
  }
}
console.log('total multi-host-same-nonempty parts:', [...byPart.entries()].filter(([,h]) => h.length>1 && h.every(x=>x.ro.length>0) && h.every(x=>JSON.stringify(x.ro)===JSON.stringify(h[0].ro))).length)

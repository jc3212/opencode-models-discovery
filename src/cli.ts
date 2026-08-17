#!/usr/bin/env bun
/**
 * opencode-models-discovery audit CLI (design §33-36, §23-27).
 *
 * Installed via npm bin: `npx opencode-models-discovery audit`.
 * Read-only: only /v1/models + models.dev metadata are contacted; no
 * inference is ever sent. Output is sanitized (no credentials).
 *
 * Usage:
 *   opencode-models-discovery audit
 *   opencode-models-discovery audit --verbose
 */

import { readFileSync, existsSync } from 'fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeBaseURL, discoverModelsFromProvider, isValidModel } from './utils/openai-compatible-api'
import { fetchModelsDevData } from './utils/models-dev-fetcher'
import { resolveReasoningForModel } from './reasoning/enricher'
import { loadRegistry } from './reasoning/registry/loader'
import { resolveOfficialModelCapability } from './reasoning/registry/resolver'
import { resolveRelayAware } from './reasoning/relay/shadow'
import { resolveReasoningTransport } from './reasoning/transport'
import { buildReasoningCoverageReport } from './reasoning/coverage'
import type { ProviderDiscoveryConfig } from './types/plugin-config'
import type { ResolvedReasoning } from './reasoning/types'

const verbose = process.argv.includes('--verbose')

function loadBundledRegistry() {
  // Works both for the packaged dist/cli.js and the source src/cli.ts:
  // both resolve <package>/src/generated/reasoning-registry.json.
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.join(dir, '../src/generated/reasoning-registry.json'),
      path.join(dir, 'generated/reasoning-registry.json'),
      path.join(dir, '../dist/generated/reasoning-registry.json'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const registry = loadRegistry(JSON.parse(readFileSync(candidate, 'utf8')))
        if (registry) return registry
      }
    }
  } catch {
    /* fail-open: audit proceeds without registry */
  }
  return undefined
}

function hostnameOnly(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined
  try { return new URL(normalizeBaseURL(baseURL)).hostname } catch { return '<invalid-url>' }
}

function loadJson(filePath: string): any {
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch { /* ignore */ }
  return undefined
}

function collectConfigs(): any[] {
  const configs: any[] = []
  const home = process.env.HOME || ''
  const globalPath = process.env.OPENCODE_CONFIG || join(home, '.config/opencode/opencode.json')
  const globalConfig = loadJson(globalPath)
  if (globalConfig?.provider) configs.push(globalConfig)
  const projectConfig = loadJson(join(process.cwd(), 'opencode.json'))
  if (projectConfig?.provider) configs.push(projectConfig)
  return configs
}

function mergeProviders(configs: any[]): Record<string, any> {
  const merged: Record<string, any> = {}
  for (const config of configs) {
    for (const [id, provider] of Object.entries(config.provider ?? {})) merged[id] = provider
  }
  return merged
}

function resolveApiKey(providerId: string, provider: any): string | undefined {
  const explicit = provider?.options?.apiKey
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit
  const home = process.env.HOME || ''
  const auth = loadJson(join(home, '.local/share/opencode/auth.json'))
  const entry = auth?.[providerId] ?? auth?.[providerId.replace(/\/+$/, '')]
  if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) return entry.key
  return undefined
}

type IdentityStatus = 'canonical-exact' | 'registry-alias' | 'user-alias' | 'safe-revision' | 'ambiguous' | 'registry-missing' | 'user-alias-required' | 'unknown'

function classifyIdentity(modelId: string, registryMatch: { source: string } | undefined, userAliases: Record<string, string> | undefined): IdentityStatus {
  if (userAliases && Object.prototype.hasOwnProperty.call(userAliases, modelId)) return 'user-alias'
  if (!registryMatch) {
    // Not in registry and not user-aliased.
    const custom = /^(vip-|custom-|my-|free-|fast-|coding-|claude-)/i.test(modelId)
    return custom ? 'user-alias-required' : 'registry-missing'
  }
  switch (registryMatch.source) {
    case 'registry-exact': return 'canonical-exact'
    case 'registry-alias': return 'registry-alias'
    case 'registry-revision': return 'safe-revision'
    default: return 'unknown'
  }
}


function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    return require('../package.json').version ?? 'n/a'
  } catch { return 'n/a' }
}

function pluginCommit(): string {
  // npm pack embeds the source revision in package.json "gitHead" when
  // available; fall back to a git call inside the package root.
  try {
    const require = createRequire(import.meta.url)
    const gitHead = require('../package.json').gitHead
    if (typeof gitHead === 'string' && gitHead.length > 0) return gitHead.slice(0, 12)
  } catch { /* fall through */ }
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 12) || 'n/a'
  } catch { return 'n/a' }
}

function opencodeVersion(): string {
  try {
    return execFileSync('opencode', ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0] || 'n/a'
  } catch { return 'n/a' }
}

function sanitizedConfigHash(): string {
  // Content hash of the raw config file(s), not their contents: no
  // credentials are ever printed. Digest only.
  const home = process.env.HOME || ''
  const globalPath = process.env.OPENCODE_CONFIG || join(home, '.config/opencode/opencode.json')
  const hash = createHash('sha256')
  for (const p of [globalPath, join(process.cwd(), 'opencode.json')]) {
    try { hash.update(readFileSync(p)) } catch { /* missing optional config */ }
  }
  return hash.digest('hex').slice(0, 12)
}

function printAuditBaseline(registry: any): void {
  console.log('--- baseline ---')
  console.log(`Plugin version: ${packageVersion()}`)
  console.log(`Plugin commit: ${pluginCommit()}`)
  console.log(`Registry version: ${registry?.registryVersion ?? 'n/a'}`)
  console.log(`OpenCode version: ${opencodeVersion()}`)
  console.log(`Config hash (sha256-12, sanitized): ${sanitizedConfigHash()}`)
}

async function main(): Promise<void> {
  const registry = loadBundledRegistry()
  const configs = collectConfigs()
  const providers = mergeProviders(configs)
  const providerIds = Object.keys(providers)

  console.log('Reasoning Audit')
  console.log('')

  const totals = { models: 0, identityResolved: 0, registryMatched: 0, variantsGenerated: 0, registryMissing: 0, aliasRequired: 0, ingressTransportUnknown: 0, ingressTransportResolved: 0, compileTransportUnknown: 0, compileTransportResolved: 0, ambiguous: 0, capabilityResolved: 0, providersConfigured: 0, providersReachable: 0, notReasoning: 0 }
  const identityCounts: Record<string, number> = {}

  for (const providerId of providerIds) {
    const provider = providers[providerId]
    const discovery: ProviderDiscoveryConfig | undefined = provider?.options?.modelsDiscovery
    const baseURL = provider?.options?.baseURL
    const host = hostnameOnly(baseURL)

    if (discovery?.enabled === false || !baseURL) {
      console.log(`Provider ${providerId} (skipped, discovery disabled or no baseURL)`)
      continue
    }

    totals.providersConfigured++
    const apiKey = resolveApiKey(providerId, provider)
    const result = await discoverModelsFromProvider(baseURL, apiKey, discovery?.endpoint ?? '/v1/models', discovery?.timeoutMs ?? 3000)
    if (!result.ok) {
      console.log(`Provider ${providerId} (${host ?? 'unknown'}) - models endpoint failed`)
      continue
    }
    totals.providersReachable++

    const models = result.models.filter(isValidModel)
    const userAliases = discovery?.reasoning?.aliases
    const modelsDevIndex = await fetchModelsDevData()
    console.log(`Provider ${providerId} (${host ?? 'unknown'})`)
    console.log(`  Models: ${models.length}`)
    totals.models += models.length

    for (const model of models) {
      const registryMatch = resolveOfficialModelCapability(model.id, registry, { aliases: userAliases })
      const identity = classifyIdentity(model.id, registryMatch, userAliases)
      identityCounts[identity] = (identityCounts[identity] ?? 0) + 1
      if (identity === 'canonical-exact' || identity === 'registry-alias' || identity === 'user-alias' || identity === 'safe-revision') {
        totals.identityResolved++
      }
      if (registryMatch) totals.registryMatched++
      if (identity === 'registry-missing') totals.registryMissing++
      if (identity === 'user-alias-required') totals.aliasRequired++
      if (identity === 'ambiguous') totals.ambiguous++

      // Three-layer facts (design §22).
      const capabilitySource = registryMatch ? 'OFFICIAL' : 'UNKNOWN'
      if (registryMatch) totals.capabilityResolved++
      if (!registryMatch) totals.notReasoning++
      const relayShadow = resolveRelayAware({
        providerId, npm: provider?.npm, baseURL, modelId: model.id, rawModel: model,
        modelsDevIndex, aliases: userAliases, relayConfig: discovery?.reasoning?.relay,
      })
      const ingressKnown = relayShadow.ingress !== 'unknown'
      if (ingressKnown) totals.ingressTransportResolved++
      else totals.ingressTransportUnknown++
      // Compile transport reuses the EXACT runtime enrichment gate
      // (src/reasoning/transport.ts). It must never be re-derived here; the
      // CLI, tests and the runtime config hook all share this one resolver.
      const compileTransport = resolveReasoningTransport({
        providerId,
        npm: provider?.npm,
        baseURL,
        explicitTransport: discovery?.reasoning?.transport === 'auto' ? undefined : discovery?.reasoning?.transport,
      })
      const compileKnown = compileTransport.transport !== 'unknown' && compileTransport.safeToCompile
      if (compileKnown) totals.compileTransportResolved++
      else totals.compileTransportUnknown++

      if (verbose) {
        console.log(`  Model: ${model.id}`)
        console.log(`    Identity: ${identity}`)
        console.log(`    Capability: ${capabilitySource}`)
        if (registryMatch) {
          const levels = registryMatch.capability.controls
            .filter((c) => c.type === 'effort')
            .flatMap((c) => (c as { values: string[] }).values)
          console.log(`    Reasoning: ${levels.join(', ') || 'n/a'}`)
        }
        console.log(`    Ingress transport: ${relayShadow.ingress}`)
        console.log(`    Compile transport: ${compileTransport.transport} (reason=${compileTransport.reason}, safe=${compileTransport.safeToCompile})`)
        console.log(`    Relay forwarding: UNVERIFIED`)
      }
    }

    const resolutions = models.map((m) => resolveReasoningForModel({
      modelConfig: {}, modelId: m.id, providerConfig: provider, discoveryConfig: discovery, modelsDevIndex, providerMetadata: m, registry,
    })).filter((r): r is ResolvedReasoning => r !== undefined)
    const report = buildReasoningCoverageReport(providerId, resolutions)
    console.log(`  Variants generated (current runtime): ${report.summary.variantEnabledModels}`)
    totals.variantsGenerated += report.summary.variantEnabledModels
    console.log('')
  }

  console.log('--- summary ---')
  console.log(`Providers configured: ${totals.providersConfigured}`)
  console.log(`Providers reachable: ${totals.providersReachable}`)
  console.log(`Models discovered: ${totals.models}`)
  console.log('')
  console.log(`Identity resolved: ${totals.identityResolved}`)
  console.log(`  Canonical exact: ${identityCounts['canonical-exact'] ?? 0}`)
  console.log(`  Registry alias: ${identityCounts['registry-alias'] ?? 0}`)
  console.log(`  Safe revision: ${identityCounts['safe-revision'] ?? 0}`)
  console.log(`  User alias: ${identityCounts['user-alias'] ?? 0}`)
  console.log(`  Ambiguous: ${totals.ambiguous}`)
  console.log(`Registry missing: ${totals.registryMissing}`)
  console.log(`Alias required: ${totals.aliasRequired}`)
  console.log('')
  console.log(`Capability resolved (official): ${totals.capabilityResolved}`)
  console.log(`Not reasoning (no official entry): ${totals.notReasoning}`)
  console.log(`Ingress transport resolved: ${totals.ingressTransportResolved}`)
  console.log(`Ingress transport unknown: ${totals.ingressTransportUnknown}`)
  console.log(`Compile transport resolved: ${totals.compileTransportResolved}`)
  console.log(`Compile transport unknown: ${totals.compileTransportUnknown}`)
  console.log(`Variants generated (current runtime): ${totals.variantsGenerated}`)
  console.log('')
  printAuditBaseline(registry)
}

main().catch((error) => {
  console.error('[audit] unexpected error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
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
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeBaseURL, discoverModelsFromProvider, isValidModel } from './utils/openai-compatible-api'
import { fetchModelsDevData } from './utils/models-dev-fetcher'
import { resolveReasoningForModel } from './reasoning/enricher'
import { loadRegistry } from './reasoning/registry/loader'
import { resolveOfficialModelCapability } from './reasoning/registry/resolver'
import { resolveRelayAware } from './reasoning/relay/shadow'
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

async function main(): Promise<void> {
  const registry = loadBundledRegistry()
  const configs = collectConfigs()
  const providers = mergeProviders(configs)
  const providerIds = Object.keys(providers)

  console.log('Reasoning Audit')
  console.log('')

  const totals = { models: 0, identityResolved: 0, registryMatched: 0, variantsGenerated: 0, registryMissing: 0, aliasRequired: 0, transportUnknown: 0, ambiguous: 0 }
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

    const apiKey = resolveApiKey(providerId, provider)
    const result = await discoverModelsFromProvider(baseURL, apiKey, discovery?.endpoint ?? '/v1/models', discovery?.timeoutMs ?? 3000)
    if (!result.ok) {
      console.log(`Provider ${providerId} (${host ?? 'unknown'}) - models endpoint failed`)
      continue
    }

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
      const relayShadow = resolveRelayAware({
        providerId, npm: provider?.npm, baseURL, modelId: model.id, rawModel: model,
        modelsDevIndex, aliases: userAliases, relayConfig: discovery?.reasoning?.relay,
      })
      const transportKnown = relayShadow.ingress !== 'unknown' || discovery?.reasoning?.transport !== 'auto'
      if (!transportKnown) totals.transportUnknown++

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
        console.log(`    Transport: ${relayShadow.ingress}`)
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
  console.log(`Providers: ${providerIds.filter((id) => providers[id]?.options?.baseURL).length}`)
  console.log(`Models: ${totals.models}`)
  console.log(`Identity resolved: ${totals.identityResolved}`)
  console.log(`Official registry matched: ${totals.registryMatched}`)
  console.log(`Variants generated: ${totals.variantsGenerated}`)
  console.log(`Registry missing: ${totals.registryMissing}`)
  console.log(`Alias required: ${totals.aliasRequired}`)
  console.log(`Transport unknown: ${totals.transportUnknown}`)
  console.log(`Ambiguous: ${totals.ambiguous}`)
}

main().catch((error) => {
  console.error('[audit] unexpected error:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
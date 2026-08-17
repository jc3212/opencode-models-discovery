#!/usr/bin/env bun
/**
 * Sanitized reasoning coverage audit (design §14-16, §55-56).
 *
 * Reads the current OpenCode provider configuration, performs READ-ONLY model
 * discovery (/v1/models) and reasoning resolution, and prints a sanitized
 * coverage report per provider. No inference is ever sent: only model lists
 * and (optionally) provider metadata endpoints and the public models.dev
 * catalog are contacted.
 *
 * Usage:
 *   bun scripts/audit-reasoning.ts
 *   bun scripts/audit-reasoning.ts --verbose
 *
 * Privacy guarantees:
 *   - never prints API keys, Authorization headers, cookies, or tokens
 *   - base URLs are reduced to hostname only
 */

import { readFileSync, existsSync } from 'fs'
import { createRequire } from 'node:module'
const requireBundled = createRequire(import.meta.url)
function requireBundledRegistry(): unknown {
  try { return requireBundled('../src/generated/reasoning-registry.json') } catch { return undefined }
}
import { join } from 'path'
import { normalizeBaseURL, discoverModelsFromProvider, isValidModel } from '../src/utils/openai-compatible-api'
import { fetchModelsDevData } from '../src/utils/models-dev-fetcher'
import { resolveReasoningForModel } from '../src/reasoning/enricher'
import { resolveRelayAware } from '../src/reasoning/relay/shadow'
import { loadRegistry } from '../src/reasoning/registry/loader'
import { resolveOfficialModelCapability } from '../src/reasoning/registry/resolver'
import { buildReasoningCoverageReport } from '../src/reasoning/coverage'
import type { ProviderDiscoveryConfig } from '../src/types/plugin-config'
import type { ResolvedReasoning } from '../src/reasoning/types'

const verbose = process.argv.includes('--verbose')

function hostnameOnly(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined
  try {
    return new URL(normalizeBaseURL(baseURL)).hostname
  } catch {
    return '<invalid-url>'
  }
}

function loadJson(filePath: string): any {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf8'))
    }
  } catch (error) {
    console.error(`[audit] could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return undefined
}

/**
 * Resolves a provider API key from the OpenCode /connect auth store, exactly
 * like the plugin's getProviderApiKey. The key is used only for the read-only
 * discovery request and is NEVER printed.
 */
function resolveApiKey(providerId: string, provider: any): string | undefined {
  const explicit = provider?.options?.apiKey
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit
  }
  const home = process.env.HOME || ''
  const auth = loadJson(join(home, '.local/share/opencode/auth.json'))
  const entry = auth?.[providerId] ?? auth?.[providerId.replace(/\/+$/, '')]
  if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) {
    return entry.key
  }
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
    for (const [id, provider] of Object.entries(config.provider ?? {})) {
      merged[id] = provider
    }
  }
  return merged
}

function isDiscoveryEnabled(provider: any): boolean {
  const discovery: ProviderDiscoveryConfig | undefined = provider?.options?.modelsDiscovery
  // Mirror the plugin's real behavior: discovery defaults to enabled for any
  // OpenAI-compatible provider (npm or /v1 URL), unless explicitly disabled.
  if (discovery?.enabled === false) return false
  if (discovery?.enabled === true) return true
  if (!provider?.options?.baseURL) return false
  return provider?.npm === '@ai-sdk/openai-compatible' ||
    /\/v1(\/|$)/.test(provider?.options?.baseURL || '')
}

async function auditProvider(providerId: string, provider: any): Promise<{ summary: any; entries: any[]; error?: string }> {
  const discovery: ProviderDiscoveryConfig | undefined = provider?.options?.modelsDiscovery
  const baseURL = provider?.options?.baseURL
  if (!baseURL) {
    return { summary: null, entries: [], error: 'no baseURL' }
  }

  const modelsDevIndex = await fetchModelsDevData()
  const apiKey = resolveApiKey(providerId, provider)

  const result = await discoverModelsFromProvider(
    baseURL,
    apiKey,
    discovery?.endpoint ?? '/v1/models',
    discovery?.timeoutMs ?? 3000,
  )

  if (!result.ok) {
    return { summary: null, entries: [], error: 'models endpoint failed' }
  }

  const bundledRegistry = loadRegistry(requireBundledRegistry())
  const resolutions: ResolvedReasoning[] = []
  const relayShadows: Array<{ modelId: string; safeToCompile: boolean; reason: string }> = []
  const registryMatches: Array<{ modelId: string; matched: boolean; source: string }> = []
  const relayConfig = discovery?.reasoning?.relay
  for (const model of result.models.filter(isValidModel)) {
    const resolution = resolveReasoningForModel({
      modelId: model.id,
      providerId,
      providerConfig: provider,
      discoveryConfig: discovery,
      modelsDevIndex,
      providerMetadata: model,
      registry: bundledRegistry,
      outputLimit: undefined,
    })
    if (resolution) resolutions.push(resolution)

    // Shadow relay-aware resolution (does NOT inject anything).
    const shadow = resolveRelayAware({
      providerId,
      npm: provider?.npm,
      baseURL,
      modelId: model.id,
      rawModel: model,
      modelsDevIndex,
      aliases: discovery?.reasoning?.aliases,
      relayConfig,
    })
    relayShadows.push({
      modelId: model.id,
      safeToCompile: shadow.safeToCompile,
      reason: shadow.reason,
    })

    // Official registry coverage (design §56-57): exact/alias match for the
    // anonymous-relay case under official-model policy.
    const registryMatch = resolveOfficialModelCapability(model.id, bundledRegistry, {
      aliases: discovery?.reasoning?.aliases,
    })
    registryMatches.push({
      modelId: model.id,
      matched: registryMatch !== undefined,
      source: registryMatch?.source ?? 'none',
    })
  }

  const report = buildReasoningCoverageReport(providerId, resolutions)
  const relaySafeCount = relayShadows.filter((s) => s.safeToCompile).length
  const relayReasonCounts: Record<string, number> = {}
  for (const s of relayShadows) {
    relayReasonCounts[s.reason] = (relayReasonCounts[s.reason] ?? 0) + 1
  }
  const registryExact = registryMatches.filter((m) => m.matched && m.source === 'registry-exact').length
  const registryAlias = registryMatches.filter((m) => m.matched && m.source === 'registry-alias').length
  const registryUnknown = registryMatches.filter((m) => !m.matched).length
  return {
    summary: report.summary,
    entries: report.entries,
    relaySafeCount,
    relayReasonCounts,
    relayShadows,
    registryExact,
    registryAlias,
    registryUnknown,
  }
}

async function main(): Promise<void> {
  const configs = collectConfigs()
  const providers = mergeProviders(configs)
  const providerIds = Object.keys(providers)

  if (providerIds.length === 0) {
    console.log('[audit] no providers found in config')
    return
  }

  console.log('[reasoning-audit] sanitized coverage (no inference sent)')
  console.log('')

  const audited = []
  for (const providerId of providerIds) {
    const provider = providers[providerId]
    if (!isDiscoveryEnabled(provider)) {
      console.log(`Provider ${providerId} (skipped, discovery disabled)`)
      continue
    }
    const { summary, entries, relaySafeCount, registryExact, registryAlias, registryUnknown, error } = await auditProvider(providerId, provider)
    const host = hostnameOnly(provider?.options?.baseURL)
    if (error) {
      console.log(`Provider ${providerId} (${host ?? 'unknown'}) - ${error}`)
      continue
    }
    audited.push({ providerId, summary, entries, relaySafeCount, registryExact, registryAlias, registryUnknown })
    console.log(`Provider ${providerId} (${host ?? 'unknown'})`)
    console.log(`  Models: ${summary.totalModels}`)
    console.log(`  Reasoning known: ${summary.reasoningModels}`)
    console.log(`  Variants available: ${summary.variantEnabledModels}`)
    console.log(`  Capability unknown: ${summary.capabilityUnknown}`)
    console.log(`  Transport unknown: ${summary.transportUnknown}`)
    console.log(`  Verified: ${summary.verifiedModels} | Resolved: ${summary.resolvedModels} | Not reasoning: ${summary.notReasoning}`)
    if (relaySafeCount !== undefined) {
      console.log(`  [relay-aware shadow] safe to compile: ${relaySafeCount} / ${summary.totalModels}`)
    }
    if (registryExact !== undefined) {
      console.log(`  [official registry] exact: ${registryExact} | alias: ${registryAlias} | unknown: ${registryUnknown}`)
    }
    if (verbose) {
      for (const entry of entries) {
        console.log(`  ${entry.modelId}`)
        console.log(`    status: ${entry.status}`)
        if (entry.reason) console.log(`    reason: ${entry.reason}`)
        if (entry.variants.length > 0) console.log(`    variants: ${entry.variants.join(',')}`)
      }
    }
    console.log('')
  }

  const totals = audited.reduce((acc, a) => {
    acc.models += a.summary.totalModels
    acc.reasoning += a.summary.reasoningModels
    acc.variants += a.summary.variantEnabledModels
    return acc
  }, { models: 0, reasoning: 0, variants: 0 })

  console.log('[reasoning-audit] totals')
  console.log(`  Providers audited: ${audited.length}`)
  console.log(`  Models: ${totals.models}`)
  console.log(`  Reasoning known: ${totals.reasoning}`)
  console.log(`  Variants available: ${totals.variants}`)
}

main().catch((error) => {
  console.error('[audit] unexpected error:', error)
  process.exit(1)
})

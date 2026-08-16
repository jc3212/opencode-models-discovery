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
import { join } from 'path'
import { normalizeBaseURL, discoverModelsFromProvider, isValidModel } from '../src/utils/openai-compatible-api'
import { fetchModelsDevData } from '../src/utils/models-dev-fetcher'
import { resolveReasoningForModel } from '../src/reasoning/enricher'
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
  return discovery?.enabled === true || (discovery && discovery.enabled !== false && provider?.npm === '@ai-sdk/openai-compatible')
}

async function auditProvider(providerId: string, provider: any): Promise<{ summary: any; entries: any[]; error?: string }> {
  const discovery: ProviderDiscoveryConfig | undefined = provider?.options?.modelsDiscovery
  const baseURL = provider?.options?.baseURL
  if (!baseURL) {
    return { summary: null, entries: [], error: 'no baseURL' }
  }

  const modelsDevIndex = await fetchModelsDevData()
  const apiKey = typeof provider?.options?.apiKey === 'string' ? provider.options.apiKey : undefined

  const result = await discoverModelsFromProvider(
    baseURL,
    apiKey,
    discovery?.endpoint ?? '/v1/models',
    discovery?.timeoutMs ?? 3000,
  )

  if (!result.ok) {
    return { summary: null, entries: [], error: 'models endpoint failed' }
  }

  const resolutions: ResolvedReasoning[] = []
  for (const model of result.models.filter(isValidModel)) {
    const resolution = resolveReasoningForModel({
      modelId: model.id,
      providerConfig: provider,
      discoveryConfig: discovery,
      modelsDevIndex,
      providerMetadata: model,
      outputLimit: undefined,
    })
    if (resolution) resolutions.push(resolution)
  }

  const report = buildReasoningCoverageReport(providerId, resolutions)
  return { summary: report.summary, entries: report.entries }
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
    const { summary, entries, error } = await auditProvider(providerId, provider)
    const host = hostnameOnly(provider?.options?.baseURL)
    if (error) {
      console.log(`Provider ${providerId} (${host ?? 'unknown'}) - ${error}`)
      continue
    }
    audited.push({ providerId, summary, entries })
    console.log(`Provider ${providerId} (${host ?? 'unknown'})`)
    console.log(`  Models: ${summary.totalModels}`)
    console.log(`  Reasoning known: ${summary.reasoningModels}`)
    console.log(`  Variants available: ${summary.variantEnabledModels}`)
    console.log(`  Capability unknown: ${summary.capabilityUnknown}`)
    console.log(`  Transport unknown: ${summary.transportUnknown}`)
    console.log(`  Verified: ${summary.verifiedModels} | Resolved: ${summary.resolvedModels} | Not reasoning: ${summary.notReasoning}`)
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

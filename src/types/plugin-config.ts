export interface PluginConfig {
  providers?: {
    include?: string[]
    exclude?: string[]
  }
  models?: {
    includeRegex?: string[]
    excludeRegex?: string[]
  }
  discovery?: {
    enabled?: boolean
  }
  smartModelName?: boolean
}

export type ModelFieldFilterValue = string | number | boolean | null

export interface ModelFieldEqualsFilter {
  field: string
  equals: ModelFieldFilterValue
}

export interface ModelFieldMatchFilter {
  field: string
  match: string
}

export type ModelFieldFilter = ModelFieldEqualsFilter | ModelFieldMatchFilter

export type CompiledModelFieldFilter = ModelFieldEqualsFilter | (Omit<ModelFieldMatchFilter, 'match'> & { match: RegExp })

export enum ModelInfoFormat {
  Bifrost = 'bifrost',
  LiteLLM = 'litellm',
  ModelsDev = 'models.dev',
  VLLM = 'vllm',
  LMStudio = 'lmstudio',
  OmniRoute = 'omniroute',
}

export const DEFAULT_CACHE_TTL_SECONDS = 86400

export interface ProviderDiscoveryCacheConfig {
  enabled?: boolean
  ttlSeconds?: number
}

export interface ProviderReasoningConfig {
  enabled?: boolean
  /** Explicit reasoning transport: auto | openai-compatible-effort | openrouter | dashscope-chat | anthropic | google | alibaba-sdk | openai */
  transport?: string
  /** Map discovered model ids to canonical models for metadata lookup. */
  aliases?: Record<string, string>
  /**
   * Capability policy (design §21-24):
   * - "strict" (default): only inject variants when the current provider/host
   *   has sufficient evidence (provider-native metadata or models.dev).
   * - "official-model": additionally allow the official local registry to
   *   provide capability when the provider has no metadata, as long as the
   *   transport is known.
   */
  capabilityPolicy?: 'strict' | 'official-model'
  /**
   * Relay hint: auto | new-api | sub2api | none. Helps detection when the
   * provider id does not reveal the relay implementation.
   */
  relay?: 'auto' | 'new-api' | 'sub2api' | 'none'
}

export interface ProviderDiscoveryConfig {
  enabled?: boolean
  endpoint?: string
  timeoutMs?: number
  modelInfoEndpoint?: string
  modelInfoFormat?: ModelInfoFormat
  filterNonChat?: boolean
  models?: {
    includeRegex?: string[]
    excludeRegex?: string[]
    includeBy?: ModelFieldFilter[]
    excludeBy?: ModelFieldFilter[]
  }
  smartModelName?: boolean
  cache?: ProviderDiscoveryCacheConfig
  reasoning?: ProviderReasoningConfig
}

export interface DiscoveryConfig {
  enabled: boolean
}

export interface ModelRegexFilter {
  includeRegex: RegExp[]
  excludeRegex: RegExp[]
}

export interface ModelFieldFilters {
  includeBy: CompiledModelFieldFilter[]
  excludeBy: CompiledModelFieldFilter[]
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  enabled: true,
}

export function getDefaultDiscoveryConfigFromEnv(logger?: PluginLogger): DiscoveryConfig {
  const rawValue = process.env.OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED

  if (rawValue === undefined) {
    return DEFAULT_DISCOVERY_CONFIG
  }

  const normalizedValue = rawValue.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
    return { enabled: true }
  }

  if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
    return { enabled: false }
  }

  if (logger) {
    logger.warn('Ignoring invalid OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED value', {
      value: rawValue,
      fallback: DEFAULT_DISCOVERY_CONFIG.enabled,
    })
  } else {
    console.warn(`[@jc3212/opencode-models-discovery] Ignoring invalid OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED value: ${rawValue}`)
  }

  return DEFAULT_DISCOVERY_CONFIG
}

export function hasLegacyGlobalDiscoveryConfig(config: PluginConfig): boolean {
  return (
    config.discovery !== undefined ||
    config.providers !== undefined ||
    config.models !== undefined ||
    config.smartModelName !== undefined
  )
}

export function shouldDiscoverProviderWithOverride(
  defaultEnabled: boolean,
  providerConfig: ProviderDiscoveryConfig
): boolean {
  if (providerConfig.enabled === true) {
    return true
  }

  if (providerConfig.enabled === false) {
    return false
  }

  return defaultEnabled
}

function toRegExp(pattern: string, logger?: PluginLogger): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    if (logger) {
      logger.warn('Ignoring invalid model regex', { category: 'filtering', pattern })
    } else {
      console.warn(`[@jc3212/opencode-models-discovery] Ignoring invalid model regex: ${pattern}`)
    }
    return null
  }
}

export function getProviderModelRegexFilter(config: ProviderDiscoveryConfig, logger?: PluginLogger): ModelRegexFilter {
  return {
    includeRegex: (config.models?.includeRegex || []).map((pattern) => toRegExp(pattern, logger)).filter((pattern): pattern is RegExp => pattern !== null),
    excludeRegex: (config.models?.excludeRegex || []).map((pattern) => toRegExp(pattern, logger)).filter((pattern): pattern is RegExp => pattern !== null),
  }
}

function toModelFieldFilter(filter: ModelFieldFilter, logger?: PluginLogger): CompiledModelFieldFilter | null {
  if ('match' in filter) {
    try {
      return {
        field: filter.field,
        match: new RegExp(filter.match),
      }
    } catch {
      if (logger) {
        logger.warn('Ignoring invalid model field regex', { category: 'filtering', field: filter.field, pattern: filter.match })
      } else {
        console.warn(`[@jc3212/opencode-models-discovery] Ignoring invalid model field regex for ${filter.field}: ${filter.match}`)
      }
      return null
    }
  }

  return filter
}

export function getProviderModelFieldFilters(config: ProviderDiscoveryConfig, logger?: PluginLogger): ModelFieldFilters {
  return {
    includeBy: (config.models?.includeBy || []).map((filter) => toModelFieldFilter(filter, logger)).filter((filter): filter is CompiledModelFieldFilter => filter !== null),
    excludeBy: (config.models?.excludeBy || []).map((filter) => toModelFieldFilter(filter, logger)).filter((filter): filter is CompiledModelFieldFilter => filter !== null),
  }
}

function matchesModelFieldFilter(model: Record<string, unknown>, filter: CompiledModelFieldFilter): boolean {
  if (!Object.prototype.hasOwnProperty.call(model, filter.field)) {
    return false
  }

  const value = model[filter.field]
  if ('match' in filter) {
    return typeof value === 'string' && filter.match.test(value)
  }

  return value === filter.equals
}

export function shouldDiscoverModelByFields(model: Record<string, unknown>, filters: ModelFieldFilters): boolean {
  if (filters.includeBy.length > 0 && !filters.includeBy.some((filter) => matchesModelFieldFilter(model, filter))) {
    return false
  }

  if (filters.excludeBy.some((filter) => matchesModelFieldFilter(model, filter))) {
    return false
  }

  return true
}

export function shouldDiscoverModel(modelId: string, filter: ModelRegexFilter): boolean {
  if (filter.includeRegex.length > 0) {
    return filter.includeRegex.some((pattern) => pattern.test(modelId))
  }

  if (filter.excludeRegex.length > 0) {
    return !filter.excludeRegex.some((pattern) => pattern.test(modelId))
  }

  return true
}

export function parsePluginConfig(rawConfig: any): PluginConfig {
  if (!rawConfig) {
    return {}
  }

  if (Array.isArray(rawConfig)) {
    if (rawConfig.length >= 2 && typeof rawConfig[0] === 'string') {
      const configObj = rawConfig[1]
      if (configObj && typeof configObj === 'object') {
        return configObj as PluginConfig
      }
    }
    return {}
  }

  if (typeof rawConfig === 'object') {
    return rawConfig as PluginConfig
  }

  return {}
}
import type { PluginLogger } from '../plugin/logger'

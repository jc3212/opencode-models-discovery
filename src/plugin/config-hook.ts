import { ToastNotifier } from '../ui/toast-notifier'
import { validateConfig } from '../utils/validation'
import { enhanceConfig } from './enhance-config'
import { hasLegacyGlobalDiscoveryConfig } from '../types/plugin-config'
import type { LegacyGlobalConfigWarningController } from './legacy-config-warning'
import { injectConfigCommand, injectMigrationCommand } from './commands'
import type { PluginLogger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from '../types/plugin-config'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../utils/openai-compatible-api'

export const DEFAULT_CONFIG_HOOK_TIMEOUT_MS = 5000

export function getConfigHookTimeoutMs(config: any, logger: PluginLogger): number {
  const providerBudgets = Object.values(config?.provider ?? {})
    .filter((provider: any) => provider?.options?.baseURL && provider?.options?.modelsDiscovery?.enabled !== false)
    .map((provider: any) => {
      const discovery = provider.options?.modelsDiscovery ?? {}
      const configured = discovery.timeoutMs
      const requestTimeoutMs = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_REQUEST_TIMEOUT_MS
      const hasMetadataRequest = discovery.modelInfoFormat === 'litellm' || discovery.modelInfoFormat === 'lmstudio'
      return requestTimeoutMs * (hasMetadataRequest ? 2 : 1)
    })
  const providerTimeoutBudgetMs = providerBudgets.reduce((sum, budget) => sum + budget, 0)
  const timeoutMs = Math.max(DEFAULT_CONFIG_HOOK_TIMEOUT_MS, providerTimeoutBudgetMs)

  logger.debug('Using config hook timeout', {
    timeoutMs,
    providerTimeoutBudgetMs,
    providerCount: providerBudgets.length,
  })
  return timeoutMs
}

export function createConfigHook(
  client: PluginInput['client'],
  toastNotifier: ToastNotifier,
  pluginConfig: PluginConfig,
  legacyGlobalConfigWarning: LegacyGlobalConfigWarningController,
  logger: PluginLogger
) {
  return async (config: any) => {
    if (config && (Object.isFrozen?.(config) || Object.isSealed?.(config))) {
      logger.warn('Config object is frozen or sealed; cannot modify directly')
      return
    }

    const validation = validateConfig(config)
    if (!validation.isValid) {
      logger.error('Invalid config provided', { errors: validation.errors })
      toastNotifier.error("Plugin configuration is invalid", "Configuration Error").catch(() => { })
      return
    }

    if (validation.warnings.length > 0) {
      logger.warn('Config warnings', { warnings: validation.warnings })
    }

    injectConfigCommand(config, logger)

    if (hasLegacyGlobalDiscoveryConfig(pluginConfig)) {
      legacyGlobalConfigWarning.markPending(logger)
      injectMigrationCommand(config, logger)
    }

    const discoveryPromise = enhanceConfig(
      config,
      client,
      toastNotifier,
      pluginConfig,
      logger.child({ category: 'discovery' })
    )
    const timeoutMs = getConfigHookTimeoutMs(config, logger)

    try {
      await Promise.race([
        discoveryPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => resolve(), timeoutMs)
        })
      ])
    } catch (error) {
      logger.error('Config enhancement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

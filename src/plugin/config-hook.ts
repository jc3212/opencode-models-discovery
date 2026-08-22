import { ToastNotifier } from '../ui/toast-notifier'
import { validateConfig } from '../utils/validation'
import { enhanceConfig } from './enhance-config'
import { hasLegacyGlobalDiscoveryConfig } from '../types/plugin-config'
import type { LegacyGlobalConfigWarningController } from './legacy-config-warning'
import { injectConfigCommand, injectMigrationCommand } from './commands'
import type { PluginLogger } from './logger'
import type { PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from '../types/plugin-config'

/**
 * Startup deadline for the whole discovery pass (v3 plan §3.1).
 *
 * This budget is a single fixed ceiling for the entire hook: it never scales
 * with provider count. Individual `modelsDiscovery.timeoutMs` values remain
 * per-request caps only — they no longer accumulate into the hook budget.
 */
export const DEFAULT_CONFIG_HOOK_TIMEOUT_MS = 5000

export function getConfigHookTimeoutMs(config: any, logger: PluginLogger): number {
  const providerCount = Object.values(config?.provider ?? {})
    .filter((provider: any) => provider?.options?.baseURL && provider?.options?.modelsDiscovery?.enabled !== false)
    .length

  const timeoutMs = DEFAULT_CONFIG_HOOK_TIMEOUT_MS
  logger.debug('Using config hook timeout', {
    timeoutMs,
    providerCount,
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

    // Cooperative cancellation: when the startup deadline fires, the signal
    // aborts in-flight provider requests and blocks any late publication to
    // the returned config object (v3 §3.1 blocking invariant).
    const abortController = new AbortController()
    const timeoutMs = getConfigHookTimeoutMs(config, logger)
    const deadline = setTimeout(() => abortController.abort(), timeoutMs)

    try {
      const discoveryPromise = enhanceConfig(
        config,
        client,
        toastNotifier,
        pluginConfig,
        logger.child({ category: 'discovery' }),
        { signal: abortController.signal }
      )
      await Promise.race([
        discoveryPromise,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), timeoutMs)
          timer.unref?.()
        })
      ])
    } catch (error) {
      logger.error('Config enhancement failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      clearTimeout(deadline)
      // Ensure any still-pending discovery work observes cancellation even
      // when it finished after the race loser.
      abortController.abort()
    }
  }
}

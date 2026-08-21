import { ToastNotifier } from '../ui/toast-notifier'
import type { PluginLogger } from './logger'

const LEGACY_GLOBAL_CONFIG_WARNING = 'Global @jc3212/opencode-models-discovery config is no longer applied in v1.0.0. Move settings to provider.<name>.options.modelsDiscovery or run /models-discovery:migrate.'
const TOAST_RETRY_DELAYS_MS = [500, 1500, 3000, 5000]

const TOAST_READY_EVENTS = new Set([
  'server.connected',
  'workspace.ready',
  'worktree.ready',
  'reference.updated',
])

export interface LegacyGlobalConfigWarningController {
  markPending(logger: PluginLogger): void
  startRetries(toastNotifier: ToastNotifier): void
}

export function isToastReadyEvent(event: any): boolean {
  return typeof event?.type === 'string' && TOAST_READY_EVENTS.has(event.type)
}

export function createLegacyGlobalConfigWarningController(): LegacyGlobalConfigWarningController {
  let pending = false
  let logged = false
  let retryStarted = false

  return {
    markPending(logger: PluginLogger): void {
      if (pending) {
        return
      }

      pending = true

      if (!logged) {
        logged = true
        logger.warn('Legacy global @jc3212/opencode-models-discovery config was detected but is ignored in v1.0.0. Use provider.<name>.options.modelsDiscovery instead.', {
          migrationCommand: '/models-discovery:migrate',
          ignoredSince: 'v1.0.0',
        })
      }
    },

    startRetries(toastNotifier: ToastNotifier): void {
      if (!pending || retryStarted) {
        return
      }

      retryStarted = true

      const runAttempt = (index: number) => {
        const delayMs = TOAST_RETRY_DELAYS_MS[index]
        const timer = setTimeout(() => {
          if (!pending) {
            return
          }

          toastNotifier.warning(LEGACY_GLOBAL_CONFIG_WARNING, 'Discovery Config Migration', 8000).catch(() => { })

          if (index + 1 < TOAST_RETRY_DELAYS_MS.length) {
            runAttempt(index + 1)
            return
          }

          pending = false
        }, delayMs)

        ;(timer as any).unref?.()
      }

      runAttempt(0)
    }
  }
}

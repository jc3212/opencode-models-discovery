import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG_HOOK_TIMEOUT_MS, getConfigHookTimeoutMs } from '../src/plugin/config-hook'
import type { PluginLogger } from '../src/plugin/logger'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/utils/openai-compatible-api'

const logger: PluginLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
}

describe('config hook timeout', () => {
  it('uses the default startup wait budget', () => {
    expect(getConfigHookTimeoutMs({}, logger)).toBe(DEFAULT_CONFIG_HOOK_TIMEOUT_MS)
    expect(logger.debug).toHaveBeenCalledWith('Using config hook timeout', {
      timeoutMs: DEFAULT_CONFIG_HOOK_TIMEOUT_MS,
      providerTimeoutBudgetMs: 0,
      providerCount: 0,
    })
  })

  it('covers the sum of sequential provider request timeouts', () => {
    const config = {
      provider: {
        fast: { options: { baseURL: 'https://fast.example.com/v1', modelsDiscovery: { timeoutMs: 3000 } } },
        slow: { options: { baseURL: 'https://slow.example.com/v1', modelsDiscovery: { timeoutMs: 7500 } } },
      },
    }

    expect(getConfigHookTimeoutMs(config, logger)).toBe(10500)
    expect(logger.debug).toHaveBeenCalledWith('Using config hook timeout', {
      timeoutMs: 10500,
      providerTimeoutBudgetMs: 10500,
      providerCount: 2,
    })
  })

  it('does not reduce the default startup wait budget', () => {
    const config = {
      provider: {
        fast: { options: { baseURL: 'https://fast.example.com/v1', modelsDiscovery: { timeoutMs: 1000 } } },
      },
    }

    expect(getConfigHookTimeoutMs(config, logger)).toBe(DEFAULT_CONFIG_HOOK_TIMEOUT_MS)
  })

  it('uses defaults, skips disabled providers, and budgets metadata requests', () => {
    const config = {
      provider: {
        defaulted: { options: { baseURL: 'https://default.example.com/v1', modelsDiscovery: {} } },
        metadata: { options: { baseURL: 'https://metadata.example.com/v1', modelsDiscovery: { modelInfoFormat: 'litellm' } } },
        disabled: { options: { baseURL: 'https://disabled.example.com/v1', modelsDiscovery: { enabled: false, timeoutMs: 9000 } } },
        noURL: { options: { modelsDiscovery: { timeoutMs: 9000 } } },
      },
    }

    expect(getConfigHookTimeoutMs(config, logger)).toBe(DEFAULT_REQUEST_TIMEOUT_MS * 3)
  })
})

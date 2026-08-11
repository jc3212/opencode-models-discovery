import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG_HOOK_TIMEOUT_MS, getConfigHookTimeoutMs } from '../src/plugin/config-hook'
import type { PluginLogger } from '../src/plugin/logger'

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
      providerTimeoutMs: undefined,
    })
  })

  it('uses the largest configured provider request timeout', () => {
    const config = {
      provider: {
        fast: { options: { modelsDiscovery: { timeoutMs: 3000 } } },
        slow: { options: { modelsDiscovery: { timeoutMs: 7500 } } },
      },
    }

    expect(getConfigHookTimeoutMs(config, logger)).toBe(7500)
    expect(logger.debug).toHaveBeenCalledWith('Using config hook timeout', {
      timeoutMs: 7500,
      providerTimeoutMs: 7500,
    })
  })

  it('does not reduce the default startup wait budget', () => {
    const config = {
      provider: {
        fast: { options: { modelsDiscovery: { timeoutMs: 1000 } } },
      },
    }

    expect(getConfigHookTimeoutMs(config, logger)).toBe(DEFAULT_CONFIG_HOOK_TIMEOUT_MS)
  })
})

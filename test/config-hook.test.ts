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
      providerCount: 0,
    })
  })

  it('does not scale with the number of providers (v3 §3.1: no per-provider accumulation)', () => {
    const config = {
      provider: {
        fast: { options: { baseURL: 'https://fast.example.com/v1', modelsDiscovery: { timeoutMs: 3000 } } },
        slow: { options: { baseURL: 'https://slow.example.com/v1', modelsDiscovery: { timeoutMs: 7500 } } },
      },
    }

    expect(getConfigHookTimeoutMs(config, logger)).toBe(DEFAULT_CONFIG_HOOK_TIMEOUT_MS)
    expect(logger.debug).toHaveBeenCalledWith('Using config hook timeout', {
      timeoutMs: DEFAULT_CONFIG_HOOK_TIMEOUT_MS,
      providerCount: 2,
    })
  })

  it('ignores large single-provider request caps in the hook budget', () => {
    const config = {
      provider: {
        defaulted: { options: { baseURL: 'https://default.example.com/v1', modelsDiscovery: {} } },
        metadata: { options: { baseURL: 'https://metadata.example.com/v1', modelsDiscovery: { modelInfoFormat: 'litellm' } } },
        disabled: { options: { baseURL: 'https://disabled.example.com/v1', modelsDiscovery: { enabled: false, timeoutMs: 9000 } } },
        noURL: { options: { modelsDiscovery: { timeoutMs: 9000 } } },
      },
    }

    // timeoutMs is a per-request cap only; the hook budget stays fixed and
    // disabled/URL-less providers are not counted.
    expect(getConfigHookTimeoutMs(config, logger)).toBe(DEFAULT_CONFIG_HOOK_TIMEOUT_MS)
    expect(logger.debug).toHaveBeenLastCalledWith('Using config hook timeout', {
      timeoutMs: DEFAULT_CONFIG_HOOK_TIMEOUT_MS,
      providerCount: 2,
    })
  })
})

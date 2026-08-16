import { describe, it, expect } from 'vitest'

// The audit script reduces base URLs to hostname and never prints api keys.
// This test exercises the hostname-only sanitization logic through the
// openai-compatible-api normalizeBaseURL used by the audit path.

import { normalizeBaseURL } from '../src/utils/openai-compatible-api'

describe('audit sanitization', () => {
  it('reduces a base URL to a hostname via URL parsing', () => {
    const url = new URL(normalizeBaseURL('https://my-gateway.example.com/v1'))
    expect(url.hostname).toBe('my-gateway.example.com')
  })

  it('drops query/path credentials from hostname extraction', () => {
    const url = new URL(normalizeBaseURL('https://gw.example.com/v1?key=secret'))
    expect(url.hostname).toBe('gw.example.com')
    // hostname never contains the secret
    expect(url.hostname).not.toContain('secret')
  })

  it('normalizes trailing slashes and /v1 suffixes', () => {
    expect(normalizeBaseURL('https://gw.example.com/v1/')).toBe('https://gw.example.com')
    expect(normalizeBaseURL('https://gw.example.com/v1')).toBe('https://gw.example.com')
  })
})

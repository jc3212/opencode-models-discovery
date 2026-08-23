import { describe, expect, it } from 'vitest'
import {
  resolveInferenceCredentialV1,
  type CredentialLookupDeps,
} from '../src/discovery/credentials/v1'

const PROVIDER = 'relay'

function deps(partial: Partial<CredentialLookupDeps>): CredentialLookupDeps {
  return partial
}

describe('resolveInferenceCredentialV1 precedence', () => {
  it('prefers explicit options over every other source', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      explicitApiKey: 'sk-explicit',
      deps: deps({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify({ [PROVIDER]: { type: 'api', key: 'sk-env' } }),
          RELAY_API_KEY: 'sk-fromenv',
        },
        readHostAuthStore: () => ({ [PROVIDER]: { type: 'api', key: 'sk-store' } }),
      }),
      providerEnvNames: ['RELAY_API_KEY'],
    })
    expect(result).toMatchObject({ kind: 'resolved', source: 'explicit-options', material: 'sk-explicit' })
  })

  it('ignores a whitespace-only explicit value', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      explicitApiKey: '   ',
      deps: deps({ env: { RELAY_API_KEY: 'sk-fromenv' } }),
      providerEnvNames: ['RELAY_API_KEY'],
    })
    expect(result).toMatchObject({ kind: 'resolved', source: 'provider-env' })
  })

  it('resolves from OPENCODE_AUTH_CONTENT including trailing-slash variants', () => {
    const result = resolveInferenceCredentialV1({
      providerId: 'my-relay',
      deps: deps({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            'my-relay/': { type: 'api', key: 'sk-slash' },
          }),
        },
      }),
    })
    expect(result).toMatchObject({
      kind: 'resolved',
      source: 'auth-content-env',
      material: 'sk-slash',
    })
  })

  it('falls through to the host store when auth content is unparsable', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({
        env: { OPENCODE_AUTH_CONTENT: '{not json' },
        readHostAuthStore: () => ({ [PROVIDER]: { type: 'api', key: 'sk-store' } }),
      }),
    })
    expect(result).toMatchObject({ kind: 'resolved', source: 'host-auth-store' })
  })

  it('treats non-object auth content as absent', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({
        env: { OPENCODE_AUTH_CONTENT: JSON.stringify([1, 2]) },
        readHostAuthStore: () => ({ [PROVIDER]: { type: 'api', key: 'sk-store' } }),
      }),
    })
    expect(result).toMatchObject({ source: 'host-auth-store' })
  })

  it('skips an unusable entry and still consults lower-priority sources', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            [PROVIDER]: { type: 'oauth', access: 'tok', refresh: 'r' },
          }),
        },
        readHostAuthStore: () => ({ [PROVIDER]: { type: 'api', key: 'sk-store' } }),
      }),
    })
    expect(result).toMatchObject({ kind: 'resolved', source: 'host-auth-store', material: 'sk-store' })
  })

  it('reports unresolved oauth-entry when only dynamic entries exist', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({
        env: {
          OPENCODE_AUTH_CONTENT: JSON.stringify({
            [PROVIDER]: { type: 'oauth', access: 'tok' },
          }),
        },
        readHostAuthStore: () => ({ [PROVIDER]: { type: 'wellknown' } }),
      }),
    })
    expect(result).toEqual({ kind: 'unresolved', providerId: PROVIDER, reason: 'oauth-entry' })
  })

  it('never triggers a throwing store reader as an error', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({
        readHostAuthStore: () => {
          throw new Error('disk exploded')
        },
        env: { RELAY_API_KEY: 'sk-fromenv' },
      }),
      providerEnvNames: ['RELAY_API_KEY'],
    })
    expect(result).toMatchObject({ source: 'provider-env' })
  })

  it('honors adapter env names strictly in declared order', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({ env: { B_KEY: 'second', A_KEY: 'first' } }),
      providerEnvNames: ['A_KEY', 'B_KEY'],
    })
    expect(result).toMatchObject({ source: 'provider-env', material: 'first' })
  })

  it('returns no-credential when every source is empty', () => {
    const result = resolveInferenceCredentialV1({
      providerId: PROVIDER,
      deps: deps({}),
      providerEnvNames: ['MISSING_KEY'],
    })
    expect(result).toEqual({ kind: 'unresolved', providerId: PROVIDER, reason: 'no-credential' })
  })

  it('keeps credential material out of diagnostics detail', () => {
    const secret = 'sk-super-secret-value-9f3a'
    const results = [
      resolveInferenceCredentialV1({
        providerId: PROVIDER,
        explicitApiKey: secret,
      }),
      resolveInferenceCredentialV1({
        providerId: PROVIDER,
        deps: deps({
          env: {
            OPENCODE_AUTH_CONTENT: JSON.stringify({ [`${PROVIDER}/`]: { type: 'api', key: secret } }),
          },
        }),
      }),
      resolveInferenceCredentialV1({
        providerId: PROVIDER,
        deps: deps({ env: { RELAY_API_KEY: secret } }),
        providerEnvNames: ['RELAY_API_KEY'],
      }),
    ]
    for (const result of results) {
      if (result.kind !== 'resolved') continue
      expect(result.material.length).toBeGreaterThan(0)
      expect(result.detail.includes(secret)).toBe(false)
      expect(result.detail).not.toMatch(/sk-/)
    }
  })
})

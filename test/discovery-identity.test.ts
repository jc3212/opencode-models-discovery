import { describe, expect, it } from 'vitest'
import {
  assertHmacSecret,
  computeCredentialGenerationHash,
  computeSemanticIdentityHash,
  createConsumerKey,
  createHostInstanceToken,
  deriveJobKey,
  encodeCanonicalFields,
  hmacHex,
  nextPlanGeneration,
  redactIdentityForDiagnostics,
  redactRequestUrl,
  type HmacSecret,
} from '../src/discovery/identity'
import type { SemanticInventoryIdentityV3 } from '../src/discovery/types'

/** Deterministic test secret: 32 bytes 0x01..0x20 (never a real secret). */
const SECRET: HmacSecret = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const SECRET2: HmacSecret = Uint8Array.from({ length: 32 }, (_, i) => 100 + i)

function baseIdentity(): SemanticInventoryIdentityV3 {
  return {
    providerId: 'relay',
    adapterId: 'generic-openai',
    adapterVersion: 1,
    canonicalRequestUrlRedacted: 'https://relay.example.com/v1/models',
    visibilitySemantics: 'credential-observed',
    visibilityScope: 'credential',
    runtimeAuth: {
      kind: 'credential',
      credentialType: 'bearer',
      identityKind: 'material',
      identityFingerprint: 'aa'.repeat(32),
    },
    requestVaryFingerprint: 'bb'.repeat(32),
    apiSurface: 'chat-completions',
  }
}

describe('assertHmacSecret', () => {
  it('accepts 32-byte secrets and rejects weaker or non-byte inputs', () => {
    expect(() => assertHmacSecret(SECRET)).not.toThrow()
    expect(() => assertHmacSecret(Uint8Array.from({ length: 31 }, () => 1))).toThrow(RangeError)
    expect(() => assertHmacSecret('x' as unknown as HmacSecret)).toThrow(TypeError)
  })
})

describe('encodeCanonicalFields', () => {
  it('is deterministic and order-sensitive', () => {
    const a = encodeCanonicalFields({ x: '1', y: '2' })
    const b = encodeCanonicalFields({ x: '1', y: '2' })
    const c = encodeCanonicalFields({ y: '2', x: '1' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('distinguishes missing from empty-string fields', () => {
    const withEmpty = encodeCanonicalFields({ region: '' })
    const withoutField = encodeCanonicalFields({})
    expect(withEmpty).toContain('region=0:')
    expect(withoutField).not.toContain('region')
    expect(withEmpty).not.toBe(withoutField)
  })

  it('encodes numbers as decimal strings', () => {
    expect(encodeCanonicalFields({ v: 3 })).toBe('v=1:3\n')
  })

  it('length-prefixes values so separators cannot be forged inside them', () => {
    const evil = encodeCanonicalFields({ a: '0:x\nb=' })
    // '0:x\nb=' is exactly 6 UTF-8 bytes; the embedded newline cannot forge a
    // field because the reader consumes exactly 6 bytes for the value.
    expect(evil).toBe('a=6:0:x\nb=\n')
  })
})

describe('redactRequestUrl', () => {
  it('keeps only origin and path', () => {
    expect(redactRequestUrl('https://u:p@relay.example.com/v1/models?key=secret#frag')).toBe(
      'https://relay.example.com/v1/models',
    )
  })

  it('returns undefined for non-http(s) or unparseable input', () => {
    expect(redactRequestUrl('ftp://relay.example.com/x')).toBeUndefined()
    expect(redactRequestUrl('not a url')).toBeUndefined()
  })
})

describe('computeSemanticIdentityHash', () => {
  it('is deterministic for identical identities and secrets', () => {
    expect(computeSemanticIdentityHash(SECRET, baseIdentity())).toBe(
      computeSemanticIdentityHash(SECRET, baseIdentity()),
    )
  })

  it('changes when any scope-bearing field changes (§16.1 ORG-REGION-PROJECT-WORKSPACE)', () => {
    const base = computeSemanticIdentityHash(SECRET, baseIdentity())
    const variants: Array<Partial<SemanticInventoryIdentityV3>> = [
      { providerId: 'other-relay' },
      { adapterVersion: 2 },
      { canonicalRequestUrlRedacted: 'https://relay.example.com/v2/models' },
      { visibilitySemantics: 'policy-filtered' },
      { visibilityScope: 'account' },
      { region: 'cn-beijing' },
      { organizationFingerprint: 'cc'.repeat(32) },
      { workspaceFingerprint: 'dd'.repeat(32) },
      { projectFingerprint: 'ee'.repeat(32) },
      { requestVaryFingerprint: 'ff'.repeat(32) },
      { apiSurface: 'responses' },
    ]
    for (const patch of variants) {
      const mutated = { ...baseIdentity(), ...patch }
      expect(computeSemanticIdentityHash(SECRET, mutated)).not.toBe(base)
    }
  })

  it('changes when runtime or control-plane auth differs (KEY-A-TO-B isolation)', () => {
    const base = computeSemanticIdentityHash(SECRET, baseIdentity())

    const otherRuntime = {
      ...baseIdentity(),
      runtimeAuth: {
        kind: 'credential' as const,
        identityKind: 'material' as const,
        identityFingerprint: '11'.repeat(32),
      },
    }
    expect(computeSemanticIdentityHash(SECRET, otherRuntime)).not.toBe(base)

    const withControlPlane = {
      ...baseIdentity(),
      controlPlaneAuth: {
        credentialType: 'ak-sk',
        identityKind: 'stable-principal' as const,
        identityFingerprint: '22'.repeat(32),
      },
    }
    expect(computeSemanticIdentityHash(SECRET, withControlPlane)).not.toBe(base)

    const publicAuth = {
      ...baseIdentity(),
      runtimeAuth: { kind: 'public' as const, identityKind: 'public' as const },
    }
    expect(computeSemanticIdentityHash(SECRET, publicAuth)).not.toBe(base)
  })

  it('is keyed: rotating the installation secret changes every fingerprint', () => {
    expect(computeSemanticIdentityHash(SECRET, baseIdentity())).not.toBe(
      computeSemanticIdentityHash(SECRET2, baseIdentity()),
    )
  })

  it('GOLDEN: regression anchor for the exact encoding scheme', () => {
    // If this changes, the canonical encoding changed; cache filenames built
    // on old hashes would orphan. Bump the scheme version deliberately.
    expect(computeSemanticIdentityHash(SECRET, baseIdentity())).toMatchInlineSnapshot(`"15c3396eb7dcc5b719ad050bb2bf431ba6dfe7b59644a33d3ce86a5367255840"`)
  })
})

describe('computeCredentialGenerationHash', () => {
  it('separates distinct tokens even under one stable principal (OAUTH-ROTATION)', () => {
    const genA = { runtimeMaterialFingerprint: 'a'.repeat(64), runtimeMaterialVersion: '1' }
    const genB = { runtimeMaterialFingerprint: 'b'.repeat(64), runtimeMaterialVersion: '1' }
    expect(computeCredentialGenerationHash(SECRET, genA)).not.toBe(
      computeCredentialGenerationHash(SECRET, genB),
    )
  })

  it('treats missing control-plane material differently from present', () => {
    const runtimeOnly = { runtimeMaterialFingerprint: 'a'.repeat(64) }
    const both = { runtimeMaterialFingerprint: 'a'.repeat(64), controlPlaneMaterialFingerprint: 'c'.repeat(64) }
    expect(computeCredentialGenerationHash(SECRET, runtimeOnly)).not.toBe(
      computeCredentialGenerationHash(SECRET, both),
    )
  })
})

describe('deriveJobKey', () => {
  const parts = {
    semanticIdentityHash: 's'.repeat(64),
    credentialGenerationHashes: ['g1'.padEnd(64, '0'), 'g2'.padEnd(64, '0')],
    requestVaryFingerprint: 'v'.repeat(64),
    adapterId: 'generic-openai',
    adapterVersion: 1,
  }

  it('requires every component', () => {
    for (const key of ['semanticIdentityHash', 'requestVaryFingerprint', 'adapterId'] as const) {
      expect(() => deriveJobKey(SECRET, { ...parts, [key]: '' })).toThrow(TypeError)
    }
    expect(() => deriveJobKey(SECRET, { ...parts, credentialGenerationHashes: [] })).toThrow(TypeError)
    expect(() =>
      deriveJobKey(SECRET, { ...parts, credentialGenerationHashes: ['', 'g'] }),
    ).toThrow(TypeError)
  })

  it('is order-insensitive over the generation set (sorted before hashing)', () => {
    const [a, b] = parts.credentialGenerationHashes
    expect(deriveJobKey(SECRET, parts)).toBe(
      deriveJobKey(SECRET, { ...parts, credentialGenerationHashes: [b, a] }),
    )
  })

  it('differs across adapter versions and vary fingerprints', () => {
    const base = deriveJobKey(SECRET, parts)
    expect(deriveJobKey(SECRET, { ...parts, adapterVersion: 2 })).not.toBe(base)
    expect(deriveJobKey(SECRET, { ...parts, requestVaryFingerprint: 'w'.repeat(64) })).not.toBe(base)
  })
})

describe('host instance tokens and consumer keys', () => {
  it('tokens are unique per call and frozen', () => {
    const t1 = createHostInstanceToken()
    const t2 = createHostInstanceToken()
    expect(t1).not.toBe(t2)
    // Embedded seq defeats structural comparators, not just reference equality.
    expect(t1).not.toEqual(t2)
    expect(typeof t1.seq).toBe('number')
    expect(Object.isFrozen(t1)).toBe(true)
  })

  it('consumer keys freeze and require a non-empty slot', () => {
    const host = createHostInstanceToken()
    const ck = createConsumerKey(host, 'v2-effect', 'relay')
    expect(Object.isFrozen(ck)).toBe(true)
    expect(() => createConsumerKey(host, 'v1', '')).toThrow(TypeError)
  })

  it('nested maps distinguish consumers by host token reference, not serialization', () => {
    const hostA = createHostInstanceToken()
    const hostB = createHostInstanceToken()
    const registry = new Map<ReturnType<typeof createHostInstanceToken>, Set<string>>()
    registry.set(hostA, new Set(['a']))
    registry.set(hostB, new Set(['b']))
    expect(registry.get(hostA)).toEqual(new Set(['a']))
    expect(registry.size).toBe(2)
  })
})

describe('nextPlanGeneration', () => {
  it('increments monotonically and rejects invalid states', () => {
    expect(nextPlanGeneration(0)).toBe(1)
    expect(nextPlanGeneration(41)).toBe(42)
    expect(() => nextPlanGeneration(-1)).toThrow(TypeError)
    expect(() => nextPlanGeneration(Number.NaN)).toThrow(TypeError)
    expect(() => nextPlanGeneration(1.5)).toThrow(TypeError)
  })
})

describe('redactIdentityForDiagnostics', () => {
  it('exposes no fingerprints, hashes, or workspace identifiers (§9.1 log rule)', () => {
    const identity = {
      ...baseIdentity(),
      workspaceFingerprint: 'dd'.repeat(32),
      organizationFingerprint: 'cc'.repeat(32),
      controlPlaneAuth: {
        credentialType: 'ak-sk',
        identityKind: 'stable-principal' as const,
        identityFingerprint: '22'.repeat(32),
      },
    }
    const summary = redactIdentityForDiagnostics(identity)
    const json = JSON.stringify(summary)
    for (const forbidden of ['dd'.repeat(32), 'cc'.repeat(32), '22'.repeat(32), 'fingerprint']) {
      expect(json).not.toContain(forbidden)
    }
    expect(summary.controlPlanePresent).toBe(true)
    expect(summary.runtimeAuthKind).toBe('credential')
  })
})

describe('hmacHex', () => {
  it('matches an independent HMAC-SHA256 computation (cross-check)', async () => {
    const { createHmac } = await import('node:crypto')
    const expected = createHmac('sha256', Buffer.from(SECRET)).update('probe', 'utf8').digest('hex')
    expect(hmacHex(SECRET, 'probe')).toBe(expected)
  })
})

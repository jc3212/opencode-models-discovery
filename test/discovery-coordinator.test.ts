import { describe, expect, it } from 'vitest'
import { createConsumerKey, createHostInstanceToken } from '../src/discovery/identity'
import { DiscoveryCoordinator } from '../src/discovery/coordinator'
import type { DiscoveredRoute } from '../src/discovery/types'

const ID_A = 'a'.repeat(64)
const ID_B = 'b'.repeat(64)
const GEN_A = 'c'.repeat(64)
const GEN_B = 'd'.repeat(64)

function route(selectionKey: string, readiness: DiscoveredRoute['readiness'] = 'ready'): DiscoveredRoute {
  return {
    selectionKey,
    invocationId: selectionKey,
    routeKind: 'model-name',
    readiness,
    maturity: 'stable',
  }
}

function coordinator(semantics: 'strict' | 'observed' = 'strict'): DiscoveryCoordinator {
  return new DiscoveryCoordinator({
    consumer: createConsumerKey(createHostInstanceToken(), 'v2-effect', 'relay'),
    semantics,
    contribution: 'auto',
    explicitSelectionKeys: ['manual'],
    previousPluginSelectionKeys: ['old'],
  })
}

describe('DiscoveryCoordinator identity and publication gates', () => {
  it('revokes the old projection immediately on semantic identity change', () => {
    const c = coordinator()
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    expect(c.applyLocalLkg({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A }, [route('a')])).toBe(true)
    expect(c.snapshot().projection.autoRoutes.map((item) => item.selectionKey)).toEqual(['a'])

    const after = c.observeIdentity({ semanticIdentityHash: ID_B, credentialGenerationHash: GEN_B })
    expect(after.epoch).toBe(2)
    expect(after.projection.state).toBe('strict-empty')
    expect(after.projection.autoRoutes).toEqual([])
    expect(after.activeJobId).toBeUndefined()
  })

  it('keeps same-semantic generation rotation from crossing identity LKG', () => {
    const c = coordinator()
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    c.applyLocalLkg({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A }, [route('a')])
    const before = c.snapshot()
    const after = c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_B })
    expect(after.epoch).toBe(before.epoch)
    expect(after.projection.autoRoutes.map((item) => item.selectionKey)).toEqual(['a'])
    expect(after.identity?.credentialGenerationHash).toBe(GEN_B)
    expect(c.applyLocalLkg({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A }, [route('old')])).toBe(false)
  })

  it('allows only one active refresh job and rejects a late old token', () => {
    const c = coordinator()
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    const first = c.beginRefresh('post-setup')
    expect(first).toBeDefined()
    expect(c.beginRefresh('manual')).toBeUndefined()
    c.observeIdentity({ semanticIdentityHash: ID_B, credentialGenerationHash: GEN_B })
    const stale = first!
    const result = c.completeRefresh({ token: stale, kind: 'complete', routes: [route('late')] })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe('stale-job')
    expect(result.snapshot.projection.autoRoutes).toEqual([])
  })

  it('publishes a complete non-empty inventory and removes vanished plugin routes', () => {
    const c = coordinator()
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    c.applyLocalLkg({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A }, [route('old'), route('keep')])
    const job = c.beginRefresh('manual')
    expect(job).toBeDefined()
    const result = c.completeRefresh({ token: job!, kind: 'complete', routes: [route('keep'), route('new')] })
    expect(result.applied).toBe(true)
    expect(result.snapshot.state.projection).toBe('fresh')
    expect(result.snapshot.projection.autoRoutes.map((item) => item.selectionKey)).toEqual(['keep', 'new'])
    expect(result.snapshot.projection.removedPluginSelectionKeys).toEqual(['old'])
  })

  it('complete empty strict inventory enters strict-empty while retaining explicit keys', () => {
    const c = coordinator()
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    const job = c.beginRefresh('manual')
    const result = c.completeRefresh({ token: job!, kind: 'complete', routes: [] })
    expect(result.snapshot.state.projection).toBe('strict-empty')
    expect(result.snapshot.projection.visibleSelectionKeys).toEqual(['manual'])
  })

  it('keeps same-identity LKG on transient failure and marks stale-allowed', () => {
    const c = coordinator('observed')
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    c.applyLocalLkg({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A }, [route('cached')])
    const job = c.beginRefresh('soft-ttl')
    const result = c.completeRefresh({ token: job!, kind: 'transient-failure', hasValidLkg: true })
    expect(result.snapshot.state.projection).toBe('stale-allowed')
    expect(result.snapshot.projection.autoRoutes.map((item) => item.selectionKey)).toEqual(['cached'])
  })

  it('disposes publication rights and ignores later operations', () => {
    const c = coordinator()
    c.observeIdentity({ semanticIdentityHash: ID_A, credentialGenerationHash: GEN_A })
    const before = c.beginRefresh('manual')
    expect(before).toBeDefined()
    const disposed = c.dispose()
    expect(disposed.disposed).toBe(true)
    expect(disposed.state).toEqual({ projection: 'disposed', refresh: 'disposed' })
    expect(c.completeRefresh({ token: before!, kind: 'complete', routes: [route('nope')] }).reason).toBe('disposed')
    expect(c.beginRefresh('manual')).toBeUndefined()
  })
})

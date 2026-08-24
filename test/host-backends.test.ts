import { describe, expect, it } from 'vitest'

import { V1ConfigBackend } from '../src/host/v1-config-backend'
import { V2CatalogBackend } from '../src/host/v2-catalog-backend'
import { projectRoutes } from '../src/discovery/projector'

function route(key: string) {
  return { selectionKey: key, invocationId: key, routeKind: 'model-name' as const, readiness: 'ready' as const, maturity: 'stable' as const }
}

function draft(autoKeys: string[], state: Parameters<typeof projectRoutes>[0]['semantics'] extends never ? never : ReturnType<typeof projectRoutes>['state'] = 'fresh') {
  const d = projectRoutes({
    semantics: 'observed',
    inventoryComplete: true,
    routes: autoKeys.map(route),
  })
  if (autoKeys.length === 0) {
    // Force an empty-but-complete shape with the requested state label.
    return { ...d, state, autoRoutes: [] }
  }
  return d
}

describe('V1ConfigBackend (E3 §8.2)', () => {
  it('injects auto routes and removes vanished keys it owns', () => {
    const backend = new V1ConfigBackend()
    const config = {}
    const models: Record<string, unknown> = { 'user-model': { custom: true } }

    const first = backend.applyProjection({ config, providerId: 'p', epoch: 1, draft: draft(['m1', 'm2']), models })
    expect(first.injected.sort()).toEqual(['m1', 'm2'])
    expect(Object.keys(models).sort()).toEqual(['m1', 'm2', 'user-model'])

    const second = backend.applyProjection({ config, providerId: 'p', epoch: 1, draft: draft(['m2']), models })
    expect(second.removed).toEqual(['m1'])
    expect(Object.keys(models).sort()).toEqual(['m2', 'user-model'])
  })

  it('never removes entries the user modified after injection', () => {
    const backend = new V1ConfigBackend()
    const config = {}
    const models: Record<string, unknown> = {}
    backend.applyProjection({ config, providerId: 'p', epoch: 1, draft: draft(['m1']), models })

    models['m1'] = { tampered: true } // user/foreign edit
    const report = backend.applyProjection({ config, providerId: 'p', epoch: 1, draft: draft([]), models })
    expect(report.preservedForeign).toEqual(['m1'])
    expect(models['m1']).toEqual({ tampered: true })
  })

  it('an epoch change drops ownership claims but spares foreign content', () => {
    const backend = new V1ConfigBackend()
    const config = {}
    const models: Record<string, unknown> = {}
    backend.applyProjection({ config, providerId: 'p', epoch: 1, draft: draft(['m1']), models })

    const report = backend.applyProjection({ config, providerId: 'p', epoch: 2, draft: draft(['m2']), models })
    // m1 was injected under epoch 1; after revocation it is no longer
    // protected, but it is also not re-claimed — it simply stays as-is.
    expect(report.injected).toEqual(['m2'])
    expect(models['m1']).toBeDefined()
  })

  it('release restores only still-equal owned entries on managed→no-op exit', () => {
    const backend = new V1ConfigBackend()
    const config = {}
    const models: Record<string, unknown> = {}
    backend.applyProjection({ config, providerId: 'p', epoch: 1, draft: draft(['m1', 'm2']), models })
    models['m1'] = { edited: true }

    const restored = backend.releaseOwnedEntries({ config, providerId: 'p', models })
    expect(restored).toEqual(['m2'])
    expect(models['m1']).toEqual({ edited: true })
    expect(models['m2']).toBeUndefined()
  })
})

describe('V2CatalogBackend (E3 §8.3)', () => {
  it('rebuilds the plugin section wholesale without accumulating mutations', () => {
    const backend = new V2CatalogBackend()
    backend.publish(draft(['m1', 'm2']) as never, 1)
    const hostModels = { 'host-entry': { native: true } }

    const first = backend.transform(hostModels)
    expect(first.appliedRoutes.sort()).toEqual(['m1', 'm2'])
    expect(first.models['host-entry']).toEqual({ native: true })

    hostModels['host-entry'] = { changedByHost: true }
    const second = backend.transform(hostModels)
    expect(second.models['host-entry']).toEqual({ changedByHost: true })
    expect(second.models['m1']).toEqual(first.models['m1'])

    // Inputs untouched.
    expect(hostModels).not.toHaveProperty('m1')
  })

  it('publishes an empty plugin section for strict-empty states before network', () => {
    const backend = new V2CatalogBackend()
    backend.publish(draft(['m1']) as never, 1)
    expect(backend.transform({}).appliedRoutes.length).toBe(1)

    backend.publish(draft([], 'auth-blocked') as never, 2)
    expect(backend.peek()?.pluginRoutes).toEqual([])
    expect(backend.transform({}).appliedRoutes).toEqual([])
  })

  it('skips publication for NO_CONTRIBUTION drafts entirely', () => {
    const backend = new V2CatalogBackend()
    const result = backend.publish(
      { ...draft([], 'fresh'), state: 'no-contribution' } as never,
      1,
    )
    expect(result.published).toBe(false)
    expect(backend.peek()).toBeUndefined()
  })

  it('recommends exactly one reload only when callable content changed', () => {
    const backend = new V2CatalogBackend()
    expect(backend.publish(draft(['m1']) as never, 1).reloadRecommended).toBe(true)
    expect(backend.publish(draft(['m1']) as never, 1).reloadRecommended).toBe(false)
    expect(backend.publish(draft(['m1', 'm2']) as never, 1).reloadRecommended).toBe(true)
  })
})

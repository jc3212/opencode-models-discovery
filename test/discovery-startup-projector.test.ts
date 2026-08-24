import { describe, expect, it } from 'vitest'
import { StartupBarrier, StartupBarrierConfigError } from '../src/discovery/startup-barrier'
import { projectRoutes } from '../src/discovery/projector'
import type { DiscoveredRoute } from '../src/discovery/types'

function route(overrides: Partial<DiscoveredRoute> = {}): DiscoveredRoute {
  return {
    selectionKey: 'm1',
    invocationId: 'm1',
    routeKind: 'model-name',
    readiness: 'ready',
    maturity: 'stable',
    ...overrides,
  }
}

describe('StartupBarrier', () => {
  it('does not allow a fetch before setup has returned', () => {
    const barrier = new StartupBarrier({ startupGraceMs: 100 })
    expect(barrier.canStartFetch(1000)).toBe(false)
    expect(barrier.markFetchStarted(1000)).toBe(false)
    expect(barrier.snapshot()).toEqual({ startupGraceMs: 100 })
  })

  it('allows the first fetch exactly at setup plus grace', () => {
    const barrier = new StartupBarrier({ startupGraceMs: 100 })
    barrier.markSetupReturned(1000)
    barrier.markCatalogAvailable(1010)
    expect(barrier.canStartFetch(1099)).toBe(false)
    expect(barrier.canStartFetch(1100)).toBe(true)
    expect(barrier.markFetchStarted(1100)).toBe(true)
    expect(barrier.markFetchStarted(1200)).toBe(false)
    expect(barrier.snapshot()).toEqual({
      startupGraceMs: 100,
      pluginSetupReturnedAtMs: 1000,
      firstCatalogAvailableAtMs: 1010,
      firstFetchStartedAtMs: 1100,
    })
  })

  it('keeps the first setup/catalog anchors on repeated marks', () => {
    const barrier = new StartupBarrier({ startupGraceMs: 0 })
    barrier.markSetupReturned(100)
    barrier.markSetupReturned(200)
    barrier.markCatalogAvailable(150)
    barrier.markCatalogAvailable(250)
    expect(barrier.snapshot()).toEqual({
      startupGraceMs: 0,
      pluginSetupReturnedAtMs: 100,
      firstCatalogAvailableAtMs: 150,
    })
  })

  it('rejects invalid grace and timestamps', () => {
    expect(() => new StartupBarrier({ startupGraceMs: -1 })).toThrow(StartupBarrierConfigError)
    expect(() => new StartupBarrier({ startupGraceMs: 1.5 })).toThrow(StartupBarrierConfigError)
    const barrier = new StartupBarrier({ startupGraceMs: 0 })
    expect(() => barrier.markSetupReturned(-1)).toThrow(StartupBarrierConfigError)
    expect(() => barrier.canStartFetch(Number.NaN)).toThrow(StartupBarrierConfigError)
  })
})

describe('projectRoutes', () => {
  it('projects only ready routes, deduplicates and preserves explicit items', () => {
    const draft = projectRoutes({
      semantics: 'strict',
      inventoryComplete: true,
      routes: [
        route({ selectionKey: 'z' }),
        route({ selectionKey: 'm1', invocationId: 'duplicate' }),
        route({ selectionKey: 'not-ready', readiness: 'not-ready' }),
        route({ selectionKey: 'unknown', readiness: 'unknown' }),
        route({ selectionKey: 'z', invocationId: 'duplicate-z' }),
      ],
      explicitSelectionKeys: ['manual', 'm1'],
      previousPluginSelectionKeys: ['old', 'z'],
    })
    expect(draft.state).toBe('fresh')
    expect(draft.strict).toBe(true)
    expect(draft.autoRoutes.map((item) => item.selectionKey)).toEqual(['m1', 'z'])
    expect(draft.visibleSelectionKeys).toEqual(['m1', 'manual', 'z'])
    expect(draft.removedPluginSelectionKeys).toEqual(['old'])
  })

  it('intersects automatic routes with an explicit user whitelist', () => {
    const draft = projectRoutes({
      semantics: 'strict',
      inventoryComplete: true,
      routes: [route({ selectionKey: 'a' }), route({ selectionKey: 'b' })],
      explicitSelectionKeys: ['manual'],
      userWhitelist: ['b', 'missing'],
    })
    expect(draft.autoRoutes.map((item) => item.selectionKey)).toEqual(['b'])
    expect(draft.visibleSelectionKeys).toEqual(['b', 'manual'])
  })

  it('complete empty strict inventory withdraws prior plugin-owned routes', () => {
    const draft = projectRoutes({
      semantics: 'strict',
      inventoryComplete: true,
      routes: [],
      explicitSelectionKeys: ['manual'],
      previousPluginSelectionKeys: ['old'],
    })
    expect(draft.state).toBe('strict-empty')
    expect(draft.removedPluginSelectionKeys).toEqual(['old'])
    expect(draft.visibleSelectionKeys).toEqual(['manual'])
  })

  it('observed empty inventory keeps explicit items and does not strict-remove', () => {
    const draft = projectRoutes({
      semantics: 'observed',
      inventoryComplete: true,
      routes: [],
      explicitSelectionKeys: ['manual'],
      previousPluginSelectionKeys: ['old'],
    })
    expect(draft.state).toBe('explicit-only')
    expect(draft.strict).toBe(false)
    expect(draft.removedPluginSelectionKeys).toEqual(['old'])
  })

  it('partial/unavailable strict input fails closed and withdraws old auto routes', () => {
    const draft = projectRoutes({
      semantics: 'strict',
      inventoryComplete: false,
      routes: [route({ selectionKey: 'should-not-appear' })],
      explicitSelectionKeys: ['manual'],
      previousPluginSelectionKeys: ['old'],
    })
    expect(draft.state).toBe('strict-empty')
    expect(draft.autoRoutes).toEqual([])
    expect(draft.removedPluginSelectionKeys).toEqual(['old'])
    expect(draft.visibleSelectionKeys).toEqual(['manual'])
  })

  it('no-contribution never mutates automatic contribution', () => {
    const draft = projectRoutes({
      noContribution: true,
      semantics: 'strict',
      inventoryComplete: true,
      routes: [route({ selectionKey: 'host-owned' })],
      explicitSelectionKeys: ['manual'],
      previousPluginSelectionKeys: ['old'],
    })
    expect(draft.state).toBe('no-contribution')
    expect(draft.autoRoutes).toEqual([])
    expect(draft.removedPluginSelectionKeys).toEqual([])
    expect(draft.visibleSelectionKeys).toEqual(['manual'])
  })

  it('manual preserve prevents strict claims while retaining discovered routes', () => {
    const draft = projectRoutes({
      semantics: 'strict',
      manualModels: 'preserve',
      inventoryComplete: true,
      routes: [route({ selectionKey: 'a' })],
    })
    expect(draft.state).toBe('fresh')
    expect(draft.strict).toBe(false)
    expect(draft.reason).toBe('complete-observed-inventory')
  })
})

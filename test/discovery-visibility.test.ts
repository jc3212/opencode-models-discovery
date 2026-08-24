import { describe, expect, it } from 'vitest'

import type { DiscoveredRoute } from '../src/discovery/types'
import { applyOwnershipGuard, resolveV1Whitelist } from '../src/discovery/visibility/v1-whitelist'
import { buildV2CatalogTransform } from '../src/discovery/visibility/v2-catalog'
import { projectRoutes } from '../src/discovery/projector'

function route(key: string, readiness: DiscoveredRoute['readiness'] = 'ready'): DiscoveredRoute {
  return {
    selectionKey: key,
    invocationId: key,
    routeKind: 'model-name',
    readiness,
    maturity: 'stable',
  }
}

describe('resolveV1Whitelist', () => {
  const models = [
    { selectionKey: 'k-dep-a', effectiveRemoteApiId: 'qwen-max' },
    { selectionKey: 'k-dep-b', effectiveRemoteApiId: 'qwen-max' },
    { selectionKey: 'k-other', effectiveRemoteApiId: 'glm-4' },
  ]

  it('passes through undefined as no restriction', () => {
    const r = resolveV1Whitelist({ models, userWhitelist: undefined })
    expect(r.selectionKeyWhitelist).toBeUndefined()
    expect(r.ignoredEntries).toEqual([])
  })

  it('maps exact effectiveRemoteApiId matches to all selection keys', () => {
    const r = resolveV1Whitelist({ models, userWhitelist: ['qwen-max'] })
    expect(r.selectionKeyWhitelist).toEqual(['k-dep-a', 'k-dep-b'])
    expect(r.ignoredEntries).toEqual([])
  })

  it('rejects near-misses instead of guessing', () => {
    const r = resolveV1Whitelist({ models, userWhitelist: ['QWEN-MAX', 'qwen-ma', 'glm-4-x'] })
    expect(r.selectionKeyWhitelist).toEqual([])
    expect(r.ignoredEntries).toEqual(['QWEN-MAX', 'glm-4-x', 'qwen-ma'])
  })

  it('treats an explicitly empty whitelist as fully restrictive', () => {
    const r = resolveV1Whitelist({ models, userWhitelist: [] })
    expect(r.selectionKeyWhitelist).toEqual([])
    expect(r.ignoredEntries).toEqual([])
  })

  it('deduplicates and sorts both outputs and skips blank entries', () => {
    const r = resolveV1Whitelist({
      models,
      userWhitelist: ['glm-4', 'glm-4', '', 'qwen-max'],
    })
    expect(r.selectionKeyWhitelist).toEqual(['k-dep-a', 'k-dep-b', 'k-other'])
    expect(r.ignoredEntries).toEqual([])
  })

  it('integrates with the projector as a selection-key intersection', () => {
    const resolution = resolveV1Whitelist({
      models: [
        { selectionKey: 'm1', effectiveRemoteApiId: 'm1' },
        { selectionKey: 'm2', effectiveRemoteApiId: 'm2' },
      ],
      userWhitelist: ['m2'],
    })
    const draft = projectRoutes({
      semantics: 'observed',
      inventoryComplete: true,
      routes: [route('m1'), route('m2')],
      userWhitelist: resolution.selectionKeyWhitelist,
    })
    expect(draft.autoRoutes.map((r) => r.selectionKey)).toEqual(['m2'])
  })
})

describe('applyOwnershipGuard', () => {
  it('removes only absent keys that were previously plugin-owned', () => {
    const r = applyOwnershipGuard({
      currentSelectionKeys: ['kept-current'],
      removableCandidates: ['kept-current', 'gone-owned', 'gone-foreign', 'gone-explicit'],
      previouslyPluginOwnedKeys: ['kept-current', 'gone-owned'],
    })
    expect(r.removed).toEqual(['gone-owned'])
    expect(r.kept).toEqual(['gone-explicit', 'gone-foreign'])
  })

  it('treats missing ownership data as remove-nothing', () => {
    const r = applyOwnershipGuard({
      currentSelectionKeys: [],
      removableCandidates: ['a', 'b'],
      previouslyPluginOwnedKeys: undefined,
    })
    expect(r.removed).toEqual([])
    expect(r.kept).toEqual(['a', 'b'])
  })
})

describe('buildV2CatalogTransform', () => {
  it('retains the previous draft when the inventory is not complete', () => {
    const t = buildV2CatalogTransform({
      inventoryComplete: false,
      autoRoutes: [route('m1')],
      previouslyPluginOwnedKeys: ['stale'],
    })
    expect(t).toEqual({ kind: 'retain-previous', reason: 'inventory-unavailable' })
  })

  it('rebuilds the plugin-owned section wholesale on complete inventory', () => {
    const t = buildV2CatalogTransform({
      inventoryComplete: true,
      autoRoutes: [route('m2'), route('m1'), route('m1'), route('m3', 'not-ready'), route('m4', 'unknown')],
      previouslyPluginOwnedKeys: ['old-1'],
    })
    if (t.kind !== 'fresh') throw new Error('expected fresh draft')
    expect(t.draft.pluginOwnedRoutes.map((r) => r.selectionKey)).toEqual(['m1', 'm2'])
    expect(t.draft.removedPluginSelectionKeys).toEqual(['old-1'])
    expect(t.draft.preservedExplicitSelectionKeys).toEqual([])
  })

  it('never removes explicit or foreign keys and keeps surviving owned keys', () => {
    const t = buildV2CatalogTransform({
      inventoryComplete: true,
      autoRoutes: [route('survivor')],
      explicitSelectionKeys: ['explicit-1'],
      previouslyPluginOwnedKeys: ['survivor', 'vanished', 'explicit-1'],
    })
    if (t.kind !== 'fresh') throw new Error('expected fresh draft')
    expect(t.draft.removedPluginSelectionKeys).toEqual(['vanished'])
    expect(t.draft.preservedExplicitSelectionKeys).toEqual(['explicit-1'])
  })

  it('is deterministic for identical inputs', () => {
    const input = {
      inventoryComplete: true,
      autoRoutes: [route('b'), route('a')],
      previouslyPluginOwnedKeys: ['z'],
    }
    const t1 = buildV2CatalogTransform(input)
    const t2 = buildV2CatalogTransform(input)
    expect(t1).toEqual(t2)
  })
})

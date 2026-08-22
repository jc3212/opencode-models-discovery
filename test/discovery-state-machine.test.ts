import { describe, expect, it } from 'vitest'
import {
  initialDiscoveryState,
  reduceDiscovery,
  type DiscoveryEvent,
  type DiscoveryMachineState,
} from '../src/discovery/state-machine'

function drive(initial: DiscoveryMachineState, events: DiscoveryEvent[]): DiscoveryMachineState {
  return events.reduce((state, event) => reduceDiscovery(state, event), initial)
}

const REFRESHING: DiscoveryMachineState = { projection: 'fresh', refresh: 'refreshing' }

describe('discovery state machine (v3 §4.1)', () => {
  describe('initial states', () => {
    it('no-contribution providers are PAUSED, never silently active', () => {
      expect(initialDiscoveryState('none')).toEqual({ projection: 'no-contribution', refresh: 'paused' })
    })

    it('explicit-only providers are PAUSED until asked', () => {
      expect(initialDiscoveryState('explicit')).toEqual({ projection: 'explicit-only', refresh: 'paused' })
    })

    it('auto strict starts as unresolved-deny; observed keeps explicit items', () => {
      expect(initialDiscoveryState('auto')).toEqual({ projection: 'unresolved-deny', refresh: 'scheduled' })
      expect(initialDiscoveryState('auto', { semantics: 'observed' }))
        .toEqual({ projection: 'explicit-only', refresh: 'scheduled' })
    })
  })

  describe('REFRESH_COMPLETE outcomes', () => {
    it('complete non-empty becomes FRESH and schedules the next cycle', () => {
      const next = reduceDiscovery(REFRESHING, {
        type: 'REFRESH_COMPLETE',
        outcome: 'complete-nonempty',
      })
      expect(next).toEqual({ projection: 'fresh', refresh: 'scheduled' })
    })

    it('complete empty is authoritative for strict surfaces -> STRICT_EMPTY', () => {
      const next = reduceDiscovery(REFRESHING, {
        type: 'REFRESH_COMPLETE',
        outcome: 'complete-empty',
        semantics: 'strict',
      })
      expect(next.projection).toBe('strict-empty')
      expect(next.refresh).toBe('scheduled')
    })

    it('complete empty on observed surfaces keeps explicit items (EXPLICIT_ONLY)', () => {
      const next = reduceDiscovery(REFRESHING, {
        type: 'REFRESH_COMPLETE',
        outcome: 'complete-empty',
        semantics: 'observed',
      })
      expect(next).toEqual({ projection: 'explicit-only', refresh: 'scheduled' })
    })

    it('partial results never overwrite a complete LKG (PARTIAL-DOES-NOT-REMOVE)', () => {
      const next = reduceDiscovery(
        { projection: 'fresh', refresh: 'refreshing' },
        { type: 'REFRESH_COMPLETE', outcome: 'partial', hasValidLkg: true },
      )
      expect(next).toEqual({ projection: 'stale-allowed', refresh: 'backoff' })
    })

    it('partial without LKG fails closed per semantics', () => {
      const strict = reduceDiscovery(REFRESHING, {
        type: 'REFRESH_COMPLETE',
        outcome: 'invalid',
        semantics: 'strict',
      })
      expect(strict).toEqual({ projection: 'strict-empty', refresh: 'backoff' })

      const observed = reduceDiscovery(REFRESHING, {
        type: 'REFRESH_COMPLETE',
        outcome: 'partial',
        semantics: 'observed',
      })
      expect(observed).toEqual({ projection: 'explicit-only', refresh: 'backoff' })
    })

    it('304 keeps an existing fresh/stale projection; without LKG it degrades', () => {
      const fresh = reduceDiscovery(REFRESHING, { type: 'REFRESH_COMPLETE', outcome: 'not-modified' })
      expect(fresh).toEqual({ projection: 'fresh', refresh: 'scheduled' })

      const withLkg = reduceDiscovery(
        { projection: 'explicit-only', refresh: 'refreshing' },
        { type: 'REFRESH_COMPLETE', outcome: 'not-modified', hasValidLkg: true },
      )
      expect(withLkg).toEqual({ projection: 'stale-allowed', refresh: 'scheduled' })

      const noLkg = reduceDiscovery(
        { projection: 'explicit-only', refresh: 'refreshing' },
        { type: 'REFRESH_COMPLETE', outcome: 'not-modified', hasValidLkg: false },
      )
      expect(noLkg.refresh).toBe('backoff')
      expect(['strict-empty', 'explicit-only']).toContain(noLkg.projection)
    })

    it('orphan completions (no owning job) do not advance the machine', () => {
      const idle: DiscoveryMachineState = { projection: 'fresh', refresh: 'idle' }
      expect(reduceDiscovery(idle, { type: 'REFRESH_COMPLETE', outcome: 'complete-nonempty' })).toBe(idle)
    })
  })

  describe('transient failures and hard-stale expiry', () => {
    it('transient failure with valid LKG -> STALE_ALLOWED + BACKOFF', () => {
      const next = reduceDiscovery(REFRESHING, { type: 'TRANSIENT_FAILURE', hasValidLkg: true })
      expect(next).toEqual({ projection: 'stale-allowed', refresh: 'backoff' })
    })

    it('HARD_TTL_DUE revokes stale strict projections but allows retries', () => {
      const next = reduceDiscovery(
        { projection: 'stale-allowed', refresh: 'backoff' },
        { type: 'HARD_TTL_DUE', semantics: 'strict' },
      )
      expect(next).toEqual({ projection: 'strict-empty', refresh: 'scheduled' })
    })

    it('HARD_TTL_DUE on observed surfaces drops discovered items, keeps explicit', () => {
      const next = reduceDiscovery(
        { projection: 'stale-allowed', refresh: 'backoff' },
        { type: 'HARD_TTL_DUE', semantics: 'observed' },
      )
      expect(next).toEqual({ projection: 'explicit-only', refresh: 'scheduled' })
    })
  })

  describe('auth errors distinguish key death from enumeration limits (§7.1)', () => {
    it('confirmed identity failure blocks the current generation', () => {
      const next = reduceDiscovery(REFRESHING, {
        type: 'AUTH_ERROR',
        confirmedIdentityAuthFailure: true,
      })
      expect(next).toEqual({ projection: 'auth-blocked', refresh: 'backoff' })
    })

    it('enumeration-unsupported degrades to EXPLICIT_ONLY + PAUSED, zero tombstone', () => {
      const before: DiscoveryMachineState = { projection: 'fresh', refresh: 'refreshing' }
      const next = reduceDiscovery(before, { type: 'AUTH_ERROR', confirmedIdentityAuthFailure: false })
      expect(next).toEqual({ projection: 'explicit-only', refresh: 'paused' })
    })
  })

  describe('trigger handling and singleflight', () => {
    it('manual refresh overrides backoff', () => {
      const backoff: DiscoveryMachineState = { projection: 'stale-allowed', refresh: 'backoff' }
      expect(reduceDiscovery(backoff, { type: 'MANUAL_REFRESH' }).refresh).toBe('scheduled')
    })

    it('soft TTL during backoff waits; refreshing state coalesces triggers', () => {
      const backoff: DiscoveryMachineState = { projection: 'fresh', refresh: 'backoff' }
      expect(reduceDiscovery(backoff, { type: 'SOFT_TTL_DUE' }).refresh).toBe('backoff')

      expect(reduceDiscovery(REFRESHING, { type: 'SOFT_TTL_DUE' })).toBe(REFRESHING)
      expect(reduceDiscovery(REFRESHING, { type: 'MANUAL_REFRESH' })).toBe(REFRESHING)
    })

    it('credential observation unblocks unresolved-deny and paused machines', () => {
      const resolved = reduceDiscovery(
        { projection: 'unresolved-deny', refresh: 'scheduled' },
        { type: 'CREDENTIAL_OBSERVED' },
      )
      expect(resolved).toEqual({ projection: 'explicit-only', refresh: 'scheduled' })

      const resumed = reduceDiscovery(
        { projection: 'explicit-only', refresh: 'paused' },
        { type: 'CREDENTIAL_OBSERVED' },
      )
      expect(resumed.refresh).toBe('scheduled')
    })

    it('POST_SETUP_DEFERRED only unblocks idle scheduling (not a ready signal)', () => {
      const idle: DiscoveryMachineState = { projection: 'explicit-only', refresh: 'idle' }
      expect(reduceDiscovery(idle, { type: 'POST_SETUP_DEFERRED' }).refresh).toBe('scheduled')
      expect(reduceDiscovery(REFRESHING, { type: 'POST_SETUP_DEFERRED' })).toBe(REFRESHING)
    })
  })

  describe('DISPOSED terminal (§3.3 finalizer order)', () => {
    it('dispose terminates both machines and swallows every later event', () => {
      const disposed = drive(
        { projection: 'fresh', refresh: 'refreshing' },
        [
          { type: 'DISPOSE' },
          { type: 'MANUAL_REFRESH' },
          { type: 'REFRESH_COMPLETE', outcome: 'complete-nonempty' },
          { type: 'AUTH_ERROR', confirmedIdentityAuthFailure: true },
          { type: 'DISPOSE' },
        ],
      )
      expect(disposed).toEqual({ projection: 'disposed', refresh: 'disposed' })
    })

    it('late completion after dispose cannot resurrect publication rights', () => {
      const disposed: DiscoveryMachineState = { projection: 'disposed', refresh: 'disposed' }
      expect(reduceDiscovery(disposed, { type: 'REFRESH_COMPLETE', outcome: 'complete-nonempty' })).toBe(disposed)
    })
  })

  describe('composed lifecycle scenarios (§16.1 mappings)', () => {
    it('KEY-A-TO-B style flow: revoke then strict-empty until new identity succeeds', () => {
      // Identity switch is modeled by seeding a NEW machine for key B
      // without LKG; the old machine for key A is disposed.
      const keyA = initialDiscoveryState('auto')
      const afterA = drive(keyA, [
        { type: 'CREDENTIAL_OBSERVED' },
        { type: 'MANUAL_REFRESH' },
        { type: 'REFRESH_STARTED' },
        { type: 'REFRESH_COMPLETE', outcome: 'complete-nonempty' },
      ])
      expect(afterA.projection).toBe('fresh')

      const disposedA = reduceDiscovery(afterA, { type: 'DISPOSE' })
      expect(disposedA.projection).toBe('disposed')

      const keyBNoLkg = initialDiscoveryState('auto')
      const refreshedB = drive(keyBNoLkg, [
        { type: 'TRANSIENT_FAILURE', hasValidLkg: false },
      ])
      expect(refreshedB).toEqual({ projection: 'strict-empty', refresh: 'backoff' })
    })

    it('relay group change: fresh -> complete shrink publishes strict empty', () => {
      const state = drive(initialDiscoveryState('auto'), [
        { type: 'CREDENTIAL_OBSERVED' },
        { type: 'REFRESH_STARTED' },
        { type: 'REFRESH_COMPLETE', outcome: 'complete-nonempty' },
        { type: 'MANUAL_REFRESH' },
        { type: 'REFRESH_STARTED' },
        { type: 'REFRESH_COMPLETE', outcome: 'complete-empty', semantics: 'strict' },
      ])
      expect(state).toEqual({ projection: 'strict-empty', refresh: 'scheduled' })
    })
  })
})

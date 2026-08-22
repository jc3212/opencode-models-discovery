/**
 * Orthogonal Projection x Refresh state machine (v3 plan §4.1; WP4 core).
 *
 * Pure reducer: no I/O, no clocks, no side effects. Callers own timers,
 * identity epochs, and publication. The machine encodes only the transition
 * law from the plan:
 *
 * - complete non-empty -> FRESH
 * - complete empty: strict/policy -> STRICT_EMPTY; observed/catalog ->
 *   EXPLICIT_ONLY (keep explicit items)
 * - transient/partial with valid same-identity LKG -> STALE_ALLOWED + BACKOFF
 * - transient/partial without LKG -> strict STRICT_EMPTY / observed
 *   EXPLICIT_ONLY + BACKOFF (never delete explicit items)
 * - HARD_TTL_DUE revokes auto stale contributions (strict -> STRICT_EMPTY;
 *   observed drops plugin-owned discovered items but keeps explicit) and may
 *   still schedule retries
 * - AUTH_ERROR blocks only when the adapter contract confirms the inference
 *   credential identity itself failed; enumeration-unsupported degrades to
 *   EXPLICIT_ONLY + PAUSED and never writes auth tombstones here
 * - DISPOSED is terminal; every later event is ignored
 *
 * Identity changes are NOT modeled as events here: callers bump an epoch,
 * build a fresh machine seeded from the exact new-identity LKG, and revoke
 * the old projection before any network activity (§4.2).
 */

import type {
  DiscoveryEvent,
  DiscoveryMachineState,
  ProjectionState,
  RefreshState,
} from './types'

export type { DiscoveryEvent, DiscoveryMachineState, ProjectionState, RefreshState }

export type ContributionKind = 'none' | 'explicit' | 'auto'

export interface InitialMachineOptions {
  /** Inventory semantics driving empty/stale decisions for this provider. */
  semantics?: 'strict' | 'observed'
}

const TERMINAL: Readonly<DiscoveryMachineState> = Object.freeze({
  projection: 'disposed',
  refresh: 'disposed',
})

function isTerminal(state: DiscoveryMachineState): boolean {
  return state.refresh === 'disposed'
}

/** Initial state before any event, per contribution kind (§3.2 step 1). */
export function initialDiscoveryState(
  contribution: ContributionKind,
  options: InitialMachineOptions = {},
): DiscoveryMachineState {
  switch (contribution) {
    case 'none':
      // Disabled/no-op providers must be PAUSED, never mistaken for no-op by
      // accident later (plan §3.2: "RefreshState=PAUSED，不能误作 no-op").
      return { projection: 'no-contribution', refresh: 'paused' }
    case 'explicit':
      return { projection: 'explicit-only', refresh: 'paused' }
    case 'auto':
      return {
        projection: options.semantics === 'observed' ? 'explicit-only' : 'unresolved-deny',
        refresh: 'scheduled',
      }
  }
}

function staleFallbackProjection(semantics: 'strict' | 'observed'): ProjectionState {
  return semantics === 'observed' ? 'explicit-only' : 'strict-empty'
}

type RefreshCompleteEvent = Extract<DiscoveryEvent, { type: 'REFRESH_COMPLETE' }>

function afterComplete(
  state: DiscoveryMachineState,
  event: RefreshCompleteEvent,
): DiscoveryMachineState {
  const { outcome, semantics } = event
  switch (outcome) {
    case 'complete-nonempty':
      return { projection: 'fresh', refresh: 'scheduled' }
    case 'complete-empty':
      // Authoritative emptiness is a first-class outcome (§8.4): strict
      // surfaces publish an authoritative empty set; observed surfaces keep
      // explicit items and simply record the empty observation.
      return {
        projection: semantics === 'observed' ? 'explicit-only' : 'strict-empty',
        refresh: 'scheduled',
      }
    case 'not-modified': {
      // 304 is legal only against an exact complete LKG (§8.4); otherwise it
      // degrades to the partial path.
      if (state.projection === 'fresh' || state.projection === 'stale-allowed') {
        return { projection: state.projection, refresh: 'scheduled' }
      }
      if (event.hasValidLkg) {
        return { projection: 'stale-allowed', refresh: 'scheduled' }
      }
      return { projection: staleFallbackProjection(semantics), refresh: 'backoff' }
    }
    case 'partial':
    case 'invalid':
      // A partial or invalid payload NEVER overwrites a complete LKG and
      // never publishes freshness (invariant §2.5, §16.2 PARTIAL-DOES-NOT-
      // REMOVE).
      if (event.hasValidLkg) {
        return { projection: 'stale-allowed', refresh: 'backoff' }
      }
      return { projection: staleFallbackProjection(semantics), refresh: 'backoff' }
    default:
      return state
  }
}

/**
 * Applies one event to the machine. Returns the SAME state object when the
 * event is ignored (terminal machine), enabling cheap change detection.
 */
export function reduceDiscovery(
  state: DiscoveryMachineState,
  event: DiscoveryEvent,
): DiscoveryMachineState {
  if (isTerminal(state)) {
    return state
  }

  switch (event.type) {
    case 'DISPOSE':
      return TERMINAL

    case 'PLAN_CHANGED': {
      // Contribution kind changes are handled by re-seeding via
      // initialDiscoveryState at the call site (identity/epoch boundary);
      // the reducer treats this as informational while active.
      return state
    }

    case 'CREDENTIAL_OBSERVED':
      // A newly resolved credential makes refresh schedulable again.
      if (state.projection === 'unresolved-deny') {
        return { projection: 'explicit-only', refresh: 'scheduled' }
      }
      if (state.refresh === 'paused') {
        return { ...state, refresh: 'scheduled' }
      }
      return state

    case 'POST_SETUP_DEFERRED':
      // Setup returned without network; background work may now start. This
      // is NOT a ready signal — it only unblocks scheduling (§4.3).
      if (state.refresh === 'idle') {
        return { ...state, refresh: 'scheduled' }
      }
      return state

    case 'REFRESH_STARTED':
      // Only an owned, scheduled slot may transition to refreshing; this is
      // what makes late completions detectable as orphans afterwards.
      if (state.refresh === 'scheduled') {
        return { ...state, refresh: 'refreshing' }
      }
      return state

    case 'SOFT_TTL_DUE':
    case 'CACHE_REVISION_CHANGED':
    case 'MANUAL_REFRESH':
      if (state.refresh === 'refreshing') {
        // Singleflight: at most one job per exact JobKey; coalesce triggers.
        return state
      }
      if (state.refresh === 'backoff' && event.type !== 'MANUAL_REFRESH') {
        return state
      }
      return { ...state, refresh: 'scheduled' }

    case 'REFRESH_COMPLETE':
      if (state.refresh !== 'refreshing') {
        // Results from jobs nobody owns are late arrivals; publication
        // gating happens above this layer (epoch/generation check), but the
        // machine itself refuses to advance on orphan completions.
        return state
      }
      return afterComplete(state, event)

    case 'TRANSIENT_FAILURE': {
      const { semantics, hasValidLkg } = event
      if (hasValidLkg) {
        return { projection: 'stale-allowed', refresh: 'backoff' }
      }
      return { projection: staleFallbackProjection(semantics), refresh: 'backoff' }
    }

    case 'AUTH_ERROR':
      if (event.confirmedIdentityAuthFailure) {
        // Confirmed failure of the current credential generation: block that
        // generation's automatic projection. A new generation starts a fresh
        // machine (caller responsibility).
        return { projection: 'auth-blocked', refresh: 'backoff' }
      }
      // Enumeration-unsupported / inventory-permission denial: degrade to
      // explicit-only and pause. Never interpreted as key death (§7.1).
      return { projection: 'explicit-only', refresh: 'paused' }

    case 'HARD_TTL_DUE': {
      const { semantics } = event
      // Wall-clock hard-stale revocation requires a scheduler (V2 Effect).
      // Promise/V1 callers must not deliver this event mid-session (§4.1).
      return {
        projection: staleFallbackProjection(semantics),
        refresh: 'scheduled',
      }
    }

    default: {
      const exhaustive: never = event
      void exhaustive
      return state
    }
  }
}

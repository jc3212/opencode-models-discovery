/**
 * Per-consumer discovery coordinator (v3 plan §3.3, §4.1-§4.4).
 *
 * This is the orchestration core without a host-specific timer or network
 * implementation. It owns the consumer epoch, exact semantic identity and
 * credential generation pointers, singleflight refresh token, reducer state,
 * and publication gate. V2 Effect can place this owner in a Scope; V1 and
 * Promise callers can use the same reducer with no background owner.
 *
 * Safety laws:
 * - A semantic identity change increments epoch and immediately revokes the
 *   old automatic projection before a new refresh can publish.
 * - Credential generation changes do not cross semantic LKGs, and an old
 *   generation's completion cannot publish or write a new-generation state.
 * - At most one refresh token is active per coordinator.
 * - Late, orphaned, disposed, or plan-mismatched completions are ignored and
 *   explicitly reported as `stale-job`, never silently applied.
 */

import type { ConsumerKey } from './identity'
import type { DiscoveredRoute, DiscoveryEvent, DiscoveryMachineState } from './types'
import {
  initialDiscoveryState,
  reduceDiscovery,
  type ContributionKind,
} from './state-machine'
import { projectRoutes, type ProjectionDraft, type ProjectionSemantics } from './projector'

export type RefreshTrigger = 'post-setup' | 'soft-ttl' | 'hard-ttl' | 'cache-revision' | 'manual'
export type CompletionKind = 'complete' | 'not-modified' | 'partial' | 'invalid' | 'transient-failure' | 'auth-failure'

export interface CoordinatorIdentity {
  semanticIdentityHash: string
  credentialGenerationHash: string
}

export interface RefreshJobToken extends CoordinatorIdentity {
  readonly jobId: number
  readonly epoch: number
  readonly planGeneration: number
}

export interface CoordinatorSnapshot {
  consumer: ConsumerKey
  epoch: number
  planGeneration: number
  identity?: CoordinatorIdentity
  state: DiscoveryMachineState
  projection: ProjectionDraft
  activeJobId?: number
  disposed: boolean
}

export interface CoordinatorOptions {
  consumer: ConsumerKey
  semantics: ProjectionSemantics
  contribution: ContributionKind
  explicitSelectionKeys?: readonly string[]
  previousPluginSelectionKeys?: readonly string[]
  /** Raw user-facing allowlist entries; resolved upstream, intersected in the projector (§8.3). */
  userWhitelist?: readonly string[]
  manualModels?: 'intersect' | 'preserve'
  planGeneration?: number
}

export interface CompleteRefreshInput {
  token: RefreshJobToken
  kind: CompletionKind
  routes?: readonly DiscoveredRoute[]
  /** Whether an exact complete LKG exists and remains within hard TTL. */
  hasValidLkg?: boolean
  /**
   * For `kind='auth-failure'`: whether the adapter contract PROVES the
   * current inference credential itself was rejected (§8.4). Defaults to
   * true; enumeration-only or permission denials must pass false so the
   * machine degrades to explicit-only without a tombstone.
   */
  confirmedIdentityAuthFailure?: boolean
}

export interface CompletionResult {
  applied: boolean
  reason: 'applied' | 'stale-job' | 'no-active-job' | 'disposed'
  snapshot: CoordinatorSnapshot
}

function identityValid(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field} must be a 64-char lowercase hex hash`)
}

function mapTrigger(trigger: Exclude<RefreshTrigger, 'hard-ttl'>): 'POST_SETUP_DEFERRED' | 'SOFT_TTL_DUE' | 'CACHE_REVISION_CHANGED' | 'MANUAL_REFRESH' {
  switch (trigger) {
    case 'post-setup': return 'POST_SETUP_DEFERRED'
    case 'soft-ttl': return 'SOFT_TTL_DUE'
    case 'cache-revision': return 'CACHE_REVISION_CHANGED'
    case 'manual': return 'MANUAL_REFRESH'
  }
}

function triggerEvent(trigger: RefreshTrigger, semantics: ProjectionSemantics): DiscoveryEvent {
  if (trigger === 'hard-ttl') return { type: 'HARD_TTL_DUE', semantics }
  return { type: mapTrigger(trigger) }
}

function emptyProjection(options: CoordinatorOptions): ProjectionDraft {
  return projectRoutes({
    semantics: options.semantics,
    inventoryComplete: false,
    routes: [],
    explicitSelectionKeys: options.explicitSelectionKeys,
    previousPluginSelectionKeys: options.previousPluginSelectionKeys,
    userWhitelist: options.userWhitelist,
    manualModels: options.manualModels,
    noContribution: options.contribution === 'none',
  })
}

export class DiscoveryCoordinator {
  private readonly options: CoordinatorOptions
  private epochValue = 0
  private planGenerationValue: number
  private identityValue?: CoordinatorIdentity
  private stateValue: DiscoveryMachineState
  private projectionValue: ProjectionDraft
  private activeJob?: RefreshJobToken
  private readonly invalidatedJobIds = new Set<number>()
  private nextJobId = 1
  private disposedValue = false

  constructor(options: CoordinatorOptions) {
    this.options = {
      ...options,
      explicitSelectionKeys: [...(options.explicitSelectionKeys ?? [])],
      previousPluginSelectionKeys: [...(options.previousPluginSelectionKeys ?? [])],
      userWhitelist: options.userWhitelist === undefined ? undefined : [...options.userWhitelist],
    }
    this.planGenerationValue = options.planGeneration ?? 0
    if (!Number.isSafeInteger(this.planGenerationValue) || this.planGenerationValue < 0) {
      throw new TypeError('planGeneration must be a non-negative safe integer')
    }
    this.stateValue = initialDiscoveryState(options.contribution, { semantics: options.semantics })
    this.projectionValue = emptyProjection(options)
  }

  snapshot(): CoordinatorSnapshot {
    return {
      consumer: this.options.consumer,
      epoch: this.epochValue,
      planGeneration: this.planGenerationValue,
      ...(this.identityValue ? { identity: { ...this.identityValue } } : {}),
      state: { ...this.stateValue },
      projection: {
        ...this.projectionValue,
        visibleSelectionKeys: [...this.projectionValue.visibleSelectionKeys],
        autoRoutes: this.projectionValue.autoRoutes.map((route) => ({ ...route })),
        preservedExplicitSelectionKeys: [...this.projectionValue.preservedExplicitSelectionKeys],
        removedPluginSelectionKeys: [...this.projectionValue.removedPluginSelectionKeys],
      },
      ...(this.activeJob ? { activeJobId: this.activeJob.jobId } : {}),
      disposed: this.disposedValue,
    }
  }

  /**
   * Observes a semantic identity. Semantic changes revoke old projection and
   * invalidate jobs; pure generation rotation retains same-identity LKG.
   */
  observeIdentity(identity: CoordinatorIdentity): CoordinatorSnapshot {
    identityValid(identity.semanticIdentityHash, 'semanticIdentityHash')
    identityValid(identity.credentialGenerationHash, 'credentialGenerationHash')
    if (this.disposedValue) return this.snapshot()

    const changed = this.identityValue?.semanticIdentityHash !== identity.semanticIdentityHash
    this.identityValue = { ...identity }
    if (changed) {
      this.epochValue += 1
      if (this.activeJob) this.invalidatedJobIds.add(this.activeJob.jobId)
      this.activeJob = undefined
      this.planGenerationValue += 1
      this.projectionValue = emptyProjection(this.options)
      this.stateValue = {
        projection: this.options.semantics === 'strict' ? 'strict-empty' : 'explicit-only',
        refresh: 'scheduled',
      }
    }
    return this.snapshot()
  }

  /** Applies an exact same-identity local complete LKG before refresh. */
  applyLocalLkg(identity: CoordinatorIdentity, routes: readonly DiscoveredRoute[]): boolean {
    if (this.disposedValue || !this.identityValue ||
        this.identityValue.semanticIdentityHash !== identity.semanticIdentityHash ||
        this.identityValue.credentialGenerationHash !== identity.credentialGenerationHash) return false
    this.projectionValue = projectRoutes({
      semantics: this.options.semantics,
      inventoryComplete: true,
      routes,
      explicitSelectionKeys: this.options.explicitSelectionKeys,
      previousPluginSelectionKeys: this.options.previousPluginSelectionKeys,
      userWhitelist: this.options.userWhitelist,
      manualModels: this.options.manualModels,
      noContribution: this.options.contribution === 'none',
    })
    this.stateValue = { projection: this.projectionValue.state, refresh: 'scheduled' }
    return true
  }

  /** Dispatches a trigger and returns an exact singleflight job token. */
  beginRefresh(trigger: RefreshTrigger): RefreshJobToken | undefined {
    if (this.disposedValue || !this.identityValue || this.activeJob) return undefined
    this.stateValue = reduceDiscovery(this.stateValue, triggerEvent(trigger, this.options.semantics))
    if (this.stateValue.refresh !== 'scheduled') return undefined
    this.stateValue = reduceDiscovery(this.stateValue, { type: 'REFRESH_STARTED' })
    if (this.stateValue.refresh !== 'refreshing') return undefined
    const token: RefreshJobToken = {
      ...this.identityValue,
      jobId: this.nextJobId++,
      epoch: this.epochValue,
      planGeneration: this.planGenerationValue,
    }
    this.activeJob = token
    return { ...token }
  }

  private tokenIsCurrent(token: RefreshJobToken): boolean {
    return this.activeJob?.jobId === token.jobId &&
      this.activeJob.epoch === token.epoch &&
      this.activeJob.planGeneration === token.planGeneration &&
      this.identityValue?.semanticIdentityHash === token.semanticIdentityHash &&
      this.identityValue.credentialGenerationHash === token.credentialGenerationHash &&
      !this.disposedValue
  }

  completeRefresh(input: CompleteRefreshInput): CompletionResult {
    if (this.disposedValue) return { applied: false, reason: 'disposed', snapshot: this.snapshot() }
    if (!this.activeJob) {
      const reason = this.invalidatedJobIds.has(input.token.jobId) ? 'stale-job' : 'no-active-job'
      return { applied: false, reason, snapshot: this.snapshot() }
    }
    if (!this.tokenIsCurrent(input.token)) return { applied: false, reason: 'stale-job', snapshot: this.snapshot() }

    const hasValidLkg = input.hasValidLkg ?? (this.projectionValue.state === 'fresh' || this.projectionValue.state === 'stale-allowed')
    if (input.kind === 'auth-failure') {
      this.stateValue = reduceDiscovery(this.stateValue, {
        type: 'AUTH_ERROR',
        confirmedIdentityAuthFailure: input.confirmedIdentityAuthFailure ?? true,
      })
    } else if (input.kind === 'transient-failure') {
      this.stateValue = reduceDiscovery(this.stateValue, { type: 'TRANSIENT_FAILURE', semantics: this.options.semantics, hasValidLkg })
    } else {
      const outcome = input.kind === 'complete' ? (input.routes && input.routes.length > 0 ? 'complete-nonempty' : 'complete-empty') : input.kind
      this.stateValue = reduceDiscovery(this.stateValue, { type: 'REFRESH_COMPLETE', outcome, semantics: this.options.semantics, hasValidLkg })
      if (input.kind === 'complete') {
        this.projectionValue = projectRoutes({
          semantics: this.options.semantics,
          inventoryComplete: true,
          routes: input.routes ?? [],
          explicitSelectionKeys: this.options.explicitSelectionKeys,
          previousPluginSelectionKeys: this.options.previousPluginSelectionKeys,
          userWhitelist: this.options.userWhitelist,
          manualModels: this.options.manualModels,
          noContribution: this.options.contribution === 'none',
        })
      } else if (!hasValidLkg) {
        this.projectionValue = emptyProjection(this.options)
      }
    }
    this.activeJob = undefined
    return { applied: true, reason: 'applied', snapshot: this.snapshot() }
  }

  dispose(): CoordinatorSnapshot {
    if (!this.disposedValue) {
      this.disposedValue = true
      this.epochValue += 1
      this.activeJob = undefined
      this.stateValue = reduceDiscovery(this.stateValue, { type: 'DISPOSE' })
      this.projectionValue = { ...this.projectionValue, state: 'disposed', reason: 'disposed' }
    }
    return this.snapshot()
  }
}

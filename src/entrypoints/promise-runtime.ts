/**
 * Promise-backend discovery runtime (v3 plan §4.3, §4.4; WP8 groundwork).
 *
 * Pure composition of the frozen engine pieces — it owns NO new semantics:
 *
 * - Startup: resolve identity → observe → load cache v3 state. A tombstone
 *   for the exact (identity × generation) pair keeps the LKG dormant
 *   (`startup-auth-blocked`); a same-identity LKG within its hard-stale
 *   window is applied via `applyLocalLkg`; a hard-stale or unparseable one
 *   is never applied.
 * - Triggers map 1:1 onto coordinator triggers. `post-setup` additionally
 *   passes the startup barrier gate; `soft-ttl` / `hard-ttl` are chosen by
 *   the pure scheduler phase classification.
 * - One refresh run = adapter fetch → singleflight completion → cache v3
 *   persistence (§8.4 matrix) → optional evidence recording. Transport
 *   exceptions degrade to `transient-failure`, never to auth semantics.
 * - Tombstone eligibility is fail-safe: only `authTombstoneEligible=true`
 *   from the adapter can confirm an identity auth failure.
 */

import type { HmacSecret } from '../discovery/identity'
import { computeSemanticIdentityHash } from '../discovery/identity'
import {
  DiscoveryCoordinator,
  type CompletionResult,
  type CoordinatorOptions,
  type RefreshJobToken,
  type RefreshTrigger,
} from '../discovery/coordinator'
import { StartupBarrier } from '../discovery/startup-barrier'
import { classifySchedulePhase } from '../discovery/scheduler'
import type { ProjectionSemantics } from '../discovery/projector'
import type { SemanticInventoryIdentityV3 } from '../discovery/types'
import type { InventoryFetchResult } from '../discovery/adapters/shared'
import type { EvidenceLedger } from '../discovery/evidence/ledger'
import { deriveEvidenceFromObservation } from '../discovery/evidence/ledger'
import {
  applyRefreshCompletion,
  loadStartupCacheState,
  type AppliedRefreshPersistence,
} from '../discovery/refresh-persistence'

export interface ResolvedIdentityContext {
  identity: SemanticInventoryIdentityV3
  credentialGenerationHash: string
}

export interface PromiseDiscoveryRuntimeOptions extends Omit<
  CoordinatorOptions,
  'planGeneration' | 'semantics' | 'contribution'
> {
  secret: HmacSecret
  cacheRoot: string
  semantics: ProjectionSemantics
  contribution: CoordinatorOptions['contribution']
  planGeneration?: number
  /** Resolves the CURRENT semantic identity + credential generation. */
  resolveIdentity: () =>
    | ResolvedIdentityContext
    | undefined
    | Promise<ResolvedIdentityContext | undefined>
  /** Executes one provider inventory fetch for the exact context. */
  fetchInventory: (context: ResolvedIdentityContext) => Promise<InventoryFetchResult>
  freshSeconds: number
  hardStaleSeconds: number
  /** Non-negative grace period after setup return, in milliseconds. */
  startupGraceMs: number
  nowMs?: () => number
  randomSource?: () => number
  /** When set, successful applied completions record evidence here. */
  evidenceLedger?: EvidenceLedger
  evidenceSource?: { adapterId: string; endpoint: string }
}

export interface RuntimeStartupOutcome {
  appliedLkg: boolean
  reason:
    | 'identity-unresolved'
    | 'startup-auth-blocked'
    | 'lkg-applied-fresh'
    | 'lkg-applied-soft-due'
    | 'lkg-hard-stale-not-applied'
    | 'lkg-unusable-timestamp'
    | 'no-lkg'
}

export type BeginOutcome =
  | { started: true; token: RefreshJobToken }
  | { started: false; reason: string }

export interface RefreshRunSummary {
  status: 'completed' | 'skipped'
  reason?: string
  completion?: CompletionResult
  persistence?: AppliedRefreshPersistence
  recordedEvidence?: number
}

function normalizeReasonCode(reason: string): string {
  const cleaned = reason
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
  return cleaned.length > 0 ? cleaned : 'unspecified'
}

function transientFromError(error: unknown): InventoryFetchResult {
  return {
    kind: 'transient-failure',
    routes: [],
    reason: normalizeReasonCode(String((error as Error)?.message ?? error)).slice(0, 64),
    authTombstoneEligible: false,
    enumerationUnsupported: false,
  }
}

export class PromiseDiscoveryRuntime {
  private readonly options: PromiseDiscoveryRuntimeOptions
  readonly coordinator: DiscoveryCoordinator
  private readonly barrier: StartupBarrier
  private context?: ResolvedIdentityContext & { semanticIdentityHash: string }
  private activeToken?: RefreshJobToken
  private lastCompleteAtMs = 0
  private disposed = false

  constructor(options: PromiseDiscoveryRuntimeOptions) {
    this.options = options
    this.coordinator = new DiscoveryCoordinator({
      consumer: options.consumer,
      semantics: options.semantics,
      contribution: options.contribution,
      ...(options.explicitSelectionKeys !== undefined
        ? { explicitSelectionKeys: options.explicitSelectionKeys }
        : {}),
      ...(options.previousPluginSelectionKeys !== undefined
        ? { previousPluginSelectionKeys: options.previousPluginSelectionKeys }
        : {}),
      ...(options.userWhitelist !== undefined ? { userWhitelist: options.userWhitelist } : {}),
      ...(options.manualModels !== undefined ? { manualModels: options.manualModels } : {}),
      ...(options.planGeneration !== undefined
        ? { planGeneration: options.planGeneration }
        : {}),
    })
    this.barrier = new StartupBarrier({ startupGraceMs: options.startupGraceMs })
  }

  private now(): number {
    const value = this.options.nowMs?.() ?? Date.now()
    if (!Number.isFinite(value) || value < 0) throw new TypeError('nowMs must be non-negative')
    return value
  }

  markSetupReturned(atMs?: number): void {
    this.barrier.markSetupReturned(atMs ?? this.now())
  }

  async initialize(): Promise<RuntimeStartupOutcome> {
    if (this.disposed) return { appliedLkg: false, reason: 'no-lkg' }
    const ctx = await this.options.resolveIdentity()
    if (!ctx) return { appliedLkg: false, reason: 'identity-unresolved' }

    const semanticIdentityHash = computeSemanticIdentityHash(this.options.secret, ctx.identity)
    this.coordinator.observeIdentity({
      semanticIdentityHash,
      credentialGenerationHash: ctx.credentialGenerationHash,
    })
    this.context = { ...ctx, semanticIdentityHash }

    const state = await loadStartupCacheState({
      cacheRoot: this.options.cacheRoot,
      secret: this.options.secret,
      identity: ctx.identity,
      credentialGenerationHash: ctx.credentialGenerationHash,
    })
    if (state.tombstone) {
      // The confirmed auth failure for THIS exact pair still stands; the
      // cached LKG must not silently resurrect behind a rejected credential.
      return { appliedLkg: false, reason: 'startup-auth-blocked' }
    }
    if (!state.lkg) return { appliedLkg: false, reason: 'no-lkg' }

    const receivedMs = Date.parse(state.lkg.receivedAt)
    if (!Number.isFinite(receivedMs) || receivedMs < 0) {
      return { appliedLkg: false, reason: 'lkg-unusable-timestamp' }
    }
    const phase = classifySchedulePhase({
      nowMs: this.now(),
      lastCompleteAtMs: receivedMs,
      freshSeconds: this.options.freshSeconds,
      hardStaleSeconds: this.options.hardStaleSeconds,
    })
    if (phase === 'hard-stale') {
      return { appliedLkg: false, reason: 'lkg-hard-stale-not-applied' }
    }

    const identityRef = {
      semanticIdentityHash,
      credentialGenerationHash: ctx.credentialGenerationHash,
    }
    const applied = this.coordinator.applyLocalLkg(identityRef, state.lkg.routes)
    if (!applied) return { appliedLkg: false, reason: 'no-lkg' }
    this.lastCompleteAtMs = receivedMs
    this.barrier.markCatalogAvailable(this.now())
    return {
      appliedLkg: true,
      reason: phase === 'fresh' ? 'lkg-applied-fresh' : 'lkg-applied-soft-due',
    }
  }

  beginRefresh(trigger: RefreshTrigger): BeginOutcome {
    if (this.disposed) return { started: false, reason: 'disposed' }
    if (trigger === 'post-setup' && !this.barrier.canStartFetch(this.now())) {
      return { started: false, reason: 'startup-barrier' }
    }
    const token = this.coordinator.beginRefresh(trigger)
    if (!token) return { started: false, reason: 'coordinator-declined' }
    this.activeToken = token
    if (trigger === 'post-setup') this.barrier.markFetchStarted(this.now())
    return { started: true, token }
  }

  /** Classifies the current TTL phase and begins the matching refresh. */
  maybeBeginTtlRefresh(): BeginOutcome {
    if (this.activeToken) return { started: false, reason: 'already-running' }
    let phase: ReturnType<typeof classifySchedulePhase>
    try {
      phase = classifySchedulePhase({
        nowMs: this.now(),
        lastCompleteAtMs: this.lastCompleteAtMs,
        freshSeconds: this.options.freshSeconds,
        hardStaleSeconds: this.options.hardStaleSeconds,
      })
    } catch {
      return { started: false, reason: 'invalid-schedule-config' }
    }
    if (phase === 'fresh') return { started: false, reason: 'phase-fresh' }
    if (phase === 'never-completed') return { started: false, reason: 'phase-never-completed' }
    return this.beginRefresh(phase === 'soft-due' ? 'soft-ttl' : 'hard-ttl')
  }

  async runActiveRefresh(token: RefreshJobToken): Promise<RefreshRunSummary> {
    if (token !== this.activeToken) {
      return { status: 'skipped', reason: 'stale-token' }
    }
    const context = this.context
    if (!context) {
      this.activeToken = undefined
      return { status: 'skipped', reason: 'identity-unresolved' }
    }

    let result: InventoryFetchResult
    try {
      result = await this.options.fetchInventory(context)
    } catch (error) {
      result = transientFromError(error)
    }

    const completion = this.coordinator.completeRefresh({
      token,
      kind: result.kind,
      routes: result.kind === 'complete' || result.kind === 'partial' ? result.routes : undefined,
      confirmedIdentityAuthFailure: result.authTombstoneEligible,
    })
    this.activeToken = undefined

    const summary: RefreshRunSummary = { status: 'completed', completion }
    if (!completion.applied) return summary

    const now = this.now()
    const persistence = await applyRefreshCompletion({
      cacheRoot: this.options.cacheRoot,
      secret: this.options.secret,
      identity: context.identity,
      credentialGenerationHash: context.credentialGenerationHash,
      kind: result.kind,
      routes: result.routes,
      confirmedIdentityAuthFailure: result.authTombstoneEligible,
      receivedAt: new Date(now).toISOString(),
      quarantineReason: normalizeReasonCode(result.reason),
    })
    summary.persistence = persistence
    if (persistence.action === 'save-inventory' && result.kind === 'complete') {
      this.lastCompleteAtMs = now
    }

    if (this.options.evidenceLedger && this.options.evidenceSource &&
        (result.kind === 'complete' || result.kind === 'partial')) {
      const records = deriveEvidenceFromObservation({
        inventoryIdentityHash: context.semanticIdentityHash,
        outcome: result.kind === 'complete'
          ? (result.routes.length > 0 ? 'complete-nonempty' : 'complete-empty')
          : result.kind,
        observedRouteKeys: result.routes
          .filter((route) => route.readiness === 'ready')
          .map((route) => route.selectionKey),
        source: {
          adapterId: this.options.evidenceSource.adapterId,
          endpoint: this.options.evidenceSource.endpoint,
        },
        receivedAt: new Date(now).toISOString(),
      })
      this.options.evidenceLedger.record(records)
      summary.recordedEvidence = records.length
    }
    return summary
  }

  /** Current TTL phase for diagnostics; never self-schedules from it. */
  schedulePhase():
    | 'never-completed'
    | 'fresh'
    | 'soft-due'
    | 'hard-stale'
    | 'invalid-config' {
    try {
      return classifySchedulePhase({
        nowMs: this.now(),
        lastCompleteAtMs: this.lastCompleteAtMs,
        freshSeconds: this.options.freshSeconds,
        hardStaleSeconds: this.options.hardStaleSeconds,
      })
    } catch {
      return 'invalid-config'
    }
  }

  snapshot() {
    return this.coordinator.snapshot()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.activeToken = undefined
    this.coordinator.dispose()
  }
}

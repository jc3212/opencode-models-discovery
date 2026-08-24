/**
 * V2 Promise local-only entrypoint (v3 plan §3.3, §4.3; E1).
 *
 * The Promise backend has NO lifecycle owner, so it must NEVER create
 * background resources: no timers, no watchers, no deferred network. Every
 * network-touching operation happens synchronously inside an explicit
 * `refreshNow()` call driven by the host (command, CLI, config hook).
 * Scheduling phases remain visible as diagnostics only.
 *
 * Contract 18 (zero background resources): this module must not call
 * `setTimeout`, `setInterval`, `setImmediate`, or `queueMicrotask`; the
 * test suite asserts this directly.
 */

import {
  PromiseDiscoveryRuntime,
  type PromiseDiscoveryRuntimeOptions,
  type RefreshRunSummary,
  type RuntimeStartupOutcome,
} from './promise-runtime'
import type { CoordinatorSnapshot } from '../discovery/coordinator'
import type { SchedulePhase } from '../discovery/scheduler'

export type V2PromiseOptions = PromiseDiscoveryRuntimeOptions

export class V2PromiseEntrypoint {
  private readonly runtime: PromiseDiscoveryRuntime

  constructor(options: V2PromiseOptions) {
    this.runtime = new PromiseDiscoveryRuntime(options)
  }

  /** Loads cache state and activates a valid LKG. Never touches network. */
  initialize(): Promise<RuntimeStartupOutcome> {
    return this.runtime.initialize()
  }

  /**
   * The ONLY network path: one explicit singleflight refresh. Concurrent
   * calls are declined; late completions are ignored by the coordinator's
   * token gate.
   */
  async refreshNow(): Promise<RefreshRunSummary> {
    const begin = this.runtime.beginRefresh('manual')
    if (!begin.started) {
      return { status: 'skipped', reason: `refresh-declined:${begin.reason}` }
    }
    return this.runtime.runActiveRefresh(begin.token)
  }

  /** Records setup-return time for barrier diagnostics; starts nothing. */
  markSetupReturned(atMs?: number): void {
    this.runtime.markSetupReturned(atMs)
  }

  snapshot(): CoordinatorSnapshot {
    return this.runtime.snapshot()
  }

  /** Current TTL phase, diagnostic only — never self-schedules from it. */
  schedulePhase(): SchedulePhase | 'invalid-config' {
    return this.runtime.schedulePhase()
  }

  dispose(): void {
    this.runtime.dispose()
  }
}

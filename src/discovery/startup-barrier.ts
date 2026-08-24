/**
 * Post-setup startup barrier (v3 plan §3.3, §4.3, §4.4).
 *
 * This is deliberately not a ready hook and owns no timer. The host entrypoint
 * calls markSetupReturned() when plugin setup has returned, then asks whether
 * a scoped background fetch may begin. The first fetch is allowed only at or
 * after setupReturnedAt + startupGraceMs. V2 Effect owns the actual sleep or
 * schedule; Promise/V1 can use the same diagnostic state without pretending
 * to have a lifecycle owner.
 */

export class StartupBarrierConfigError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'StartupBarrierConfigError'
  }
}

export interface StartupBarrierOptions {
  /** Non-negative grace period after setup return, in milliseconds. */
  startupGraceMs: number
}

export interface StartupBarrierSnapshot {
  startupGraceMs: number
  pluginSetupReturnedAtMs?: number
  firstCatalogAvailableAtMs?: number
  firstFetchStartedAtMs?: number
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new StartupBarrierConfigError(`${field} must be a non-negative finite epoch timestamp`)
  }
  return value
}

function requireGrace(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StartupBarrierConfigError('startupGraceMs must be a non-negative safe integer')
  }
  return value
}

export class StartupBarrier {
  readonly startupGraceMs: number
  private pluginSetupReturnedAtMs?: number
  private firstCatalogAvailableAtMs?: number
  private firstFetchStartedAtMs?: number

  constructor(options: StartupBarrierOptions) {
    this.startupGraceMs = requireGrace(options.startupGraceMs)
  }

  /** Records setup completion. Repeated calls do not move the anchor. */
  markSetupReturned(atMs: number): void {
    const timestamp = requireTimestamp(atMs, 'setupReturnedAtMs')
    this.pluginSetupReturnedAtMs ??= timestamp
  }

  /** Records first local catalog availability; does not imply readiness. */
  markCatalogAvailable(atMs: number): void {
    const timestamp = requireTimestamp(atMs, 'firstCatalogAvailableAtMs')
    this.firstCatalogAvailableAtMs ??= timestamp
  }

  /**
   * True only after setup has returned and the grace barrier elapsed. This is
   * a scheduling permission, not a claim that the host is ready.
   */
  canStartFetch(atMs: number): boolean {
    const timestamp = requireTimestamp(atMs, 'nowMs')
    return this.pluginSetupReturnedAtMs !== undefined &&
      timestamp >= this.pluginSetupReturnedAtMs + this.startupGraceMs
  }

  /**
   * Records first fetch start and returns whether it was accepted. A fetch
   * before the barrier is rejected without mutating diagnostic state.
   */
  markFetchStarted(atMs: number): boolean {
    const timestamp = requireTimestamp(atMs, 'firstFetchStartedAtMs')
    if (this.firstFetchStartedAtMs !== undefined) return false
    if (!this.canStartFetch(timestamp)) return false
    this.firstFetchStartedAtMs = timestamp
    return true
  }

  snapshot(): StartupBarrierSnapshot {
    return {
      startupGraceMs: this.startupGraceMs,
      ...(this.pluginSetupReturnedAtMs !== undefined
        ? { pluginSetupReturnedAtMs: this.pluginSetupReturnedAtMs }
        : {}),
      ...(this.firstCatalogAvailableAtMs !== undefined
        ? { firstCatalogAvailableAtMs: this.firstCatalogAvailableAtMs }
        : {}),
      ...(this.firstFetchStartedAtMs !== undefined
        ? { firstFetchStartedAtMs: this.firstFetchStartedAtMs }
        : {}),
    }
  }
}

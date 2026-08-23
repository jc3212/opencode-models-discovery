/**
 * Pure refresh-timing decisions for the discovery engine (v3 plan §3.3,
 * §4.4 scheduler safety requirements minus any timer ownership).
 *
 * No I/O, no clock reads, no randomness beyond the injectable source —
 * every function takes `now`/random as arguments so tests pin behavior
 * exactly and long-run convergence is decidable without sleeping.
 *
 * Semantics locked here:
 * - Jitter is EARLY-ONLY: `nextRefreshAt = lastCompleteAt + fresh − jitter`,
 *   so a fresh hit never schedules later than the soft TTL allows (§4.4).
 * - The four phases map onto state machine events: `never-completed`
 *   (first fetch), `fresh` (no action), `soft-due` (SOFT_TTL_DUE), and
 *   `hard-stale` (HARD_TTL_DUE — strict stale must be withdrawn).
 * - Backoff honors a server-provided Retry-After as a floor and otherwise
 *   applies capped exponential FULL jitter, so retries spread instead of
 *   stampeding.
 */

export class SchedulerConfigError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulerConfigError'
  }
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SchedulerConfigError(`${field} must be a positive safe integer`)
  }
  return value
}

function requireNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new SchedulerConfigError(`${field} must be a non-negative finite number`)
  }
  return value
}

export interface NextRefreshInput {
  /** Epoch ms of the last complete, validated inventory (0 = never). */
  lastCompleteAtMs: number
  /** Soft TTL seconds; the earliest automatic re-check window. */
  freshSeconds: number
  /**
   * Upper bound for the early jitter fraction of freshSeconds (0..1).
   * Defaults to 0.1; the absolute jitter is also capped at 60s.
   */
  earlyJitterFraction?: number
  randomSource?: () => number
}

/**
 * Computes the next scheduled refresh epoch in ms. With the default random
 * source absent (deterministic mode) the jitter is zero, which keeps
 * snapshot tests stable; production callers always inject one.
 */
export function computeNextRefreshAtMs(input: NextRefreshInput): number {
  const lastCompleteAtMs = requireNonNegativeNumber(input.lastCompleteAtMs, 'lastCompleteAtMs')
  const freshMs = requirePositiveInt(input.freshSeconds, 'freshSeconds') * 1000
  const fraction = input.earlyJitterFraction ?? 0.1
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new SchedulerConfigError('earlyJitterFraction must be within [0, 1]')
  }
  const randomSource = input.randomSource ?? (() => 0)

  const jitterCapMs = Math.min(Math.floor(freshMs * fraction), 60_000)
  const jitterMs = Math.floor(randomSource() * (jitterCapMs + 1))
  // Early-only by construction: subtracting keeps us at or before the soft
  // deadline, never past it (§4.4).
  return lastCompleteAtMs + freshMs - jitterMs
}

export type SchedulePhase = 'never-completed' | 'fresh' | 'soft-due' | 'hard-stale'

export interface ClassifyScheduleInput {
  nowMs: number
  lastCompleteAtMs: number
  freshSeconds: number
  hardStaleSeconds: number
}

/**
 * Classifies where an exact identity stands relative to its TTLs.
 * Boundary semantics: `now === nextRefreshAt` is already `soft-due`;
 * `now === lastComplete + hardStale` is already `hard-stale`.
 */
export function classifySchedulePhase(input: ClassifyScheduleInput): SchedulePhase {
  const { nowMs, lastCompleteAtMs } = input
  const freshMs = requirePositiveInt(input.freshSeconds, 'freshSeconds') * 1000
  const hardMs = requirePositiveInt(input.hardStaleSeconds, 'hardStaleSeconds') * 1000
  if (!(hardMs > freshMs)) {
    throw new SchedulerConfigError('hardStaleSeconds must exceed freshSeconds')
  }
  requireNonNegativeNumber(nowMs, 'nowMs')
  requireNonNegativeNumber(lastCompleteAtMs, 'lastCompleteAtMs')

  if (lastCompleteAtMs === 0) return 'never-completed'
  const age = nowMs - lastCompleteAtMs
  if (age >= hardMs) return 'hard-stale'
  if (age >= freshMs) return 'soft-due'
  return 'fresh'
}

export interface BackoffInput {
  /** 1-based failed attempt counter. */
  attempt: number
  /** Server-provided Retry-After converted to ms, when present. */
  retryAfterMs?: number
  /** Base delay for exponential growth. Defaults to 2000ms. */
  baseMs?: number
  /** Hard ceiling for the randomized delay. Defaults to 60000ms. */
  maxMs?: number
  randomSource?: () => number
}

/**
 * Full-jitter capped exponential backoff. When the server sent
 * Retry-After, the result never comes back shorter than that floor —
 * hammering a rate limiter is exactly what the header asks us not to do.
 */
export function computeBackoffDelayMs(input: BackoffInput): number {
  const attempt = requirePositiveInt(input.attempt, 'attempt')
  if (input.retryAfterMs !== undefined) {
    requireNonNegativeNumber(input.retryAfterMs, 'retryAfterMs')
  }
  const baseMs = input.baseMs ?? 2000
  const maxMs = input.maxMs ?? 60_000
  requirePositiveInt(baseMs, 'baseMs')
  requirePositiveInt(maxMs, 'maxMs')
  if (maxMs < baseMs) {
    throw new SchedulerConfigError('maxMs must be greater than or equal to baseMs')
  }
  const randomSource = input.randomSource ?? (() => 0)

  const exponential = Math.min(baseMs * 2 ** (attempt - 1), maxMs)
  const ceiling = Math.min(maxMs, exponential)
  const jittered = Math.floor(randomSource() * (ceiling + 1))

  if (input.retryAfterMs !== undefined) {
    return Math.max(input.retryAfterMs, jittered)
  }
  return jittered
}

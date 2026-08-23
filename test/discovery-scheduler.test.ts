import { describe, expect, it } from 'vitest'
import {
  SchedulerConfigError,
  classifySchedulePhase,
  computeBackoffDelayMs,
  computeNextRefreshAtMs,
} from '../src/discovery/scheduler'

describe('computeNextRefreshAtMs', () => {
  it('lands at the soft deadline when jitter is zero (deterministic mode)', () => {
    expect(computeNextRefreshAtMs({ lastCompleteAtMs: 1000, freshSeconds: 300 })).toBe(301_000)
  })

  it('applies early-only jitter bounded by fraction and the absolute cap', () => {
    // random=1 → maximum jitter = min(0.1 * fresh, 60s)
    const maxJitter = computeNextRefreshAtMs({
      lastCompleteAtMs: 0,
      freshSeconds: 600,
      randomSource: () => 0.999999,
    })
    expect(maxJitter).toBe(600_000 - Math.min(60_000, 60_000))

    const small = computeNextRefreshAtMs({
      lastCompleteAtMs: 0,
      freshSeconds: 30,
      randomSource: () => 0.5,
    })
    // min(3s, 60s) * 0.5 → 1.5s before the deadline.
    expect(small).toBe(30_000 - 1500)

    // Jitter can never push the schedule past lastComplete + fresh.
    for (let i = 0; i < 50; i += 1) {
      const at = computeNextRefreshAtMs({
        lastCompleteAtMs: 10_000,
        freshSeconds: 300,
        randomSource: Math.random,
      })
      expect(at).toBeLessThanOrEqual(310_000)
      expect(at).toBeGreaterThanOrEqual(310_000 - 30_000)
    }
  })

  it('rejects invalid TTLs and out-of-range fractions', () => {
    expect(() => computeNextRefreshAtMs({ lastCompleteAtMs: 0, freshSeconds: 0 })).toThrow(
      SchedulerConfigError,
    )
    expect(() =>
      computeNextRefreshAtMs({ lastCompleteAtMs: 0, freshSeconds: 300, earlyJitterFraction: 1.5 }),
    ).toThrow(SchedulerConfigError)
    expect(() => computeNextRefreshAtMs({ lastCompleteAtMs: -1, freshSeconds: 300 })).toThrow(
      SchedulerConfigError,
    )
  })
})

describe('classifySchedulePhase', () => {
  const base = { lastCompleteAtMs: 1_000_000, freshSeconds: 300, hardStaleSeconds: 3600 }

  it('reports never-completed only when nothing has ever completed', () => {
    expect(classifySchedulePhase({ ...base, nowMs: 0, lastCompleteAtMs: 0 })).toBe('never-completed')
  })

  it('switches phases exactly on the boundary values', () => {
    expect(classifySchedulePhase({ ...base, nowMs: 1_000_000 + 299_999 })).toBe('fresh')
    expect(classifySchedulePhase({ ...base, nowMs: 1_000_000 + 300_000 })).toBe('soft-due')
    expect(classifySchedulePhase({ ...base, nowMs: 1_000_000 + 3_599_999 })).toBe('soft-due')
    expect(classifySchedulePhase({ ...base, nowMs: 1_000_000 + 3_600_000 })).toBe('hard-stale')
  })

  it('requires hardStale to exceed fresh', () => {
    expect(() =>
      classifySchedulePhase({ ...base, nowMs: 0, freshSeconds: 300, hardStaleSeconds: 300 }),
    ).toThrow(SchedulerConfigError)
  })
})

describe('computeBackoffDelayMs', () => {
  it('grows exponentially up to the ceiling with full jitter bounds', () => {
    // random=0 → minimum of the jitter window.
    expect(computeBackoffDelayMs({ attempt: 1, baseMs: 2000, maxMs: 60_000 })).toBe(0)
    // random≈1 → exactly the current exponential level (capped).
    expect(computeBackoffDelayMs({ attempt: 1, baseMs: 2000, maxMs: 60_000, randomSource: () => 0.999999 })).toBe(2000)
    expect(computeBackoffDelayMs({ attempt: 2, baseMs: 2000, maxMs: 60_000, randomSource: () => 0.999999 })).toBe(4000)
    expect(computeBackoffDelayMs({ attempt: 7, baseMs: 2000, maxMs: 60_000, randomSource: () => 0.999999 })).toBe(60_000)

    for (let i = 0; i < 50; i += 1) {
      const delay = computeBackoffDelayMs({
        attempt: 3,
        baseMs: 1000,
        maxMs: 8000,
        randomSource: Math.random,
      })
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThanOrEqual(4000)
    }
  })

  it('treats Retry-After as a floor even when jitter would be smaller', () => {
    const delay = computeBackoffDelayMs({
      attempt: 1,
      retryAfterMs: 45_000,
      baseMs: 2000,
      maxMs: 60_000,
      randomSource: () => 0,
    })
    expect(delay).toBe(45_000)
  })

  it('rejects invalid attempts, bases and ceilings', () => {
    expect(() => computeBackoffDelayMs({ attempt: 0 })).toThrow(SchedulerConfigError)
    expect(() => computeBackoffDelayMs({ attempt: 1, baseMs: 5000, maxMs: 1000 })).toThrow(
      SchedulerConfigError,
    )
  })
})

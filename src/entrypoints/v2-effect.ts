/**
 * V2 Effect entrypoint (v3 plan §3.3, §4.4; E2).
 *
 * The Effect backend is the ONLY owner of background resources. Default
 * entry contract: one `yieldNow` to the macrotask queue, then the startup
 * grace window, then a single post-setup refresh forked into the Scope.
 * Closing the Scope runs the finalizer, which disposes the runtime —
 * bumping epoch, aborting in-flight fetches, and tearing down state — and
 * must complete promptly (plan budget: well under 100 ms).
 */

import { Duration, Effect, type Scope } from 'effect'

import {
  PromiseDiscoveryRuntime,
  type PromiseDiscoveryRuntimeOptions,
} from './promise-runtime'
import type { CoordinatorSnapshot } from '../discovery/coordinator'

export type V2EffectOptions = PromiseDiscoveryRuntimeOptions

/**
 * Builds the scoped runtime: acquire creates the engine and forks the
 * post-setup refresh; release disposes it. Requires a Scope (use
 * `Effect.scoped` or embed in your own scope).
 */
export const makeV2EffectEntrypoint = (
  options: V2EffectOptions,
): Effect.Effect<PromiseDiscoveryRuntime, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const runtime = new PromiseDiscoveryRuntime(options)
      // This entrypoint runs after host setup by definition, so it anchors
      // the startup barrier itself before yielding.
      runtime.markSetupReturned(options.nowMs?.() ?? Date.now())
      yield* Effect.yieldNow
      // Cache-backed initialization: observe identity, load LKG/tombstone.
      // Never touches network; failures fall back to the safe empty start.
      yield* Effect.ignore(Effect.promise(() => runtime.initialize()))
      if (options.startupGraceMs > 0) {
        yield* Effect.sleep(Duration.millis(options.startupGraceMs))
      }
      yield* Effect.forkScoped(
        Effect.ignore(
          Effect.tryPromise({
            try: async () => {
              const begin = runtime.beginRefresh('post-setup')
              if (begin.started) await runtime.runActiveRefresh(begin.token)
            },
            catch: () => new V2EffectBackgroundError(),
          }),
        ),
      )
      return runtime
    }),
    (runtime) => Effect.sync(() => runtime.dispose()),
  )

/** Error marker for background-refresh failures (diagnostics only). */
export class V2EffectBackgroundError extends Error {
  readonly _tag = 'V2EffectBackgroundError'
  constructor() {
    super('v2-effect background refresh failed')
    this.name = 'V2EffectBackgroundError'
  }
}

/**
 * Runs `use` with the scoped runtime; disposal happens right after `use`
 * completes or fails.
 */
export const withV2EffectEntrypoint = <A, E, R>(
  options: V2EffectOptions,
  use: (runtime: PromiseDiscoveryRuntime) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> => Effect.scoped(makeV2EffectEntrypoint(options).pipe(Effect.flatMap(use)))

/** Snapshot accessor as an Effect for service-style composition. */
export const v2EffectSnapshot = (
  runtime: PromiseDiscoveryRuntime,
): Effect.Effect<CoordinatorSnapshot> => Effect.sync(() => runtime.snapshot())

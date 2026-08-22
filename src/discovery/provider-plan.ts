/**
 * Provider plan classification (v3 plan §3.2, §7.5; Gate 1 scope).
 *
 * The only classification in this first increment is NO_CONTRIBUTION for the
 * official OpenCode Zen / OpenCode Go providers: the host already implements
 * their model catalogs natively, so this plugin must not parse their keys,
 * contact any endpoint, read/write caches, or touch provider/model fields.
 * Everything else keeps the legacy discoverable behavior unchanged.
 *
 * Recognition is deliberately narrow (plan §5.1 `recognition`):
 * - explicit npm adapter `@ai-sdk/opencode`, OR
 * - an HTTPS base URL on an exact official origin.
 * A custom gateway that merely copies the path shape must never bypass
 * generic discovery; only the listed origins count as official.
 */

export type ProviderPlanKind = 'no-contribution' | 'discoverable'

export interface ProviderPlan {
  kind: ProviderPlanKind
  /** Stable diagnostic reason, e.g. `delegated-to-host`. */
  reason?: string
}

/** Exact official OpenCode Zen/Go origins (HTTPS only, host match). */
const OFFICIAL_ZEN_ORIGINS = new Set([
  'https://opencode.ai',
  'https://api.opencode.ai',
])

const OFFICIAL_ZEN_NPM = '@ai-sdk/opencode'

function extractOrigin(baseURL: unknown): string | undefined {
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) {
    return undefined
  }
  try {
    const url = new URL(baseURL.trim())
    if (url.protocol !== 'https:') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * Classifies a single configured provider. Pure function: no I/O, no env
 * reads, deterministic output for identical input.
 */
export function classifyProviderPlan(provider: unknown): ProviderPlan {
  const p = provider as { npm?: unknown; options?: { baseURL?: unknown } } | null | undefined
  if (!p || typeof p !== 'object') {
    return { kind: 'discoverable' }
  }

  if (p.npm === OFFICIAL_ZEN_NPM) {
    return { kind: 'no-contribution', reason: 'delegated-to-host' }
  }

  const origin = extractOrigin(p.options?.baseURL)
  if (origin && OFFICIAL_ZEN_ORIGINS.has(origin)) {
    return { kind: 'no-contribution', reason: 'delegated-to-host' }
  }

  return { kind: 'discoverable' }
}

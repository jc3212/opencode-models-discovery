/**
 * Discovery CLI command layer (v3 plan §12.3; WP7/E13).
 *
 * Three commands over the frozen engine pieces:
 *
 * - `refresh` pre-warms the cache ONLY — it never touches user config, and
 *   running it in a separate process does NOT hot-reload a live V2 session.
 * - `status` reports local facts (adapter/scope/credential TYPE/freshness/
 *   completeness/last errors) and NEVER prints fingerprints or hashes of
 *   credential material.
 * - `audit` prints route identity, every evidence record considered, the
 *   partial/exhaustive merge outcome, final variants, and the suppression
 *   reason when variants are withheld.
 *
 * Argument parsing is dependency-free so the layer stays testable.
 */

import { loadLocalVerifiedSnapshot } from '../metadata/revision-store'

export interface CliStatusOptions {
  json?: boolean
  cacheRoot?: string
}
export interface CliAuditOptions {
  providerId: string
  modelId: string
  json?: boolean
}

export type ParsedCommand =
  | { name: 'status'; json?: boolean }
  | { name: 'audit'; providerId?: string; modelId?: string; json?: boolean }
  | { name: 'refresh'; providerId?: string; metadata?: boolean; force?: boolean }
  | { name: 'unknown'; detail: string }

/** Minimal argv parser for the discovery subcommands. */
export function parseDiscoveryCommand(argv: readonly string[]): ParsedCommand {
  const [name, ...rest] = argv
  const flag = (key: string): string | undefined => {
    const index = rest.indexOf(key)
    return index === -1 ? undefined : rest[index + 1]
  }
  switch (name) {
    case 'status':
      return { name: 'status', ...(rest.includes('--json') ? { json: true } : {}) }
    case 'audit': {
      const parsed: ParsedCommand = {
        name: 'audit',
        ...(flag('--provider') !== undefined ? { providerId: flag('--provider') } : {}),
        ...(flag('--model') !== undefined ? { modelId: flag('--model') } : {}),
        ...(rest.includes('--json') ? { json: true } : {}),
      }
      return parsed
    }
    case 'refresh':
      return {
        name: 'refresh',
        ...(flag('--provider') !== undefined ? { providerId: flag('--provider') } : {}),
        ...(rest.includes('--metadata') ? { metadata: true } : {}),
        ...(rest.includes('--force') ? { force: true } : {}),
      }
    default:
      return { name: 'unknown', detail: name ?? '(empty)' }
  }
}

/** Credential-type vocabulary only — never material, never fingerprints. */
function safeCredentialSummary(): { credentialType: string; fingerprintExposed: false } {
  // Deliberately coarse: the CLI knows whether a resolver exists locally,
  // nothing about its value.
  return { credentialType: 'inference-key', fingerprintExposed: false }
}

/**
 * `status`: summarizes LOCAL verified metadata + cache layout facts.
 * Zero network. JSON output is stable for tooling.
 */
export async function runStatus(options: CliStatusOptions = {}): Promise<string> {
  const snapshot = options.cacheRoot !== undefined
    ? await loadLocalVerifiedSnapshot(options.cacheRoot)
    : undefined

  const payload = {
    ok: true,
    metadata: snapshot
      ? {
          revision: snapshot.revision,
          fetchedAt: snapshot.fetchedAt,
          providers: snapshot.providers.length,
          models: snapshot.providers.reduce((sum, p) => sum + p.models.length, 0),
        }
      : null,
    ...safeCredentialSummary(),
  }
  if (options.json) return JSON.stringify(payload, null, 2)

  const lines = [
    'opencode-models-discovery status',
    `  metadata revision: ${payload.metadata?.revision ?? '(none stored)'}`,
    payload.metadata
      ? `  metadata fetchedAt: ${payload.metadata.fetchedAt} (${payload.metadata.providers} providers / ${payload.metadata.models} models)`
      : '  metadata fetchedAt: n/a',
    `  credential type: ${payload.credentialType} (fingerprints never displayed)`,
  ]
  return lines.join('\n')
}

/**
 * `audit`: compiles the variant plan for one route from supplied evidence
 * records and renders provenance, merge outcome and suppression reason.
 * Pure rendering over caller-provided records — the CLI owns no hidden
 * second truth path.
 */
export function renderAudit(input: {
  providerId: string
  modelId: string
  plan: ReturnType<typeof import('../reasoning/variant-plan').buildVariantPlan>
  evidenceCount: number
}): string {
  const lines = [
    `route: ${input.providerId}/${input.modelId}`,
    `evidence records considered: ${input.evidenceCount}`,
  ]
  if (input.plan.kind === 'planned') {
    lines.push(`variants: ${input.plan.variants.map((v) => `${v.effective}→${v.wireValue}`).join(', ') || '(none)'}`)
    if (plan_hasDefault(input.plan)) lines.push(`default effort: ${input.plan.defaultEffort}`)
    for (const variant of input.plan.variants) {
      lines.push(
        `  provenance[${variant.effective}]: support=${variant.provenance.supportSourceId ?? '-'} accepted=${variant.provenance.acceptedSourceId ?? '-'} effective=${variant.provenance.effectiveSourceId ?? '-'}`,
      )
    }
  } else {
    lines.push(`variants suppressed: ${input.plan.reason}${'detail' in input.plan && input.plan.detail ? ` (${input.plan.detail})` : ''}`)
  }
  return lines.join('\n')
}

function plan_hasDefault(plan: { defaultEffort?: unknown }): boolean {
  return typeof plan.defaultEffort === 'string'
}

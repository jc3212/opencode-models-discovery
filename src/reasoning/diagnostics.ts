import type { ResolvedReasoning } from './types'

/**
 * Formats a one-line, machine-readable reasoning diagnostic (design §38).
 * Used by the enricher logger so success, Qwen, failure, and ambiguous cases
 * are all explainable from the log.
 */
export function formatReasoningDiagnostic(resolution: ResolvedReasoning): string {
  const { model, capability, transport, variants } = resolution
  const parts: string[] = []

  parts.push(`model=${model.discoveredModelId}`)
  parts.push(`canonical=${model.canonicalModelId ?? 'unresolved'}`)
  parts.push(`match=${model.source}`)
  if (capability.source !== 'none') {
    parts.push(`capabilitySource=${capability.source}`)
  }
  parts.push(`control=${capability.options.map((o) => o.type).join('+') || 'none'}`)
  parts.push(`transport=${transport.transport}`)
  parts.push(`transportReason=${transport.reason}`)
  parts.push(`variants=${Object.keys(variants).join(',') || 'none'}`)

  if (model.ambiguous) {
    parts.push('reason=ambiguous-canonical-match')
  }

  return '[reasoning] ' + parts.join(' ')
}

export function summarizeReasoningResolution(resolution: ResolvedReasoning): Record<string, unknown> {
  return {
    model: resolution.model.discoveredModelId,
    canonical: resolution.model.canonicalModelId ?? null,
    match: resolution.model.source,
    capabilitySource: resolution.capability.source,
    control: resolution.capability.options.map((o) => o.type).join('+') || null,
    transport: resolution.transport.transport,
    transportReason: resolution.transport.reason,
    variants: Object.keys(resolution.variants),
  }
}

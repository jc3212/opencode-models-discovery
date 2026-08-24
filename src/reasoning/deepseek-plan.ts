/**
 * DeepSeek direct-surface normalization contract (v3 plan §11; WP6/E9).
 *
 * The official DeepSeek Thinking Mode mapping, frozen verbatim from the
 * plan. This contract applies ONLY to the DeepSeek direct surface;
 * OpenRouter, Bailian (百炼), Ark (方舟) and generic relays must use their
 * OWN provider-surface evidence — a `max` proven on the direct surface can
 * never leak onto another provider's tuple.
 *
 * Identity rules:
 * - `deepseek-v4-flash` and `deepseek-v4-flash-0731` are SEPARATE exact
 *   records. No generic suffix stripping ever binds the dated id to the
 *   floating one; only an explicit official alias record may relate them.
 * - UI shows only low/high/max: medium/xhigh are compatibility inputs that
 *   normalize into existing tiers, never duplicate ones.
 * - `off` is an independent toggle with per-surface wire encodings:
 *   Chat sends `thinking.type=disabled`; Responses sends
 *   `reasoning.effort=none`.
 */

import type { EffectiveEffort, ReasoningCapabilityEvidence } from '../capabilities/types'
import { providerNativeEvidence } from '../capabilities/sources/provider-native'
import type { BuildEvidenceInput } from '../capabilities/sources/common'

export const DEEPSEEK_OFFICIAL_DOCS_URL = 'https://api-docs.deepseek.com/guides/thinking_mode'

export const DEEPSEEK_ACCEPTED_INPUTS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export const DEEPSEEK_EFFECTIVE_VALUES = Object.freeze<EffectiveEffort[]>([
  'low',
  'high',
  'max',
])

export const DEEPSEEK_NORMALIZATION: Readonly<Record<string, EffectiveEffort>> =
  Object.freeze({
    low: 'low',
    medium: 'high',
    high: 'high',
    xhigh: 'high',
    max: 'max',
  })

/** Exact model ids; each gets its own record, no suffix-stripped aliases. */
export const DEEPSEEK_EXACT_MODEL_IDS = Object.freeze([
  'deepseek-v4-flash',
  'deepseek-v4-flash-0731',
])

export type DeepSeekDirectSurface = 'chat-completions' | 'responses'

/** Off-toggle wire fragments per surface (plan §11). */
export const DEEPSEEK_OFF_WIRE: Readonly<
  Record<DeepSeekDirectSurface, string>
> = Object.freeze({
  'chat-completions': JSON.stringify({ thinking: { type: 'disabled' } }),
  responses: JSON.stringify({ reasoning: { effort: 'none' } }),
})

const BASE_SCOPE = {
  providerKind: 'deepseek-direct',
  origin: 'https://api.deepseek.com',
  apiSurface: 'chat-completions',
} as const

export interface DeepSeekRecordInput extends BuildEvidenceInput {
  remoteModelId: string
  /** Defaults to chat-completions. */
  surface?: DeepSeekDirectSurface
}

function requireExactModelId(remoteModelId: string): string {
  if (!(DEEPSEEK_EXACT_MODEL_IDS as readonly string[]).includes(remoteModelId)) {
    throw new TypeError(
      `"${remoteModelId}" is not an exact DeepSeek model id; suffix stripping is forbidden (§11)`,
    )
  }
  return remoteModelId
}

function scopeFor(input: DeepSeekRecordInput): {
  inventoryIdentityHash: string
  routeKey: string
  origin: string
  remoteModelId: string
  apiSurface: string
  providerKind: string
} {
  return {
    inventoryIdentityHash: '0'.repeat(64),
    routeKey: input.remoteModelId,
    origin: BASE_SCOPE.origin,
    remoteModelId: input.remoteModelId,
    apiSurface: input.surface ?? BASE_SCOPE.apiSurface,
    providerKind: BASE_SCOPE.providerKind,
  }
}

function docsSource() {
  return { url: DEEPSEEK_OFFICIAL_DOCS_URL }
}

function surfaceTag(input: DeepSeekRecordInput): string {
  return input.surface ?? BASE_SCOPE.apiSurface
}

/** Official reasoning.support evidence for one exact DeepSeek model+surface. */
export function deepSeekReasoningSupportEvidence(
  input: DeepSeekRecordInput,
): ReasoningCapabilityEvidence {
  requireExactModelId(input.remoteModelId)
  return providerNativeEvidence({
    claim: 'reasoning.support',
    scope: scopeFor(input),
    support: 'supported',
    completeness: 'exhaustive',
    authority: 'exact',
    sourceId: `thinking-mode#support#${surfaceTag(input)}#${input.remoteModelId}`,
    ...docsSource(),
    receivedAt: input.receivedAt,
    activatedAt: input.activatedAt,
  })
}

/** Official accepted-inputs evidence for one exact DeepSeek model. */
export function deepSeekAcceptedInputsEvidence(
  input: DeepSeekRecordInput,
): ReasoningCapabilityEvidence {
  requireExactModelId(input.remoteModelId)
  return providerNativeEvidence({
    claim: 'effort.accepted',
    scope: scopeFor(input),
    support: 'supported',
    completeness: 'exhaustive',
    values: [...DEEPSEEK_ACCEPTED_INPUTS],
    authority: 'exact',
    sourceId: `thinking-mode#accepted#${surfaceTag(input)}#${input.remoteModelId}`,
    ...docsSource(),
    receivedAt: input.receivedAt,
    activatedAt: input.activatedAt,
  })
}

/** Official normalization evidence: accepted input → effective strength. */
export function deepSeekNormalizationEvidence(
  input: DeepSeekRecordInput,
): ReasoningCapabilityEvidence {
  requireExactModelId(input.remoteModelId)
  return providerNativeEvidence({
    claim: 'effort.normalization',
    scope: scopeFor(input),
    support: 'supported',
    completeness: 'exhaustive',
    normalization: { ...DEEPSEEK_NORMALIZATION },
    preferredWireByEffective: { low: 'low', high: 'high', max: 'max' },
    authority: 'exact',
    sourceId: `thinking-mode#normalization#${surfaceTag(input)}#${input.remoteModelId}`,
    ...docsSource(),
    receivedAt: input.receivedAt,
    activatedAt: input.activatedAt,
  })
}

/**
 * Off-toggle evidence for the requested surface. Chat and Responses wire
 * encodings differ and are never interchangeable.
 */
export function deepSeekOffToggleEvidence(input: DeepSeekRecordInput & {
  surface: DeepSeekDirectSurface
}): ReasoningCapabilityEvidence {
  requireExactModelId(input.remoteModelId)
  return providerNativeEvidence({
    claim: 'toggle',
    scope: scopeFor(input),
    support: 'supported',
    completeness: 'exhaustive',
    values: ['off'],
    scalar: DEEPSEEK_OFF_WIRE[input.surface],
    authority: 'exact',
    sourceId: `off-toggle#${input.surface}#${input.remoteModelId}`,
    ...docsSource(),
    receivedAt: input.receivedAt,
    activatedAt: input.activatedAt,
  })
}

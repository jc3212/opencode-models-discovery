/**
 * OpenRouter gateway-surface reasoning object parser (v3 plan §7.1; WP6/E10).
 *
 * Fields on an OpenRouter model object are HIGH-TRUST evidence about the
 * OPENROUTER GATEWAY SURFACE ONLY — never about the underlying direct
 * provider contract:
 *
 * - `supported_efforts` ARRAY: the accepted set for this surface; the schema
 *   declares the full set, so the record is exhaustive. A listed `max` IS
 *   explicit and stays.
 * - `supported_efforts: null`: the gateway accepts arbitrary gateway effort
 *   inputs — recorded as accepted-but-unenumerable; it NEVER becomes seven
 *   effective strengths.
 * - OMITTED: no effort selector is exposed; no effort records at all.
 * - `mandatory`: true forbids off/none variants downstream.
 * - `supports_max_tokens`: enters `transport.wire` ONLY — it must never
 *   fabricate an effort tier named `max`.
 * - Dynamic model aliases (`auto`, `free`, `*latest`) get no automatic
 *   tiers without exact declared controls.
 * - `requireParameters=false` marks every emitted id best-effort.
 */

import type { ReasoningCapabilityEvidence } from '../capabilities/types'
import { providerNativeEvidence } from '../capabilities/sources/provider-native'
import type { BuildEvidenceInput } from '../capabilities/sources/common'

export const OPENROUTER_GATEWAY_ORIGIN = 'https://openrouter.ai'
export const OPENROUTER_GATEWAY_SURFACE = 'chat-completions'

const DYNAMIC_ALIAS_PATTERN = /^(auto|free|.*-latest)$/

export interface OpenRouterReasoningObject {
  supported_efforts?: readonly unknown[] | null
  default_effort?: unknown
  mandatory?: unknown
  supports_max_tokens?: unknown
}

export interface ParsedReasoningRecords {
  records: ReasoningCapabilityEvidence[]
  /** Machine-readable notes for audit output; never credential material. */
  diagnostics: {
    selectorState: 'enumerable' | 'open-ended' | 'omitted'
    droppedUnsupportedEffortValues?: number
    delivery: 'best-effort' | 'strict'
    dynamicAliasGuarded?: boolean
  }
}

export interface ParseOpenRouterReasoningInput extends BuildEvidenceInput {
  remoteModelId: string
  /** Model-object `reasoning` field value; undefined means omitted. */
  reasoning?: OpenRouterReasoningObject | null
  /** Model-object `requireParameters`; defaults to false (best-effort). */
  requireParameters?: boolean
}

function scopeFor(input: ParseOpenRouterReasoningInput) {
  return {
    inventoryIdentityHash: '0'.repeat(64),
    routeKey: input.remoteModelId,
    providerKind: 'openrouter-gateway',
    origin: OPENROUTER_GATEWAY_ORIGIN,
    remoteModelId: input.remoteModelId,
    apiSurface: OPENROUTER_GATEWAY_SURFACE,
  }
}

function deliveryTag(
  input: ParseOpenRouterReasoningInput,
): 'best-effort' | 'strict' {
  return input.requireParameters === true ? 'strict' : 'best-effort'
}

/**
 * Parses one OpenRouter reasoning object into validated evidence records.
 * Pure function; throws only on internal invariant failures — malformed
 * FIELD VALUES degrade to diagnostics, never guesses.
 */
export function parseOpenRouterReasoning(
  input: ParseOpenRouterReasoningInput,
): ParsedReasoningRecords {
  const records: ReasoningCapabilityEvidence[] = []
  let dropped = 0
  const delivery = deliveryTag(input)
  const guarded =
    !input.reasoning?.supported_efforts && DYNAMIC_ALIAS_PATTERN.test(input.remoteModelId)

  let selectorState: ParsedReasoningRecords['diagnostics']['selectorState'] = 'omitted'

  const efforts = input.reasoning?.supported_efforts
  if (efforts === null) {
    // Gateway accepts any effort input; existence of acceptance is recorded,
    // the tier list is NOT invented.
    selectorState = 'open-ended'
    if (!guarded) {
      records.push(providerNativeEvidence({
        claim: 'effort.accepted',
        scope: scopeFor(input),
        support: 'supported',
        completeness: 'unknown',
        authority: 'exact',
        sourceId: `reasoning#null#${delivery}#${input.remoteModelId}`,
        url: OPENROUTER_GATEWAY_ORIGIN,
        receivedAt: input.receivedAt,
        activatedAt: input.activatedAt,
      }))
    }
  } else if (Array.isArray(efforts)) {
    const values = efforts.filter((value): value is string => typeof value === 'string')
    dropped = efforts.length - values.length
    selectorState = values.length > 0 ? 'enumerable' : 'omitted'
    if (values.length > 0 && !guarded) {
      records.push(providerNativeEvidence({
        claim: 'effort.accepted',
        scope: scopeFor(input),
        support: 'supported',
        completeness: 'exhaustive',
        values,
        authority: 'exact',
        sourceId: `reasoning#array#${delivery}#${input.remoteModelId}`,
        url: OPENROUTER_GATEWAY_ORIGIN,
        receivedAt: input.receivedAt,
        activatedAt: input.activatedAt,
      }))
    }
  }

  if (typeof input.reasoning?.default_effort === 'string') {
    records.push(providerNativeEvidence({
      claim: 'effort.default',
      scope: scopeFor(input),
      support: 'supported',
      completeness: 'exhaustive',
      scalar: input.reasoning.default_effort,
      authority: 'exact',
      sourceId: `reasoning#default#${delivery}#${input.remoteModelId}`,
      url: OPENROUTER_GATEWAY_ORIGIN,
      receivedAt: input.receivedAt,
      activatedAt: input.activatedAt,
    }))
  }

  if (typeof input.reasoning?.mandatory === 'boolean') {
    records.push(providerNativeEvidence({
      claim: 'reasoning.mandatory',
      scope: scopeFor(input),
      support: 'supported',
      completeness: 'exhaustive',
      scalar: input.reasoning.mandatory,
      authority: 'exact',
      sourceId: `reasoning#mandatory#${delivery}#${input.remoteModelId}`,
      url: OPENROUTER_GATEWAY_ORIGIN,
      receivedAt: input.receivedAt,
      activatedAt: input.activatedAt,
    }))
  }

  if (input.reasoning?.supports_max_tokens === true) {
    // Budget/wire fact ONLY — never an effort tier named `max`.
    records.push(providerNativeEvidence({
      claim: 'transport.wire',
      scope: scopeFor(input),
      support: 'supported',
      completeness: 'exhaustive',
      values: ['max_tokens'],
      scalar: true,
      authority: 'exact',
      sourceId: `reasoning#max-tokens#${delivery}#${input.remoteModelId}`,
      url: OPENROUTER_GATEWAY_ORIGIN,
      receivedAt: input.receivedAt,
      activatedAt: input.activatedAt,
    }))
  }

  return {
    records,
    diagnostics: {
      selectorState,
      ...(dropped > 0 ? { droppedUnsupportedEffortValues: dropped } : {}),
      delivery,
      ...(guarded ? { dynamicAliasGuarded: true } : {}),
    },
  }
}

import type { ReasoningTransportType, TransportConfidence } from './types'

/**
 * A small, evidence-based profile registry. Profiles describe API *surfaces*,
 * not model databases. Each profile is only as trustworthy as its signal:
 * an npm package alone is never treated as proof of a host's reasoning
 * semantics (e.g. `@ai-sdk/openai-compatible` is used by relays, first-party
 * APIs, and self-hosted proxies alike).
 */
export interface ProfileEvidence {
  type: 'official-doc' | 'sdk-source' | 'wire-test'
  note: string
}

export interface ProviderProfile {
  id: string
  match: {
    npm?: string
    baseURL?: RegExp
    providerId?: RegExp
  }
  transport: ReasoningTransportType
  confidence: TransportConfidence
  /** Evidence trail satisfying the profile admission rule (design §22-23). */
  evidence: ProfileEvidence[]
}

const DASHSCOPE_BASE_URL = /(^|[./])dashscope(\.|\/|$)/i
const DASHSCOPE_INTL_BASE_URL = /(^|[./])dashscope-intl(\.|\/|$)/i

export const KNOWN_PROVIDER_PROFILES: ProviderProfile[] = [
  {
    id: 'openrouter',
    match: { npm: '@openrouter/ai-sdk-provider' },
    transport: 'openrouter',
    confidence: 'exact',
    evidence: [
      { type: 'wire-test', note: 'reasoning.effort and reasoning.max_tokens forwarded verbatim (wire capture)' },
      { type: 'official-doc', note: 'OpenRouter reasoning parameter docs' },
    ],
  },
  {
    id: 'openai',
    match: { npm: '@ai-sdk/openai' },
    transport: 'openai',
    confidence: 'exact',
    evidence: [
      { type: 'wire-test', note: 'reasoningEffort -> reasoning.effort + summary (Responses API wire capture)' },
      { type: 'official-doc', note: 'OpenAI Responses API reasoning parameter docs' },
    ],
  },
  {
    id: 'dashscope-chat',
    match: { baseURL: DASHSCOPE_BASE_URL },
    transport: 'dashscope-chat',
    confidence: 'high',
    evidence: [
      { type: 'wire-test', note: 'enable_thinking/thinking_budget pass through an OpenAI-compatible surface (wire capture)' },
      { type: 'official-doc', note: 'DashScope compatible-mode thinking interface' },
    ],
  },
  {
    id: 'dashscope-chat-intl',
    match: { baseURL: DASHSCOPE_INTL_BASE_URL },
    transport: 'dashscope-chat',
    confidence: 'high',
    evidence: [
      { type: 'wire-test', note: 'enable_thinking/thinking_budget pass through (wire capture)' },
      { type: 'official-doc', note: 'DashScope intl compatible-mode thinking interface' },
    ],
  },
  {
    id: 'dashscope-provider-id',
    match: { providerId: /(^|[/._-])dashscope([/._-]|$)/i },
    transport: 'dashscope-chat',
    confidence: 'high',
    evidence: [
      { type: 'wire-test', note: 'DashScope wire semantics captured' },
      { type: 'official-doc', note: 'DashScope host identity from provider id' },
    ],
  },
  {
    id: 'alibaba-sdk',
    match: { npm: '@ai-sdk/alibaba' },
    transport: 'alibaba-sdk',
    confidence: 'exact',
    evidence: [
      { type: 'sdk-source', note: '@ai-sdk/alibaba maps enableThinking/thinkingBudget to enable_thinking/thinking_budget' },
      { type: 'wire-test', note: 'camelCase toggle/budget reaches wire (wire capture)' },
    ],
  },
  {
    id: 'anthropic',
    match: { npm: '@ai-sdk/anthropic' },
    transport: 'anthropic',
    confidence: 'exact',
    evidence: [
      { type: 'wire-test', note: 'effort -> output_config.effort, budget -> thinking.budget_tokens, toggle -> thinking.type (wire capture)' },
    ],
  },
  {
    id: 'google',
    match: { npm: '@ai-sdk/google' },
    transport: 'google',
    confidence: 'exact',
    evidence: [
      { type: 'wire-test', note: 'effort -> thinkingConfig.thinkingLevel, budget -> thinkingConfig.thinkingBudget (wire capture)' },
    ],
  },
  {
    id: 'google-vertex',
    match: { npm: '@ai-sdk/google-vertex' },
    transport: 'google',
    confidence: 'exact',
    evidence: [
      { type: 'sdk-source', note: '@ai-sdk/google-vertex shares google transport semantics' },
    ],
  },
]

/**
 * Normalizes a user-supplied explicit transport string into a known
 * ReasoningTransportType, or `undefined` when it is not recognized.
 * Explicit transport is the highest-confidence signal available.
 */
export function normalizeExplicitTransport(value: unknown): ReasoningTransportType | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  switch (value.trim().toLowerCase()) {
    case 'auto':
    case '':
      return undefined
    case 'openai-compatible-effort':
      return 'openai-compatible-effort'
    case 'openai':
      return 'openai'
    case 'openrouter':
      return 'openrouter'
    case 'dashscope-chat':
    case 'dashscope':
      return 'dashscope-chat'
    case 'anthropic':
      return 'anthropic'
    case 'google':
      return 'google'
    case 'alibaba-sdk':
      return 'alibaba-sdk'
    default:
      return undefined
  }
}

/**
 * Signals that identify which host/API surface a provider connects to.
 * Collected as evidence for both resolution and diagnostics.
 */
export interface HostSignals {
  npm?: string
  baseURL?: string
  providerId?: string
}

export interface ProfileMatchResult {
  transport: ReasoningTransportType
  confidence: TransportConfidence
  profileId: string
}

/**
 * Matches a provider against known profiles. Returns the strongest match
 * only when its signal is unambiguous; conflicting profiles resolve to
 * nothing (unknown) rather than guessing.
 */
export function matchKnownProviderProfile(signals: HostSignals): ProfileMatchResult | undefined {
  const matches: ProfileMatchResult[] = []

  for (const profile of KNOWN_PROVIDER_PROFILES) {
    const { npm, baseURL, providerId } = profile.match
    if (npm && signals.npm && signals.npm === npm) {
      matches.push({ transport: profile.transport, confidence: profile.confidence, profileId: profile.id })
      continue
    }
    if (baseURL && signals.baseURL && baseURL.test(signals.baseURL)) {
      matches.push({ transport: profile.transport, confidence: profile.confidence, profileId: profile.id })
      continue
    }
    if (providerId && signals.providerId && providerId.test(signals.providerId)) {
      matches.push({ transport: profile.transport, confidence: profile.confidence, profileId: profile.id })
    }
  }

  if (matches.length === 0) {
    return undefined
  }

  // Prefer the strongest confidence; if two different transports tie at the
  // same confidence, treat the signal as ambiguous.
  const ranked = [...matches].sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence))
  const best = ranked[0]!
  const tiedConflicts = ranked.some(
    (m) => m !== best && confidenceRank(m.confidence) === confidenceRank(best.confidence) && m.transport !== best.transport,
  )
  if (tiedConflicts) {
    return undefined
  }
  return best
}

function confidenceRank(confidence: TransportConfidence): number {
  switch (confidence) {
    case 'exact':
      return 4
    case 'high':
      return 3
    case 'medium':
      return 2
    case 'low':
      return 1
    default:
      return 0
  }
}
/**
 * Official Model Reasoning Registry - schema (design §4-9, §18).
 *
 * The registry stores the OFFICIAL reasoning capability of a precise model:
 * which reasoning modes the model vendor supports, independent of how any
 * particular relay forwards them. Transport is a separate concern.
 *
 * Key design points:
 * - accepted values vs effective values are separated via `aliases`
 *   (design §7): the API may accept medium/xhigh but those are equivalent to
 *   high/max, so the registry keeps the effective set and records aliases.
 * - per-model entries only; NO family/glob rules (design §14).
 * - evidence must state the source (official-doc / models.dev / sdk-source).
 */

export type ReasoningControl =
  | ReasoningEffortControl
  | ReasoningToggleControl
  | ReasoningBudgetControl

export interface ReasoningEffortControl {
  type: 'effort'
  /** Effective (distinct) effort values, e.g. ["none","low","medium","high","xhigh"]. */
  values: string[]
  /** Default effort when none is specified. Must exist in `values`. */
  default?: string
  /**
   * Compatibility aliases: accepted values that map to an effective value.
   * e.g. { "medium": "high", "xhigh": "max" } - the UI shows the effective
   * set, not the accepted set (design §7).
   */
  aliases?: Record<string, string>
}

export interface ReasoningToggleControl {
  type: 'toggle'
}

export interface ReasoningBudgetControl {
  type: 'budget_tokens'
  min?: number
  max?: number
}

export type CapabilityEvidenceType =
  | 'official-doc'
  | 'official-api'
  | 'models.dev'
  | 'sdk-source'
  | 'opencode-core'
  | 'manual-review'

export interface CapabilityEvidence {
  type: CapabilityEvidenceType
  vendor: string
  verifiedAt: string
  /** Optional source locator (stripped from the runtime bundle). */
  url?: string
  note?: string
}

export interface OfficialReasoningCapability {
  /** Canonical `vendor/model` id. */
  model: string
  /** Short vendor-scoped aliases the registry itself recognizes (not user aliases). */
  aliases?: string[]
  /** When true, date/version suffixes may safely map to this entry (design §15). */
  revision_alias?: boolean
  reasoning: boolean
  controls: ReasoningControl[]
  sources: CapabilityEvidence[]
  updatedAt: string
  /** Registry schema version this entry conforms to. */
  schemaVersion: number
}

export interface ReasoningRegistry {
  schemaVersion: number
  registryVersion: string
  models: OfficialReasoningCapability[]
}

/** Latest known schema version. */
export const REGISTRY_SCHEMA_VERSION = 1

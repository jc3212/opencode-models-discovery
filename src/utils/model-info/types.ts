import type { ReasoningOption } from '../../reasoning/types'

export interface ReasoningMetadata {
  reasoning: boolean
  options: ReasoningOption[]
  source: 'models.dev' | 'provider-native' | 'user' | 'safe-rule' | 'none'
  /** The canonical host id that exposed these controls, when known. */
  hostId?: string
}

export interface ModelInfoEnricher {
  shouldSkipModel(modelId: string): boolean
  getModelName?(modelId: string, rawModel?: Record<string, unknown>): string | undefined
  applyModelInfo(modelConfig: any, modelId: string, rawModel?: Record<string, unknown>): void
  /**
   * Returns host-side reasoning control metadata without writing it into the
   * runtime model config (kept separate from standard OpenCode fields).
   */
  getReasoningMetadata?(modelId: string, rawModel?: Record<string, unknown>): ReasoningMetadata | undefined
}

export interface ModelInfoEnricherOptions {
  filterNonChat: boolean
}

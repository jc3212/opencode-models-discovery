import type { ModelInfoEnricher } from './types'

function hasUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function getModalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const modalities = value.filter((modality): modality is string =>
    typeof modality === 'string' && modality.length > 0
  )
  return modalities.length > 0 ? modalities : undefined
}

export function createBifrostModelInfoEnricher(_data: unknown): ModelInfoEnricher {
  return {
    shouldSkipModel(): boolean {
      return false
    },
    getModelName(_modelId: string, rawModel?: Record<string, unknown>): string | undefined {
      const name = rawModel?.normalized_name
      return typeof name === 'string' && name.length > 0 ? name : undefined
    },
    applyModelInfo(modelConfig: any, _modelId: string, rawModel?: Record<string, unknown>): void {
      const context = rawModel?.context_length
      const input = rawModel?.max_input_tokens
      const output = rawModel?.max_output_tokens
      if (hasUsableNumber(context) || hasUsableNumber(input) || hasUsableNumber(output)) {
        modelConfig.limit = {
          ...(hasUsableNumber(context) ? { context } : {}),
          ...(hasUsableNumber(input) ? { input } : {}),
          ...(hasUsableNumber(output) ? { output } : {}),
        }
      }

      const architecture = rawModel?.architecture
      if (architecture && typeof architecture === 'object' && !Array.isArray(architecture)) {
        const inputModalities = getModalities((architecture as Record<string, unknown>).input_modalities)
        const outputModalities = getModalities((architecture as Record<string, unknown>).output_modalities)
        if (inputModalities || outputModalities) {
          modelConfig.modalities = {
            ...(inputModalities ? { input: inputModalities } : {}),
            ...(outputModalities ? { output: outputModalities } : {}),
          }
        }
      }

      const pricing = rawModel?.pricing
      if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
        const inputCost = parseNonNegativeNumber((pricing as Record<string, unknown>).prompt)
        const outputCost = parseNonNegativeNumber((pricing as Record<string, unknown>).completion)
        if (inputCost !== undefined || outputCost !== undefined) {
          modelConfig.cost = {
            ...(inputCost !== undefined ? { input: inputCost } : {}),
            ...(outputCost !== undefined ? { output: outputCost } : {}),
          }
        }
      }
    },
  }
}

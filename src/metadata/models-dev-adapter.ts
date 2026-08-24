/**
 * models.dev public catalog → candidate metadata snapshot adapter
 * (v3 plan §12.1/§12.2; WP7/E14).
 *
 * PURE converter: no network, no clock. The CI sync script fetches the raw
 * document and stamps revision/fetchedAt; this module only shapes data.
 * Output is a CANDIDATE snapshot that still must pass
 * `validateMetadataSnapshot` and `decideUpdate` before anything is stored.
 *
 * Public metadata can only ever enrich exact ids already in an inventory:
 * nothing here adds routes, changes invocationIds or widens whitelists.
 */

interface RawReasoningOption {
  type?: unknown
  values?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extracts declared effort values from a models.dev reasoning_options array. */
export function effortsFromOptions(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) return undefined
  const values = new Set<string>()
  for (const option of options as RawReasoningOption[]) {
    if (!isRecord(option) || option.type !== 'effort') continue
    if (!Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value === 'string' && value.length > 0) values.add(value)
    }
  }
  return values.size > 0 ? [...values].sort() : undefined
}

/**
 * Shapes a raw models.dev document into a v1 candidate snapshot.
 * Returns the structured draft WITHOUT validating byte/depth limits —
 * callers run `validateMetadataSnapshot` next (fail-closed pipeline).
 */
export function buildSnapshotDraftFromModelsDev(
  raw: unknown,
  revision: string,
  fetchedAt: string,
): MetadataCandidateDraft | { error: string } {
  if (!isRecord(raw)) return { error: 'raw document must be an object' }

  const providers: NonNullable<MetadataCandidateDraft['providers']> = []
  for (const [providerId, providerRaw] of Object.entries(raw)) {
    if (!isRecord(providerRaw)) continue
    const modelsRaw = isRecord(providerRaw.models) ? providerRaw.models : {}
    if (Object.keys(modelsRaw).length === 0) continue
    const models: Array<{ id: string; canonicalModelId?: string; reasoning?: { supportedEfforts?: string[] | null } }> = []
    for (const [modelId, modelRaw] of Object.entries(modelsRaw)) {
      if (!isRecord(modelRaw)) continue
      const model: { id: string; canonicalModelId?: string; reasoning?: { supportedEfforts?: string[] | null } } = { id: modelId }
      if (typeof modelRaw.name === 'string' && modelRaw.name.length > 0) {
        model.canonicalModelId = modelRaw.name
      }
      // Public catalogs may carry a boolean reasoning hint OR explicit option
      // values. A bare `true` says NOTHING about tiers: recorded as open-ended
      // acceptance (null), never as invented effort strengths.
      const efforts = effortsFromOptions(modelRaw.reasoning_options)
      if (efforts !== undefined) {
        model.reasoning = { supportedEfforts: efforts }
      } else if (modelRaw.reasoning === true) {
        model.reasoning = { supportedEfforts: null }
      }
      models.push(model)
    }
    if (models.length > 0) providers.push({ id: providerId, models })
  }

  return { schemaVersion: 1, revision, fetchedAt, providers }
}

export interface MetadataCandidateDraft {
  schemaVersion: 1
  revision: string
  fetchedAt: string
  providers: Array<{
    id: string
    models: Array<{ id: string; canonicalModelId?: string; reasoning?: { supportedEfforts?: string[] | null } }>
  }>
}

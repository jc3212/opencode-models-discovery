/**
 * G4.2 - Evidence-aware v2 registry schema (design §6).
 *
 * v1 (OfficialReasoningCapability) stays as the curated official runtime
 * registry. v2 is the COMPILED, evidence-merged view produced by
 * registry:compile: every reasoning-related record from models.dev plus the
 * curated official entries, with per-model evidence provenance and explicit
 * conflict resolutions. v1 is migrated/compatible: runtime keeps reading v1.
 */

import type { ReasoningControl } from './types'

/** v2 schema version for evidence-merged registry. */
export const REGISTRY_SCHEMA_VERSION_V2 = 2

export type Confidence = 'exact' | 'high' | 'medium' | 'low'

export type EvidenceType =
  | 'vendor-official-doc'
  | 'vendor-official-sdk'
  | 'models-dev'
  | 'family-consensus'
  | 'manual-verified'

export type EvidenceScope = 'exact-model' | 'model-family' | 'provider-model'

export type EvidenceClaim = 'identity' | 'reasoning-support' | 'reasoning-control'

export interface EvidenceV2 {
  id: string
  type: EvidenceType
  scope: EvidenceScope
  vendor?: string
  url?: string
  upstreamRevision?: string
  verifiedAt: string
  claim: EvidenceClaim
}

export interface ReasoningCapabilityV2 {
  supported: boolean
  controlsKnown: boolean
  controls: ReasoningControl[]
  evidenceRefs: string[]
}

export interface ConflictResolutionV2 {
  model: string
  kind:
    | 'md-extra'
    | 'md-controls-only'
    | 'flag-conflict'
    | 'official-extra'
    | 'official-controls-only'
  prefer: 'official-exact' | 'models-dev'
  /** models.dev values that are not in the official record (when kind=md-extra). */
  mdOnlyValues?: string[]
  reason: string
  resolvedAt: string
}

export interface RegistryModelV2 {
  /** Canonical `vendor/model` id. */
  model: string
  /**
   * Base-model identity relation (G4.3). Identity hint only; NEVER used to
   * override capabilities. Sources: snapshot base_model (when models.dev
   * provides it) or registry/evidence/base-models.json explicit relations.
   */
  baseModel?: string
  family?: string
  reasoning: ReasoningCapabilityV2
  evidence: EvidenceV2[]
  layers: {
    official: boolean
    modelsDev: boolean
    inferred: boolean
  }
  conflictResolution?: ConflictResolutionV2
}

export interface ModelsDevRegistry {
  _notice: string
  schemaVersion: number
  registryVersion: string
  source: {
    models: 'models.dev'
    fetchedAt: string
    snapshotSha256: string
  }
  coverage: {
    providerModelsScanned: number
    providerAgnosticScanned: number
    reasoningTrue: number
    reasoningOptionsPresent: number
    linkedByBaseModel: number
    providerOnlyUnlinked: number
    controlsKnown: number
    controlsUnknown: number
    unsupportedOptionTypes: string[]
    /** base-model identity relations applied from the models.dev snapshot. */
    baseModelFromSnapshot: number
    /** base-model identity relations applied from registry/evidence/base-models.json. */
    baseModelFromEvidence: number
    /** Total base-model relations declared across layers (audit, G4 §34). */
    baseModelRelationsDeclared: number
    conflictsDuringBuild: number
    resolutionsApplied: number
    resolutionsRequired: number
    silentlyDropped: number
  }
  models: RegistryModelV2[]
}
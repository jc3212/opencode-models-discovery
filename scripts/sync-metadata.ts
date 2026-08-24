/**
 * CI metadata sync script (v3 plan §12.2; WP7/E14).
 *
 * Runs in the scheduled GitHub workflow ONLY — never at plugin runtime:
 * fetch models.dev public catalog → shape candidate → fail-closed
 * validation → quarantine-aware diff against the committed baseline →
 * write a candidate + human-readable audit report for a REVIEWABLE PR.
 *
 * The workflow never auto-merges; runtime only accepts bundled curated
 * files, so this script cannot affect live behavior until a human lands
 * the PR.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  decideUpdate,
  validateMetadataSnapshot,
  type MetadataSnapshotV1,
} from '../src/metadata/revision-store'
import { buildSnapshotDraftFromModelsDev } from '../src/metadata/models-dev-adapter'

const MODELS_DEV_API = 'https://models.dev/api.json'
const BASELINE_PATH = 'metadata/curated-baseline.json'
const CANDIDATE_PATH = 'metadata/candidate-snapshot.json'
const REPORT_PATH = 'metadata/sync-report.md'

async function main(): Promise<void> {
  const response = await fetch(MODELS_DEV_API, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`models.dev fetch failed: HTTP ${response.status}`)
  }
  const raw: unknown = await response.json()
  const revision = response.headers.get('etag') ?? new Date().toISOString()
  const fetchedAt = new Date().toISOString()

  const draft = buildSnapshotDraftFromModelsDev(raw, revision, fetchedAt)
  if ('error' in draft) throw new Error(draft.error)

  const validation = validateMetadataSnapshot(draft)
  if (!validation.ok) {
    throw new Error(`candidate rejected by fail-closed validation: ${validation.reason}`)
  }
  const candidate: MetadataSnapshotV1 = validation.value

  let activated: MetadataSnapshotV1 | undefined
  try {
    const baselineRaw = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as unknown
    const baselineResult = validateMetadataSnapshot(baselineRaw)
    if (baselineResult.ok) activated = baselineResult.value
  } catch {
    // No committed baseline yet: first sync produces one after review.
  }

  const decision = decideUpdate(activated, candidate)

  await mkdir(path.dirname(CANDIDATE_PATH), { recursive: true })
  await writeFile(CANDIDATE_PATH, `${JSON.stringify(candidate, null, 2)}\n`)

  const modelTotal = candidate.providers.reduce((sum, p) => sum + p.models.length, 0)
  const lines = [
    '# Metadata sync report',
    '',
    `- revision: \`${revision}\``,
    `- providers: ${candidate.providers.length}, models: ${modelTotal}`,
    `- decision: **${decision.decision}**`,
    ...(decision.decision === 'quarantine'
      ? ['', '## Quarantine reasons', ...decision.reasons.map((r) => `- ${r}`)]
      : []),
    '',
    'Review required before landing into `metadata/curated-baseline.json`; runtime only reads bundled curated files.',
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)

  if (decision.decision === 'quarantine') {
    console.error('[metadata-sync] candidate quarantined:', decision.reasons.join(', '))
    process.exitCode = 3
    return
  }
  console.log(`[metadata-sync] candidate accepted for review: ${modelTotal} models`)
}

main().catch((error: unknown) => {
  console.error('[metadata-sync] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})

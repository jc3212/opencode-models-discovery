/**
 * Quarantine store for cache v3 (v3 plan §9.1 item 6, §8.4).
 *
 * Partial responses, schema violations, diff anomalies and corrupt files
 * are recorded here for diagnosis. Quarantine entries NEVER feed the
 * projection: they are write-only diagnostics with a bounded count, using
 * restricted `<timestamp>-<hmac16>` file names.
 */

import { hmacHex, type HmacSecret } from '../discovery/identity'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assertTimestampedHashName, writeJsonAtomic } from './safe-file'

const QUARANTINE_DIR = 'quarantine/v1'

/** Keeps the quarantine directory bounded; oldest entries are pruned first. */
export const MAX_QUARANTINE_FILES = 100

const QUARANTINE_KIND_VALUES = [
  'partial-response',
  'schema-invalid',
  'diff-anomaly',
  'corrupt-file',
  'other',
] as const

const KINDS = new Set<string>(QUARANTINE_KIND_VALUES)

export type QuarantineKind = (typeof QUARANTINE_KIND_VALUES)[number]

export interface QuarantineEntryV1 {
  schemaVersion: 1
  kind: QuarantineKind
  identityHash?: string
  jobKeyHash?: string
  reason: string
  observedAt: string
  /** Small scalar-only diagnostic summary; keys are restricted. */
  summary?: Record<string, string | number | boolean>
}

const SUMMARY_KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/

function sanitizeSummary(summary: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> | undefined {
  if (summary === undefined) return undefined
  const entries = Object.entries(summary)
  if (entries.length > 32) {
    throw new TypeError('quarantine summary is limited to 32 keys')
  }
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of entries) {
    if (!SUMMARY_KEY_PATTERN.test(key)) {
      throw new TypeError(`quarantine summary key "${key.slice(0, 8)}…" is not a restricted key`)
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError('quarantine summary values must be scalars')
    }
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function compactTimestamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso)
  if (!match) throw new TypeError('observedAt must be an ISO-8601 timestamp')
  return `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}`
}

export interface AppendQuarantineOptions {
  cacheRoot: string
  secret: HmacSecret
  kind: QuarantineKind
  reason: string
  identityHash?: string
  jobKeyHash?: string
  observedAt?: string
  summary?: Record<string, string | number | boolean>
  /** Override only for tests. */
  cap?: number
}

export interface AppendedQuarantineEntry {
  path: string
  pruned: number
}

/** Appends one bounded diagnostic entry and prunes the directory to cap. */
export async function appendQuarantineEntry(
  options: AppendQuarantineOptions,
): Promise<AppendedQuarantineEntry> {
  const kind = options.kind
  if (!KINDS.has(kind)) {
    throw new TypeError(`quarantine kind "${kind}" is not a known kind`)
  }
  if (!REASON_PATTERN.test(options.reason)) {
    throw new TypeError('quarantine reason must be a short lowercase reason code')
  }
  if (options.identityHash !== undefined && !/^[0-9a-f]{64}$/.test(options.identityHash)) {
    throw new TypeError('identityHash must be a 64-char lowercase hex hash')
  }
  if (options.jobKeyHash !== undefined && !/^[0-9a-f]{64}$/.test(options.jobKeyHash)) {
    throw new TypeError('jobKeyHash must be a 64-char lowercase hex hash')
  }

  const observedAt = options.observedAt ?? new Date().toISOString()
  const summary = sanitizeSummary(options.summary)
  const entry: QuarantineEntryV1 = {
    schemaVersion: 1,
    kind,
    reason: options.reason,
    observedAt,
    ...(options.identityHash !== undefined ? { identityHash: options.identityHash } : {}),
    ...(options.jobKeyHash !== undefined ? { jobKeyHash: options.jobKeyHash } : {}),
    ...(summary !== undefined ? { summary } : {}),
  }

  const stemSource = JSON.stringify([
    kind,
    options.reason,
    options.identityHash ?? '',
    options.jobKeyHash ?? '',
    summary ?? {},
  ])
  const stemHash = hmacHex(options.secret, `quarantine-v1\n${stemSource}`).slice(0, 16)
  const stem = `${compactTimestamp(observedAt)}-${stemHash}`
  assertTimestampedHashName(stem)

  const finalPath = await writeJsonAtomic(
    options.cacheRoot,
    QUARANTINE_DIR,
    `${stem}.json`,
    entry,
  )

  const cap = options.cap ?? MAX_QUARANTINE_FILES
  const pruned = await pruneQuarantine(options.cacheRoot, cap)
  return { path: finalPath, pruned }
}

async function pruneQuarantine(cacheRoot: string, cap: number): Promise<number> {
  const dir = path.join(cacheRoot, QUARANTINE_DIR)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  const entries = names
    .filter((name) => /^\d{8}T\d{6}-[0-9a-f]{16}\.json$/.test(name))
    .sort()
    .reverse()
  if (entries.length <= cap) return 0
  const victims = entries.slice(cap)
  let pruned = 0
  for (const victim of victims) {
    await fs.rm(path.join(dir, victim), { force: true }).catch(() => undefined)
    pruned += 1
  }
  return pruned
}

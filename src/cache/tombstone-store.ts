/**
 * Auth tombstones for cache v3 (v3 plan §9.1 item 5, §4.1 AUTH_BLOCKED).
 *
 * A tombstone blocks ONLY the exact (semantic identity × credential
 * generation) pair that suffered a confirmed auth failure. New generations
 * never inherit old tombstones: the file name embeds the HMAC of both
 * hashes, so a rotated token simply misses the lookup. Tombstone content
 * carries reason codes only — never credential material or account data.
 */

import { hmacHex, type HmacSecret } from '../discovery/identity'
import {
  readJsonOptional,
  removeCacheFile,
  writeJsonAtomic,
} from './safe-file'

const TOMBSTONE_DIR = 'tombstones/v1'
const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export interface StoredAuthTombstoneV1 {
  schemaVersion: 1
  identityHash: string
  credentialGenerationHash: string
  /** Short machine reason code, e.g. `confirmed-auth-failure`. */
  reason: string
  createdAt: string
}

function tombstoneName(secret: HmacSecret, identityHash: string, generationHash: string): string {
  return hmacHex(secret, `auth-tombstone-v1\n${identityHash}\n${generationHash}`)
}

function tombstonePath(cacheRoot: string, name: string): string {
  return `${cacheRoot}/${TOMBSTONE_DIR}/${name}.json`
}

export interface WriteTombstoneOptions {
  cacheRoot: string
  secret: HmacSecret
  identityHash: string
  credentialGenerationHash: string
  reason: string
  createdAt?: string
}

export async function writeAuthTombstone(options: WriteTombstoneOptions): Promise<string> {
  const { identityHash, credentialGenerationHash, reason } = options
  if (!/^[0-9a-f]{64}$/.test(identityHash)) {
    throw new TypeError('identityHash must be a 64-char lowercase hex hash')
  }
  if (!/^[0-9a-f]{64}$/.test(credentialGenerationHash)) {
    throw new TypeError('credentialGenerationHash must be a 64-char lowercase hex hash')
  }
  if (!REASON_PATTERN.test(reason)) {
    throw new TypeError('tombstone reason must be a short lowercase reason code')
  }
  const name = tombstoneName(options.secret, identityHash, credentialGenerationHash)
  const record: StoredAuthTombstoneV1 = {
    schemaVersion: 1,
    identityHash,
    credentialGenerationHash,
    reason,
    createdAt: options.createdAt ?? new Date().toISOString(),
  }
  return writeJsonAtomic(options.cacheRoot, TOMBSTONE_DIR, `${name}.json`, record)
}

/**
 * Whether the exact (identity, generation) pair is blocked. Any structural
 * surprise reads as "not blocked" — tombstones may only ever widen denial
 * for their own pair, never for anything else.
 */
export async function hasAuthTombstone(
  cacheRoot: string,
  secret: HmacSecret,
  identityHash: string,
  credentialGenerationHash: string,
): Promise<StoredAuthTombstoneV1 | undefined> {
  const name = tombstoneName(secret, identityHash, credentialGenerationHash)
  const result = await readJsonOptional<StoredAuthTombstoneV1>(
    tombstonePath(cacheRoot, name),
  )
  if (!result.ok) return undefined
  const record = result.value
  if (
    record?.schemaVersion !== 1 ||
    record.identityHash !== identityHash ||
    record.credentialGenerationHash !== credentialGenerationHash
  ) {
    return undefined
  }
  return record
}

/** Removes the tombstone for the exact pair. Returns existence. */
export async function clearAuthTombstone(
  cacheRoot: string,
  secret: HmacSecret,
  identityHash: string,
  credentialGenerationHash: string,
): Promise<boolean> {
  const name = tombstoneName(secret, identityHash, credentialGenerationHash)
  return removeCacheFile(tombstonePath(cacheRoot, name))
}

/**
 * Atomic, containment-checked JSON file primitives for the v3 cache
 * (v3 plan §9.1, §16.2 storage safety bullets).
 *
 * Rules enforced here so every store stays thin:
 * - File names must be restricted encodings: either a full 64-char lowercase
 *   hex hash, or `<compact-timestamp>-<16 hex>` for append-style stores.
 *   Free-form names are refused — nothing user-controlled ever becomes a
 *   path segment.
 * - Every resolved path must stay inside the store root (containment);
 *   traversal attempts throw before touching the filesystem.
 * - Directories are created 0700 and files written 0600 via a unique temp
 *   sibling followed by rename, so readers never observe partial JSON.
 * - fsync is best-effort: losing an unsynced cache file only costs a
 *   refetch, never correctness.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export type CacheFileErrorCode =
  | 'INVALID_NAME'
  | 'CONTAINMENT_VIOLATION'
  | 'CORRUPT_JSON'
  | 'IO_ERROR'

export class CacheFileError extends Error {
  readonly code: CacheFileErrorCode

  constructor(code: CacheFileErrorCode, message: string) {
    super(message)
    this.name = 'CacheFileError'
    this.code = code
  }
}

const FULL_HASH_PATTERN = /^[0-9a-f]{64}$/

/** Restricts a standalone file name to a full 64-char lowercase hex hash. */
export function assertFullHashName(name: string): void {
  if (!FULL_HASH_PATTERN.test(name)) {
    throw new CacheFileError('INVALID_NAME', 'cache file name must be a 64-char lowercase hex hash')
  }
}

/**
 * Restricts an append-style file name to `<compact-timestamp>-<16 hex>`,
 * e.g. `20260823T111213-0123456789abcdef.json` minus extension handling.
 * The timestamp part is digits plus a single `T`, so it cannot traverse.
 */
export function assertTimestampedHashName(stem: string): void {
  const match = /^(\d{8}T\d{6})-([0-9a-f]{16})$/.exec(stem)
  if (!match) {
    throw new CacheFileError(
      'INVALID_NAME',
      'cache stem must be <YYYYMMDDTHHMMSS>-<16 lowercase hex>',
    )
  }
}

function assertInsideRoot(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new CacheFileError('CONTAINMENT_VIOLATION', 'resolved path escaped the cache root')
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(dir)
  if (stat.isSymbolicLink()) {
    throw new CacheFileError('IO_ERROR', 'cache directory is a symlink')
  }
}

/**
 * Atomically writes `value` as pretty JSON to `<root>/<relativeDir>/<fileName>`.
 * Returns the final absolute path. Concurrent writers converge because rename
 * is atomic within a filesystem; the temp name is unique per call.
 */
export async function writeJsonAtomic(
  root: string,
  relativeDir: string,
  fileName: string,
  value: unknown,
): Promise<string> {
  // Accept the conventional `.json` suffix but validate the restricted
  // stem: either a full 64-char hash or `<timestamp>-<16 hex>` for
  // append-style stores.
  const stem = fileName.endsWith('.json') ? fileName.slice(0, -5) : fileName
  if (!FULL_HASH_PATTERN.test(stem)) {
    assertTimestampedHashName(stem)
  }
  assertInsideRoot(root, path.join(root, relativeDir, fileName))
  const dir = path.join(root, relativeDir)
  await ensureDir(dir)

  const tempName = `${fileName}.${randomBytes(6).toString('hex')}.tmp`
  const tempPath = path.join(dir, tempName)
  const finalPath = path.join(dir, fileName)

  const handle = await fs.open(tempPath, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8')
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(tempPath, finalPath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw new CacheFileError(
      'IO_ERROR',
      `failed to publish cache file: ${String((error as Error)?.message ?? error)}`,
    )
  }
  return finalPath
}

export type ReadJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; missing: true }
  | { ok: false; corrupt: true }

/**
 * Reads a JSON cache file without throwing for expected conditions:
 * missing → `{ ok:false, missing }`; unparsable → `{ ok:false, corrupt }`.
 * Only unexpected IO errors propagate.
 */
export async function readJsonOptional<T>(
  filePath: string,
): Promise<ReadJsonResult<T>> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: false, missing: true }
    }
    throw error
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T }
  } catch {
    return { ok: false, corrupt: true }
  }
}

/** Removes a cache file; returns whether it existed. */
export async function removeCacheFile(filePath: string): Promise<boolean> {
  try {
    await fs.rm(filePath, { force: false })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw error
  }
}

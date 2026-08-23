/**
 * Cross-process advisory lock for cache writes (v3 plan §3.3, §16.1
 * CROSS-PROCESS-CONVERGENCE).
 *
 * Uses directory creation as the atomic primitive: `mkdir` succeeds for
 * exactly one contender on POSIX filesystems, so no separate "lock file +
 * check" race window exists. The winner records a small holder manifest
 * (pid, random token, timestamp — never credential material) that enables
 * two safety properties:
 *
 * - Stale takeover: a lock whose age exceeds the TTL is recovered via an
 *   atomic rename, so crashed holders cannot wedge refresh forever.
 * - Ownership-checked release: releasing verifies our own token first;
 *   a holder that was already taken over must not delete someone else's
 *   live lock.
 *
 * Losers are expected to re-read the shared cache revision after the
 * winner publishes (converge), which is caller-side logic by design.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export interface CacheLockOptions {
  /** Absolute path acting as the lock directory. */
  lockDir: string
  /** A lock older than this may be taken over from a dead holder. */
  ttlMs: number
  /** Override only for tests. */
  now?: () => number
}

export interface CacheLockHandle {
  /** Diagnostic identity written into the holder manifest. */
  readonly holder: string
  /** Removes the lock if we still own it; false when taken over meanwhile. */
  release(): Promise<boolean>
}

interface HolderManifest {
  schemaVersion: 1
  pid: number
  token: string
  acquiredAtMs: number
}

const MANIFEST_NAME = 'holder.json'
const RECOVERY_SUFFIX = '.recovering-'

function makeHolderToken(): string {
  return randomBytes(12).toString('hex')
}

async function readManifest(lockDir: string): Promise<HolderManifest | undefined> {
  try {
    const raw = await fs.readFile(path.join(lockDir, MANIFEST_NAME), 'utf8')
    const parsed = JSON.parse(raw) as HolderManifest
    if (
      parsed?.schemaVersion === 1 &&
      typeof parsed.pid === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.acquiredAtMs === 'number'
    ) {
      return parsed
    }
    return undefined
  } catch {
    // Missing or unreadable manifest: treat as unknown-age legacy lock.
    return undefined
  }
}

/**
 * Attempts to acquire the lock without blocking. Returns a handle when
 * this call owns the lock, otherwise undefined — callers converge by
 * re-reading published state instead of waiting.
 */
export async function acquireCacheLock(options: CacheLockOptions): Promise<CacheLockHandle | undefined> {
  const now = options.now ?? Date.now
  const holder = `${process.pid}-${makeHolderToken()}`

  const tryMkdir = async (): Promise<boolean> => {
    try {
      await fs.mkdir(options.lockDir, { recursive: false, mode: 0o700 })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false
      throw error
    }
  }

  let owned = await tryMkdir()

  if (!owned) {
    // Someone holds the lock. Take it over only when provably stale.
    const existing = await readManifest(options.lockDir)
    let acquiredAt = existing?.acquiredAtMs
    if (acquiredAt === undefined) {
      // No manifest (holder died between mkdir and write, or corrupt):
      // fall back to directory mtime instead of assuming the lock is old.
      try {
        const stat = await fs.stat(options.lockDir)
        acquiredAt = stat.mtimeMs
      } catch {
        return undefined
      }
    }
    if (now() - acquiredAt <= options.ttlMs) {
      return undefined
    }

    // Atomic recovery: move the stale lock aside, then race again.
    const recovering = `${options.lockDir}${RECOVERY_SUFFIX}${makeHolderToken()}`
    try {
      await fs.rename(options.lockDir, recovering)
    } catch {
      // Another process recovered it first; treat as contended.
      return undefined
    }
    await fs.rm(recovering, { recursive: true, force: true }).catch(() => undefined)

    owned = await tryMkdir()
    if (!owned) return undefined
  }

  const manifest: HolderManifest = {
    schemaVersion: 1,
    pid: process.pid,
    token: holder,
    acquiredAtMs: now(),
  }
  try {
    await fs.writeFile(
      path.join(options.lockDir, MANIFEST_NAME),
      JSON.stringify(manifest),
      { encoding: 'utf8', mode: 0o600 },
    )
  } catch (error) {
    // Never keep an undescribed lock: back out immediately.
    await fs.rm(options.lockDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  return {
    holder,
    async release(): Promise<boolean> {
      const current = await readManifest(options.lockDir)
      if (current?.token !== holder) {
        // Taken over by someone else; leave their lock alone.
        return false
      }
      await fs.rm(options.lockDir, { recursive: true, force: true })
      return true
    },
  }
}

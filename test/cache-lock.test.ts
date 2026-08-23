import { mkdir, mkdtemp, rm, stat, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { acquireCacheLock, type CacheLockOptions } from '../src/cache/lock'

const tempRoots: string[] = []

async function makeLockDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-cache-lock-'))
  tempRoots.push(root)
  return path.join(root, 'refresh.lock')
}

function lockOptions(lockDir: string, ttlMs = 60_000): CacheLockOptions {
  return { lockDir, ttlMs }
}

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
})

describe('acquireCacheLock', () => {
  it('is exclusive: a held lock blocks other contenders', async () => {
    const lockDir = await makeLockDir()
    const first = await acquireCacheLock(lockOptions(lockDir))
    expect(first).toBeDefined()
    await expect(acquireCacheLock(lockOptions(lockDir))).resolves.toBeUndefined()

    const statResult = await stat(lockDir)
    expect(statResult.isDirectory()).toBe(true)
    expect((statResult.mode & 0o777)).toBe(0o700)

    await first?.release()
  })

  it('allows re-acquisition after release', async () => {
    const lockDir = await makeLockDir()
    const first = await acquireCacheLock(lockOptions(lockDir))
    await expect(first?.release()).resolves.toBe(true)
    const second = await acquireCacheLock(lockOptions(lockDir))
    expect(second).toBeDefined()
    await second?.release()
  })

  it('release is idempotent and reports ownership loss', async () => {
    const lockDir = await makeLockDir()
    const first = await acquireCacheLock(lockOptions(lockDir))
    expect(await first?.release()).toBe(true)
    expect(await first?.release()).toBe(false)
  })

  it('takes over a stale lock from a dead holder', async () => {
    const lockDir = await makeLockDir()
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    const deadAt = Date.now() - 10 * 60_000
    await writeFile(
      path.join(lockDir, 'holder.json'),
      JSON.stringify({ schemaVersion: 1, pid: 1, token: 'dead-beef', acquiredAtMs: deadAt }),
      'utf8',
    )

    const takeover = await acquireCacheLock(lockOptions(lockDir, 60_000))
    expect(takeover).toBeDefined()
    await takeover?.release()
  })

  it('does not take over a fresh foreign lock', async () => {
    const lockDir = await makeLockDir()
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(lockDir, 'holder.json'),
      JSON.stringify({ schemaVersion: 1, pid: 2, token: 'alive', acquiredAtMs: Date.now() }),
      'utf8',
    )
    await expect(acquireCacheLock(lockOptions(lockDir, 60_000))).resolves.toBeUndefined()
  })

  it('uses directory mtime as the age fallback when no manifest exists', async () => {
    const lockDir = await makeLockDir()
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    const fresh = new Date()
    await utimes(lockDir, fresh, fresh)

    // Fresh unmanifested dir: not takeover-able within TTL.
    await expect(acquireCacheLock(lockOptions(lockDir, 60_000))).resolves.toBeUndefined()

    // Aged unmanifested dir: takeover succeeds.
    const old = new Date(Date.now() - 10 * 60_000)
    await utimes(lockDir, old, old)
    const takeover = await acquireCacheLock(lockOptions(lockDir, 60_000))
    expect(takeover).toBeDefined()
    await takeover?.release()
  })

  it('release does not delete a lock taken over by someone else', async () => {
    const lockDir = await makeLockDir()
    const first = await acquireCacheLock(lockOptions(lockDir))

    // Simulate external takeover: dead-holder recovery by a third party.
    await rm(lockDir, { recursive: true, force: true })
    const second = await acquireCacheLock(lockOptions(lockDir))
    expect(second).toBeDefined()

    await expect(first?.release()).resolves.toBe(false)
    // Second holder's lock must still exist and be releasable.
    await expect(stat(lockDir)).resolves.toBeDefined()
    expect(await second?.release()).toBe(true)
  })

  it('concurrent contenders produce exactly one winner', async () => {
    const lockDir = await makeLockDir()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireCacheLock(lockOptions(lockDir))),
    )
    const winners = results.filter((handle) => handle !== undefined)
    expect(winners).toHaveLength(1)
    await winners[0]?.release()
  })
})

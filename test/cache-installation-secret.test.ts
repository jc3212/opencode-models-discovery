import { promises as fs } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  InstallationSecretError,
  INSTALLATION_SECRET_BYTES,
  loadOrCreateInstallationSecret,
} from '../src/cache/installation-secret'

const tempRoots: string[] = []

async function makeBaseDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-installation-secret-'))
  tempRoots.push(root)
  const baseDir = path.join(root, 'data', '@jc3212', 'opencode-models-discovery')
  await fs.mkdir(baseDir, { recursive: true })
  return baseDir
}

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

describe('loadOrCreateInstallationSecret creation', () => {
  it('creates a 32-byte secret with 0700 dir / 0600 file on first use', async () => {
    const baseDir = await makeBaseDir()
    const result = await loadOrCreateInstallationSecret({ baseDir })

    expect(result.created).toBe(true)
    expect(result.secret).toBeInstanceOf(Uint8Array)
    expect(result.secret.byteLength).toBe(INSTALLATION_SECRET_BYTES)
    expect(result.secret.every((b) => b === 0)).toBe(false)

    const dirMode = (await fs.stat(baseDir)).mode & 0o777
    expect(dirMode).toBe(0o700)
    const fileStat = await fs.stat(result.path)
    expect(fileStat.isFile()).toBe(true)
    expect(fileStat.mode & 0o777).toBe(0o600)

    const content = await fs.readFile(result.path, 'utf8')
    expect(content).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns identical bytes without recreating on subsequent calls', async () => {
    const baseDir = await makeBaseDir()
    const first = await loadOrCreateInstallationSecret({ baseDir })
    const second = await loadOrCreateInstallationSecret({ baseDir })

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(Buffer.from(second.secret).equals(Buffer.from(first.secret))).toBe(true)
    expect(second.path).toBe(first.path)
  })
})

describe('concurrent first use', () => {
  it('converges all callers onto one winner secret', async () => {
    const baseDir = await makeBaseDir()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateInstallationSecret({ baseDir })),
    )

    const winners = results.filter((r) => r.created)
    expect(winners.length).toBe(1)
    for (const result of results.slice(1)) {
      expect(
        Buffer.from(result.secret).equals(Buffer.from(results[0].secret)),
        'every caller must observe the same secret',
      ).toBe(true)
    }
  })
})

describe('failure-safety rejections', () => {
  it('rejects a symlinked key file', async () => {
    const baseDir = await makeBaseDir()
    const target = path.join(baseDir, 'elsewhere.key')
    await fs.writeFile(target, 'a'.repeat(64), { mode: 0o600 })
    const linkPath = path.join(baseDir, 'installation.key')
    await fs.symlink(target, linkPath)

    try {
      await loadOrCreateInstallationSecret({ baseDir })
      expect.unreachable('symlink must be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationSecretError)
      expect((error as InstallationSecretError).code).toBe('SYMLINK_REJECTED')
    }
  })

  it('rejects a symlinked base directory (containment)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'omd-installation-secret-'))
    tempRoots.push(root)
    const real = path.join(root, 'real')
    const fake = path.join(root, 'fake')
    await fs.mkdir(real, { recursive: true })
    await fs.symlink(real, fake)

    try {
      await loadOrCreateInstallationSecret({ baseDir: fake })
      expect.unreachable('symlinked base dir must be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationSecretError)
      expect((error as InstallationSecretError).code).toBe('SYMLINK_REJECTED')
    }
  })

  it('rejects traversal or separator-bearing file names up front', async () => {
    const baseDir = await makeBaseDir()
    for (const bad of ['../escape.key', 'sub/dir.key', '.', '..', '', 'a\\b.key']) {
      try {
        await loadOrCreateInstallationSecret({ baseDir, fileName: bad })
        expect.unreachable(`file name ${JSON.stringify(bad)} must be rejected`)
      } catch (error) {
        expect(error).toBeInstanceOf(InstallationSecretError)
        expect((error as InstallationSecretError).code).toBe('INVALID_FILE_NAME')
      }
    }
    // Nothing was written under the base dir by any rejected name.
    const entries = await fs.readdir(baseDir)
    expect(entries.filter((name) => name !== 'installation.key')).toEqual([])
  })

  it('rejects corrupt content instead of using it', async () => {
    const baseDir = await makeBaseDir()
    for (const bad of ['zz'.repeat(32), 'ab'.repeat(31), `${'ab'.repeat(32)}\n\n`, '']) {
      await fs.writeFile(path.join(baseDir, 'installation.key'), bad, { mode: 0o600 })
      try {
        await loadOrCreateInstallationSecret({ baseDir })
        expect.unreachable(`content ${JSON.stringify(bad.slice(0, 6))}... must be rejected`)
      } catch (error) {
        expect(error).toBeInstanceOf(InstallationSecretError)
        expect((error as InstallationSecretError).code).toBe('CORRUPT_SECRET')
      }
      await fs.rm(path.join(baseDir, 'installation.key'))
    }
  })

  it('tolerates a single trailing newline written by editors', async () => {
    const baseDir = await makeBaseDir()
    const hex = 'cd'.repeat(INSTALLATION_SECRET_BYTES)
    await fs.writeFile(path.join(baseDir, 'installation.key'), `${hex}\n`, { mode: 0o600 })
    const result = await loadOrCreateInstallationSecret({ baseDir })
    expect(result.created).toBe(false)
    expect(Array.from(result.secret)).toEqual(
      Array.from({ length: INSTALLATION_SECRET_BYTES }, () => 0xcd),
    )
  })

  it('refuses an existing file with group/other permission bits', async () => {
    const baseDir = await makeBaseDir()
    await fs.writeFile(path.join(baseDir, 'installation.key'), 'ab'.repeat(32), { mode: 0o644 })
    try {
      await loadOrCreateInstallationSecret({ baseDir })
      expect.unreachable('widened permissions must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(InstallationSecretError)
      expect((error as InstallationSecretError).code).toBe('INSECURE_PERMISSIONS')
    }
  })

  it('rejects relative base directories', async () => {
    await expect(loadOrCreateInstallationSecret({ baseDir: 'relative/path' })).rejects.toMatchObject({
      code: 'INVALID_BASE_DIR',
    })
  })
})

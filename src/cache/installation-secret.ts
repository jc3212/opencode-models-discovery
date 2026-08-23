/**
 * Per-installation HMAC secret store (v3 plan §9.1 item 7, §16.2).
 *
 * Owns `<data>/installation.key`: 32 random bytes stored as 64 lowercase
 * hex characters. Every fingerprint primitive in `../discovery/identity`
 * consumes the bytes loaded here.
 *
 * Failure-safety contract:
 * - Directory is created 0700, the key file 0600; an existing file with
 *   group/other bits is rejected instead of silently used.
 * - Creation is exclusive (`O_CREAT|O_EXCL`, plus `O_NOFOLLOW` where the
 *   platform provides it): under concurrent first use exactly one writer
 *   wins and every loser re-reads the winner's bytes, so all callers
 *   converge on the same secret.
 * - Symlinks are refused for both the file and the storage directory
 *   (containment); illegal file names (separators, traversal segments)
 *   are refused up front.
 * - Corrupt content (wrong length, non-hex, trailing garbage) fails closed.
 * - No error message or diagnostic ever contains secret material.
 */

import { constants as fsConstants } from 'node:fs'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/** Plan §9.1: the installation secret is exactly 32 bytes. */
export const INSTALLATION_SECRET_BYTES = 32

const DEFAULT_FILE_NAME = 'installation.key'

/** Hex encoding length of {@link INSTALLATION_SECRET_BYTES} bytes. */
const HEX_LENGTH = INSTALLATION_SECRET_BYTES * 2

export type InstallationSecretErrorCode =
  | 'INVALID_BASE_DIR'
  | 'INVALID_FILE_NAME'
  | 'SYMLINK_REJECTED'
  | 'NOT_A_FILE'
  | 'CORRUPT_SECRET'
  | 'INSECURE_PERMISSIONS'
  | 'IO_ERROR'

export class InstallationSecretError extends Error {
  readonly code: InstallationSecretErrorCode

  constructor(code: InstallationSecretErrorCode, message: string) {
    super(message)
    this.name = 'InstallationSecretError'
    this.code = code
  }
}

export interface InstallationSecretResult {
  /** Raw secret bytes; feed these to identity HMAC helpers. */
  secret: Uint8Array
  /** True when this call created the file, false when an existing one was read. */
  created: boolean
  /** Absolute path of the key file. */
  path: string
}

export interface LoadOrCreateInstallationSecretOptions {
  /**
   * Plugin data directory, e.g. `<xdgData>/@jc3212/opencode-models-discovery`.
   * Must be absolute; symlinked directories are rejected (containment).
   */
  baseDir: string
  /** Override only for tests; defaults to `installation.key`. */
  fileName?: string
}

function assertPlainFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\') ||
    fileName.includes('\0')
  ) {
    throw new InstallationSecretError(
      'INVALID_FILE_NAME',
      'installation secret file name must be a plain name without separators',
    )
  }
}

function assertBaseDir(baseDir: string): void {
  if (!path.isAbsolute(baseDir) || baseDir.includes('\0')) {
    throw new InstallationSecretError(
      'INVALID_BASE_DIR',
      'installation secret base directory must be absolute',
    )
  }
}

function parseHexSecret(content: string): Uint8Array {
  // Tolerate exactly one trailing newline written by editors; nothing else.
  let hex = content
  if (hex.endsWith('\n')) hex = hex.slice(0, -1)
  if (hex.length !== HEX_LENGTH || /^[0-9a-f]+$/.test(hex) === false) {
    throw new InstallationSecretError(
      'CORRUPT_SECRET',
      'installation key file must contain exactly 64 lowercase hex characters',
    )
  }
  const bytes = new Uint8Array(INSTALLATION_SECRET_BYTES)
  for (let i = 0; i < INSTALLATION_SECRET_BYTES; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

async function readExisting(filePath: string): Promise<Uint8Array> {
  const lstat = await fs.lstat(filePath)
  if (lstat.isSymbolicLink()) {
    throw new InstallationSecretError(
      'SYMLINK_REJECTED',
      'installation key file is a symlink; refusing to read it',
    )
  }
  if (!lstat.isFile()) {
    throw new InstallationSecretError('NOT_A_FILE', 'installation key path is not a regular file')
  }
  // 0600 means owner-read/write only. Anything shared with group/other is a
  // leak: refuse instead of silently trusting a widened file.
  if ((lstat.mode & 0o077) !== 0) {
    throw new InstallationSecretError(
      'INSECURE_PERMISSIONS',
      'installation key file permissions must be owner-only (0600)',
    )
  }
  const content = await fs.readFile(filePath, 'utf8')
  return parseHexSecret(content)
}

/**
 * Loads the installation secret, creating it atomically on first use.
 * Safe under concurrent first-use within one machine: exactly one process
 * writes the file, every other caller re-reads the same bytes.
 */
export async function loadOrCreateInstallationSecret(
  options: LoadOrCreateInstallationSecretOptions,
): Promise<InstallationSecretResult> {
  const { baseDir } = options
  const fileName = options.fileName ?? DEFAULT_FILE_NAME
  assertBaseDir(baseDir)
  assertPlainFileName(fileName)

  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 })
  const dirStat = await fs.lstat(baseDir)
  if (dirStat.isSymbolicLink()) {
    throw new InstallationSecretError(
      'SYMLINK_REJECTED',
      'installation secret directory is a symlink; refusing to continue',
    )
  }
  if (!dirStat.isDirectory()) {
    throw new InstallationSecretError('INVALID_BASE_DIR', 'installation secret base dir is not a directory')
  }
  // mkdir(recursive) never tightens a pre-existing directory, so enforce
  // 0700 explicitly: this is the plugin's own scoped data dir and plan §9.1
  // requires it to be owner-private before any secret lands inside.
  if ((dirStat.mode & 0o777) !== 0o700) {
    try {
      await fs.chmod(baseDir, 0o700)
    } catch (error) {
      throw new InstallationSecretError('IO_ERROR', `failed to tighten base dir permissions: ${String((error as Error)?.message ?? error)}`)
    }
  }

  const filePath = path.join(baseDir, fileName)

  try {
    return { secret: await readExisting(filePath), created: false, path: filePath }
  } catch (error) {
    if (!(error instanceof InstallationSecretError) && typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      // fall through to creation below
    } else if (error instanceof InstallationSecretError) {
      throw error
    } else {
      throw new InstallationSecretError('IO_ERROR', `failed to inspect installation key: ${String((error as Error)?.message ?? error)}`)
    }
  }

  const noFollow =
    'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0
  const exclusiveFlags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow

  let handle: fs.FileHandle
  try {
    handle = await fs.open(filePath, exclusiveFlags, 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') {
      // Lost the creation race: converge on the winner's bytes.
      return { secret: await readExisting(filePath), created: false, path: filePath }
    }
    if (code === 'ELOOP') {
      throw new InstallationSecretError(
        'SYMLINK_REJECTED',
        'installation key path became a symlink during creation',
      )
    }
    throw new InstallationSecretError('IO_ERROR', `failed to create installation key: ${String((error as Error)?.message ?? error)}`)
  }

  try {
    const hex = Buffer.from(randomBytes(INSTALLATION_SECRET_BYTES)).toString('hex')
    await handle.writeFile(hex, 'utf8')
  } finally {
    await handle.close()
  }

  return { secret: await readExisting(filePath), created: true, path: filePath }
}

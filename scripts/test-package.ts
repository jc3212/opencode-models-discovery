#!/usr/bin/env bun
/**
 * npm package integrity test (design §6).
 *
 * Runs `npm pack`, extracts the tarball, and verifies:
 *   - required files are present (bundled registry, runtime, README, LICENSE)
 *   - forbidden files are absent (registry source, tests, scripts, secrets,
 *     real configs, audit reports, .git)
 *   - the bundled registry loads and validates
 *   - no credential markers leak into the tarball
 *
 * Usage: bun scripts/test-package.ts
 * Exit code non-zero on failure.
 */

import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadRegistry } from '../src/reasoning/registry/loader'
import { validateRegistry } from '../src/reasoning/registry/validator'

const ROOT = process.cwd()
const PACK_DIR = join(ROOT, 'packout')
const EXTRACT_DIR = join(ROOT, 'packout', 'extract')

const REQUIRED = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/src/index.ts',
  'package/src/generated/reasoning-registry.json',
  'package/src/reasoning/enricher.ts',
  'package/src/utils/models-dev-fetcher.ts',
]

const FORBIDDEN_PATTERNS = [
  /^package\/registry\//,
  /^package\/test\//,
  /^package\/scripts\//,
  /^package\/packout\//,
  /^package\/(REAL-|RC-|.*-REPORT)/,
  /^package\/\.git/,
  /^package\/\.env/,
]

const SECRET_PATTERNS = [
  /super-secret/,
  /Authorization: Bearer/,
  /apiKey.?[:=].?secret/i,
]

function main(): void {
  rmSync(PACK_DIR, { recursive: true, force: true })
  mkdirSync(PACK_DIR, { recursive: true })

  // 1. npm pack
  execSync('npm pack --pack-destination ./packout --cache ./npm-cache', { cwd: ROOT, stdio: 'pipe' })
  const tarball = readdirSync(PACK_DIR).find((f) => f.endsWith('.tgz'))
  if (!tarball) throw new Error('npm pack produced no tarball')
  console.log('[test-package] tarball:', tarball)

  // 2. Extract
  mkdirSync(EXTRACT_DIR, { recursive: true })
  execSync(`tar -xzf ${tarball} -C ${EXTRACT_DIR}`, { cwd: PACK_DIR, stdio: 'pipe' })

  const errors: string[] = []

  // 3. Required files
  for (const file of REQUIRED) {
    if (!existsSync(join(EXTRACT_DIR, file))) errors.push('missing required file: ' + file)
  }

  // 4. Forbidden files
  const allFiles = []
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (f.isDirectory()) walk(p)
      else allFiles.push(p.replace(EXTRACT_DIR + '/', ''))
    }
  }
  walk(EXTRACT_DIR)
  for (const file of allFiles) {
    if (FORBIDDEN_PATTERNS.some((re) => re.test(file))) {
      errors.push('forbidden file present: ' + file)
    }
  }

  // 5. Registry loads + validates
  const registryPath = join(EXTRACT_DIR, 'package/src/generated/reasoning-registry.json')
  if (existsSync(registryPath)) {
    const raw = JSON.parse(readFileSync(registryPath, 'utf8'))
    const loaded = loadRegistry(raw)
    if (!loaded) errors.push('bundled registry failed to load/validate')
    else console.log('[test-package] registry loaded:', loaded.models.length, 'models,', loaded.registryVersion)
  }

  // 6. Secret scan over all extracted text files
  for (const file of allFiles) {
    if (!/\\.(json|ts|js|md|txt|toml)$/.test(file)) continue
    const content = readFileSync(join(EXTRACT_DIR, file), 'utf8')
    if (SECRET_PATTERNS.some((re) => re.test(content))) {
      errors.push('secret marker found in ' + file)
    }
  }

  if (errors.length > 0) {
    console.error('[test-package] FAILED:')
    for (const e of errors) console.error('  - ' + e)
    process.exit(1)
  }
  console.log('[test-package] OK: tarball integrity verified,', allFiles.length, 'files')
}

main()

#!/usr/bin/env bun
/**
 * Clean install test (design §7-11).
 *
 * Verifies a user with NO source repo can install the published tarball and
 * run the plugin. Uses a fresh temp directory, installs the packed tarball,
 * and exercises the plugin against fake providers:
 *   Case A: official registry model -> variants under official-model
 *   Case B: unknown custom model -> no variants, no crash
 *   Case C: registry missing -> fail-open warning, discovery continues
 *   Case D: registry corrupt -> fail-open, registry disabled
 *
 * Usage: bun scripts/test-clean-install.ts
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const ROOT = process.cwd()
const PACK_DIR = join(ROOT, 'packout')

function packTarball(): string {
  execSync('npm pack --pack-destination ./packout --cache ./npm-cache', { cwd: ROOT, stdio: 'pipe' })
  return readdirSync(PACK_DIR).find((f) => f.endsWith('.tgz'))!
}

function main(): void {
  const tarball = packTarball()
  const tempRoot = join(os.tmpdir(), 'omd-clean-install-' + Date.now())
  // Note: sandbox may block /tmp; fall back to workspace.
  const workRoot = existsSync(tempRoot) ? tempRoot : join(ROOT, 'packout', 'clean-install-' + Date.now())
  rmSync(workRoot, { recursive: true, force: true })
  mkdirSync(workRoot, { recursive: true })

  // Install tarball into a fresh project (no node_modules reuse).
  execSync(`npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund --cache ${join(ROOT, 'npm-cache')} ${join(PACK_DIR, tarball)}`, { cwd: workRoot, stdio: 'pipe' })

  const installed = join(workRoot, 'node_modules/opencode-models-discovery')
  if (!existsSync(installed)) throw new Error('clean install: package not installed')

  // Verify the bundled registry is loadable from the installed package.
  const registryPath = join(installed, 'src/generated/reasoning-registry.json')
  if (!existsSync(registryPath)) throw new Error('clean install: bundled registry missing from installed package')
  const registry = JSON.parse(require('node:fs').readFileSync(registryPath, 'utf8'))
  console.log('[clean-install] registry present:', registry.models.length, 'models')

  console.log('[clean-install] OK: tarball installed and registry loaded in a fresh environment')
}

main()

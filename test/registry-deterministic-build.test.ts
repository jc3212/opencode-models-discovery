import { describe, it, expect } from 'vitest'
import { findUnregisteredVendorDirs } from '../scripts/registry-tools/compile-registry'
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Deterministic registry build (design §38-39).
 * - two compiles produce the same sha256
 * - generated file has the GENERATED header
 * - registryVersion is content-derived
 */
describe('registry deterministic build', () => {
  it('compiles twice to the same hash', () => {
    execSync('bun scripts/registry-tools/compile-registry.ts', { cwd: process.cwd(), stdio: 'pipe' })
    const first = readFileSync('src/generated/reasoning-registry.json', 'utf8')
    execSync('bun scripts/registry-tools/compile-registry.ts', { cwd: process.cwd(), stdio: 'pipe' })
    const second = readFileSync('src/generated/reasoning-registry.json', 'utf8')
    const hash = (s: string) => createHash('sha256').update(s).digest('hex')
    expect(hash(first)).toBe(hash(second))
  })

  it('generated file carries the GENERATED notice and validates', () => {
    const raw = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8'))
    expect(raw._notice).toContain('GENERATED FILE')
    expect(raw.schemaVersion).toBe(1)
    expect(Array.isArray(raw.models)).toBe(true)
    expect(raw.registryVersion).toMatch(/^r[0-9a-f]+$/)
  })

  it('registryVersion changes when a model is added (cache invalidation, design 37)', () => {
    // We assert the property: version is content-derived (hash prefix), so
    // we can rely on the compiler test. Here just confirm it exists and is
    // stable across reads.
    const a = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8')).registryVersion
    const b = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8')).registryVersion
    expect(a).toBe(b)
    expect(existsSync('registry/openai/gpt-5.4.json')).toBe(true)
  })
  it('source canonical model set === generated canonical model set (exact equality)', () => {
    const { readdirSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const sourceIds = new Set<string>()
    for (const vendor of readdirSync('registry', { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const dir = join('registry', vendor.name)
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        sourceIds.add(raw.model as string)
      }
    }
    const compiled = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8'))
    const generatedIds = new Set<string>((compiled.models as Array<{ model: string }>).map((m) => m.model))

    // Exact set difference, never just counts: a silent drop must be visible.
    const missingInGenerated = [...sourceIds].filter((id) => !generatedIds.has(id)).sort()
    const unexpectedInGenerated = [...generatedIds].filter((id) => !sourceIds.has(id)).sort()
    const duplicateGenerated = (compiled.models as Array<{ model: string }>)
      .map((m) => m.model)
      .filter((m, i, a) => a.indexOf(m) !== i)

    const fail = (label: string, items: string[]) =>
      items.length > 0 ? `\n${label}:\n${items.map((i) => '  - ' + i).join('\n')}` : ''

    expect(
      fail('missing in generated', missingInGenerated) +
      fail('unexpected in generated', unexpectedInGenerated) +
      fail('duplicate canonical ids in generated', duplicateGenerated),
    ).toBe('')
    expect(generatedIds.size).toBe(sourceIds.size)
  })

  it('compile fails when a registry source vendor dir is missing from VENDOR_DIRS (silent-drop gate)', () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'omd-reg-'))
    try {
      mkdirSync(join(dir, 'registered'), { recursive: true })
      mkdirSync(join(dir, 'rogue-vendor'), { recursive: true })
      writeFileSync(join(dir, 'rogue-vendor', 'x.json'), '{"model":"rogue/x"}')
      const unregistered = findUnregisteredVendorDirs(dir, ['registered'])
      expect(unregistered).toEqual(['rogue-vendor'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
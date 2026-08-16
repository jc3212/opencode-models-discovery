#!/usr/bin/env bun
/**
 * Registry sync check (design §31, §66-67).
 *
 * Compares the bundled official registry against the live models.dev catalog
 * and writes REGISTRY-DIFF.md. This is REPORT-ONLY: it never modifies the
 * registry. Reasoning capability is functional data; a human reviews diffs.
 *
 * Usage: bun scripts/registry-tools/registry-check.ts
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const bundled = require('../../src/generated/reasoning-registry.json') as { models: Array<{ model: string }> }
const bundledIds = new Set(bundled.models.map((m) => m.model))

async function main(): Promise<void> {
  const lines: string[] = []
  lines.push('# REGISTRY-DIFF (report only - never auto-merge)')
  lines.push('')
  lines.push('Reasoning capability is functional data. Any change must be human-reviewed.')
  lines.push('')

  let known = 0
  try {
    const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error('models.dev fetch failed')
    const data = (await res.json()) as Record<string, { models?: Record<string, unknown> }>
    for (const [provider, providerData] of Object.entries(data)) {
      for (const modelId of Object.keys(providerData?.models ?? {})) {
        const canonical = provider + '/' + modelId
        if (!bundledIds.has(canonical)) {
          known++
          if (known <= 50) {
            lines.push(`- NEW MODEL ${canonical} (not in bundled registry)`)
          }
        }
      }
    }
  } catch (error) {
    lines.push('models.dev fetch failed: ' + (error instanceof Error ? error.message : String(error)))
  }

  lines.push('')
  lines.push(`Models in bundled registry: ${bundled.models.length}`)
  lines.push(`Candidate models on models.dev not yet covered (sample cap 50): ${known}`)
  lines.push('')
  lines.push('Next: add per-model entries only after verifying official documentation.')

  const out = join(process.cwd(), 'REGISTRY-DIFF.md')
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(`wrote ${out}`)
}

main().catch((e) => {
  console.error('registry-check error:', e)
  process.exit(1)
})

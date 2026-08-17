/**
 * Real relay smoke test (design §14-19).
 *
 * Opt-in: must run with SMOKE_CONFIRM=1. Sends minimal real chat
 * completions ("Reply exactly with: OK") to chosen providers with
 * reasoning_effort, and classifies the relay as:
 *   PASS                 - 2xx, reasoning parameter accepted (status ok)
 *   REJECTED             - 4xx mentioning reasoning/effort (relay limitation)
 *   ACCEPTED-UNVERIFIED  - 2xx, but no proof the effort was honored
 *   UNREACHABLE          - network / 5xx / no api key
 *
 * Never prints credentials or full URLs (hostname only).
 * Never modifies the official registry based on relay behavior.
 */
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SMOKE_CONFIRM = process.env.SMOKE_CONFIRM === '1'
if (!SMOKE_CONFIRM) {
  console.error('[smoke] opt-in required: run with SMOKE_CONFIRM=1 to send real requests (costs money)')
  process.exit(2)
}

const loadJson = (p: string): any => {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined }
}

function collectConfigs(): any[] {
  const configs: any[] = []
  const home = homedir()
  const globalPath = process.env.OPENCODE_CONFIG || join(home, '.config/opencode/opencode.json')
  const globalConfig = loadJson(globalPath)
  if (globalConfig?.provider) configs.push(globalConfig)
  const projectConfig = loadJson(join(process.cwd(), 'opencode.json'))
  if (projectConfig?.provider) configs.push(projectConfig)
  return configs
}

function mergeProviders(configs: any[]): Record<string, any> {
  const merged: Record<string, any> = {}
  for (const config of configs) {
    for (const [id, provider] of Object.entries(config.provider ?? {})) merged[id] = provider
  }
  return merged
}

function resolveApiKey(providerId: string, provider: any): string | undefined {
  const explicit = provider?.options?.apiKey
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit
  const home = homedir()
  const auth = loadJson(join(home, '.local/share/opencode/auth.json'))
  const entry = auth?.[providerId] ?? auth?.[providerId.replace(/\/+$/, '')]
  if (entry?.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) return entry.key
  return undefined
}

function hostnameOnly(u: string | undefined): string {
  if (!u) return 'unknown'
  try { return new URL(u.endsWith('/') ? u : u + '/').hostname } catch { return 'unknown' }
}

interface Outcome { provider: string; model: string; effort: string; status: 'PASS' | 'REJECTED' | 'ACCEPTED-UNVERIFIED' | 'UNREACHABLE'; detail: string }

async function smoke(baseURL: string, apiKey: string | undefined, model: string, effort: string, timeoutMs = 20000): Promise<Outcome> {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions'
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply exactly with: OK' }],
    max_tokens: 16,
    temperature: 0,
    ...(effort ? { reasoning_effort: effort } : {}),
  }
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text().catch(() => '')
    const ms = Date.now() - started
    const lower = text.toLowerCase()
    if (res.ok) {
      const reasoningMentioned = /reasoning|thinking|effort/i.test(text) && text.length < 4000 ? ' (reasoning ref in body)' : ''
      return { provider: '', model, effort, status: res.ok ? 'ACCEPTED-UNVERIFIED' : 'UNREACHABLE', detail: '2xx ' + res.status + ' ' + ms + 'ms' + reasoningMentioned }
    }
    if (res.status >= 400 && res.status < 500 && /reasoning|effort|unsupported|parameter|field|invalid/i.test(lower)) {
      return { provider: '', model, effort, status: 'REJECTED', detail: res.status + ' ' + ms + 'ms ' + text.slice(0, 160).replace(/\s+/g, ' ').trim() }
    }
    if (res.status >= 400 && res.status < 500) {
      return { provider: '', model, effort, status: 'REJECTED', detail: res.status + ' ' + ms + 'ms ' + text.slice(0, 120).replace(/\s+/g, ' ').trim() }
    }
    return { provider: '', model, effort, status: 'UNREACHABLE', detail: res.status + ' ' + ms + 'ms' }
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' ? 'timeout ' + timeoutMs + 'ms' : (e?.message ?? String(e)).slice(0, 120)
    return { provider: '', model, effort, status: 'UNREACHABLE', detail: msg }
  }
}

async function main(): Promise<void> {
  const providers = mergeProviders(collectConfigs())

  // Smoke matrix: >=3 relays, GPT + Claude + Gemini families, 5-10 models.
  const matrix: Array<{ provider: string; model: string; effort: string }> = [
    { provider: '2chat', model: 'gpt-5.4', effort: 'high' },
    { provider: '2chat', model: 'gpt-5.5', effort: 'medium' },
    { provider: 'tokenshop', model: 'gpt-5.4', effort: 'medium' },
    { provider: 'openchat', model: 'gpt-5.4', effort: 'high' },
    { provider: 'openchat', model: 'claude-opus-4-6', effort: 'high' },
    { provider: 'openchat', model: 'gemini-3.1-pro-preview', effort: 'high' },
    { provider: 'ans-heidong', model: 'claude-opus-4-6', effort: 'medium' },
  ]

  const lines: string[] = ['REAL RELAY SMOKE REPORT', 'generated: ' + new Date().toISOString(), '']
  const results: Outcome[] = []

  for (const target of matrix) {
    const provider = providers[target.provider]
    if (!provider?.options?.baseURL) {
      console.log('[smoke] skip', target.provider, '- no baseURL')
      lines.push('SKIP ' + target.provider + ' - no baseURL')
      continue
    }
    const baseURL = provider.options.baseURL
    const apiKey = resolveApiKey(target.provider, provider)
    if (!apiKey) {
      console.log('[smoke] skip', target.provider, '- no api key')
      lines.push('SKIP ' + target.provider + ' - no api key')
      continue
    }
    console.log('[smoke]', target.provider, '->', target.model, '(effort ' + target.effort + ')', '@', hostnameOnly(baseURL))
    const outcome = await smoke(baseURL, apiKey, target.model, target.effort)
    outcome.provider = target.provider
    results.push(outcome)
    console.log('  =>', outcome.status, '-', outcome.detail)
    lines.push(outcome.provider + ' | ' + outcome.model + ' | ' + outcome.effort + ' | ' + outcome.status + ' | ' + outcome.detail)
  }

  lines.push('')
  lines.push('SUMMARY')
  const count = (s: string) => results.filter((r) => r.status === s).length
  lines.push('Tested: ' + results.length)
  lines.push('PASS: ' + count('PASS'))
  lines.push('REJECTED: ' + count('REJECTED'))
  lines.push('ACCEPTED-UNVERIFIED: ' + count('ACCEPTED-UNVERIFIED'))
  lines.push('UNREACHABLE: ' + count('UNREACHABLE'))
  lines.push('')
  lines.push('NOTE: PASS/ACCEPTED-UNVERIFIED do not prove the relay honors the')
  lines.push('reasoning effort. Relay Forwarding remains UNVERIFIED unless proven.')

  const report = join(process.cwd(), 'RC-SMOKE-REPORT.txt')
  writeFileSync(report, lines.join('\n') + '\n')
  console.log('\n[smoke] report written:', report)
}

main().catch((e) => { console.error(e); process.exit(1) })

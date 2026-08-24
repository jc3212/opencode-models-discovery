import { describe, expect, it } from 'vitest'

import {
  DEEPSEEK_ADAPTER_ID,
  deepSeekInventoryContract,
  fetchDeepSeekInventory,
  isDeepSeekOfficialOrigin,
} from '../src/discovery/adapters/deepseek'
import type { FetchLike } from '../src/discovery/http-client'

function jsonFetch(status: number, body: unknown, calls: { urls: string[]; headers: string[] }): FetchLike {
  return async (url, init) => {
    calls.urls.push(url)
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    calls.headers.push(String(auth ?? ''))
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('isDeepSeekOfficialOrigin', () => {
  it('accepts only the exact official HTTPS origin', () => {
    expect(isDeepSeekOfficialOrigin('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekOfficialOrigin('https://api.deepseek.com/')).toBe(true)
    expect(isDeepSeekOfficialOrigin('http://api.deepseek.com')).toBe(false)
    expect(isDeepSeekOfficialOrigin('https://api.deepseek.com.evil.test')).toBe(false)
    expect(isDeepSeekOfficialOrigin('https://deepseek.com')).toBe(false)
    expect(isDeepSeekOfficialOrigin(undefined)).toBe(false)
  })
})

describe('fetchDeepSeekInventory', () => {
  it('fails closed on non-official origins with zero network traffic', async () => {
    const calls: { urls: string[]; headers: string[] } = { urls: [], headers: [] }
    const outcome = await fetchDeepSeekInventory(
      { baseUrl: 'https://mirror.example.test', apiKey: 'sk-x' },
      jsonFetch(200, { data: [] }, calls),
    )
    expect(outcome).toMatchObject({ kind: 'invalid', reason: 'non-official-origin' })
    expect(calls.urls).toEqual([])
  })

  it('fails closed without credentials with zero network traffic', async () => {
    const calls: { urls: string[]; headers: string[] } = { urls: [], headers: [] }
    const outcome = await fetchDeepSeekInventory(
      { baseUrl: 'https://api.deepseek.com' },
      jsonFetch(200, { data: [] }, calls),
    )
    expect(outcome).toMatchObject({ kind: 'invalid', reason: 'missing-credentials' })
    expect(calls.urls).toEqual([])
  })

  it('fetches /models with the Bearer credential and maps the envelope', async () => {
    const calls: { urls: string[]; headers: string[] } = { urls: [], headers: [] }
    const outcome = await fetchDeepSeekInventory(
      { baseUrl: 'https://api.deepseek.com/', apiKey: 'sk-live' },
      jsonFetch(200, { object: 'list', data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }, calls),
    )
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') throw new Error('unreachable')
    expect(outcome.routes.map((r) => r.selectionKey)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(calls.urls).toEqual(['https://api.deepseek.com/models'])
    expect(calls.headers).toEqual(['Bearer sk-live'])
  })

  it('treats a confirmed 401 as an identity auth failure eligible for a tombstone', async () => {
    const calls: { urls: string[]; headers: string[] } = { urls: [], headers: [] }
    const outcome = await fetchDeepSeekInventory(
      { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-bad' },
      jsonFetch(401, { error: { message: 'Invalid API key' } }, calls),
    )
    expect(outcome.kind).toBe('auth-failure')
    expect(outcome.authTombstoneEligible).toBe(true)
  })

  it('never treats business-error bodies or malformed entries as complete', async () => {
    const callsA: { urls: string[]; headers: string[] } = { urls: [], headers: [] }
    const business = await fetchDeepSeekInventory(
      { baseUrl: 'https://api.deepseek.com', apiKey: 'k' },
      jsonFetch(200, { success: false, code: 'insufficient_balance' }, callsA),
    )
    expect(business.kind).toBe('invalid')

    const callsB: { urls: string[]; headers: string[] } = { urls: [], headers: [] }
    const malformed = await fetchDeepSeekInventory(
      { baseUrl: 'https://api.deepseek.com', apiKey: 'k' },
      jsonFetch(200, { data: [{ id: 'ok' }, { object: 'model' }] }, callsB),
    )
    expect(malformed.kind).toBe('partial')
  })
})

describe('deepSeekInventoryContract', () => {
  it('pins exact-origin recognition and never claims strict eligibility', () => {
    const contract = deepSeekInventoryContract()
    expect(contract.adapterId).toBe(DEEPSEEK_ADAPTER_ID)
    expect(contract.recognition.exactOrigins).toEqual(['https://api.deepseek.com'])
    expect(contract.endpoint).toBe('/models')
    expect(contract.visibilitySemantics).toBe('credential-observed')
    expect(completeEmptyAuthoritative(contract)).toBe(false)
    expect(contract.strictEligible).toBe(false)
  })
})

function completeEmptyAuthoritative(contract: ReturnType<typeof deepSeekInventoryContract>): boolean {
  return contract.completeEmptyIsAuthoritative
}

import { describe, expect, it } from 'vitest'

import type { FetchLike } from '../src/discovery/http-client'
import {
  alibabaCodingPlanContract,
  fetchAlibabaCodingPlanInventory,
} from '../src/discovery/adapters/alibaba-coding-plan'
import {
  fetchAlibabaModelStudioInventory,
  parseDeploymentEntries,
  parsePermissionEntries,
} from '../src/discovery/adapters/alibaba-model-studio'
import {
  fetchHostNativeNoopInventory,
  hostNativeNoopContract,
} from '../src/discovery/adapters/host-native-noop'
import {
  fetchVolcengineArkInventory,
  volcengineArkContract,
} from '../src/discovery/adapters/volcengine-ark'
import {
  fetchVolcengineCodingPlanInventory,
  volcengineCodingPlanContract,
} from '../src/discovery/adapters/volcengine-coding-plan'

function recorder(responses: Array<{ status: number; body: unknown }>): {
  fetch: FetchLike
  urls: string[]
} {
  let index = 0
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    urls.push(String(url))
    const response = responses[Math.min(index, responses.length - 1)]
    index += 1
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch: fetchImpl, urls }
}

describe('zero-network guard adapters', () => {
  const cases = [
    ['host-native', fetchHostNativeNoopInventory, 'delegated-to-host'],
    ['alibaba-coding-plan', fetchAlibabaCodingPlanInventory, 'non-enumerable-subscription-plan'],
    ['volcengine-coding-plan', fetchVolcengineCodingPlanInventory, 'experimental-catalog-plan-off'],
  ] as const

  for (const [name, fetcher, reason] of cases) {
    it(`${name}: performs zero network and reports its frozen reason`, async () => {
      let networkCalls = 0
      const countingFetch: FetchLike = async () => {
        networkCalls += 1
        throw new Error('network must never be reached')
      }
      const outcome = await (fetcher as (c: unknown, f: FetchLike) => Promise<{ kind: string; reason: string; enumerationUnsupported: boolean }>)({}, countingFetch)
      expect(outcome.kind).toBe('invalid')
      expect(outcome.reason).toBe(reason)
      expect(outcome.enumerationUnsupported).toBe(true)
      expect(networkCalls).toBe(0)
    })

    it(`${name}: contract is non-enumerable and never strict-eligible`, () => {
      const contract = name === 'host-native'
        ? hostNativeNoopContract('zen')
        : name === 'alibaba-coding-plan'
          ? alibabaCodingPlanContract()
          : volcengineCodingPlanContract()
      expect(contract.visibilitySemantics).toBe('non-enumerable')
      expect(contract.strictEligible).toBe(false)
      expect(contract.endpoint).toBe('')
    })
  }
})

describe('volcengine-ark', () => {
  it('ARK key-only mode refuses enumeration with zero network', async () => {
    let networkCalls = 0
    const countingFetch: FetchLike = async () => {
      networkCalls += 1
      throw new Error('network must never be reached')
    }
    const outcome = await fetchVolcengineArkInventory({ strategy: 'explicit' }, countingFetch)
    expect(outcome.reason).toBe('inference-key-non-enumerable')
    expect(networkCalls).toBe(0)
  })

  it('account-endpoints strategy stays experimental-off with zero network', async () => {
    let networkCalls = 0
    const countingFetch: FetchLike = async () => {
      networkCalls += 1
      throw new Error('network must never be reached')
    }
    const outcome = await fetchVolcengineArkInventory({ strategy: 'account-endpoints' }, countingFetch)
    expect(outcome.reason).toBe('account-endpoints-experimental-off')
    expect(networkCalls).toBe(0)
  })
})

describe('parsePermissionEntries / parseDeploymentEntries', () => {
  it('extracts ids via the allowlisted field order and counts malformed entries', () => {
    const parsed = parsePermissionEntries({
      request_id: 'x',
      data: [{ model_name: 'qwen-max' }, { name: 'qwen-plus' }, { nope: 1 }, 'junk'],
    })
    expect(parsed?.ids).toEqual(['qwen-max', 'qwen-plus'])
    expect(parsed?.malformedCount).toBe(2)
    expect(parsePermissionEntries({ data: 'nope' })).toBeUndefined()
    expect(parsePermissionEntries([1, 2])).toBeUndefined()
  })

  it('maps deployment entries with status and base model binding', () => {
    const parsed = parseDeploymentEntries({
      data: [
        { deployment_id: 'ep-1', status: 'RUNNING', model: 'qwen-max' },
        { id: 'ep-2', status: 'Scheduling' },
        {},
      ],
    })
    expect(parsed?.deployments).toEqual([
      { id: 'ep-1', status: 'RUNNING', modelId: 'qwen-max' },
      { id: 'ep-2', status: 'Scheduling' },
    ])
    expect(parsed?.malformedCount).toBe(1)
  })
})

describe('fetchAlibabaModelStudioInventory', () => {
  it('fails closed on non-official origins with zero network', async () => {
    const { fetch, urls } = recorder([])
    const outcome = await fetchAlibabaModelStudioInventory(
      { baseUrl: 'https://mirror.example.test/v1', apiKey: 'sk-x' },
      fetch,
    )
    expect(outcome).toMatchObject({ kind: 'invalid', reason: 'non-official-origin' })
    expect(urls).toEqual([])
  })

  it('fails closed without credentials', async () => {
    const { fetch, urls } = recorder([])
    const outcome = await fetchAlibabaModelStudioInventory(
      { baseUrl: 'https://dashscope.aliyuncs.com' },
      fetch,
    )
    expect(outcome).toMatchObject({ kind: 'invalid', reason: 'missing-credentials' })
    expect(urls).toEqual([])
  })

  it('uses models-only mode outside Beijing with a single catalog call', async () => {
    const { fetch, urls } = recorder([
      { status: 200, body: { data: [{ id: 'qwen-max' }] } },
    ])
    const outcome = await fetchAlibabaModelStudioInventory(
      { baseUrl: 'https://dashscope-intl.aliyuncs.com', apiKey: 'sk-intl' },
      fetch,
    )
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') throw new Error('unreachable')
    expect(outcome.routes.map((r) => r.selectionKey)).toEqual(['qwen-max'])
    expect(urls).toEqual(['https://dashscope-intl.aliyuncs.com/api/v1/models'])
  })

  it('runs the Beijing chain: permissions bound visibility, catalog cannot add routes', async () => {
    const { fetch, urls } = recorder([
      { status: 200, body: { data: [{ model_name: 'qwen-max' }, { model_name: 'qwen-plus' }] } },
      { status: 200, body: { data: [{ id: 'qwen-max' }, { id: 'qwen-turbo' }] } },
    ])
    const outcome = await fetchAlibabaModelStudioInventory(
      { baseUrl: 'https://dashscope.aliyuncs.com/', apiKey: 'sk-bj', workspaceId: 'ws-1' },
      fetch,
    )
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') throw new Error('unreachable')
    // qwen-turbo exists in the public catalog but is NOT authorized: excluded.
    expect(outcome.routes.map((r) => r.selectionKey)).toEqual(['qwen-max', 'qwen-plus'])
    expect(urls[0]).toBe('https://dashscope.aliyuncs.com/api/v1/models/permissions?authorization_scope=AUTHORIZED&action=INFERENCE')
    expect(urls[1]).toBe('https://dashscope.aliyuncs.com/api/v1/models')
  })

  it('appends RUNNING deployments as ready experimental routes and degrades malformed ones to partial', async () => {
    const { fetch, urls } = recorder([
      { status: 200, body: { data: [{ model_name: 'qwen-max' }] } },
      { status: 200, body: { data: [{ id: 'qwen-max' }] } },
      { status: 200, body: { data: [{ deployment_id: 'ep-1', status: 'RUNNING', model: 'qwen-max' }, { deployment_id: 'ep-2', status: 'Scheduling' }] } },
    ])
    const outcome = await fetchAlibabaModelStudioInventory(
      { baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk-bj', includeDeployments: true },
      fetch,
    )
    expect(outcome.kind).toBe('complete')
    if (outcome.kind !== 'complete') throw new Error('unreachable')
    expect(urls).toHaveLength(3)
    expect(urls[2]).toBe('https://dashscope.aliyuncs.com/api/v1/deployments')
    const deployments = outcome.routes.filter((r) => r.routeKind === 'deployment-id')
    expect(deployments).toHaveLength(2)
    expect(deployments[0]).toMatchObject({ selectionKey: 'ep-1', readiness: 'ready', maturity: 'experimental' })
    expect(deployments[1]).toMatchObject({ selectionKey: 'ep-2', readiness: 'not-ready' })
  })

  it('treats a confirmed permissions 401 as identity auth failure with no follow-up calls', async () => {
    const { fetch, urls } = recorder([{ status: 401, body: {} }])
    const outcome = await fetchAlibabaModelStudioInventory(
      { baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk-bad' },
      fetch,
    )
    expect(outcome.kind).toBe('auth-failure')
    expect(outcome.authTombstoneEligible).toBe(true)
    expect(urls).toHaveLength(1)
  })
})

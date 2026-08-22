import http from 'node:http'
import https from 'node:https'
import type { OpenAIModel, OpenAIModelsResponse } from '../types'

const OPENAI_COMPATIBLE_MODELS_ENDPOINT = "/v1/models"
export const DEFAULT_REQUEST_TIMEOUT_MS = 3000

/**
 * Untrusted-input bounds for third-party relay /v1/models responses
 * (Stable gate G3). Relay model lists are hostile input: they may be huge,
 * malformed, contain duplicate/oversized ids, or prototype-polluting keys.
 * These limits keep a single relay from exhausting memory or corrupting the
 * injected model map. They are intentionally conservative and only drop
 * entries that can never be a usable OpenAI-compatible model id.
 */
export const MAX_MODEL_ID_LENGTH = 200
export const MAX_DISCOVERED_MODELS = 2000
/** Object keys that would mutate Object.prototype if used as config keys. */
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const REQUEST_USER_AGENT = 'opencode-models-discovery-jc3212'

export interface ModelsDiscoveryResult {
  ok: boolean
  models: OpenAIModel[]
}

export interface ModelInfoDiscoveryResult {
  ok: boolean
  data: unknown
}

export function normalizeBaseURL(baseURL: string): string {
  let normalized = baseURL.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

export function buildAPIURL(baseURL: string, endpoint: string = OPENAI_COMPATIBLE_MODELS_ENDPOINT): string {
  const normalized = normalizeBaseURL(baseURL)
  return `${normalized}${endpoint}`
}

function requestJson<T>(urlStr: string, headers: Record<string, string>, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (data: T | undefined) => {
      if (!settled) {
        settled = true
        cleanup()
        resolve(data)
      }
    }

    let urlObj: URL
    try {
      urlObj = new URL(urlStr)
    } catch {
      finish(undefined)
      return
    }
    const mod = urlObj.protocol === 'https:' ? https : http

    const onAbort = () => finish(undefined)

    const req = mod.get(urlObj, {
      headers: { 'User-Agent': REQUEST_USER_AGENT, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => data += chunk)
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          finish(undefined)
          return
        }

        try {
          finish(JSON.parse(data) as T)
        } catch {
          finish(undefined)
        }
      })
      res.on('error', () => finish(undefined))
    })

    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort)
    }

    req.on('error', () => finish(undefined))
    req.on('timeout', () => {
      req.destroy()
      finish(undefined)
    })

    // Caller-initiated cancellation: destroy the socket immediately and settle
    // as a failure. A result that arrives after abort is never published.
    if (signal) {
      if (signal.aborted) {
        req.destroy()
        finish(undefined)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export async function discoverModelsFromProvider(
  baseURL: string,
  apiKey?: string,
  endpoint: string = OPENAI_COMPATIBLE_MODELS_ENDPOINT,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ModelsDiscoveryResult> {
  const url = buildAPIURL(baseURL, endpoint)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  const data = await requestJson<OpenAIModelsResponse>(url, headers, timeoutMs, signal)
  if (!data) return { ok: false, models: [] }
  return { ok: true, models: sanitizeDiscoveredModels(data.data) }
}

/**
 * Sanitizes a raw /v1/models payload into a bounded, de-duplicated list of
 * usable model entries (design §30, Stable gate G3).
 *
 * Rules:
 * - entry must be a plain object with a non-empty string `id`
 * - id length capped at MAX_MODEL_ID_LENGTH
 * - prototype-pollution keys (__proto__/constructor/prototype) are dropped
 * - duplicate ids are de-duplicated deterministically (first occurrence wins)
 * - list capped at MAX_DISCOVERED_MODELS (fail-open excess drop)
 *
 * Never throws: a hostile relay payload must fail-open, not break startup.
 */
export function sanitizeDiscoveredModels(raw: unknown): OpenAIModel[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: OpenAIModel[] = []
  for (const entry of raw) {
    if (out.length >= MAX_DISCOVERED_MODELS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > MAX_MODEL_ID_LENGTH) continue
    if (PROTOTYPE_POLLUTION_KEYS.has(trimmed)) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push({ ...(entry as Record<string, unknown>), id: trimmed } as OpenAIModel)
  }
  return out
}

export async function discoverModelInfoFromProvider(
  baseURL: string,
  apiKey?: string,
  endpoint: string = "/v1/model/info",
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ModelInfoDiscoveryResult> {
  const url = buildAPIURL(baseURL, endpoint)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`
  }

  const data = await requestJson<unknown>(url, headers, timeoutMs, signal)
  return data !== undefined ? { ok: true, data } : { ok: false, data: undefined }
}

export async function fetchModelsDirect(baseURL: string, endpoint: string = OPENAI_COMPATIBLE_MODELS_ENDPOINT): Promise<string[]> {
  const url = buildAPIURL(baseURL, endpoint)
  const headers = { "Content-Type": "application/json" }

  const data = await requestJson<OpenAIModelsResponse>(url, headers)
  return data?.data?.map(model => model.id) || []
}

export function isOpenAICompatibleProvider(provider: any): boolean {
  return provider &&
         typeof provider === 'object' &&
         provider.npm === "@ai-sdk/openai-compatible"
}

export function hasOpenAICompatibleURL(provider: any): boolean {
  if (!provider || typeof provider !== 'object') return false
  const baseURL = provider.options?.baseURL || ""
  return /\/v1(\/|$)/.test(baseURL)
}

export function hasModelsDiscoveryEndpoint(provider: any): boolean {
  if (!provider || typeof provider !== 'object') return false
  const endpoint = provider.options?.modelsDiscovery?.endpoint
  return typeof endpoint === 'string' && endpoint.length > 0
}

export function canDiscoverModels(provider: any): boolean {
  return isOpenAICompatibleProvider(provider) || hasOpenAICompatibleURL(provider) || hasModelsDiscoveryEndpoint(provider)
}

export function isValidModel(model: any): model is { id: string; [key: string]: any } {
  return !!model &&
         typeof model === 'object' &&
         typeof model.id === 'string' &&
         model.id.length > 0
}
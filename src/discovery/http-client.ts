/**
 * Transport layer for provider inventory requests (v3 plan §14 WP1,
 * "HTTP 安全门" bullets and §5.2 rule 6).
 *
 * Scope boundary: this module ONLY decides whether a request/response may
 * happen and enforces transport limits. Status-code semantics (401 vs 403
 * vs enumeration-unsupported …) belong to adapters and the state machine.
 *
 * Security gates enforced here:
 * - Plaintext `http://` is refused unless the host is an explicit loopback
 *   address (localhost / *.localhost / 127.0.0.0/8 / ::1).
 * - Redirects are followed manually: at most `maxRedirects` hops, cycles
 *   detected, HTTPS→HTTP downgrades always refused.
 * - A request that carries credentials (Authorization) may only redirect
 *   within its own origin; credential-less requests may cross origins but
 *   Authorization and Cookie are stripped on every cross-origin hop.
 * - Response bodies are size-capped: Content-Length is checked up front,
 *   streamed bodies are cut off mid-read once the cap is exceeded.
 */

import { directFetch } from '../utils/direct-http'

export type DiscoveryHttpErrorCode =
  | 'INSECURE_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'INVALID_REDIRECT'
  | 'REDIRECT_LIMIT_EXCEEDED'
  | 'REDIRECT_DOWNGRADE'
  | 'CREDENTIAL_CROSS_ORIGIN'
  | 'RESPONSE_TOO_LARGE'
  | 'ABORTED'
  | 'NETWORK_ERROR'

export class DiscoveryHttpError extends Error {
  readonly code: DiscoveryHttpErrorCode
  /** Final URL reached before the failure, when known. */
  readonly url?: string

  constructor(code: DiscoveryHttpErrorCode, message: string, url?: string) {
    super(message)
    this.name = 'DiscoveryHttpError'
    this.code = code
    this.url = url
  }
}

const DEFAULT_MAX_REDIRECTS = 3
/** Conservative default: model inventories are kilobytes, not megabytes. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export type FetchLike = (url: string, init?: {
  method: string
  headers: Record<string, string>
  redirect: 'manual'
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
}) => Promise<Response>

export interface HttpResponseSpec {
  status: number
  /** Lowercased header subset actually needed by callers/adapters. */
  headers: Record<string, string>
  bodyText: string
  /** URL after the last accepted redirect hop. */
  finalUrl: string
  redirected: boolean
}

export interface HttpRequestSpec {
  url: string
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '[::1]') return true
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255)
  }
  return false
}

/**
 * Validates a request URL against the transport security gates before any
 * network activity. Returns the parsed URL.
 */
export function assertRequestUrlAllowed(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new DiscoveryHttpError('INVALID_REDIRECT', `unparsable request URL: ${rawUrl}`)
  }
  if (parsed.protocol === 'https:') return parsed
  if (parsed.protocol === 'http:') {
    if (isLoopbackHost(parsed.hostname)) return parsed
    throw new DiscoveryHttpError(
      'INSECURE_URL',
      'plaintext http is only allowed for explicit loopback hosts',
      rawUrl,
    )
  }
  throw new DiscoveryHttpError('UNSUPPORTED_SCHEME', `unsupported URL scheme: ${parsed.protocol}`, rawUrl)
}

function credentialHeadersPresent(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
}

function sanitizeForCrossOrigin(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization' || lower === 'cookie') continue
    out[name] = value
  }
  return out
}

async function readBodyCapped(response: Response, maxBytes: number, url: string): Promise<string> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isSafeInteger(declared) && declared > maxBytes) {
    throw new DiscoveryHttpError('RESPONSE_TOO_LARGE', `content-length ${declared} exceeds cap ${maxBytes}`, url)
  }

  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) {
      throw new DiscoveryHttpError('RESPONSE_TOO_LARGE', `body ${buffer.byteLength} exceeds cap ${maxBytes}`, url)
    }
    return new TextDecoder().decode(buffer)
  }

  const decoder = new TextDecoder()
  const reader = body.getReader()
  let received = 0
  let text = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    received += chunk.value.byteLength
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new DiscoveryHttpError('RESPONSE_TOO_LARGE', `streamed body exceeded cap ${maxBytes} mid-read`, url)
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  text += decoder.decode()
  return text
}

/**
 * Executes one inventory HTTP request under the transport security gates.
 * Every outgoing hop is validated again, so a redirect can never smuggle
 * the request onto a scheme or origin the initial gate refused.
 */
export async function executeDiscoveryRequest(
  spec: HttpRequestSpec,
  fetchImpl: FetchLike = directFetch,
): Promise<HttpResponseSpec> {
  const maxRedirects = spec.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES
  const method = spec.method ?? 'GET'

  let currentUrl = assertRequestUrlAllowed(spec.url)
  let headers: Record<string, string> = { ...(spec.headers ?? {}) }
  let hops = 0
  const seen = new Set<string>()
  let redirected = false

  for (;;) {
    assertRequestUrlAllowed(currentUrl.href)
    const visitKey = `${currentUrl.origin}${currentUrl.pathname}${currentUrl.search}`
    if (seen.has(visitKey)) {
      throw new DiscoveryHttpError('REDIRECT_LIMIT_EXCEEDED', `redirect cycle detected at ${visitKey}`, visitKey)
    }
    seen.add(visitKey)

    let response: Response
    try {
      response = await fetchImpl(currentUrl.href, {
        method,
        headers,
        redirect: 'manual',
        signal: spec.signal,
        timeoutMs: spec.timeoutMs,
        maxBytes: spec.maxBytes,
      })
    } catch (error) {
      if (spec.signal?.aborted || (error as Error)?.name === 'AbortError') {
        throw new DiscoveryHttpError('ABORTED', 'request aborted', currentUrl.href)
      }
      throw new DiscoveryHttpError(
        'NETWORK_ERROR',
        `request failed: ${String((error as Error)?.message ?? error)}`,
        currentUrl.href,
      )
    }

    const status = response.status
    const isRedirect = status === 301 || status === 302 || status === 303 || status === 307 || status === 308

    if (!isRedirect) {
      const picked: Record<string, string> = {}
      for (const name of ['content-type', 'content-length', 'etag', 'last-modified', 'retry-after']) {
        const value = response.headers.get(name)
        if (value !== null) picked[name] = value
      }
      const bodyText = method === 'HEAD' ? '' : await readBodyCapped(response, maxBytes, currentUrl.href)
      return { status, headers: picked, bodyText, finalUrl: currentUrl.href, redirected }
    }

    hops += 1
    if (hops > maxRedirects) {
      throw new DiscoveryHttpError(
        'REDIRECT_LIMIT_EXCEEDED',
        `more than ${maxRedirects} redirects`,
        currentUrl.href,
      )
    }

    const location = response.headers.get('location')
    if (!location) {
      throw new DiscoveryHttpError('INVALID_REDIRECT', `redirect ${status} without Location header`, currentUrl.href)
    }
    let next: URL
    try {
      next = new URL(location, currentUrl)
    } catch {
      throw new DiscoveryHttpError('INVALID_REDIRECT', `unparsable redirect target: ${location}`, currentUrl.href)
    }

    if (currentUrl.protocol === 'https:' && next.protocol === 'http:') {
      throw new DiscoveryHttpError('REDIRECT_DOWNGRADE', 'https-to-http redirect downgrade is refused', next.href)
    }

    if (next.origin !== currentUrl.origin) {
      if (credentialHeadersPresent(headers)) {
        throw new DiscoveryHttpError(
          'CREDENTIAL_CROSS_ORIGIN',
          'credentialed requests may not redirect cross-origin',
          next.href,
        )
      }
      headers = sanitizeForCrossOrigin(headers)
    }

    currentUrl = next
    redirected = true
  }
}

/**
 * Convenience wrapper: executes a request and parses the body as JSON.
 * Transport failures throw; malformed JSON throws a typed error so callers
 * can classify it as partial/invalid instead of complete-empty.
 */
export async function executeDiscoveryJsonRequest(
  spec: HttpRequestSpec,
  fetchImpl: FetchLike,
): Promise<HttpResponseSpec & { json: unknown }> {
  const response = await executeDiscoveryRequest(spec, fetchImpl)
  let json: unknown
  try {
    json = JSON.parse(response.bodyText)
  } catch {
    throw new DiscoveryHttpError(
      'NETWORK_ERROR',
      'response body is not valid JSON',
      response.finalUrl,
    )
  }
  return { ...response, json }
}

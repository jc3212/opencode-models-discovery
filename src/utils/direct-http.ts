import net from 'node:net'
import tls from 'node:tls'

export type DirectHttpErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'INSECURE_URL'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE'

export class DirectHttpError extends Error {
  readonly code: DirectHttpErrorCode
  readonly url?: string

  constructor(code: DirectHttpErrorCode, message: string, url?: string) {
    super(message)
    this.name = 'DirectHttpError'
    this.code = code
    this.url = url
  }
}

export interface DirectHttpRequest {
  url: string
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
}

export interface DirectHttpResponse {
  status: number
  headers: Record<string, string>
  bodyText: string
}

const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_HEADER_BYTES = 64 * 1024

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '[::1]') return true
  const ipv4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!ipv4 && ipv4.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255)
}

function parseUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new DirectHttpError('INVALID_URL', 'unparsable URL')
  }

  if (url.username || url.password) {
    throw new DirectHttpError('INVALID_URL', 'URLs with embedded credentials are not allowed', rawUrl)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DirectHttpError('UNSUPPORTED_SCHEME', `unsupported URL scheme: ${url.protocol}`)
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new DirectHttpError('INSECURE_URL', 'plaintext http is only allowed for loopback hosts')
  }
  return url
}

function headerEnd(buffer: Buffer): number {
  return buffer.indexOf('\r\n\r\n')
}

function parseHeaders(headerText: string, url: string): { status: number; headers: Record<string, string> } {
  const lines = headerText.split('\r\n')
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/.exec(lines[0] ?? '')
  if (!statusMatch) {
    throw new DirectHttpError('INVALID_RESPONSE', 'invalid HTTP status line', url)
  }

  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator <= 0) {
      throw new DirectHttpError('INVALID_RESPONSE', 'invalid HTTP response header', url)
    }
    const name = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value
  }

  return { status: Number.parseInt(statusMatch[1]!, 10), headers }
}

function parseChunkedBody(body: Buffer, maxBytes: number, url: string): { complete: boolean; body?: Buffer } {
  let offset = 0
  const chunks: Buffer[] = []
  let total = 0

  for (;;) {
    const lineEnd = body.indexOf('\r\n', offset)
    if (lineEnd < 0) return { complete: false }
    const sizeText = body.slice(offset, lineEnd).toString('ascii').split(';', 1)[0]!.trim()
    const size = Number.parseInt(sizeText, 16)
    if (!sizeText || !Number.isSafeInteger(size) || size < 0) {
      throw new DirectHttpError('INVALID_RESPONSE', 'invalid chunk size', url)
    }
    offset = lineEnd + 2
    if (size === 0) {
      const trailerEnd = body.indexOf('\r\n\r\n', offset)
      if (trailerEnd >= 0) return { complete: true, body: Buffer.concat(chunks, total) }
      if (body.indexOf('\r\n', offset) === offset) {
        return { complete: true, body: Buffer.concat(chunks, total) }
      }
      return { complete: false }
    }

    if (offset + size + 2 > body.length) return { complete: false }
    const chunk = body.subarray(offset, offset + size)
    if (!body.subarray(offset + size, offset + size + 2).equals(Buffer.from('\r\n'))) {
      throw new DirectHttpError('INVALID_RESPONSE', 'chunk is missing its terminator', url)
    }
    total += size
    if (total > maxBytes) {
      throw new DirectHttpError('RESPONSE_TOO_LARGE', `response body exceeds ${maxBytes} bytes`, url)
    }
    chunks.push(chunk)
    offset += size + 2
  }
}

function responseBody(
  buffer: Buffer,
  bodyOffset: number,
  status: number,
  headers: Record<string, string>,
  maxBytes: number,
  url: string,
  ended: boolean,
): { complete: boolean; body?: Buffer } {
  if (status === 204 || status === 304 || (status >= 100 && status < 200)) {
    return { complete: true, body: Buffer.alloc(0) }
  }

  const body = buffer.subarray(bodyOffset)
  const contentLength = headers['content-length']
  if (contentLength !== undefined) {
    const length = Number.parseInt(contentLength, 10)
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new DirectHttpError('INVALID_RESPONSE', 'invalid Content-Length', url)
    }
    if (length > maxBytes) {
      throw new DirectHttpError('RESPONSE_TOO_LARGE', `response body exceeds ${maxBytes} bytes`, url)
    }
    return body.length >= length
      ? { complete: true, body: body.subarray(0, length) }
      : { complete: false }
  }

  if (/\bchunked\b/i.test(headers['transfer-encoding'] ?? '')) {
    return parseChunkedBody(body, maxBytes, url)
  }

  if (body.length > maxBytes) {
    throw new DirectHttpError('RESPONSE_TOO_LARGE', `response body exceeds ${maxBytes} bytes`, url)
  }
  return ended ? { complete: true, body } : { complete: false }
}

function requestHeaders(input: Record<string, string> | undefined, url: URL): string {
  const headers = new Map<string, { name: string; value: string }>()
  const set = (name: string, value: string) => {
    if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
      throw new DirectHttpError('INVALID_URL', 'request headers must not contain newlines')
    }
    headers.set(name.toLowerCase(), { name, value })
  }

  for (const [name, value] of Object.entries(input ?? {})) {
    if (!['host', 'connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase())) {
      set(name, value)
    }
  }

  const defaultPort = url.protocol === 'https:' ? '443' : '80'
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
  set('Host', url.port && url.port !== defaultPort ? `${host}:${url.port}` : host)
  set('Connection', 'close')
  set('Accept-Encoding', 'identity')

  return [...headers.values()].map(({ name, value }) => `${name}: ${value}`).join('\r\n')
}

/**
 * Sends one HTTP/1.1 request through a raw TCP/TLS socket. The socket is
 * opened directly, so proxy environment variables are intentionally ignored.
 */
export function requestDirectHttp(spec: DirectHttpRequest): Promise<DirectHttpResponse> {
  const url = parseUrl(spec.url)
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = spec.maxBytes ?? DEFAULT_MAX_BYTES
  const method = spec.method ?? 'GET'
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const path = `${url.pathname || '/'}${url.search}`
  const request = `${method} ${path} HTTP/1.1\r\n${requestHeaders(spec.headers, url)}\r\n\r\n`

  return new Promise((resolve, reject) => {
    if (spec.signal?.aborted) {
      reject(new DirectHttpError('ABORTED', 'request aborted before connection', url.href))
      return
    }

    let settled = false
    let received = Buffer.alloc(0)
    let parsedHeaderEnd = -1
    let parsedHeaders: { status: number; headers: Record<string, string> } | undefined
    const socket = url.protocol === 'https:'
      ? tls.connect({
        host: url.hostname,
        port,
        servername: net.isIP(url.hostname) ? undefined : url.hostname,
        rejectUnauthorized: true,
      })
      : net.connect({ host: url.hostname, port })

    const cleanup = () => {
      clearTimeout(timer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error?: Error, response?: DirectHttpResponse) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      if (error) reject(error)
      else resolve(response!)
    }
    const fail = (code: DirectHttpErrorCode, message: string) => finish(new DirectHttpError(code, message, url.href))
    const onAbort = () => fail('ABORTED', 'request aborted')
    const timer = setTimeout(() => fail('TIMEOUT', `request exceeded ${timeoutMs} ms`), timeoutMs)
    timer.unref?.()

    const inspect = (ended: boolean) => {
      if (parsedHeaderEnd < 0) {
        parsedHeaderEnd = headerEnd(received)
        if (parsedHeaderEnd < 0) {
          if (received.length > MAX_HEADER_BYTES) fail('INVALID_RESPONSE', 'response headers exceed the limit')
          return
        }
        parsedHeaders = parseHeaders(received.subarray(0, parsedHeaderEnd).toString('latin1'), url.href)
      }
      const body = responseBody(received, parsedHeaderEnd + 4, parsedHeaders!.status, parsedHeaders!.headers, maxBytes, url.href, ended)
      if (body.complete) {
        finish(undefined, {
          status: parsedHeaders!.status,
          headers: parsedHeaders!.headers,
          bodyText: new TextDecoder().decode(body.body ?? Buffer.alloc(0)),
        })
      }
    }

    socket.setTimeout(timeoutMs, () => fail('TIMEOUT', `request exceeded ${timeoutMs} ms`))
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      received = Buffer.concat([received, chunk])
      try {
        inspect(false)
      } catch (error) {
        finish(error instanceof Error ? error : new DirectHttpError('INVALID_RESPONSE', String(error), url.href))
      }
    })
    socket.on('end', () => {
      if (settled) return
      try {
        inspect(true)
        if (!settled) fail('INVALID_RESPONSE', 'response ended before its body was complete')
      } catch (error) {
        finish(error instanceof Error ? error : new DirectHttpError('INVALID_RESPONSE', String(error), url.href))
      }
    })
    socket.on('error', (error) => finish(new DirectHttpError('NETWORK_ERROR', error.message, url.href)))

    const onConnect = () => socket.write(request)
    if (url.protocol === 'https:') socket.once('secureConnect', onConnect)
    else socket.once('connect', onConnect)

    if (spec.signal) {
      spec.signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

export async function directFetch(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number },
): Promise<Response> {
  const method = init?.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    throw new DirectHttpError('INVALID_URL', `unsupported discovery method: ${method}`, url)
  }
  const response = await requestDirectHttp({
    url,
    method,
    headers: init?.headers,
    timeoutMs: init?.timeoutMs,
    maxBytes: init?.maxBytes,
    signal: init?.signal,
  })
  return new Response(response.bodyText, { status: response.status, headers: response.headers })
}

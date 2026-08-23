import { describe, expect, it } from 'vitest'
import {
  DiscoveryHttpError,
  assertRequestUrlAllowed,
  executeDiscoveryJsonRequest,
  executeDiscoveryRequest,
  type FetchLike,
} from '../src/discovery/http-client'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
}

interface FetchRoute {
  match: (url: string) => boolean
  respond: () => Response
}

function makeFetch(routes: FetchRoute[], calls: RecordedCall[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: { ...(init?.headers ?? {}) } })
    const route = routes.find((candidate) => candidate.match(url))
    if (!route) throw new Error(`no fake route for ${url}`)
    return route.respond()
  }
}

function jsonResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers })
}

function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

const HTTPS_OK = 'https://relay.example.com/v1/models'
const HTTPS_NEXT = 'https://relay.example.com/v1/next'

describe('URL security gate', () => {
  it('refuses plaintext http outside loopback before any network call', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch([], calls)
    try {
      await executeDiscoveryRequest({ url: 'http://relay.example.com/v1/models' }, fetchImpl)
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(DiscoveryHttpError)
      expect((error as DiscoveryHttpError).code).toBe('INSECURE_URL')
    }
    expect(calls).toHaveLength(0)
  })

  it('allows explicit loopback http targets', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch(
      [{ match: () => true, respond: () => jsonResponse('{}') }],
      calls,
    )
    for (const url of [
      'http://127.0.0.1:9/v1/models',
      'http://localhost/v1/models',
      'http://[::1]/v1/models',
      'http://inference.localhost/v1/models',
    ]) {
      const response = await executeDiscoveryRequest({ url }, fetchImpl)
      expect(response.status).toBe(200)
    }
  })

  it('rejects unsupported schemes and unparsable URLs', () => {
    expect(() => assertRequestUrlAllowed('ftp://relay.example.com/x')).toThrow(DiscoveryHttpError)
    expect(() => assertRequestUrlAllowed('not-a-url')).toThrow(/unparsable/)
  })
})

describe('plain requests', () => {
  it('returns status, picked headers and body without redirects', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch(
      [{
        match: (url) => url === HTTPS_OK,
        respond: () => jsonResponse('{"ok":true}', { etag: '"v1"', 'x-ignore': 'dropped' }),
      }],
      calls,
    )
    const response = await executeDiscoveryRequest(
      { url: HTTPS_OK, headers: { authorization: 'Bearer k1', 'x-trace': 't' } },
      fetchImpl,
    )
    expect(response.status).toBe(200)
    expect(response.finalUrl).toBe(HTTPS_OK)
    expect(response.redirected).toBe(false)
    expect(response.headers.etag).toBe('"v1"')
    expect(response.headers['x-ignore']).toBeUndefined()
    // Same-origin single hop forwards every header untouched.
    expect(calls[0]?.headers.authorization).toBe('Bearer k1')
    expect(calls[0]?.headers['x-trace']).toBe('t')
  })

  it('wraps network failures as typed NETWORK_ERROR', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('socket hung up')
    }
    try {
      await executeDiscoveryRequest({ url: HTTPS_OK }, fetchImpl)
      expect.unreachable()
    } catch (error) {
      expect((error as DiscoveryHttpError).code).toBe('NETWORK_ERROR')
      expect((error as DiscoveryHttpError).message).toContain('socket hung up')
    }
  })

  it('maps aborted requests to ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.signal?.aborted) {
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
      }
      return jsonResponse('{}')
    }
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK, signal: controller.signal }, fetchImpl),
    ).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('redirect policy', () => {
  it('follows same-origin redirect chains and reports the final URL', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch(
      [
        { match: (url) => url === HTTPS_OK, respond: () => redirectResponse('/v1/next') },
        { match: (url) => url === HTTPS_NEXT, respond: () => redirectResponse('/v1/models2') },
        {
          match: (url) => url === 'https://relay.example.com/v1/models2',
          respond: () => jsonResponse('{"final":true}'),
        },
      ],
      calls,
    )
    const response = await executeDiscoveryRequest({ url: HTTPS_OK }, fetchImpl)
    expect(response.redirected).toBe(true)
    expect(response.finalUrl).toBe('https://relay.example.com/v1/models2')
    expect(response.bodyText).toContain('final')
    expect(calls).toHaveLength(3)
  })

  it('refuses chains longer than maxRedirects', async () => {
    let counter = 0
    const fetchImpl: FetchLike = async () => {
      counter += 1
      return redirectResponse(`/hop-${counter}`)
    }
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK, maxRedirects: 2 }, fetchImpl),
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT_EXCEEDED' })
  })

  it('detects redirect cycles', async () => {
    let toggle = false
    const fetchImpl: FetchLike = async (url) => {
      toggle = !toggle
      return redirectResponse(toggle ? '/b' : new URL(url).pathname === '/a' ? '/a' : '/')
    }
    await expect(
      executeDiscoveryRequest({ url: `${HTTPS_OK.replace('/v1/models', '')}/a` }, fetchImpl),
    ).rejects.toMatchObject({ code: 'REDIRECT_LIMIT_EXCEEDED' })
  })

  it('refuses https-to-http downgrades', async () => {
    const fetchImpl = makeFetch([
      {
        match: (url) => url === HTTPS_OK,
        respond: () => redirectResponse('http://relay.example.com/v1/next'),
      },
    ])
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK }, fetchImpl),
    ).rejects.toMatchObject({ code: 'REDIRECT_DOWNGRADE' })
  })

  it('refuses credentialed cross-origin redirects', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch(
      [{
        match: (url) => url === HTTPS_OK,
        respond: () => redirectResponse('https://other.example.net/v1/models'),
      }],
      calls,
    )
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK, headers: { authorization: 'Bearer k1' } }, fetchImpl),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_CROSS_ORIGIN' })
    expect(calls).toHaveLength(1)
  })

  it('allows credential-less cross-origin redirects but strips auth material', async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = makeFetch(
      [
        { match: (url) => url === HTTPS_OK, respond: () => redirectResponse('https://other.example.net/v1/models') },
        {
          match: (url) => url.startsWith('https://other.example.net'),
          respond: () => jsonResponse('{"crossed":true}'),
        },
      ],
      calls,
    )
    const response = await executeDiscoveryRequest(
      { url: HTTPS_OK, headers: { cookie: 'sid=1', 'x-flag': 'keep' } },
      fetchImpl,
    )
    expect(response.bodyText).toContain('crossed')
    const second = calls[1]
    expect(second?.headers.cookie).toBeUndefined()
    expect(second?.headers['x-flag']).toBe('keep')
  })

  it('rejects redirects without a Location header', async () => {
    const fetchImpl = makeFetch([
      { match: () => true, respond: () => new Response(null, { status: 302 }) },
    ])
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK }, fetchImpl),
    ).rejects.toMatchObject({ code: 'INVALID_REDIRECT' })
  })
})

describe('response size caps', () => {
  it('rejects via Content-Length before reading the body', async () => {
    let bodyRead = false
    // Minimal Response stand-in: undici strips hand-set content-length on
    // streamed bodies, so the pre-check is exercised against a plain object.
    const oversized = {
      status: 200,
      headers: new Headers({ 'content-length': String(1024 * 1024) }),
      body: null,
      arrayBuffer: async () => {
        bodyRead = true
        return new ArrayBuffer(0)
      },
    } as unknown as Response
    const fetchImpl: FetchLike = async () => oversized
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK, maxBytes: 1024 }, fetchImpl),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
    expect(bodyRead).toBe(false)
  })

  it('cuts off streamed bodies that exceed the cap mid-read', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(64)))
        controller.close()
      },
    })
    const fetchImpl: FetchLike = async () => new Response(stream, { status: 200 })
    await expect(
      executeDiscoveryRequest({ url: HTTPS_OK, maxBytes: 8 }, fetchImpl),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })
})

describe('json convenience wrapper', () => {
  it('parses valid JSON bodies', async () => {
    const fetchImpl = makeFetch([{ match: () => true, respond: () => jsonify({ models: [1, 2] }) }])
    const result = await executeDiscoveryJsonRequest({ url: HTTPS_OK }, fetchImpl)
    expect(result.json).toEqual({ models: [1, 2] })
  })

  it('raises a typed error for non-JSON bodies', async () => {
    const fetchImpl = makeFetch([{ match: () => true, respond: () => jsonResponse('<html>boom</html>') }])
    await expect(
      executeDiscoveryJsonRequest({ url: HTTPS_OK }, fetchImpl),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })
})

function jsonify(value: unknown): Response {
  return jsonResponse(JSON.stringify(value), { 'content-type': 'application/json' })
}

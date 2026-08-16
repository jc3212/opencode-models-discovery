import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * Sub2API conformance harness (design §36-38, §64-66).
 *
 * Verifies the behaviors the design requires of a Sub2API-style relay:
 *   - /v1/models may return platform-free bare ids (generic list, §64)
 *   - a model may expose reasoningEfforts (Grok, §65 / §18) as exact
 *     provider-native metadata
 *   - composite groups route a single model id to one of several platforms
 *     dynamically (§38) - never a provider-level fixed transport
 *   - channel mapping may rename a public model to a different upstream (§66)
 */

export interface Sub2APIConformanceOptions {
  /** If true, /v1/models returns bare ids only (no platform metadata). */
  bareList?: boolean
  /** If true, include Grok reasoning metadata on /v1/models. */
  grokMetadata?: boolean
  /** platform for a composite group: 'openai' | 'anthropic' | 'gemini' */
  compositePlatform?: 'openai' | 'anthropic' | 'gemini' | undefined
  /** Channel mapping: publicId -> upstreamId (when set). */
  channelMapping?: Record<string, string>
}

export class Sub2APIConformanceHarness {
  readonly server: http.Server
  readonly baseURL: string
  readonly captured: Array<{ url: string; body: Record<string, unknown> }> = []
  private readonly options: Sub2APIConformanceOptions

  private constructor(options: Sub2APIConformanceOptions, port: number) {
    this.options = options
    this.baseURL = `http://127.0.0.1:${port}/v1`
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  static async create(options: Sub2APIConformanceOptions = {}): Promise<Sub2APIConformanceHarness> {
    const harness = new Sub2APIConformanceHarness(options, 0)
    await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
    const address = harness.server.address() as AddressInfo
    ;(harness as unknown as { baseURL: string }).baseURL = `http://127.0.0.1:${address.port}/v1`
    return harness
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = raw ? JSON.parse(raw) : {} } catch { body = { __invalid: raw } }
      this.captured.push({ url: req.url ?? '', body })

      if (req.url === '/v1/models') {
        this.json(res, 200, this.modelsResponse())
        return
      }
      if (req.url === '/v1/chat/completions' || req.url?.includes('messages') || req.url?.includes('generateContent')) {
        // Channel mapping: rename the public model to the upstream id.
        const outbound = { ...body }
        const map = this.options.channelMapping
        if (map && typeof body.model === 'string' && map[body.model]) {
          outbound.model = map[body.model]
        }
        this.json(res, 200, {
          id: 's2a_test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: String(outbound.model),
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
        return
      }
      this.json(res, 404, { error: { message: 'not found' } })
    })
  }

  private modelsResponse(): Record<string, unknown> {
    const data: Array<Record<string, unknown>> = [
      { id: 'gpt-5.4', object: 'model', created: 1, owned_by: 'openai' },
      { id: 'claude-opus-4-6', object: 'model', created: 1, owned_by: 'anthropic' },
    ]
    if (this.options.bareList) {
      // Generic list: platform info dropped (design §64).
      return { object: 'list', data: data.map(({ id }) => ({ id, object: 'model', created: 1 })) }
    }
    if (this.options.grokMetadata) {
      data.push({
        id: 'grok-4',
        object: 'model',
        created: 1,
        supportsReasoningEffort: true,
        reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      })
    }
    return { object: 'list', data }
  }

  private json(res: http.ServerResponse, status: number, data: Record<string, unknown>): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  lastRequest(): { url: string; body: Record<string, unknown> } | undefined {
    return this.captured[this.captured.length - 1]
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

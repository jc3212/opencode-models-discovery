import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A fake OpenAI-compatible provider for wire-level verification.
 *
 * It serves `/v1/models` and `/v1/chat/completions` (and optionally
 * `/v1/responses`), capturing every request body and header so tests can
 * assert the ACTUAL HTTP payload produced by the AI SDK after OpenCode-style
 * variant application - not just the shape of `model.variants`.
 */

export interface CapturedRequest {
  method: string
  url: string
  body: Record<string, unknown>
  headers: Record<string, string | string[] | undefined>
}

export interface FakeProviderOptions {
  models?: Array<Record<string, unknown> & { id: string }>
  /** Override the chat completion response body. */
  chatResponse?: Record<string, unknown>
  /** If true, also serve `/v1/responses` with the same body. */
  responses?: boolean
}

export class FakeProvider {
  readonly captured: CapturedRequest[] = []
  readonly server: http.Server
  readonly baseURL: string
  private readonly options: FakeProviderOptions

  private constructor(options: FakeProviderOptions, port: number) {
    this.options = options
    this.baseURL = `http://127.0.0.1:${port}/v1`
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  /** Create a provider bound to a real listening port. */
  static async create(options: FakeProviderOptions = {}): Promise<FakeProvider> {
    const provider = new FakeProvider(options, 0)
    await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve))
    const address = provider.server.address() as AddressInfo
    ;(provider as unknown as { baseURL: string }).baseURL = `http://127.0.0.1:${address.port}/v1`
    return provider
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = { __invalid_json: raw }
      }
      this.captured.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        body,
        headers: req.headers,
      })

      const url = req.url ?? ''
      if (url === '/v1/models' && req.method === 'GET') {
        const models = this.options.models ?? [{ id: 'gpt-test' }]
        this.json(res, 200, { object: 'list', data: models })
        return
      }
      if (url === '/v1/chat/completions' || url === '/v1/responses') {
        this.json(res, 200, this.options.chatResponse ?? defaultChatResponse())
        return
      }
      if (url === '/v1/messages') {
        // Anthropic messages API.
        this.json(res, 200, {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
        return
      }
      if (url.endsWith(':generateContent') || url.endsWith(':streamGenerateContent')) {
        // Google Generative Language API (Gemini).
        this.json(res, 200, {
          candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        })
        return
      }
      this.json(res, 404, { error: { message: 'not found' } })
    })
  }

  private json(res: http.ServerResponse, status: number, data: Record<string, unknown>): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  lastBody(urlFilter?: string): Record<string, unknown> | undefined {
    const reqs = urlFilter ? this.captured.filter((c) => c.url.includes(urlFilter)) : this.captured
    return reqs[reqs.length - 1]?.body
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

export function defaultChatResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

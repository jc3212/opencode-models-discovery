import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * New API reasoning conformance harness (design §32-34).
 *
 * Simulates New API's documented reasoning conversion (source research on
 * QuantumNous/new-api relay/channel/openai/adaptor.go):
 *
 *   client reasoning_effort (ingress)
 *     -> New API channel conversion
 *     -> upstream wire format (per channel type)
 *
 * Channel conversions covered (design §33):
 *   openai        : reasoning_effort passes through (OpenAI/OAI-compatible)
 *   openrouter    : reasoning_effort -> reasoning.effort (enabled:true)
 *   anthropic     : thinking.enabled + budget_tokens -> anthropic thinking
 *
 * The harness captures BOTH the inbound request (what OpenCode/AI SDK sent
 * to the relay) and the outbound request (what the relay forwards to the
 * fake upstream), so tests assert the complete pipeline.
 */

export interface ConformanceCapture {
  inbound: Record<string, unknown>
  outbound: Record<string, unknown>
}

export type ChannelType = 'openai' | 'openrouter' | 'anthropic' | 'gemini'

interface UpstreamHandler {
  (body: Record<string, unknown>): Record<string, unknown>
}

/**
 * Simulates New API's channel conversion for a reasoning_effort ingress.
 * Mirrors the source adaptor.go behavior observed in research.
 */
function convertToChannel(channel: ChannelType, ingress: Record<string, unknown>): Record<string, unknown> {
  const effort = ingress.reasoning_effort
  const thinking = ingress.thinking

  if (channel === 'openrouter') {
    // OpenRouter channel: reasoning_effort -> reasoning: { enabled, effort }
    const out: Record<string, unknown> = { ...ingress }
    delete out.reasoning_effort
    if (effort && effort !== 'none') {
      out.reasoning = { enabled: true, effort }
    }
    return out
  }

  if (channel === 'anthropic') {
    // Anthropic channel: thinking budget -> Claude thinking
    const out: Record<string, unknown> = { ...ingress }
    delete out.reasoning_effort
    if (thinking && typeof thinking === 'object') {
      const t = thinking as { type?: string; budgetTokens?: number }
      if (t.type === 'enabled') {
        out.thinking = { type: 'enabled', budget_tokens: t.budgetTokens ?? 1024 }
      } else {
        out.thinking = { type: 'disabled' }
      }
    }
    return out
  }

  // openai / gemini channels: pass reasoning_effort through.
  return { ...ingress }
}

export class NewAPIConformanceHarness {
  readonly server: http.Server
  readonly baseURL: string
  readonly captures: ConformanceCapture[] = []
  private readonly upstream: UpstreamHandler
  private readonly channel: ChannelType

  private constructor(channel: ChannelType, port: number, upstream: UpstreamHandler) {
    this.channel = channel
    this.upstream = upstream
    this.baseURL = `http://127.0.0.1:${port}/v1`
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  static async create(channel: ChannelType, upstream: UpstreamHandler = defaultUpstream): Promise<NewAPIConformanceHarness> {
    const harness = new NewAPIConformanceHarness(channel, 0, upstream)
    await new Promise<void>((resolve) => harness.server.listen(0, '127.0.0.1', resolve))
    const address = harness.server.address() as AddressInfo
    ;(harness as unknown as { baseURL: string }).baseURL = `http://127.0.0.1:${address.port}/v1`
    return harness
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
    req.on('end', () => {
      let inbound: Record<string, unknown> = {}
      try { inbound = raw ? JSON.parse(raw) : {} } catch { inbound = { __invalid: raw } }

      // Simulate New API routing to the configured channel and capture both.
      const outbound = convertToChannel(this.channel, inbound)
      this.captures.push({ inbound, outbound })

      // The outbound goes to a fake upstream; we respond with the fake
      // upstream's response (chat-shaped).
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(this.upstream(outbound)))
    })
  }

  lastOutbound(): Record<string, unknown> | undefined {
    return this.captures[this.captures.length - 1]?.outbound
  }

  lastInbound(): Record<string, unknown> | undefined {
    return this.captures[this.captures.length - 1]?.inbound
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

export function defaultUpstream(): Record<string, unknown> {
  return {
    id: 'chatcmpl-relay',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'upstream',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
}

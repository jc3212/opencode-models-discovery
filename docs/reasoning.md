# Automatic Reasoning Variants

> **Conservative Automatic Reasoning Enrichment for Dynamically Discovered OpenCode Models.**

This plugin can automatically generate OpenCode `model.variants` for discovered
models whose reasoning metadata and API transport semantics are both known with
high confidence. It never guesses.

## Core Principle

```
metadata (what the host can control)
        +
transport (how to express a control on the wire)
        =
model.variants (safe to compile)
```

If either side is not trustworthy, **no automatic variants are generated** and
the model simply remains available for normal chat without a reasoning selector.

## Configuration

```json
{
  "modelsDiscovery": {
    "enabled": true,
    "modelInfoFormat": "models.dev",
    "reasoning": {
      "enabled": true,
      "transport": "auto",
      "aliases": {}
    }
  }
}
```

### `reasoning.enabled`

Defaults to `true`. Set to `false` to keep the pre-reasoning behavior exactly as
before (discovery and metadata enrichment still run; no reasoning variants are
generated).

### `reasoning.transport`

How reasoning controls should be expressed for this provider's API surface.

| Value | Meaning |
|-------|---------|
| `auto` (default) | Only compile variants when transport confidence is high (explicit config or a known provider profile). Otherwise keep the model without variants. |
| `openai-compatible-effort` | OpenAI-style `reasoning_effort` on the wire (via `reasoningEffort`). |
| `openrouter` | OpenRouter `reasoning.effort` / `reasoning.max_tokens`. |
| `dashscope-chat` | DashScope / Qwen `enable_thinking` + `thinking_budget` (snake_case passthrough via an OpenAI-compatible surface). |
| `anthropic` | Anthropic `effort` / `thinking.budgetTokens`. |
| `google` | Gemini `thinkingConfig.thinkingLevel` / `thinkingBudget`. |
| `alibaba-sdk` | `@ai-sdk/alibaba` camelCase `enableThinking` / `thinkingBudget`. |

**Recommended for first version**: be explicit whenever you know your gateway's
semantics. `transport: auto` is the incremental capability.

### `reasoning.aliases`

Map discovered model ids to canonical models for metadata lookup only. The
discovered id is still what is sent to the provider on the wire.

```json
{
  "aliases": {
    "vip-gpt": "openai/gpt-5"
  }
}
```

## What Gets Generated

Reasoning metadata is read from two sources, in priority order:

1. **Provider-native metadata**: if the provider's `/v1/models` response
   includes a `reasoning_options` array on a model, it is authoritative for
   "what this host can do".
2. **models.dev**: when `modelInfoFormat: "models.dev"` is set, the plugin
   reads the `reasoning_options` field of the canonical model. Note: as of
   this writing, models.dev only publishes a boolean `reasoning` flag, so the
   `reasoning_options` array is forward-compatible and currently absent from
   live data. The parser accepts it when present and stays conservative when
   absent.

Supported controls:

| Control | Variants produced | Notes |
|---------|-------------------|-------|
| `effort` | the exact metadata value set (e.g. `low`, `medium`, `high`) | never invents `none`/minimal/`xhigh`/max |
| `toggle` | `none` (disabled), `high` (enabled) | |
| `budget_tokens` | `high`, `max` | capped by metadata max, output limit, and a safety ceiling |

For `toggle` + `budget_tokens` (e.g. Qwen on DashScope), the plugin produces:

```json
{
  "none": { "enable_thinking": false },
  "high": { "enable_thinking": true, "thinking_budget": 16000 },
  "max":  { "enable_thinking": true, "thinking_budget": 32768 }
}
```

## Transport Confidence Rules

- **Explicit `reasoning.transport` always wins** and is treated as exact.
- Known provider profiles (OpenRouter npm, DashScope baseURL/provider id,
  `@ai-sdk/alibaba`, `@ai-sdk/anthropic`, `@ai-sdk/google`) resolve with
  high confidence.
- **`@ai-sdk/openai-compatible` + unknown host ⇒ `unknown` transport.** This
  is deliberate: the same SDK is used by relays, first-party APIs, and
  self-hosted proxies, so the npm package alone proves nothing about reasoning
  semantics.
- A model name (e.g. "qwen") never decides transport on its own.

## Behavior When Transport Is Unknown

- The model is discovered and injected normally.
- Reasoning metadata is recorded and visible in diagnostics.
- **No automatic variants are generated** - nothing unverified is sent.
- You can later add an explicit `transport` to unlock variants.

## Wire-Level Verification

The plugin's compiled variants are verified end-to-end against the real AI SDK
packages: the selected variant flows through the SDK and the actual HTTP request
body is captured and asserted. This is a hard requirement because different SDKs
map options to wire fields differently (e.g. `reasoningEffort` →
`reasoning_effort`; `enable_thinking` passes through verbatim on
OpenAI-compatible surfaces).

## Example: New API / gateway with confirmed OpenAI-style effort

```json
{
  "provider": {
    "newapi": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "New API",
      "options": {
        "baseURL": "https://your-newapi.example.com/v1",
        "modelsDiscovery": {
          "enabled": true,
          "modelInfoFormat": "models.dev",
          "reasoning": {
            "enabled": true,
            "transport": "openai-compatible-effort"
          }
        }
      }
    }
  }
}
```

> Even when a gateway calls itself "New API", its reasoning semantics should be
> confirmed before setting an explicit transport. When unsure, use
> `"transport": "auto"` - the plugin will keep models usable without variants.

## Example: DashScope / Qwen

Only use `dashscope-chat` when the actual API surface is DashScope's
OpenAI-compatible thinking interface:

```json
{
  "modelsDiscovery": {
    "enabled": true,
    "reasoning": {
      "enabled": true,
      "transport": "dashscope-chat"
    }
  }
}
```

## Example: OpenRouter

```json
{
  "modelsDiscovery": {
    "enabled": true,
    "reasoning": {
      "enabled": true,
      "transport": "openrouter"
    }
  }
}
```

## Diagnostics

The plugin logs one line per reasoning decision:

```
[reasoning] model=qwen-x canonical=alibaba/qwen-x match=unique-model-id
            capabilitySource=models.dev control=toggle+budget_tokens
            transport=dashscope-chat transportReason=known-provider-profile
            variants=none,high,max
```

When transport is unresolved the line reports `transport=unknown` and
`variants=none` with the reason.

## What "thinking intensity" means here

This plugin proves that the provider/API accepted and forwarded the requested
reasoning control (e.g. the request body contains `reasoning_effort: high`). It
does NOT measure how much compute the model actually spent. Unless the upstream
response reports reasoning/token usage, the plugin's claim is limited to
"the reasoning control was sent correctly", not "the model thought exactly X%
more".

## Caching

Automatic reasoning resolution is derived from live provider metadata and the
transport config on every startup, so no separate reasoning cache is needed for
correctness. The existing persisted model-discovery cache stores the resulting
`model.variants` exactly as OpenCode will consume them.

## What to Expect (three situations)

### 1. Model + reasoning variants appear automatically

The plugin obtained trustworthy reasoning metadata and a verified transport.
For example a gpt model with effort metadata on a provider whose surface is
confirmed OpenAI-compatible:

```json
{
  "variants": {
    "low": { "reasoningEffort": "low" },
    "medium": { "reasoningEffort": "medium" },
    "high": { "reasoningEffort": "high" }
  }
}
```

### 2. Model appears but has no reasoning variants

This is usually NOT a bug. One of these holds:

- **Capability metadata is missing** - neither the provider nor models.dev
  publishes reasoning controls for this model. Nothing trustworthy to compile.
- **The provider's transport is not confirmed** - we know the model reasons
  but not how this particular host expects reasoning controls, so nothing
  unverified is sent.

Use the reasoning coverage audit to tell them apart:

```text
$ npm run reasoning:audit --verbose

Provider newapi-a
  Models: 38
  Reasoning known: 26
  Variants available: 19
  Capability unknown: 4
  Transport unknown: 3
```

### 3. You configure variants explicitly

Explicit `provider.<id>.models.<model-id>.variants` always win over automatic
variants. User configuration is never overwritten by the plugin.

## Provider Compatibility Matrix

| Transport | Status | Wire verified | How to enable |
|-----------|--------|---------------|---------------|
| OpenAI-compatible effort | **VERIFIED** | yes | `transport: "openai-compatible-effort"` or known profile |
| DashScope / Qwen | **VERIFIED** | yes | `transport: "dashscope-chat"` |
| OpenRouter | **VERIFIED** | yes | `transport: "openrouter"` |
| Anthropic | **VERIFIED** | yes (effort/budget/toggle) | `transport: "anthropic"` |
| Gemini | **VERIFIED** | yes (level/budget, never both) | `transport: "google"` |
| Alibaba SDK | **VERIFIED** | yes (camelCase toggle/budget) | `transport: "alibaba-sdk"` |
| New API / Sub2API relays | **UNKNOWN by default** | n/a | only via explicit `transport` after confirming your instance's channels |

> New API and Sub2API are multi-channel relays: a single instance can route
> different models through OpenAI, Azure, OpenRouter, or Anthropic channels with
> different reasoning semantics. The plugin therefore does not register a blanket
> profile for them. Set an explicit `transport` only after confirming what your
> instance actually forwards.

## Reasoning Coverage Audit

A read-only, sanitized audit tool reports reasoning coverage per provider
without sending any inference:

```bash
npm run reasoning:audit            # summary per provider
npm run reasoning:audit --verbose  # per-model detail
```

- Contacts only `/v1/models`, provider metadata endpoints, and the public
  models.dev catalog.
- Never prints API keys, Authorization headers, cookies, or tokens.
- Base URLs are reduced to hostname only.


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

## Caching

Automatic reasoning resolution is derived from live provider metadata and the
transport config on every startup, so no separate reasoning cache is needed for
correctness. The existing persisted model-discovery cache stores the resulting
`model.variants` exactly as OpenCode will consume them.

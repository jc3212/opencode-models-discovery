# Registry Coverage Gaps

Generated from the real RC audit (design §23, §28-32). Updated 2026-08-17.

Current registry: 37 models (registryVersion rfb947323e7)

## Classification

- **A - Official model, registry missing**: confirmed official entries still to add
- **B - Official model, alias missing**: official model exists under a different stable name
- **C - Relay/user custom alias**: never add to the global registry; user alias required
- **D - Ambiguous model identity**: do not guess
- **E - Explicitly not reasoning**: no registry entry expected
- **F - Unknown/unverifiable**: cannot confirm identity

## A - Official model, registry missing

_none currently confirmed_

## B - Official model, alias missing

_none currently confirmed_

## C - Relay/user custom alias (user alias required)

| Model | Providers | Why | Action |
|-------|-----------|-----|--------|
| claude-sonnet-4 | k3-free | non-standard short form, no official doc | user alias |
| claude-haiku-4.5 | k3-free | dot-form variant, not the official dash form | user alias |
| claude-opus-4.5 | k3-free | dot-form variant | user alias |
| grok-420-fast / grok-420-thinking | openchat | custom relay naming, not official grok IDs | user alias |
| gpt-image-2-vip | openchat | 'vip' suffix is relay branding | user alias |
| auto | k3-free | relay sentinel model | user alias / ignore |

## E - Explicitly not reasoning

| Model | Why |
|-------|-----|
| gpt-image-2 | image generation model, no text reasoning |

## F - Unknown/unverifiable

| Model | Why |
|-------|-----|
| codex-auto-review | official Codex model id not confirmed; registry entry omitted |

## Recently added A-class entries

| Model | Canonical | Values |
|-------|-----------|--------|
| gemini-3.1-pro-high | google/gemini-3.1-pro-high | high |
| gemini-3.1-pro-low | google/gemini-3.1-pro-low | low |
| gpt-5.4-xhigh | openai/gpt-5.4-xhigh | xhigh |
| gpt-5.5-xhigh | openai/gpt-5.5-xhigh | xhigh |
| grok-3 | xai/grok-3 | low, medium, high |
| grok-4 | xai/grok-4 | low, medium, high |


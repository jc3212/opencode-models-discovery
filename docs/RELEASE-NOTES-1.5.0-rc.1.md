# Release Notes — 1.5.0-rc.1

> Prerelease candidate. Install explicitly; not tagged as stable.

## What's in this RC

- **Dynamic model discovery** from provider /v1/models across OpenAI-compatible, Anthropic, Gemini, DashScope relays
- **Official Model Reasoning Registry** (37 models, registryVersion rfb947323e7) — bundled, deterministic, evidence-tracked
- **strict policy default** — preserves legacy behavior; no automatic variants unless provider metadata proves capability
- **official-model policy (opt-in)** — injects official registry variants for matched models
- **Model aliases** — user aliases map custom relay names to official models; no fuzzy matching
- **Reasoning audit CLI** — `npx opencode-models-discovery audit [--verbose]`, node-only, read-only, 0 credential leak
- **Verified transport matrix** — OpenAI Responses, OpenAI-compatible, OpenRouter, Anthropic, Gemini, DashScope, Alibaba SDK wire-verified
- **Relay forwarding limitations documented** — `Model Capability: OFFICIAL` ≠ `Relay Forwarding: VERIFIED`
- **Bun-less CLI** — compiled to dist/cli.js, runs with plain node; no system bun required

## Registry additions since 1.4.0

| Model | Values |
|-------|--------|
| google/gemini-3.1-pro-high | high |
| google/gemini-3.1-pro-low | low |
| openai/gpt-5.4-xhigh | xhigh |
| openai/gpt-5.5-xhigh | xhigh |
| xai/grok-3 | low, medium, high |
| xai/grok-4 | low, medium, high |

## Known limitations (by design)

- Anonymous relays that return no capability metadata stay conservative: models appear, variants are not injected (strict).
- Custom relay names (claude-haiku-4.5, grok-420-*) require user aliases — never guessed.
- Relay forwarding of reasoning parameters is UNVERIFIED unless smoke-tested; smoke-accepted ≠ fully verified.
- Registry missing / alias required / transport unknown are explicit diagnostics, not silent failures.


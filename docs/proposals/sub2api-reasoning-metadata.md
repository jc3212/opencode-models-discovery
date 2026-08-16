# Sub2API Upstream Enhancement Proposal

**Status:** Proposal (plugin does not depend on this being merged)

**Context:** Sub2API's model endpoint currently enumerates models across the
API-key group's platforms (OpenAI, Anthropic, Gemini, Antigravity, Grok,
composite) but the public `/v1/models` response only emits
`{ id, type, display_name, created_at }` - platform information is dropped
during merge. The plugin therefore cannot tell which platform a bare model id
belongs to and correctly refuses to guess.

## Current state (source research)

- For a composite group, Sub2API merges models from all platforms and then
  drops the platform field in the public list.
- At request time it resolves the target platform via
  `ensureCompositeTargetPlatform` + `ResolveChannelMappingAndRestrict`.
- Some Grok models already expose `supportsReasoningEffort` /
  `reasoningEffort` / `reasoningEfforts` on `/v1/models` - so capability
  metadata is already an established pattern.

## Proposed additions (two steps)

### 1. Preserve platform candidates

Before deduping models in a composite group, keep the platform(s) that offer
each model, and emit an optional field:

```json
{
  "id": "gpt-5.4",
  "platforms": ["openai"]
}
```

For a model offered by several platforms:

```json
{
  "id": "gpt-x",
  "platforms": ["openai", "antigravity"]
}
```

This is public information only - no credentials or channel details.

### 2. Emit reasoning_options

Following the Grok precedent, add the models.dev-compatible shape when known:

```json
{
  "id": "gpt-5.4",
  "platforms": ["openai"],
  "reasoning_options": [
    {
      "type": "effort",
      "values": ["low", "medium", "high"]
    }
  ]
}
```

## Why this is safe

- `platforms` / `reasoning_options` are public capability, not secrets.
- The plugin treats reasoning_options as exact provider-native evidence
  (highest priority) and uses `platforms` as route evidence (preferred host
  ranking, dynamic = true).
- Composite models never get a provider-level fixed transport; the plugin
  keeps them dynamic.

## Client-side handling (already implemented)

- `reasoning_options` -> provider-native exact metadata (compiled to
  variants).
- Grok `supportsReasoningEffort` + `reasoningEfforts` -> exact effort
  metadata (implemented).
- `platforms` -> route evidence for consensus ranking.

## Notes

- A model offered by multiple platforms must not collapse to one transport.
- The plugin cannot (and will not) verify the true upstream for an anonymous
  relay purely from `/v1/models`; upstream metadata is the durable fix.

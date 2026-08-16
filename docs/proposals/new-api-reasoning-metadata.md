# New API Upstream Enhancement Proposal

**Status:** Proposal (plugin does not depend on this being merged)

**Context:** The plugin's real-provider audit shows anonymous relays (New API,
Sub2API, etc.) return bare model ids, and models.dev candidates for those ids
have conflicting `reasoning_options` across hosts. The plugin safely refuses
to guess. The fastest durable fix is for relays to publish per-model reasoning
capability on `/v1/models`.

## Current state (source research)

New API already returns on each model object:

```json
{
  "id": "gpt-5.4",
  "owned_by": "openrouter",
  "supported_endpoint_types": ["chat", "responses"]
}
```

- `owned_by` is the preferred channel type from a priority/weight/enabled/
  user-group sort (GetPreferredModelOwnerChannelTypes) - route evidence, not a
  request-level guarantee.
- New API already performs reasoning conversion in its OpenAI adaptor:
  client `reasoning_effort` -> OpenRouter `reasoning.effort`, Claude
  `thinking`, etc.

## Proposed addition

Add an optional per-model `reasoning_options` field to `/v1/models`
responses, computed by New API from its current available channels + model
mapping + supported request semantics:

```json
{
  "id": "gpt-5.4",
  "owned_by": "openrouter",
  "supported_endpoint_types": ["chat", "responses"],
  "reasoning_options": [
    {
      "type": "effort",
      "values": ["low", "medium", "high"]
    }
  ]
}
```

This is exactly the `reasoning_options` shape models.dev publishes per host;
consumers (OpenCode + this plugin) already parse it. The values should be the
**safe intersection** of what every currently-enabled channel for that model
accepts, so it is correct even when channel priority changes.

## Why this is safe

- It exposes only public capability, never channel ids, base URLs, or
  credentials (design §55).
- The plugin treats it as exact provider-native metadata (highest priority),
  so no guessing is needed.
- It is optional: clients that ignore it behave exactly as today.

## Proposed output constraints

- Do NOT expose channel ids, channel base URLs, provider credentials.
- Compute values as the intersection over enabled channels for the model.
- Emit the same `{ type, values }` schema as models.dev.

## Client-side handling (already implemented)

`opencode-models-discovery` reads `reasoning_options` from the raw
`/v1/models` model object (provider-native normalizer) and treats it as
exact provider-native evidence. No client change is required beyond discovery
already preserving the raw field.

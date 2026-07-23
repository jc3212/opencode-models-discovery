# PR 26: models.dev Metadata Enrichment

## Context

PR #26 proposed using [models.dev](https://models.dev) as a fallback metadata source for discovered models.

This project is not affiliated with, endorsed by, or sponsored by [models.dev](https://models.dev/).

The original idea is useful because many OpenAI-compatible providers expose only a minimal `/v1/models` response. That response usually contains model ids, but not enough metadata for OpenCode to know context limits, tool calling support, reasoning support, image input support, or structured output support.

This also overlaps with the capability-mapping requests in issue #21 and PR #25, but it avoids directly interpreting provider-specific `/v1/models` extension fields in the generic discovery path.

## Original PR Risk

The original PR #26 implementation made models.dev a global default fallback. That meant every config enhancement run would fetch `https://models.dev/models.json`, even for local-only providers and users who did not opt into external metadata.

It also injected hardcoded fallback limits for every discovered model when metadata was missing:

- `context: 200000`
- `output: 32000`

Those defaults can overstate model capabilities and may cause runtime failures if OpenCode sends prompts or expects output sizes beyond what the provider actually supports.

The original matching strategy also needed tightening:

- prefix matching had no effective threshold
- prefix matching ignored provider boundaries
- model-only matching could attach metadata from the wrong provider
- metadata fields such as pricing, benchmarks, and weights were copied into model config even though they are not needed by OpenCode model capability selection

## Current Design

models.dev enrichment is now explicit and opt-in through `modelInfoFormat`:

```json
{
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "modelsDiscovery": {
          "enabled": true,
          "modelInfoFormat": "models.dev"
        }
      },
      "models": {}
    }
  }
}
```

When `modelInfoFormat` is not set to `"models.dev"`, the plugin does not contact models.dev.

Unlike `"litellm"`, the `"models.dev"` format does not require `modelInfoEndpoint`, because the metadata source is fixed to:

```text
https://models.dev/models.json
```

## Enriched Fields

The models.dev enricher only maps fields that OpenCode model configuration can use for capability selection:

- `limit.context`
- `limit.input`
- `limit.output`
- `attachment`
- `reasoning`
- `tool_call`
- `structured_output`
- `temperature`
- `modalities`

It intentionally does not copy broader catalog metadata such as:

- `pricing`
- `benchmarks`
- `weights`
- `open_weights`
- `family`
- `knowledge`
- `release_date`
- `last_updated`

Those fields may be useful later, but they should not be added to generated OpenCode model config without a concrete consumer and schema contract.

## Matching Strategy

The matcher is intentionally based on model id segments, not provider ids or display names, so custom provider ids can still use models.dev metadata.

Exact id matches are preferred first.

Provider-qualified model ids may match models.dev entries from a different provider when the model id segment after the provider prefix is the same. For example, `custom/gpt-4o` may match the models.dev `openai/gpt-4o` entry because both ids have the `gpt-4o` model segment.

Prefix matching is limited to strong model id segment variants. It requires:

- at least two shared hyphen-delimited prefix parts
- a score of at least `70`

This allows date-suffixed variants such as `custom/gpt-4o-2024-11-20` to match `openai/gpt-4o`, while avoiding broad matches such as `gpt` to `gpt-4o-2024-11-20`.

## Failure Behavior

If models.dev cannot be fetched, discovery still succeeds.

If a model cannot be matched safely, the plugin leaves metadata fields unset.

The plugin does not inject hardcoded default context or output limits for unknown models.

This preserves the distinction between:

- metadata is known and explicitly enriched
- metadata is unavailable and should not be guessed

## Relationship to LiteLLM Enrichment

LiteLLM enrichment remains independent.

Use LiteLLM model info with:

```json
{
  "modelsDiscovery": {
    "modelInfoFormat": "litellm"
  }
}
```

Use models.dev enrichment with:

```json
{
  "modelsDiscovery": {
    "modelInfoFormat": "models.dev"
  }
}
```

The LiteLLM enricher does not implicitly fetch or merge models.dev metadata. This keeps provider-specific metadata formats isolated and avoids surprising external network requests.

## Tests

The implementation includes tests for:

- models.dev is not fetched by default
- models.dev is fetched only when `modelInfoFormat: "models.dev"` is configured
- discovery continues when models.dev fetch fails
- provider-nested models.dev schema parsing
- flat model-id keyed models.dev schema parsing
- exact matches
- model id segment matches across provider ids
- strong model id segment prefix matches
- rejecting weak prefix matches

Current verification:

```text
npm run test:run
3 test files passed
50 tests passed

npm run typecheck
passed
```

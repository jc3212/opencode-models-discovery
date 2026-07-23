# Configuration Guide

This plugin discovers models for OpenAI-compatible providers and merges them into the active OpenCode config at startup.

Use `provider.<name>.options.modelsDiscovery` for provider-specific behavior. This is the only supported configuration boundary in `1.0.0`.

OpenCode's own provider config still controls provider identity, npm package, `baseURL`, credentials, and provider availability. This plugin controls model discovery for providers that OpenCode has made available.

## Provider-Level Configuration

Each provider can configure discovery behavior through `provider.<name>.options.modelsDiscovery`:

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "modelsDiscovery": {
          "enabled": true,
          "models": {
            "includeBy": [
              { "field": "id", "match": "^llama" }
            ]
          },
          "smartModelName": true
        }
      }
    }
  }
}
```

| Option | Type | Description |
|--------|------|-------------|
| `provider.<name>.options.modelsDiscovery.enabled` | `boolean` | Force enable or disable discovery for a single provider |
| `provider.<name>.options.modelsDiscovery.endpoint` | `string` | Provider-specific models endpoint path. Defaults to `/v1/models` |
| `provider.<name>.options.modelsDiscovery.modelInfoEndpoint` | `string` | Provider-specific model info endpoint path. Metadata enrichment is disabled when omitted |
| `provider.<name>.options.modelsDiscovery.modelInfoFormat` | `string` | Model info response format. Currently supports `"litellm"`, `"models.dev"`, and `"vllm"` |
| `provider.<name>.options.modelsDiscovery.filterNonChat` | `boolean` | When model info is available, skip models whose `model_info.mode` is not `chat`. Defaults to `true` |
| `provider.<name>.options.modelsDiscovery.models.includeRegex` | `string[]` | Shortcut regex allow-list for discovered model ids only |
| `provider.<name>.options.modelsDiscovery.models.excludeRegex` | `string[]` | Shortcut regex deny-list for discovered model ids only |
| `provider.<name>.options.modelsDiscovery.models.includeBy` | `{ field: string, equals: string \| number \| boolean \| null }[]` or `{ field: string, match: string }[]` | Allow-list for top-level raw provider model fields |
| `provider.<name>.options.modelsDiscovery.models.excludeBy` | `{ field: string, equals: string \| number \| boolean \| null }[]` or `{ field: string, match: string }[]` | Deny-list for top-level raw provider model fields |
| `provider.<name>.options.modelsDiscovery.smartModelName` | `boolean` | Use human-friendly display names instead of raw discovered model ids |

Recommended approach:

1. Keep the plugin entry simple: `"plugin": ["opencode-models-discovery"]`.
2. Put endpoint, enablement, and model filtering rules on each provider.
3. Use `modelsDiscovery.endpoint` whenever a provider does not follow the usual `/v1/models` convention.
4. Use OpenCode `/connect` credentials or `provider.<name>.options.apiKey` for secrets; do not duplicate API keys unless needed.

If `provider.<name>.options.modelsDiscovery.endpoint` is omitted, the plugin uses `/v1/models`.

## Default Enablement

1. `provider.<name>.options.modelsDiscovery.enabled = true` forces discovery for that provider.
2. `provider.<name>.options.modelsDiscovery.enabled = false` disables discovery for that provider.
3. If `enabled` is omitted, `OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED` controls the default when set.
4. If the environment variable is omitted or invalid, the built-in default is `true`.
5. OpenCode `enabled_providers` and `disabled_providers` control whether providers are available at all. This plugin does not override those OpenCode provider availability settings.

Accepted false values are `false`, `0`, `no`, and `off`. Accepted true values are `true`, `1`, `yes`, and `on`. Invalid values warn and fall back to `true`.

## Model Filters

Provider-level filters live under `provider.<name>.options.modelsDiscovery.models`.

Prefer `includeBy` and `excludeBy` for model filtering. They work for `id` and for other top-level raw fields returned in the provider's `/v1/models` response.

Use `includeBy` or `excludeBy` with `field: "id"` and `match` when filtering model ids by regex. This is the recommended form for new config.

`includeRegex` and `excludeRegex` are retained as shortcuts for id-only regex filtering. They are regular expressions evaluated against the discovered model id and cannot filter non-id fields.

Use `includeBy` and `excludeBy` when filtering by top-level fields returned in the provider's raw `/v1/models` response. Each rule must include exactly one of:

- `equals`: strict equality against `string`, `number`, `boolean`, or `null` field values
- `match`: regular expression matching against string field values

```json
{
  "modelsDiscovery": {
    "models": {
      "excludeBy": [
        { "field": "available", "equals": false },
        { "field": "id", "match": "embedding" }
      ],
      "includeBy": [
        { "field": "id", "match": "^deepseek" }
      ]
    }
  }
}
```

`includeBy` keeps a model when it matches at least one rule. `excludeBy` removes a model when it matches any rule, and exclusion wins when both include and exclude rules match. Missing fields do not match. Nested paths, type coercion, arrays, and objects are not supported.

`includeBy` and `excludeBy` can replace `includeRegex` and `excludeRegex` for id filtering by using `field: "id"` with `match`.

### Filter Order And Combination

`includeBy` and `excludeBy` are cumulative. A model must pass `includeBy` first, then `excludeBy`, before it can be injected.

Recommended field-filter order is:

1. `includeBy`
2. `excludeBy`

Within that order:

- `includeBy` is an allow-list: when configured, a model must match at least one rule.
- `excludeBy` is a deny-list: when a model matches any rule, it is removed.
- `excludeBy` wins over `includeBy` when both match the same model.

`includeRegex` and `excludeRegex` are retained as legacy id-only shortcuts. They are not fully cumulative with each other: when `includeRegex` is configured, the model id only needs to match `includeRegex`, and `excludeRegex` is not applied. `excludeRegex` is applied only when `includeRegex` is not configured.

Prefer `includeBy` and `excludeBy` with `field: "id"` and `match` when you need both allow-list and deny-list regex behavior for model ids.

Provider-specific raw fields such as `available` are not part of the generic OpenAI-compatible model list contract. The plugin does not hardcode provider-specific behavior; use `includeBy` or `excludeBy` only when your provider returns the field.

## Legacy Global Config

Version `1.0.0` ignores legacy plugin-level discovery configuration at runtime. It still detects legacy config so users can migrate.

Legacy plugin-level options:

- `discovery.enabled`
- `providers.include`
- `providers.exclude`
- `models.includeRegex`
- `models.excludeRegex`
- `smartModelName`

When legacy global config is detected, the plugin logs a warning, shows a toast, and injects `/models-discovery:migrate` to guide migration. The legacy fields do not change discovery behavior.

Use `/models-discovery:config` for assistant-guided provider-level setup. Use `/models-discovery:migrate` when legacy plugin-level config is detected.

Community provider examples live in [`docs/config_example/`](config_example/).

## Model Metadata Enrichment

The generic OpenAI-compatible `/v1/models` endpoint only guarantees a small model list shape. Extra metadata such as context limits, tool calling, reasoning, image input, or structured output is provider-specific, so metadata enrichment is opt-in.

The plugin currently supports three model info formats:

| Format | Source | Requires `modelInfoEndpoint` | Notes |
|--------|--------|------------------------------|-------|
| `"litellm"` | Provider-specific model info endpoint | Yes | Uses LiteLLM `/v1/model/info` responses |
| `"models.dev"` | `https://models.dev/models.json` | No | Uses the public models.dev metadata index |
| `"vllm"` | Fields in the provider's `/v1/models` response | No | Reads vLLM-style `max_model_len` when present |

### LiteLLM Model Info

LiteLLM exposes a richer `/v1/model/info` endpoint in addition to the OpenAI-compatible `/v1/models` endpoint.

Configure both `modelInfoEndpoint` and `modelInfoFormat` to enable it for a provider.

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "litellm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LiteLLM",
      "options": {
        "baseURL": "http://127.0.0.1:4000/v1",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/v1/models",
          "modelInfoEndpoint": "/v1/model/info",
          "modelInfoFormat": "litellm"
        }
      },
      "models": {}
    }
  }
}
```

When model info is available, the plugin uses LiteLLM `model_info` fields to populate OpenCode model configuration:

- `max_input_tokens`, `max_output_tokens`, and `max_tokens` become `limit.context`, `limit.input`, and `limit.output`
- `supports_reasoning` enables `reasoning`
- `supports_*_reasoning_effort` and `supported_openai_params` create reasoning `variants`
- By default, entries whose `model_info.mode` is not `chat` are skipped

### vLLM Model Info

Use `modelInfoFormat: "vllm"` for a vLLM-compatible provider whose `/v1/models` response includes a numeric `max_model_len` field for each model. This does not make another metadata request.

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "local-vllm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local vLLM",
      "options": {
        "baseURL": "http://127.0.0.1:8000/v1",
        "modelsDiscovery": {
          "enabled": true,
          "modelInfoFormat": "vllm"
        }
      },
      "models": {}
    }
  }
}
```

For each discovered model with a positive numeric `max_model_len`, the plugin sets `limit.context` and `limit.output` to that value. `max_model_len` represents the total request sequence length shared by prompt and generated tokens; it is not used as an independent input limit.

`max_model_len` is not part of the standard OpenAI-compatible `/v1/models` response. If a vLLM deployment or proxy does not expose it, discovery still succeeds but no limit is added. This format does not infer reasoning, tool-calling, modalities, or other capabilities.

### models.dev Metadata

Use `modelInfoFormat: "models.dev"` to enrich discovered models from the public [models.dev](https://models.dev) metadata index.

This project is not affiliated with, endorsed by, or sponsored by [models.dev](https://models.dev/).

This does not require `modelInfoEndpoint`, because the source is fixed to `https://models.dev/models.json`:

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKey": "YOUR_OPENROUTER_API_KEY",
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

When a discovered model can be matched to models.dev metadata, the plugin may populate:

- `limit.context`, `limit.input`, and `limit.output`
- `attachment`
- `reasoning`
- `tool_call`
- `structured_output`
- `temperature`
- `modalities`

Matching is intentionally conservative:

- Exact model ids are preferred.
- Provider ids are not used for models.dev matching; only the model id segment after the provider prefix is matched.
- Prefix matching is limited to strong model id segment variants, such as date-suffixed model ids.

If models.dev cannot be fetched, or if no safe match is found, discovery still succeeds and the plugin leaves metadata fields unset. It does not inject hardcoded default context or output limits for unknown models.

Because this option makes a public network request to models.dev during discovery, it is disabled unless explicitly configured.

For providers with custom metadata paths or non-standard behavior:

```json
{
  "provider": {
    "custom": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:9000/v1",
        "modelsDiscovery": {
          "modelInfoEndpoint": "/custom/model-info",
          "modelInfoFormat": "litellm",
          "filterNonChat": false
        }
      }
    }
  }
}
```

## Example Configurations

### Mixed Providers

```json
{
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LM Studio",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/v1/models",
          "models": {
            "includeBy": [
              { "field": "id", "match": "^gpt-" }
            ]
          },
          "smartModelName": true
        }
      },
      "models": {}
    },
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "sk-example-deepseek-key",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/models",
          "smartModelName": true
        }
      },
      "models": {}
    }
  }
}
```

In this example:

1. `lmstudio` explicitly enables discovery and uses the default `/v1/models` endpoint.
2. `lmstudio` limits discovery to model ids matching `^gpt-` with `includeBy`.
3. `deepseek` explicitly enables discovery but uses `"/models"` instead of `/v1/models`.
4. The API key uses an example placeholder and should be replaced in real configs.

### Provider-First Style

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1",
        "modelsDiscovery": {
          "enabled": true,
          "models": {
            "includeBy": [
              { "field": "id", "match": "^qwen/" }
            ]
          }
        }
      }
    },
    "deepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek",
      "options": {
        "baseURL": "https://api.deepseek.com",
        "apiKey": "YOUR_DEEPSEEK_API_KEY",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/models",
          "smartModelName": true
        }
      }
    }
  }
}
```

In this example:

1. The plugin entry is simple and contains no legacy global discovery config.
2. `ollama` uses the default discovery path derived from its `/v1` baseURL.
3. `deepseek` does not rely on `/v1/models` and explicitly uses `"/models"`.
4. Each provider can evolve independently without changing global include or endpoint rules.

## Provider Filtering

For new configs, enable or disable discovery on the provider itself:

```json
{
  "provider": {
    "ollama": {
      "options": {
        "modelsDiscovery": {
          "enabled": true
        }
      }
    },
    "lmstudio": {
      "options": {
        "modelsDiscovery": {
          "enabled": false
        }
      }
    }
  }
}
```

Legacy plugin-level provider filters are ignored in `1.0.0` and are shown here only to help identify config that should be migrated:

| Option | Type | Description |
|--------|------|-------------|
| `providers.include` | `string[]` | If non-empty, only these providers will be discovered |
| `providers.exclude` | `string[]` | These providers will be skipped when `include` is empty |

```json
{
  "plugin": [
    ["opencode-models-discovery", {
      "providers": {
        "include": ["ollama"],
        "exclude": ["lmstudio"]
      }
    }]
  ]
}
```

## Model Filtering Reference

Control which discovered models are auto-injected with provider-level field filters:

| Option | Type | Description |
|--------|------|-------------|
| `provider.<name>.options.modelsDiscovery.models.includeBy` | `{ field: string, equals: string \| number \| boolean \| null }[]` or `{ field: string, match: string }[]` | If non-empty, only discovered models matching at least one rule will be added for this provider |
| `provider.<name>.options.modelsDiscovery.models.excludeBy` | `{ field: string, equals: string \| number \| boolean \| null }[]` or `{ field: string, match: string }[]` | Discovered models matching any rule will be skipped for this provider |
| `provider.<name>.options.modelsDiscovery.models.includeRegex` | `string[]` | Id-only shortcut for `includeBy` with `field: "id"` and `match` |
| `provider.<name>.options.modelsDiscovery.models.excludeRegex` | `string[]` | Id-only shortcut for `excludeBy` with `field: "id"` and `match` |

Filtering only applies to auto-discovered models. Models already explicitly configured by the user are preserved.

```json
{
  "provider": {
    "ollama": {
      "options": {
        "modelsDiscovery": {
          "models": {
            "includeBy": [
              { "field": "id", "match": "^qwen/|gpt-4" }
            ],
            "excludeBy": [
              { "field": "id", "match": "embedding|test" }
            ]
          }
        }
      }
    }
  }
}
```

Legacy plugin-level model filters are ignored in `1.0.0`. Move them to `provider.<name>.options.modelsDiscovery.models` when you still need those filters. Prefer migrating regex id filters to `includeBy`/`excludeBy` rules using `field: "id"` and `match`; provider-level `includeRegex`/`excludeRegex` remain available as id-only shortcuts.

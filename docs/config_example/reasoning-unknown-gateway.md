# Unknown Gateway (conservative default)

For a gateway whose reasoning semantics you have not confirmed, use
`transport: "auto"` (the default). The gateway's models are discovered and
injected normally; reasoning metadata is recorded for diagnostics, but **no
automatic variants are generated** until the transport is certain.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-models-discovery"],
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Gateway",
      "options": {
        "baseURL": "https://gateway.example.com/v1",
        "modelsDiscovery": {
          "enabled": true,
          "modelInfoFormat": "models.dev",
          "reasoning": {
            "enabled": true,
            "transport": "auto"
          }
        }
      }
    }
  }
}
```

Models stay available for normal chat. Once you confirm the gateway's
reasoning controls, set `transport` to unlock automatic variants.

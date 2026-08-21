# New API / OpenAI-compatible Gateway with Reasoning Effort

Use `openai-compatible-effort` only after confirming the gateway accepts
OpenAI-style `reasoning_effort` on the wire.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@jc3212/opencode-models-discovery"],
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

If you cannot confirm the gateway's reasoning semantics, drop `transport` (or
set it to `"auto"`). The gateway's models are still discovered and usable;
reasoning variants are simply not generated until the transport is certain.

## Wire verification

For `high`, the real request body contains `"reasoning_effort": "high"`
(verified against `@ai-sdk/openai-compatible`).

# DashScope / Qwen (thinking interface)

Use `dashscope-chat` only when the API surface is DashScope's
OpenAI-compatible thinking interface.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@jc3212/opencode-models-discovery"],
  "provider": {
    "dashscope": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DashScope",
      "options": {
        "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "modelsDiscovery": {
          "enabled": true,
          "modelInfoFormat": "models.dev",
          "reasoning": {
            "enabled": true,
            "transport": "dashscope-chat"
          }
        }
      }
    }
  }
}
```

For a Qwen model with `toggle` + `budget_tokens` metadata, the plugin
generates:

```json
{
  "none": { "enable_thinking": false },
  "high": { "enable_thinking": true, "thinking_budget": 16000 },
  "max":  { "enable_thinking": true, "thinking_budget": 32768 }
}
```

## Wire verification

Verified end-to-end: selecting `high` produces the actual request body
`{"enable_thinking": true, "thinking_budget": 16000}` through
`@ai-sdk/openai-compatible`.

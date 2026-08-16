# Troubleshooting

## Models do not appear

- Check `modelsDiscovery.enabled` is true (or default-enabled) for the provider.
- Verify the provider `/v1/models` endpoint is reachable and returns a model list.
- Confirm credentials resolve (option `apiKey` or OpenCode `/connect`).

## Models appear but have no reasoning variants

Run the audit to see exactly why:

```bash
npx opencode-models-discovery audit --verbose
```

Possible reasons per model:

- **Registry missing**: official model not yet in the bundled registry - a registry update is required.
- **Alias required**: the relay uses a custom name (e.g. `vip-gpt`) - add a user alias if you know the underlying model.
- **Transport unknown**: official capability found, but this provider's reasoning transport could not be determined - set an explicit `transport` or use `auto` (which may stay unresolved).
- **strict policy**: `capabilityPolicy` defaults to `strict`; enable `official-model` to use the bundled registry.

## Models have variants but the relay may not forward them

The audit reports `Relay Forwarding: UNVERIFIED` separately from `Model Capability: OFFICIAL`. Variants are generated from the model's official capability; a third-party relay may or may not forward them. Verify with the provider directly.

## Something is broken and I want to isolate it

- The plugin is fail-open: discovery, cache, registry, and reasoning failures never block model discovery.
- Check logs with `opencode --print-logs`; categories include `discovery`, `reasoning`, `filtering`.
- Run `npm run test:package` / `npm run test:clean-install` to verify packaging.


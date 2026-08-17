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
- **Transport unknown**: capability was found, but this provider's reasoning transport could not be determined. Under `auto`, `@ai-sdk/openai-compatible` is inferred only for an exact official Registry model with a non-empty effort control; all other cases need provider metadata or an explicit transport.
- **strict policy**: `capabilityPolicy` defaults to `strict`; enable `official-model` to use the bundled registry.

## Models have variants but the relay may not forward them

The audit reports `Relay Forwarding: UNVERIFIED` separately from `Model Capability: OFFICIAL`. For the compatible fallback it also reports `transportConfidence=medium` and `official-model-openai-compatible-effort-inferred`. Variants prove the client can serialize the selected effort, not that a third-party relay forwards or executes it. Verify with Relay/upstream evidence.

## Variants exist but OpenCode reports `capabilities.reasoning: false`

Reinstall or rebuild the current plugin package. Current enrichment writes
`reasoning: true` whenever it successfully compiles a non-empty automatic
variant set. OpenCode 1.18.18 lists and cycles variants from `model.variants`
independently, but the capability flag should still agree with the controls.

## Something is broken and I want to isolate it

- The plugin is fail-open: discovery, cache, registry, and reasoning failures never block model discovery.
- Check logs with `opencode --print-logs`; categories include `discovery`, `reasoning`, `filtering`.
- Run `npm run test:package` / `npm run test:clean-install` to verify packaging.

# Troubleshooting

## Models do not appear

- Check `modelsDiscovery.enabled` is true (or default-enabled) for the provider.
- Verify the provider `/v1/models` endpoint is reachable and returns a model list.
- Confirm credentials resolve (option `apiKey` or OpenCode `/connect`).

## Provider discovery and proxy variables

The plugin's runtime discovery traffic uses its own direct TCP/TLS transport.
It intentionally ignores `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
`NO_PROXY`; this applies to `/v1/models`, custom model endpoints, and model
information requests. OpenCode's inference request remains a separate path
and is not changed by the plugin.

If discovery fails, inspect the structured fields in the startup log:
`transport=direct`, `proxyEnvironment=ignored`, and `errorCode`. A direct
connection can still fail with an HTTP status, timeout, or network error; that
is reported as a discovery failure and does not prove that inference is
available.

Do not work around this by changing `process.env` or setting a process-wide
`NO_PROXY` value inside the plugin. Those changes can affect OpenCode and
other plugins. If a deployment requires a proxy-only network path, configure
the provider's explicit models or use a separately managed network route.

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

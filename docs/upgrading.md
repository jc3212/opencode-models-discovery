# Upgrading

## v1.0 Provider-Level Boundary

Version `1.0.0` completes the provider-level configuration migration started in `0.12.0`.

Plugin-level discovery config is no longer applied at runtime:

- `discovery.enabled`
- `providers.include`
- `providers.exclude`
- `models.includeRegex`
- `models.excludeRegex`
- `smartModelName`

When legacy config is detected, the plugin logs a warning, shows a migration toast, and injects `/models-discovery:migrate` into OpenCode's command list. The legacy fields are ignored for discovery behavior.

Move settings to `provider.<name>.options.modelsDiscovery`.

## Discovery Defaults

Discovery remains enabled by default for compatible providers.

Default precedence is:

1. `provider.<name>.options.modelsDiscovery.enabled` when explicitly set.
2. `OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED` when set to `true`, `1`, `yes`, `on`, `false`, `0`, `no`, or `off`.
3. Built-in default `true`.

Use `/models-discovery:config` to get assistant-guided provider-level configuration help. Use `/models-discovery:migrate` to migrate legacy plugin-level config when it is detected.

Legacy global `models.includeRegex` and `models.excludeRegex` can map to provider-level `modelsDiscovery.models.includeRegex` and `modelsDiscovery.models.excludeRegex`, but the recommended migration is provider-level `models.includeBy` and `models.excludeBy` using `field: "id"` and `match`. Provider-level `models.includeRegex` and `models.excludeRegex` remain available as id-only shortcuts. Provider-level `models.includeBy` and `models.excludeBy` support strict equality with `equals` and regex matching with `match` against top-level raw fields returned by a provider's `/v1/models` response.

## Refresh Plugin Cache After Upgrade

If you upgrade `@jc3212/opencode-models-discovery` and OpenCode still behaves like it is using an older version, refresh the OpenCode plugin cache and restart OpenCode.

This is worth checking when:

- a newly released feature does not appear after upgrading
- behavior still matches an older plugin build
- issue fixes seem not to have taken effect locally

OpenCode may continue using a cached plugin package even after the npm package has been updated.

## Recommended Upgrade Checklist

1. Upgrade the npm package version you use.
2. Restart OpenCode.
3. If behavior still looks stale, refresh the OpenCode plugin cache.
4. Start OpenCode again and verify the plugin version now matches the expected build.

## When This Matters Most

This is especially relevant after upgrades that change startup-time behavior, such as:

- model discovery behavior
- `/connect` credential discovery
- provider-specific discovery endpoints
- model filtering or metadata enrichment

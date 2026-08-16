# Official Model Reasoning Registry

The plugin ships a small, offline, bundled registry of OFFICIAL reasoning
capability for precise models. This decouples **what a model supports** from
**how a particular relay forwards it** - the core change of this phase.

## Why

Real relays (New API, Sub2API, anonymous gateways) return bare model ids and
usually no reasoning metadata. Strict mode therefore resolves 0/82 models on
the real set. The registry supplies the official capability; the transport
resolver supplies how to send it.

## Two separate truths

| | What it means |
|---|---|
| **Model capability** | The vendor's official reasoning modes for this precise model (e.g. gpt-5.4 -> none/low/medium/high/xhigh). |
| **Relay transport** | Whether the specific third-party relay actually forwards those modes. |

`MODEL_OFFICIAL` evidence means the model supports the modes - it does NOT
claim your relay has been verified end-to-end. The audit distinguishes
`Model Capability: OFFICIAL` from `Relay Transport: UNVERIFIED`.

## Capability Policy

```json
{
  "modelsDiscovery": {
    "reasoning": {
      "enabled": true,
      "capabilityPolicy": "official-model"
    }
  }
}
```

- `strict` (default): only inject when the current provider/host has
  evidence (provider-native metadata or models.dev). Keeps prior behavior.
- `official-model`: additionally allow the bundled official registry to
  provide capability when the provider has no metadata - as long as the
  transport is known. Recommended for anonymous relays.

Transport unknown still means no variants (design §25, §73).

## Priority (design §16)

1. user explicit variants (highest)
2. provider-native exact metadata (a relay may restrict capability - it wins
   over the registry, design §71)
3. exact host-specific verified metadata (models.dev)
4. official local registry
5. relay consensus
6. unknown

## Aliases for anonymous relays

A relay that renames models needs a user alias to reach the official entry
(design §39, §75):

```json
{ "reasoning": { "capabilityPolicy": "official-model", "aliases": { "vip-gpt": "openai/gpt-5.4" } } }
```

## Effective vs accepted values (design §7)

The registry stores effective values and records compatibility aliases
separately. Example (DeepSeek V4):

```json
{ "type": "effort", "values": ["low", "high", "max"], "aliases": { "medium": "high", "xhigh": "high" } }
```

The UI shows the effective set, not the accepted-but-equivalent set.

## Registry source & build

- Sources: `registry/<vendor>/*.json` (one entry per model).
- Compile: `bun scripts/registry-tools/compile-registry.ts` -> validates and
  writes `src/generated/reasoning-registry.json` (bundled, offline).
- Cache fingerprint includes `registryVersion`; a registry update
  invalidates old automatic variants (design §37).

## Scope and limits

- Per-model entries only; NO family globs (design §14).
- `revision_alias` must be declared before a date/version suffix maps to an
  entry (design §15).
- A bare id that is NOT in the registry and has no user alias stays unknown;
  the audit reports it as `Possible alias required` (design §58).
- The plugin cannot verify what an anonymous relay actually forwards; enable
  `official-model` knowing the capability is official-model-level, and
  verify the relay separately.

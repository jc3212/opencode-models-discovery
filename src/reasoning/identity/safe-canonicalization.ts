/**
 * G5 - Safe Canonicalization (narrow, evidence-driven, NO fuzzy matching).
 *
 * Runs only after exact/alias/vendor-anchor lookup fails. A match is allowed
 * only when ALL of these hold (design §15):
 *   A. a vendor/family anchor can be identified
 *   B. canonical base is unique
 *   C. the removed part is an explicitly allowed deployment representation
 *   D. no second candidate exists in models.dev/Registry
 *   E. no semantic token is changed
 *
 * First version only allows:
 *   - date revision suffix (-YYYYMMDD)
 * Case/dash/unicode normalization is intentionally NOT implemented yet until
 * per-model evidence exists (e.g. claude-opus-4.7 vs 4-7 are distinct
 * models.dev records and must stay unresolved).
 */

export type SafeCanonicalizationResult =
  | { resolved: true; canonical: string; match: 'safe-canonicalization'; confidence: 'high' | 'medium'; suffix: string }
  | { resolved: false; canonical: null; reason: 'no-anchor' | 'ambiguous' | 'semantic-suffix' | 'no-match' }

const SAFE_SUFFIX_RE = /-(\d{8})$/i

/** Known deployment/revision suffix patterns that never change model semantics. */
const SAFE_SUFFIX_KIND: Array<{ kind: string; test: (model: string) => RegExpMatchArray | null }> = [
  { kind: 'date', test: (m) => SAFE_SUFFIX_RE.exec(m) },
]

export function isSemanticSuffix(suffix: string): boolean {
  const semantic = [
    'thinking', 'reasoner', 'coder', 'code', 'instruct', 'chat', 'vision', 'vl', 'audio',
    'mini', 'max', 'pro', 'flash', 'turbo', 'preview', 'experimental', 'latest', 'free',
  ]
  return semantic.includes(suffix.toLowerCase())
}

/**
 * Resolves a model id to a canonical via safe representation suffix stripping.
 * @param modelId relay/user model id (e.g. claude-haiku-4-5-20251001)
 * @param canonicalIndex all known canonical model ids (vendor/model)
 */
export function resolveSafeCanonicalization(
  modelId: string,
  canonicalIndex: Iterable<string>,
): SafeCanonicalizationResult {
  const canonicals = [...canonicalIndex]
  const byName = new Map<string, string[]>()
  for (const c of canonicals) {
    const name = c.split('/').slice(1).join('/')
    const list = byName.get(name) ?? []
    list.push(c)
    byName.set(name, list)
  }

  for (const rule of SAFE_SUFFIX_KIND) {
    const match = rule.test(modelId)
    if (!match) continue
    const suffix = match[0]
    if (isSemanticSuffix(suffix.replace(/-/g, ''))) {
      return { resolved: false, canonical: null, reason: 'semantic-suffix' }
    }
    const base = modelId.slice(0, -suffix.length)
    const anchors = byName.get(base) ?? []
    if (anchors.length === 0) return { resolved: false, canonical: null, reason: 'no-anchor' }
    // canonical base must be unique across the whole index
    const distinctVendors = [...new Set(anchors.map((a) => a.split('/')[0]))]
    if (distinctVendors.length !== 1 || anchors.length !== 1) {
      return { resolved: false, canonical: null, reason: 'ambiguous' }
    }
    // D: no second candidate (id itself must not be a canonical)
    if (byName.has(modelId)) return { resolved: false, canonical: null, reason: 'ambiguous' }
    return {
      resolved: true,
      canonical: anchors[0],
      match: 'safe-canonicalization',
      confidence: 'high',
      suffix,
    }
  }

  return { resolved: false, canonical: null, reason: 'no-match' }
}

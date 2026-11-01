/**
 * Model chains (idea borrowed from oh-my-openagent): each role or category lists models in preference order; the first
 * model OpenCode can actually serve wins. Unlike OMO there is no hardcoded provider catalogue: the chain is plain config
 * and availability comes from OpenCode's own model registry.
 */

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface AvailableModel {
  providerID: string
  id: string
  variants?: ReadonlyArray<{ id: string }>
}

/** `provider/model#variant` (the model id may itself contain `/`). */
export function parseModelRef(s: string): ModelRef | null {
  const [main, variant] = s.trim().split("#", 2) as [string, string | undefined]
  const slash = main.indexOf("/")
  if (slash <= 0 || slash === main.length - 1) return null
  const ref: ModelRef = { providerID: main.slice(0, slash), id: main.slice(slash + 1) }
  if (variant) ref.variant = variant
  return ref
}

export const formatModelRef = (r: ModelRef) => `${r.providerID}/${r.id}${r.variant ? `#${r.variant}` : ""}`

export interface Resolution {
  model: ModelRef | null
  /** Chain entries that were skipped and why. */
  skipped: Array<{ entry: string; reason: string }>
}

/**
 * First chain entry whose provider/model is available. A variant the model does not offer is dropped (the model is still
 * used) and reported, so a typo does not silently fall through to a weaker model.
 */
export function resolveChain(chain: readonly string[], available: readonly AvailableModel[]): Resolution {
  const skipped: Resolution["skipped"] = []
  for (const entry of chain) {
    const ref = parseModelRef(entry)
    if (!ref) {
      skipped.push({ entry, reason: "not in provider/model[#variant] form" })
      continue
    }
    const m = available.find((a) => a.providerID === ref.providerID && a.id === ref.id)
    if (!m) {
      skipped.push({ entry, reason: available.some((a) => a.providerID === ref.providerID) ? "model not served by provider" : "provider not connected" })
      continue
    }
    if (ref.variant && m.variants && !m.variants.some((v) => v.id === ref.variant)) {
      skipped.push({ entry, reason: `variant "${ref.variant}" not offered (${m.variants.map((v) => v.id).join(", ") || "none"}); using the model without it` })
      return { model: { providerID: ref.providerID, id: ref.id }, skipped }
    }
    return { model: ref, skipped }
  }
  return { model: null, skipped }
}

/** Category for a task from the routing rules (first match), or null. */
export function routeCategory(
  rules: ReadonlyArray<{ when: { size?: string; area?: string }; category: string }>,
  task: { size?: string; area?: string },
): string | null {
  for (const r of rules) {
    if (r.when.size !== undefined && r.when.size !== task.size) continue
    if (r.when.area !== undefined && r.when.area !== task.area) continue
    return r.category
  }
  return null
}

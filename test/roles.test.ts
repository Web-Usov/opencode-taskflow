import { describe, expect, test } from "bun:test"
import { commandSpecs } from "../src/commands.ts"
import { ROLES } from "../src/config.ts"
import { globToRegExp, guard, matchesAny, roleRules, toWildcard } from "../src/core/guard.ts"
import { parseModelRef, resolveChain, routeCategory } from "../src/core/models.ts"
import { contract, rolePrompt } from "../src/roles.ts"
import { dispatchChain, lastAssistantText, resolveRoleModels } from "../src/tools.ts"
import { cfg } from "./helpers.ts"

const layout = { base: "main", mainDir: "/r/app", worktreeParent: "/r/app-wt" }
const gctx = { base: "main", roots: ["/r/app"], worktreeParent: "/r/app-wt" }

const available = [
  { providerID: "anthropic", id: "claude-opus-5-5", variants: [{ id: "high" }, { id: "medium" }] },
  { providerID: "opencode", id: "big-pickle", variants: [] },
]

describe("models", () => {
  test("parseModelRef", () => {
    expect(parseModelRef("anthropic/claude-opus-5-5#high")).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" })
    expect(parseModelRef("openrouter/meta/llama-4")).toEqual({ providerID: "openrouter", id: "meta/llama-4" })
    expect(parseModelRef("nope")).toBeNull()
  })
  test("resolveChain takes the first available entry and explains skips", () => {
    const r = resolveChain(["openai/gpt-6-astra#high", "anthropic/claude-x", "anthropic/claude-opus-5-5#high"], available)
    expect(r.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5", variant: "high" })
    expect(r.skipped.map((s) => s.reason)).toEqual(["provider not connected", "model not served by provider"])
  })
  test("an unknown variant keeps the model and is reported", () => {
    const r = resolveChain(["anthropic/claude-opus-5-5#ultra"], available)
    expect(r.model).toEqual({ providerID: "anthropic", id: "claude-opus-5-5" })
    expect(r.skipped[0]!.reason).toContain('variant "ultra" not offered')
  })
  test("nothing available -> null", () => {
    expect(resolveChain(["x/y"], []).model).toBeNull()
  })
  test("routing: first matching rule", () => {
    const rules = [{ when: { area: "mobile" }, category: "visual" }, { when: { size: "S" }, category: "quick" }]
    expect(routeCategory(rules, { size: "S", area: "mobile" })).toBe("visual")
    expect(routeCategory(rules, { size: "S", area: "api" })).toBe("quick")
    expect(routeCategory(rules, { size: "M", area: "api" })).toBeNull()
  })
  test("dispatchChain prefers the routed category for implementers only", () => {
    const c = cfg({ routing: [{ when: { size: "S" }, category: "quick" }], categories: { quick: { models: ["opencode/big-pickle"] } }, agents: { implementer: { models: ["anthropic/claude-opus-5-5"] } } })
    expect(dispatchChain(c, "implementer", { size: "S" })).toEqual({ chain: ["opencode/big-pickle", "anthropic/claude-opus-5-5"], category: "quick" })
    expect(dispatchChain(c, "implementer", { size: "M" }).category).toBeNull()
    expect(dispatchChain(c, "reviewer", { size: "S" }).category).toBeNull()
  })
  test("resolveRoleModels covers every role", () => {
    const rows = resolveRoleModels(cfg({ agents: { qa: { disable: true } } }), available)
    expect(rows.map((r) => r.role)).toEqual([...ROLES])
    expect(rows.find((r) => r.role === "qa")!.disabled).toBe(true)
    expect(rows.find((r) => r.role === "lead")!.model?.providerID).toBe("anthropic")
  })
})

describe("guard", () => {
  test("glob matching", () => {
    expect(globToRegExp("docs/spec/**").test("docs/spec/a/b.md")).toBe(true)
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false)
    expect(matchesAny("./epics/E-01.md", ["epics/**"])).toBe(true)
    expect(toWildcard("docs/spec/**")).toBe("docs/spec/*")
  })
  test("implementer may not edit protected paths or merge; planner may edit them; reviewer may merge", () => {
    const c = cfg()
    expect(guard(c, { agent: "implementer", action: "edit", resources: ["docs/spec/10-x.md"] }, gctx)).toContain("protected path")
    expect(guard(c, { agent: "implementer", action: "edit", resources: ["src/a.ts"] }, gctx)).toBeNull()
    expect(guard(c, { agent: "planner", action: "edit", resources: ["epics/E-01.md"] }, gctx)).toBeNull()
    expect(guard(c, { agent: "implementer", action: "shell", resources: ["gh pr merge 5 --squash --auto"] }, gctx)).toContain("only the reviewer")
    expect(guard(c, { agent: "reviewer", action: "shell", resources: ["gh pr merge 5 --squash --auto"] }, gctx)).toBeNull()
    expect(guard(c, { agent: "build", action: "edit", resources: ["docs/spec/x.md"] }, gctx)).toBeNull()
  })
  test("custom agent names are honoured", () => {
    const c = cfg({ agents: { implementer: { name: "tf-dev" } } })
    expect(guard(c, { agent: "tf-dev", action: "edit", resources: ["epics/x.md"] }, gctx)).not.toBeNull()
  })
  test("role rules encode the contract", () => {
    const c = cfg({ verify: { full: "pnpm verify" } })
    const has = (role: any, action: string, resource: string, effect: string) =>
      roleRules(c, role, layout).some((r) => r.action === action && r.resource === resource && r.effect === effect)
    expect(has("implementer", "edit", "docs/spec/*", "deny")).toBe(true)
    expect(has("implementer", "shell", "git push *:main*", "deny")).toBe(true)
    expect(has("reviewer", "shell", "*", "deny")).toBe(true)
    expect(has("reviewer", "shell", "pnpm verify*", "allow")).toBe(true)
    expect(has("reviewer", "shell", "gh pr merge * --squash --auto", "allow")).toBe(true)
    expect(has("qa", "edit", "e2e/*", "allow")).toBe(true)
    expect(has("planner", "edit", "epics/*", "allow")).toBe(true)
    // reviewer's last shell rule must re-deny rebase updates after the allows
    const rr = roleRules(c, "reviewer", layout)
    expect(rr).toContainEqual({ action: "shell", resource: "gh api * update_method*", effect: "deny" })
  })
})

describe("prompts and commands", () => {
  test("every role prompt carries the project contract", () => {
    const c = cfg({ verify: { full: "make verify" }, protected: ["spec/**"] })
    for (const role of ROLES) {
      const p = rolePrompt(c, role, layout)
      expect(p).toContain("make verify")
      expect(p).toContain("spec/**")
      expect(p).toContain("Taskflow contract")
    }
    expect(contract(cfg({ language: { human: "ru", agent: "en" } }), layout)).toContain("is Russian")
  })
  test("commands are prefixed and render arguments", () => {
    const specs = commandSpecs(cfg(), layout)
    expect(specs.map((s) => s.name)).toEqual(["tf-next", "tf-ship", "tf-review", "tf-handoff", "tf-status", "tf-plan", "tf-drive", "tf-milestone", "tf-init", "tf-doctor"])
    expect(specs.find((s) => s.name === "tf-next")!.render(" T-007 ")).toContain('id "T-007"')
    expect(specs.find((s) => s.name === "tf-next")!.render("")).toContain("tf_next")
    expect(specs.find((s) => s.name === "tf-drive")!.switchTo).toBe("lead")
    expect(commandSpecs(cfg({ commandPrefix: "" }), layout)[0]!.name).toBe("next")
  })
  test("lastAssistantText picks the last assistant text", () => {
    const msgs = [
      { type: "assistant", content: [{ type: "text", text: "first" }] },
      { type: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "final" }] },
      { type: "assistant", content: [{ type: "tool" }] },
      { type: "idle" },
    ]
    expect(lastAssistantText(msgs)).toBe("final")
    expect(lastAssistantText([])).toBe("")
  })
})

import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { commandSpecs } from "../src/commands.ts"
import { defaultConfig, loadConfig } from "../src/config.ts"
import { guard, roleRules } from "../src/core/guard.ts"
import { init } from "../src/core/init.ts"
import { loadStandards, readStandardsIndex, standardIds, suggestStandards, taskStandards, validateStandardsIndex } from "../src/core/standards.ts"
import { check } from "../src/core/tasks.ts"
import { contract, rolePrompt } from "../src/roles.ts"
import { buildTools, type ToolHost } from "../src/tools.ts"
import { cfg, epicFile, repoWithOrigin, taskFile, tmpdir, write } from "./helpers.ts"

const entry = (id = "api-tests", extra: Record<string, unknown> = {}) => ({ id, title: "API tests", description: "Existing test rules", path: "docs/testing.md", areas: ["api"], tags: ["tests"], status: "approved", ...extra })
const index = (entries: unknown[] = [entry()]) => JSON.stringify({ version: 1, entries })
const layout = { base: "main", mainDir: "/r/app", worktreeParent: "/r/app-wt" }
function project(entries: unknown[] = [entry()]) {
  const root = tmpdir()
  write(root, "docs/standards/index.json", index(entries))
  write(root, "docs/testing.md", "# Existing rules\nUse deterministic tests.\n")
  return root
}

describe("standards schema and compatibility", () => {
  test("missing index and old tasks remain valid; empty binding needs no index", () => {
    const root = tmpdir()
    write(root, "epics/E-01-core.md", epicFile("E-01"))
    write(root, "tasks/T-001-old.md", taskFile({ id: "T-001" }))
    expect(readStandardsIndex(root, cfg())).toBeNull()
    expect(check(root, cfg()).errors).toEqual([])
    expect(taskStandards(root, cfg(), undefined).sources).toEqual([])
    expect(taskStandards(root, cfg(), []).ids).toEqual([])
    expect(() => loadStandards(root, cfg(), ["api-tests"])).toThrow("index missing")
  })
  test.each([null, {}, { version: 2, entries: [] }, { version: 1, entries: {} }, { version: 1, entries: [entry("bad id")] }, { version: 1, entries: [entry(), entry()] }, { version: 1, entries: [entry("x", { status: "confirmed" })] }, { version: 1, entries: [entry("x", { areas: "api" })] }, { version: 1, entries: [entry("x", { title: "" })] }, { version: 1, entries: [entry("x", { description: {} })] }])("rejects malformed index %#", (value) => {
    expect(() => validateStandardsIndex(value)).toThrow()
  })
  test.each(["one", null, [""], ["../x"], ["one", "one"], [1]])("rejects invalid selected ids %#", (value) => {
    expect(() => standardIds(value)).toThrow("standards must be a list")
  })
  test("malformed JSON fails gracefully", () => {
    const root = project()
    write(root, "docs/standards/index.json", "{broken")
    expect(() => readStandardsIndex(root, cfg())).toThrow("cannot read standards index")
  })
  test("invalid config fields fall back individually without changing model chains", () => {
    const root = tmpdir()
    const { config, sources } = loadConfig(root, { standards: { index: "", roots: "docs", maxContextChars: -1 } }, "/nonexistent")
    expect(config.standards).toEqual(defaultConfig().standards)
    expect(config.agents).toEqual(cfg().agents)
    expect(sources[0]?.error).toContain("standards")
  })
})

describe("standards path isolation", () => {
  test.each(["../outside.md", "/etc/passwd", "docs/../AGENTS.md", "docs//a.md", "docs/.git/config.md", "docs/node_modules/a.md", "docs/secrets.md", "docs/credentials/api.md", "docs/.env", "https://host/a.md", "docs\\a.md", "docs/a.key", "docs/a.ts", "other/a.md"])("rejects %s before returning source data", (source) => {
    const root = project([entry("x", { path: source })])
    expect(() => loadStandards(root, cfg(), ["x"])).toThrow()
  })
  test("top-level AGENTS.md is allowed; configurable roots are segment bounded", () => {
    const root = project([entry("agents", { path: "AGENTS.md" }), entry("app", { path: "apps/guide.md" })])
    write(root, "AGENTS.md", "# Authoritative guide")
    write(root, "apps/guide.md", "# App conventions")
    const c = cfg({ standards: { roots: ["docs", "AGENTS.md", "apps"] } })
    expect(loadStandards(root, c, ["agents", "app"]).sources.map((s) => s.path)).toEqual(["AGENTS.md", "apps/guide.md"])
    write(root, "docs/standards/index.json", index([entry("x", { path: "apps-private/a.md" })]))
    expect(() => readStandardsIndex(root, c)).toThrow("outside allowed roots")
  })
  test("nested directory symlink and symlinked index cannot escape the repo", () => {
    const outside = tmpdir()
    write(outside, "source.md", "SECRET OUTSIDE")
    write(outside, "index.json", index())
    const root = project([entry("x", { path: "docs/escape/source.md" })])
    fs.symlinkSync(outside, path.join(root, "docs/escape"))
    expect(() => readStandardsIndex(root, cfg())).toThrow("unsafe standards path")
    fs.unlinkSync(path.join(root, "docs/standards/index.json"))
    fs.symlinkSync(path.join(outside, "index.json"), path.join(root, "docs/standards/index.json"))
    expect(() => readStandardsIndex(root, cfg())).toThrow()
  })
  test("internal symlink cannot alias secrets or leave allowed roots", () => {
    const root = project([entry("x", { path: "docs/alias.md" })])
    write(root, ".env", "SECRET")
    fs.symlinkSync("../.env", path.join(root, "docs/alias.md"))
    expect(() => loadStandards(root, cfg(), ["x"])).toThrow()
    fs.unlinkSync(path.join(root, "docs/alias.md"))
    write(root, "private/file.md", "private")
    fs.symlinkSync("../private/file.md", path.join(root, "docs/alias.md"))
    expect(() => loadStandards(root, cfg(), ["x"])).toThrow("outside allowed roots")
  })
  test.each(["id_rsa", "implementation.ts"])("documentation alias cannot expose non-documentation target %s", (target) => {
    const root = project([entry("alias", { path: "docs/public.md" })])
    write(root, `docs/${target}`, "SYNTHETIC NON-DOCUMENT DATA")
    fs.symlinkSync(target, path.join(root, "docs/public.md"))
    expect(() => readStandardsIndex(root, cfg())).toThrow("source must be a documentation file")
    expect(() => loadStandards(root, cfg(), ["alias"])).toThrow("source must be a documentation file")
  })
  test("safe documentation-to-documentation source alias remains supported", () => {
    const root = project([entry("alias", { path: "docs/public.md" })])
    fs.symlinkSync("testing.md", path.join(root, "docs/public.md"))
    expect(loadStandards(root, cfg(), ["alias"]).sources[0]!.content).toContain("Use deterministic tests")
  })
  test("ignored source and ignored alias targets are denied", () => {
    const { main } = repoWithOrigin({ ".gitignore": "docs/private.md\n", "docs/standards/index.json": index([entry("x", { path: "docs/alias.md" })]) })
    write(main, "docs/private.md", "IGNORED SECRET")
    fs.symlinkSync("private.md", path.join(main, "docs/alias.md"))
    expect(() => loadStandards(main, cfg(), ["x"])).toThrow("ignored standards path")
    write(main, "docs/standards/index.json", index([entry("x", { path: "docs/private.md" })]))
    expect(() => readStandardsIndex(main, cfg())).toThrow("ignored standards path")
  })
  test("repo-contained symlinked index is validated and readable", () => {
    const root = project()
    write(root, "docs/actual.json", index())
    fs.unlinkSync(path.join(root, "docs/standards/index.json"))
    fs.symlinkSync("../actual.json", path.join(root, "docs/standards/index.json"))
    expect(loadStandards(root, cfg(), ["api-tests"]).ids).toEqual(["api-tests"])
  })
  test("dangling symlinked index fails closed rather than pretending the optional index is absent", () => {
    const root = project()
    fs.unlinkSync(path.join(root, "docs/standards/index.json"))
    fs.symlinkSync(path.join(tmpdir(), "absent.json"), path.join(root, "docs/standards/index.json"))
    expect(() => readStandardsIndex(root, cfg())).toThrow()
  })
})

describe("explicit bounded loading and relevance", () => {
  test("drafts excluded from suggestions and loading unless explicitly requested for review", () => {
    const root = project([entry("draft", { status: "draft" }), entry()])
    const i = readStandardsIndex(root, cfg())!
    expect(suggestStandards(i, { area: "api" }).map((e) => e.id)).toEqual(["api-tests"])
    expect(() => loadStandards(root, cfg(), ["draft"])).toThrow("draft")
    expect(loadStandards(root, cfg(), ["draft"], true).ids).toEqual(["draft"])
  })
  test("relevance is deterministic with id tie breaks and never loads sources", () => {
    const root = project([entry("z"), entry("a"), entry("tag", { areas: ["web"], tags: ["tests"] }), entry("absent", { path: "docs/missing.md", areas: ["other"], tags: [] })])
    const i = readStandardsIndex(root, cfg())!
    expect(i.entries.map((e) => e.id)).toEqual(["a", "absent", "tag", "z"])
    const result = suggestStandards(i, { area: "api", tags: ["tests"], query: "rules" })
    expect(result.map((e) => e.id)).toEqual(["a", "z", "tag", "absent"])
    expect(suggestStandards(i, { area: "api", tags: ["tests"], query: "rules" })).toEqual(result)
    expect(suggestStandards(i, { query: "unmatched" })).toEqual([])
  })
  test("multiple ids share one full reference; source content is not copied into index", () => {
    const root = project([entry("b"), entry("a")])
    const result = loadStandards(root, cfg(), ["b", "a"])
    expect(result.ids).toEqual(["b", "a"])
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]!.ids).toEqual(["b", "a"])
    expect(result.sources[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.text.match(/Use deterministic tests/g)).toHaveLength(1)
    expect(result.text).toContain("NOT authenticated human sign-off")
  })
  test("unknown ids and missing files fail instead of returning earlier selected contents", () => {
    const root = project([entry(), entry("missing", { path: "docs/missing.md" })])
    expect(() => loadStandards(root, cfg(), ["api-tests", "stale"])).toThrow("unknown standards id")
    expect(() => loadStandards(root, cfg(), ["api-tests", "missing"])).toThrow()
  })
  test("individual and aggregate budgets fail without truncation, including wrapper overhead", () => {
    const root = project([entry(), entry("other", { path: "docs/other.md" })])
    write(root, "docs/testing.md", "a".repeat(800))
    write(root, "docs/other.md", "b".repeat(800))
    const c = cfg({ standards: { maxContextChars: 1600 } })
    expect(loadStandards(root, c, ["api-tests"]).sources[0]!.content).toHaveLength(800)
    expect(() => loadStandards(root, c, ["api-tests", "other"])).toThrow("nothing loaded")
    write(root, "docs/testing.md", "a".repeat(1601))
    expect(() => loadStandards(root, c, ["api-tests"])).toThrow("exceeds budget")
    write(root, "docs/testing.md", "x")
    expect(() => loadStandards(root, cfg({ standards: { maxContextChars: 10 } }), ["api-tests"])).toThrow("nothing loaded")
  })
  test("aggregate accounting short-circuits source reads and reserves metadata before reading", () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(`s${i}`, { path: `docs/s${i}.md` }))
    const root = project(entries)
    for (const e of entries) write(root, e.path, "x".repeat(800))
    const original = fs.readFileSync
    const reads: string[] = []
    ;(fs as any).readFileSync = (file: any, ...args: any[]) => {
      if (/\/s\d+\.md$/.test(String(file))) reads.push(path.basename(String(file)))
      return (original as any)(file, ...args)
    }
    try {
      // Wrappers alone exceed this budget: do not open ANY source.
      expect(() => loadStandards(root, cfg({ standards: { maxContextChars: 1600 } }), entries.map((e) => e.id))).toThrow("nothing loaded")
      expect(reads).toEqual([])
      // These wrappers fit, but contents do not: later sources remain unopened.
      expect(() => loadStandards(root, cfg({ standards: { maxContextChars: 1600 } }), ["s0", "s1", "s2"])).toThrow("nothing loaded")
      expect(reads).toEqual(["s0.md"])
      reads.length = 0
      expect(() => loadStandards(root, cfg({ standards: { maxContextChars: 10 } }), ["s0"])).toThrow("nothing loaded")
      expect(reads).toEqual([])
    } finally { fs.readFileSync = original }
  })
  test("budget reservation includes every selected id in shared-source wrappers", () => {
    const root = project([entry("a"), entry("b")])
    const complete = loadStandards(root, cfg(), ["b", "a"])
    const exact = cfg({ standards: { maxContextChars: complete.text.length } })
    expect(loadStandards(root, exact, ["b", "a"]).text).toBe(complete.text)
    expect(() => loadStandards(root, cfg({ standards: { maxContextChars: complete.text.length - 1 } }), ["b", "a"])).toThrow("nothing loaded")
  })
  test("binary and non-regular sources rejected", () => {
    const root = project()
    write(root, "docs/testing.md", "abc\0def")
    expect(() => loadStandards(root, cfg(), ["api-tests"])).toThrow("UTF-8")
    write(root, "docs/standards/index.json", index([entry("dir", { path: "docs/dir.md" })]))
    fs.mkdirSync(path.join(root, "docs/dir.md"))
    expect(() => loadStandards(root, cfg(), ["dir"])).toThrow("regular file")
  })
  test("task check validates only explicitly provided standards field", () => {
    const root = project()
    write(root, "epics/E-01-core.md", epicFile("E-01"))
    const task = taskFile({ id: "T-001" })
    write(root, "tasks/T-001-task.md", task.replace("spec: []", "standards: [api-tests]\nspec: []"))
    expect(check(root, cfg()).errors).toEqual([])
    for (const value of ["api-tests", "[unknown]", "[api-tests, api-tests]"]) {
      write(root, "tasks/T-001-task.md", task.replace("spec: []", `standards: ${value}\nspec: []`))
      expect(check(root, cfg()).ok).toBe(false)
    }
  })
})

describe("tool, process and scaffold boundaries", () => {
  function tool(root: string) {
    const host: ToolHost = { root: () => root, sessionRoot: async () => root, config: () => cfg(), layout: () => layout, configSources: () => [], models: () => [], refreshModels: async () => {}, reloadRegistrations: async () => {}, dispatch: async () => { throw new Error("not used") } }
    return buildTools(host).find((t) => t.name === "tf_standards")!
  }
  const context = (agent = "planner") => ({ sessionID: "session", agent, signal: new AbortController().signal })
  test("new read-only tool is injectable; exact ids only and no arbitrary read path", async () => {
    const root = project([entry(), entry("draft", { status: "draft" })])
    const t = tool(root)
    expect(t.permission).toBe("taskflow.read")
    expect((t.input as any).properties.directory).toBeUndefined()
    expect((t.input as any).properties.path).toBeUndefined()
    expect(await t.execute({ operation: "load", ids: ["api-tests"] }, context())).toContain("docs/testing.md")
    const listed = await t.execute({ operation: "list" }, context())
    expect(JSON.parse(listed).entries.map((e: any) => e.id)).toEqual(["api-tests"])
    expect(await t.execute({ operation: "suggest", query: "rules" }, context())).not.toContain("Use deterministic tests")
    expect(await t.execute({ operation: "load", query: "rules" }, context())).toContain("ERROR")
    expect(await t.execute({ operation: "load", ids: ["draft"], includeDrafts: true }, context())).toContain("Reference:")
    for (const role of ["implementer", "reviewer", "qa"]) expect(await t.execute({ operation: "list", includeDrafts: true }, context(role))).toContain("ERROR")
    expect(await t.execute({ operation: "check" }, context())).not.toContain("ERROR")
    expect(await t.execute({ operation: "wrong" }, context())).toContain("ERROR")
  })
  test("missing and malformed index handled as readable tool results", async () => {
    const root = tmpdir()
    expect(await tool(root).execute({ operation: "list" }, context())).toContain("Optional until ids")
    write(root, "docs/standards/index.json", "bad")
    expect(await tool(root).execute({ operation: "list" }, context())).toContain("ERROR")
  })
  test("scaffold starts empty and never overwrites existing index or source", () => {
    const root = tmpdir()
    const local = { ...layout, mainDir: root }
    init(root, cfg(), local)
    expect(readStandardsIndex(root, cfg())!.entries).toEqual([])
    const custom = index([entry()])
    write(root, "docs/standards/index.json", custom)
    write(root, "docs/testing.md", "existing source")
    write(root, "docs/standards/README.md", "existing guide")
    expect(init(root, cfg(), local).created).toEqual([])
    expect(fs.readFileSync(path.join(root, "docs/standards/index.json"), "utf8")).toBe(custom)
    expect(fs.readFileSync(path.join(root, "docs/testing.md"), "utf8")).toBe("existing source")
    expect(fs.readFileSync(path.join(root, "docs/standards/README.md"), "utf8")).toBe("existing guide")
  })
  test.each(["en", "ru"])("init/reload preserves global standards settings and accurate %s guide without plugin options", (human) => {
    const root = tmpdir()
    const globalFile = path.join(tmpdir(), "global-taskflow.jsonc")
    const standards = { index: "policy/index.json", roots: ["policy"], maxContextChars: 12000 }
    fs.writeFileSync(globalFile, JSON.stringify({ backend: "standalone", language: { human }, standards }))
    const before = loadConfig(root, undefined, globalFile).config
    init(root, before, { ...layout, mainDir: root })
    const after = loadConfig(root, undefined, globalFile).config
    expect(after.standards).toEqual(standards)
    expect(fs.existsSync(path.join(root, standards.index))).toBe(true)
    expect(fs.existsSync(path.join(root, "docs/standards/index.json"))).toBe(false)
    expect(readStandardsIndex(root, after)!.entries).toEqual([])
    const guide = fs.readFileSync(path.join(root, after.paths.standardsGuide), "utf8")
    expect(guide).toContain("`policy/index.json`")
    expect(guide).toContain('"path": "policy/existing.md"')
    expect(guide).toContain('`roots` (["policy"])')
    expect(guide).toContain("`maxContextChars` (12000)")
    expect(guide).not.toContain("24000")
    expect(init(root, after, { ...layout, mainDir: root }).created).toEqual([])
  })
  test("prompts preserve the explicit human gate and configurable command prefix", () => {
    const c = cfg({ commandPrefix: "work-" })
    const commands = commandSpecs(c, layout)
    const discover = commands.find((s) => s.name === "work-discover")!.render("api")
    expect(discover).toContain("exceptions")
    expect(discover).toContain("ask why")
    expect(discover).toContain("draft until the human explicitly approves")
    expect(discover).toContain("MUST NOT override AGENTS/spec/ADR")
    const shape = commands.find((s) => s.name === "work-shape")!.render("feature")
    for (const field of ["goal", "non-goals", "examples", "edge cases", "acceptance", "verification", "code/design", "standards", "unresolved decisions", "shape.md", "Draft", "Human confirmation"]) expect(shape).toContain(field)
    expect(shape).toContain("in English")
    const plan = commands.find((s) => s.name === "work-plan")!.render("idea")
    expect(plan).toContain("/work-shape")
    expect(plan).toContain("BEFORE decomposition or coding")
    expect(contract(c, layout)).toContain("NOT authenticated")
    expect(rolePrompt(c, "reviewer", layout)).toContain("docs/standards/**")
    expect(rolePrompt(c, "planner", layout)).toContain("Never invent approval")
    expect(commands.find((s) => s.name === "work-review")!.render("1")).toContain("not just in the prompt")
  })
  test("standards and shape edits require planner even with custom protected list", () => {
    const c = cfg({ protected: [], standards: { index: "policy/index.json", roots: ["policy"] } })
    for (const file of ["policy/index.json", "docs/standards/README.md", "docs/plans/feature/shape.md"]) {
      expect(guard(c, { agent: "implementer", action: "edit", resources: [file] }, { base: "main", roots: ["/r/app"] })).toContain("protected")
      expect(guard(c, { agent: "planner", action: "edit", resources: [file] }, { base: "main", roots: ["/r/app"] })).toBeNull()
    }
    expect(roleRules(c, "reviewer", layout)).toContainEqual({ action: "taskflow.write", resource: "*", effect: "deny" })
    expect(roleRules(c, "reviewer", layout).some((r) => r.action === "taskflow.read" && r.effect === "deny")).toBe(false)
  })
})

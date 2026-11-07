import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { commandSpecs } from "../src/commands.ts"
import { configStamp, defaultConfig, deepMerge, loadConfig, projectConfigPath, ROLES } from "../src/config.ts"
import { claim } from "../src/core/claim.ts"
import { guard, protectedPaths, roleRules } from "../src/core/guard.ts"
import { init } from "../src/core/init.ts"
import { loadStandards, readStandardsIndex } from "../src/core/standards.ts"
import { check, loadEpics, renderBoard, writeBoard } from "../src/core/tasks.ts"
import { rolePrompt } from "../src/roles.ts"
import { epicFile, repoWithOrigin, sh, tmpdir, write } from "./helpers.ts"

const layout = (root: string) => ({ base: "main", mainDir: root, worktreeParent: root + "-wt" })
const load = (root: string, global = "/nonexistent") => loadConfig(root, undefined, global)

test("fresh init creates only .taskflow, no live epic, empty index, valid board; repeats byte-identically", () => {
  const root = tmpdir()
  const c = load(root).config
  const r = init(root, c, layout(root))
  expect(fs.readdirSync(root)).toEqual([".taskflow"])
  expect(r.created.sort()).toEqual([
    ".taskflow/config.jsonc", ".taskflow/workflow.md", ".taskflow/tasks/README.md", ".taskflow/epics/README.md",
    ".taskflow/standards/index.json", ".taskflow/standards/README.md", ".taskflow/templates/task.md",
    ".taskflow/templates/epic.md", ".taskflow/templates/pull-request.md", ".taskflow/templates/human-review.md",
  ].sort())
  expect(loadEpics(root, c)).toEqual([])
  expect(check(root, c)).toMatchObject({ ok: true, epics: 0, tasks: 0 })
  expect(readStandardsIndex(root, c)?.entries).toEqual([])
  expect(writeBoard(root, c, true).stale).toBe(false)
  const contents = r.created.map((f) => fs.readFileSync(path.join(root, f), "utf8"))
  const projectConfig = fs.readFileSync(path.join(root, c.paths.config), "utf8")
  expect(projectConfig).not.toContain('"agents"')
  expect(projectConfig).not.toContain('"categories"')
  expect(init(root, load(root).config, layout(root)).created).toEqual([])
  expect(r.created.map((f) => fs.readFileSync(path.join(root, f), "utf8"))).toEqual(contents)
  const template = fs.readFileSync(path.join(root, c.paths.template), "utf8")
  expect(template).toContain(c.paths.config)
  expect(template).not.toContain("{{")
})

test("discovery precedence does not merge legacy project settings; stamps observe creation, changes and removal", () => {
  const root = tmpdir()
  const global = path.join(root, "global.jsonc")
  write(root, "global.jsonc", JSON.stringify({ parallel: 4, verify: { full: "global-verify" } }))
  const first = configStamp(root, global)
  write(root, ".opencode/taskflow.jsonc", JSON.stringify({ parallel: 8, paths: { tasks: "old-tasks" } }))
  expect(projectConfigPath(root)).toBe(path.join(root, ".opencode/taskflow.jsonc"))
  expect(configStamp(root, global)).not.toBe(first)
  expect(load(root, global).config.paths.tasks).toBe("old-tasks")
  expect(load(root, global).config.paths.epics).toBe("epics")
  const oldStamp = configStamp(root, global)
  write(root, ".taskflow/config.jsonc", JSON.stringify({ parallel: 2 }))
  expect(configStamp(root, global)).not.toBe(oldStamp)
  expect(projectConfigPath(root)).toBe(path.join(root, ".taskflow/config.jsonc"))
  expect(load(root, global).config).toMatchObject({ parallel: 2, paths: { tasks: ".taskflow/tasks", epics: ".taskflow/epics" }, verify: { full: "global-verify" } })
  expect(load(root, global).sources.find((s) => s.path.endsWith("/.opencode/taskflow.jsonc"))?.error).toContain("ignored")
  const stamp = configStamp(root, global)
  fs.utimesSync(path.join(root, ".taskflow/config.jsonc"), new Date(), new Date(Date.now() + 1000))
  expect(configStamp(root, global)).not.toBe(stamp)
  fs.unlinkSync(path.join(root, ".taskflow/config.jsonc"))
  expect(load(root, global).config.parallel).toBe(8)
})

test("legacy ship selects both existing custom GitHub checklists without init; explicit overrides win", () => {
  const root = tmpdir()
  write(root, ".opencode/taskflow.jsonc", "{}")
  const agent = ".github/pull_request_template.md"
  const human = ".github/PULL_REQUEST_TEMPLATE/human-review.md"
  write(root, agent, "CUSTOM AGENT CHECKLIST")
  write(root, human, "CUSTOM HUMAN CHECKLIST")
  const c = load(root).config
  expect(c.paths.prTemplate).toBe(agent)
  expect(c.paths.humanReviewTemplate).toBe(human)
  const ship = commandSpecs(c, layout(root)).find((s) => s.name === "tf-ship")!.render("")
  expect(ship).toContain(agent)
  expect(ship).toContain(human)
  expect(fs.readFileSync(path.join(root, agent), "utf8")).toBe("CUSTOM AGENT CHECKLIST")
  expect(fs.readFileSync(path.join(root, human), "utf8")).toBe("CUSTOM HUMAN CHECKLIST")
  expect(fs.existsSync(path.join(root, "docs"))).toBe(false)
  write(root, ".opencode/taskflow.jsonc", JSON.stringify({ paths: { prTemplate: "custom/agent.md", humanReviewTemplate: "custom/human.md" } }))
  const explicit = load(root).config
  expect(explicit.paths.prTemplate).toBe("custom/agent.md")
  expect(explicit.paths.humanReviewTemplate).toBe("custom/human.md")
  write(root, ".opencode/taskflow.jsonc", "{}")
  write(root, "global.jsonc", JSON.stringify({ paths: { prTemplate: "global/agent.md", humanReviewTemplate: "global/human.md" } }))
  expect(load(root, path.join(root, "global.jsonc")).config.paths.prTemplate).toBe("global/agent.md")
  expect(loadConfig(root, { paths: { humanReviewTemplate: "options/human.md" } }, path.join(root, "global.jsonc")).config.paths.humanReviewTemplate).toBe("options/human.md")
  // Central layout never adopts GitHub templates just because they exist.
  write(root, ".taskflow/config.jsonc", "{}")
  expect(load(root).config.paths.prTemplate).toBe(".taskflow/templates/pull-request.md")
})

test("arbitrary tasks/epics are not ownership; strong legacy signature and explicit global legacy paths retain old layout", () => {
  const root = tmpdir()
  write(root, "tasks/README.md", "Unrelated product tasks")
  write(root, "epics/README.md", "Unrelated")
  expect(load(root).config.paths.tasks).toBe(".taskflow/tasks")
  write(root, "tasks/README.md", "Generated by node scripts/tasks.mjs board")
  write(root, "tasks/_template.md", "template")
  write(root, "scripts/tasks.mjs", "// legacy")
  const legacy = load(root)
  expect(legacy.config.paths.tasks).toBe("tasks")
  expect(projectConfigPath(root)).toBe(path.join(root, ".opencode/taskflow.jsonc"))
  expect(legacy.sources.find((s) => s.path === "(layout)")?.error).toContain("Migration requires")
  init(root, legacy.config, layout(root))
  expect(fs.existsSync(path.join(root, ".taskflow"))).toBe(false)
  expect(load(root).config.paths.tasks).toBe("tasks")
  const fresh = tmpdir()
  const global = path.join(fresh, "global.jsonc")
  write(fresh, "global.jsonc", JSON.stringify({ paths: { tasks: "tasks", epics: "epics" } }))
  expect(load(fresh, global).config.paths.template).toBe("tasks/_template.md")
})

test("legacy custom paths persist across init, and existing AGENTS/GitHub files are untouched unless opted in", () => {
  const root = tmpdir()
  write(root, ".opencode/taskflow.jsonc", JSON.stringify({ paths: { tasks: "work/items", epics: "work/goals", template: "work/task.md", board: "work/board.md", plans: "work/plans", workflow: "work/workflow.md" } }))
  write(root, "AGENTS.md", "Existing instructions\n")
  write(root, ".github/PULL_REQUEST_TEMPLATE/human-review.md", "existing GitHub template")
  const c = load(root).config
  init(root, c, layout(root))
  expect(init(root, load(root).config, layout(root)).created).toEqual([])
  expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("Existing instructions\n")
  expect(fs.existsSync(path.join(root, ".taskflow"))).toBe(false)
  init(root, c, layout(root), { agentsLink: true, githubTemplate: true })
  expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("`work/workflow.md`")
  expect(fs.readFileSync(path.join(root, ".github/PULL_REQUEST_TEMPLATE/human-review.md"), "utf8")).toBe("existing GitHub template")
  const fresh = tmpdir()
  init(fresh, defaultConfig(), layout(fresh), { agentsLink: true, githubTemplate: true })
  expect(fs.existsSync(path.join(fresh, "AGENTS.md"))).toBe(true)
  expect(fs.existsSync(path.join(fresh, ".github/PULL_REQUEST_TEMPLATE/human-review.md"))).toBe(true)
})

test("all configured process paths survive init/reload and drive templates, shape, ship and protection", () => {
  const root = tmpdir()
  const c = loadConfig(root, {
    paths: { tasks: ".taskflow/items", epics: ".taskflow/goals", board: ".taskflow/board.md", template: ".taskflow/forms/task.md", epicTemplate: ".taskflow/forms/epic.md", workflow: ".taskflow/process.md", plans: ".taskflow/shapes", standardsGuide: ".taskflow/policy/guide.md", prTemplate: ".taskflow/forms/pr.md", humanReviewTemplate: ".taskflow/forms/human.md", milestones: ".taskflow/reports" },
    standards: { index: ".taskflow/policy/index.json" },
  }, "/nonexistent").config
  const r = init(root, c, layout(root))
  const after = load(root).config
  expect(after.paths).toEqual(c.paths)
  expect(after.standards).toEqual(c.standards)
  for (const file of [c.paths.template, c.paths.epicTemplate, c.paths.workflow, c.paths.standardsGuide, c.paths.prTemplate, c.paths.humanReviewTemplate, c.paths.board]) expect(r.created).toContain(file)
  const ship = commandSpecs(after, layout(root)).find((s) => s.name === "tf-ship")!.render("")
  expect(ship).toContain(c.paths.prTemplate)
  expect(ship).toContain(c.paths.humanReviewTemplate)
  const shape = commandSpecs(after, layout(root)).find((s) => s.name === "tf-shape")!.render("feature")
  expect(shape).toContain(`${c.paths.plans}/<slug>/shape.md`)
  expect(fs.readFileSync(path.join(root, c.paths.prTemplate), "utf8")).toContain(c.paths.humanReviewTemplate)
  expect(fs.readFileSync(path.join(root, c.paths.standardsGuide), "utf8")).toContain(c.paths.plans)
  expect(init(root, after, layout(root)).created).toEqual([])
  expect(guard(after, { agent: "implementer", action: "edit", resources: [c.paths.workflow] }, { base: "main", roots: [root] })).toContain("protected")
  expect(roleRules(after, "planner", layout(root))).toContainEqual({ action: "edit", resource: c.paths.board, effect: "allow" })
})

test("configured .taskflow documentation is readable, but hidden/secret/internal/symlink escapes fail", () => {
  const { main } = repoWithOrigin({ "README.md": "app" })
  const c = defaultConfig("en")
  init(main, c, layout(main))
  const entry = (source: string) => JSON.stringify({ version: 1, entries: [{ id: "chosen", title: "Chosen", path: source, status: "approved" }] })
  write(main, ".taskflow/standards/rules.md", "Human-approved rules")
  write(main, c.standards.index, entry(".taskflow/standards/rules.md"))
  expect(loadStandards(main, c, ["chosen"]).sources[0]?.content).toBe("Human-approved rules")
  const outside = tmpdir()
  write(outside, "rules.md", "outside")
  fs.symlinkSync(outside, path.join(main, ".taskflow/escape"))
  for (const source of [".git/config.md", ".env", ".other/rules.md", ".taskflow/.env.md", ".taskflow/.git/config.md", ".taskflow/node_modules/rules.md", ".taskflow/secrets/rules.md", ".taskflow/escape/rules.md"]) {
    write(main, c.standards.index, entry(source))
    expect(() => loadStandards(main, c, ["chosen"])).toThrow()
  }
  // Even explicitly configured arbitrary hidden roots do not lift the namespace exception.
  const unsafe = deepMerge(c, { standards: { roots: [".other", ".taskflow"] } })
  expect(() => readStandardsIndex(main, unsafe)).toThrow()
})

test("central protections leave task updates available; planner permits metadata, all prompts use effective paths", () => {
  const c = defaultConfig("en")
  const root = "/r/app"
  const ctx = { base: "main", roots: [root], worktreeParent: "/r/app-wt" }
  const protectedFiles = [c.paths.config, c.standards.index, c.paths.standardsGuide, c.paths.workflow, c.paths.template, c.paths.epicTemplate, c.paths.prTemplate, c.paths.humanReviewTemplate, `${c.paths.plans}/x/shape.md`, `${c.paths.epics}/E-01-core.md`]
  for (const file of protectedFiles) {
    expect(guard(c, { agent: "implementer", action: "edit", resources: [file] }, ctx)).toContain("protected")
    expect(guard(c, { agent: "implementer", action: "edit", resources: [`/r/app-wt/t-001-x/${file}`] }, ctx)).toContain("protected")
    expect(guard(c, { agent: "planner", action: "edit", resources: [file] }, ctx)).toBeNull()
  }
  expect(guard(c, { agent: "implementer", action: "edit", resources: [".taskflow/tasks/T-001-x.md", c.paths.board] }, ctx)).toBeNull()
  const rules = roleRules(c, "planner", layout(root))
  for (const file of [c.paths.config, c.paths.workflow, c.paths.template]) expect(rules).toContainEqual({ action: "edit", resource: file, effect: "allow" })
  expect(protectedPaths(c)).not.toContain(".taskflow/**")
  const rootIndex = deepMerge(c, { standards: { index: ".taskflow/index.json" }, paths: { standardsGuide: ".taskflow/standards-guide.md" } })
  expect(protectedPaths(rootIndex)).not.toContain(".taskflow/**")
  expect(guard(rootIndex, { agent: "implementer", action: "edit", resources: [".taskflow/tasks/T-001-x.md"] }, ctx)).toBeNull()
  const prompts = [...ROLES.map((r) => rolePrompt(c, r, layout(root))), ...commandSpecs(c, layout(root)).map((s) => s.render("example"))].join("\n")
  for (const old of ["`tasks/", "`epics/", "docs/plans/", ".opencode/taskflow.jsonc", ".github/pull_request_template.md"]) expect(prompts).not.toContain(old)
  for (const effective of [c.paths.config, c.paths.plans, c.paths.prTemplate, c.paths.humanReviewTemplate]) expect(prompts).toContain(effective)
})

test("real git new-task claim uses central template, tracks board/config and increments nested-path ids", async () => {
  const { main } = repoWithOrigin({ "README.md": "app" })
  init(main, defaultConfig("en"), layout(main))
  const c = load(main).config
  write(main, `${c.paths.epics}/E-01-real.md`, epicFile("E-01", "Actual user milestone"))
  sh("git", ["add", "-A"], main)
  sh("git", ["commit", "-qm", "chore: initialize centralized process"], main)
  sh("git", ["push", "-q", "origin", "main"], main)
  const r = await claim({ cwd: main, cfg: c, create: { title: "Central task", epic: "E-01", area: "api", size: "S" }, skipSetup: true })
  expect(r.error).toBeUndefined()
  expect(r.id).toBe("T-001")
  expect(load(r.worktree!).config.paths).toEqual(c.paths)
  expect(check(r.worktree!, c).errors).toEqual([])
  expect(fs.readFileSync(path.join(r.worktree!, c.paths.board), "utf8")).toBe(renderBoard(r.worktree!, c))
  expect(sh("git", ["ls-files", c.paths.config, c.paths.board, `${c.paths.tasks}/T-001-central-task.md`], r.worktree!).split("\n")).toHaveLength(3)
  const next = await claim({ cwd: main, cfg: c, create: { title: "Next task", epic: "E-01", area: "docs", size: "S" }, skipSetup: true })
  expect(next.error).toBeUndefined()
  expect(next.id).toBe("T-002")
}, 60_000)

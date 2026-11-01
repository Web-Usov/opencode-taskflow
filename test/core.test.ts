import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { deepMerge, defaultConfig, loadConfig, parseJsonc } from "../src/config.ts"
import { parseFrontmatter, sectionBody, setField } from "../src/core/frontmatter.ts"
import { check, notReadyReason, readyTasks, loadTasks, renderBoard, setStatus, summary, writeBoard } from "../src/core/tasks.ts"
import { cfg, epicFile, taskFile, tmpdir, write } from "./helpers.ts"

describe("frontmatter", () => {
  test("parses scalars, lists, null and strips comments", () => {
    const { data } = parseFrontmatter(`---\nid: T-001\ntitle: "Quoted title"\nstatus: todo   # comment\ndepends: [T-002, T-003]\nempty: []\npr: null\n---\nbody`)
    expect(data).toEqual({ id: "T-001", title: "Quoted title", status: "todo", depends: ["T-002", "T-003"], empty: [], pr: null })
  })
  test("no frontmatter -> data null", () => {
    expect(parseFrontmatter("# just text").data).toBeNull()
  })
  test("setField replaces a value and keeps the trailing comment", () => {
    const text = `---\nid: T-001\nstatus: todo          # todo | done\nbranch: null\n---\n`
    const out = setField(setField(text, "status", "in_progress"), "branch", "task/T-001-x")
    expect(out).toContain("status: in_progress          # todo | done")
    expect(out).toContain("branch: task/T-001-x")
  })
  test("setField appends a missing key", () => {
    expect(setField(`---\nid: T-1\n---\n`, "pr", "u")).toContain("id: T-1\npr: u")
  })
  test("sectionBody strips HTML comments and stops at the next section", () => {
    const t = `## Result\n\n<!-- hidden -->\n\n## Next\nx`
    expect(sectionBody(t, "Result")!.trim()).toBe("")
    expect(sectionBody(`## Result\nDone it\n`, "Result")!.trim()).toBe("Done it")
    expect(sectionBody("nothing", "Result")).toBeNull()
  })
})

describe("config", () => {
  test("parseJsonc handles comments, trailing commas and // inside strings", () => {
    expect(parseJsonc(`{\n // c\n "a": "http://x", /* b */ "b": [1, 2,],\n}`)).toEqual({ a: "http://x", b: [1, 2] })
  })
  test("deepMerge merges objects, replaces arrays, drops __proto__", () => {
    const merged = deepMerge({ a: { b: 1, c: [1] }, d: 1 }, JSON.parse(`{"a":{"c":[2]},"__proto__":{"x":1}}`))
    expect(merged).toEqual({ a: { b: 1, c: [2] }, d: 1 })
    expect(({} as any).x).toBeUndefined()
  })
  test("loadConfig layers global, project and options; language picks board texts", () => {
    const root = tmpdir()
    const globalFile = path.join(root, "global.jsonc")
    fs.writeFileSync(globalFile, `{ "language": { "human": "en" }, "parallel": 5 }`)
    write(root, ".opencode/taskflow.jsonc", `{ "parallel": 3, // project wins\n "verify": { "full": "make check" } }`)
    const { config, sources } = loadConfig(root, { review: { maxRounds: 7 } }, globalFile)
    expect(config.parallel).toBe(3)
    expect(config.verify.full).toBe("make check")
    expect(config.review.maxRounds).toBe(7)
    expect(config.board.header[0]).toBe("# Task board (generated, do not edit)")
    expect(sources.map((s) => s.ok)).toEqual([true, true])
  })
  test("a broken project config is reported, defaults stay", () => {
    const root = tmpdir()
    write(root, ".opencode/taskflow.jsonc", `{ nope`)
    const { config, sources } = loadConfig(root, undefined, "/nonexistent")
    expect(sources[0]!.ok).toBe(false)
    expect(config.parallel).toBe(defaultConfig().parallel)
  })
})

function project(files: Record<string, string>) {
  const root = tmpdir()
  for (const [k, v] of Object.entries(files)) write(root, k, v)
  return root
}

describe("check", () => {
  const base = { "epics/E-01-core.md": epicFile("E-01") }

  test("a valid project passes", () => {
    const root = project({ ...base, "tasks/T-001-a.md": taskFile({ id: "T-001" }), "tasks/T-002-b.md": taskFile({ id: "T-002", depends: ["T-001"] }) })
    const r = check(root, cfg())
    expect(r.errors).toEqual([])
    expect(r).toMatchObject({ ok: true, epics: 1, tasks: 2 })
  })

  test("reports enum, epic, depends and file-name errors", () => {
    const root = project({
      ...base,
      "tasks/T-001-a.md": taskFile({ id: "T-001", status: "doing", area: "space", epic: "E-09", depends: ["T-404"] }),
      "tasks/T-2-bad.md": taskFile({ id: "T-002" }),
    })
    const e = check(root, cfg()).errors.join("\n")
    expect(e).toContain('invalid status "doing"')
    expect(e).toContain('invalid area "space"')
    expect(e).toContain('unknown epic "E-09"')
    expect(e).toContain("depends on unknown task T-404")
    expect(e).toContain("file name must match T-NNN-slug.md")
  })

  test("done requires pr, ticked DoD and a Result", () => {
    const root = project({ ...base, "tasks/T-001-a.md": taskFile({ id: "T-001", status: "done", branch: "task/T-001-a" }) })
    const e = check(root, cfg()).errors.join("\n")
    expect(e).toContain("status done requires pr")
    expect(e).toContain("1 unchecked Definition of Done item(s)")
    expect(e).toContain('non-empty "## Result"')
  })

  test("done with everything set passes", () => {
    const root = project({ ...base, "tasks/T-001-a.md": taskFile({ id: "T-001", status: "done", branch: "task/T-001-a", pr: "https://x/pull/1", dod: "- [x] ok", result: "Shipped." }) })
    expect(check(root, cfg()).ok).toBe(true)
  })

  test("in_progress requires branch; cycles are detected", () => {
    const root = project({
      ...base,
      "tasks/T-001-a.md": taskFile({ id: "T-001", status: "in_progress", depends: ["T-002"] }),
      "tasks/T-002-b.md": taskFile({ id: "T-002", depends: ["T-001"] }),
    })
    const e = check(root, cfg()).errors.join("\n")
    expect(e).toContain("status in_progress requires branch")
    expect(e).toContain("dependency cycle: T-001 -> T-002 -> T-001")
  })

  test("spec ids and questions are validated when spec is configured", () => {
    const root = project({
      ...base,
      "docs/spec/10-ops.md": "**[OP-01]** rule\n~~[OP-02]~~ old\n**[AC-01]** accept",
      "docs/spec/99-q.md": "**[Q-01]** open?",
      "tasks/T-001-a.md": taskFile({ id: "T-001", blocked_by: ["Q-02"] }).replace("spec: []", "spec: [OP-01, OP-02, OP-09]").replace("acceptance: []", "acceptance: [AC-01, XX-1]"),
    })
    const c = cfg({ spec: { dir: "docs/spec", definition: "\\*\\*\\[([A-Z]+-\\d{2,3})\\]\\*\\*|~~\\[([A-Z]+-\\d{2,3})\\]~~", questions: "docs/spec/99-q.md", questionPattern: "\\*\\*\\[(Q-\\d+)\\]\\*\\*", acceptancePattern: "^AC-\\d+$" } })
    const e = check(root, c).errors
    expect(e).toEqual([
      "tasks/T-001-a.md: blocked_by Q-02 not found in docs/spec/99-q.md",
      "tasks/T-001-a.md: unknown spec rule OP-09",
      'tasks/T-001-a.md: acceptance "XX-1" is not an acceptance id',
    ])
  })

  test("warns when a done task's PR is not merged", () => {
    const root = project({ ...base, "tasks/T-001-a.md": taskFile({ id: "T-001", status: "done", pr: "https://x/pull/1", dod: "- [x] ok", result: "r" }) })
    const r = check(root, cfg(), { prState: () => "CLOSED" })
    expect(r.warnings).toEqual(["tasks/T-001-a.md: status done but PR is CLOSED"])
  })
})

describe("board, next, set", () => {
  test("board lists tasks per epic with relative links and no counters", () => {
    const root = project({
      "epics/E-01-core.md": epicFile("E-01", "Core", "in_progress"),
      "epics/E-02-ui.md": epicFile("E-02", "UI"),
      "tasks/T-002-b.md": taskFile({ id: "T-002", epic: "E-01", depends: ["T-001"], title: "Second" }),
      "tasks/T-001-a.md": taskFile({ id: "T-001", epic: "E-01", status: "done", pr: "https://x/pull/1", title: "First" }),
    })
    const board = renderBoard(root, cfg())
    expect(board).toContain("## E-01. Core — in_progress")
    expect(board).toContain("Epic: [E-01-core.md](../epics/E-01-core.md)")
    expect(board.indexOf("[T-001]")).toBeLessThan(board.indexOf("[T-002]"))
    expect(board).toContain("- [T-001](T-001-a.md) First — **done** · api · S · depends: — · [PR](https://x/pull/1)")
    expect(board).toContain("- [T-002](T-002-b.md) Second — **todo** · api · S · depends: T-001 · —")
    expect(board).not.toMatch(/\d+\/\d+ done/)
    expect(summary(root, cfg())).toContain("E-01 in_progress: 1/2 done")
  })

  test("writeBoard reports staleness and writes only when changed", () => {
    const root = project({ "epics/E-01-core.md": epicFile("E-01"), "tasks/T-001-a.md": taskFile({ id: "T-001" }) })
    expect(writeBoard(root, cfg(), true)).toMatchObject({ stale: true, written: false })
    expect(writeBoard(root, cfg())).toMatchObject({ stale: true, written: true })
    expect(writeBoard(root, cfg(), true)).toMatchObject({ stale: false })
  })

  test("ready tasks: todo, depends done, not blocked", () => {
    const root = project({
      "epics/E-01-core.md": epicFile("E-01"),
      "tasks/T-001-a.md": taskFile({ id: "T-001", status: "done" }),
      "tasks/T-002-b.md": taskFile({ id: "T-002", depends: ["T-001"] }),
      "tasks/T-003-c.md": taskFile({ id: "T-003", depends: ["T-002"] }),
      "tasks/T-004-d.md": taskFile({ id: "T-004", blocked_by: ["Q-01"] }),
    })
    const docs = loadTasks(root, cfg())
    expect(readyTasks(docs).map((t) => t.id)).toEqual(["T-002"])
    expect(notReadyReason(docs, "T-003")).toBe("T-003 depends on unfinished task(s): T-002")
    expect(notReadyReason(docs, "T-004")).toBe("T-004 is blocked by Q-01")
    expect(notReadyReason(docs, "T-001")).toBe('T-001 has status "done", expected todo')
  })

  test("setStatus updates status, branch and pr; rejects bad input", () => {
    const root = project({ "epics/E-01-core.md": epicFile("E-01"), "tasks/T-001-a.md": taskFile({ id: "T-001" }) })
    setStatus(root, cfg(), "T-001", "done", { pr: "https://x/pull/9", branch: "task/T-001-a" })
    const { data } = parseFrontmatter(fs.readFileSync(path.join(root, "tasks/T-001-a.md"), "utf8"))
    expect(data).toMatchObject({ status: "done", pr: "https://x/pull/9", branch: "task/T-001-a" })
    expect(() => setStatus(root, cfg(), "T-001", "finished")).toThrow("invalid status")
    expect(() => setStatus(root, cfg(), "T-404", "done")).toThrow("not found")
  })
})

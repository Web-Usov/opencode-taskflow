import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { claim, clean, planWorktree, renderNewTask } from "../src/core/claim.ts"
import { cfg, epicFile, repoWithOrigin, sh, taskFile, tmpdir, TEMPLATE } from "./helpers.ts"

const T = 60_000
const files = {
  "tasks/_template.md": TEMPLATE,
  "epics/E-01-core.md": epicFile("E-01"),
  "tasks/T-001-first-task.md": taskFile({ id: "T-001", title: "First task" }),
  "tasks/README.md": "",
}

describe("claim edges", () => {
  test("a repo without a remote claims from local refs", async () => {
    const dir = tmpdir("tf-noremote-")
    const main = path.join(dir, "app")
    fs.mkdirSync(main)
    sh("git", ["init", "-q", "-b", "main"], main)
    for (const [rel, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true })
      fs.writeFileSync(path.join(main, rel), c)
    }
    sh("git", ["add", "-A"], main)
    sh("git", ["commit", "-qm", "init"], main)
    const r = await claim({ cwd: main, cfg: cfg(), id: "T-001" })
    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.log.join("\n")).toContain("no remote")
  }, T)

  test("an unreachable remote fails with git fetch, offline succeeds", async () => {
    const { main } = repoWithOrigin(files)
    sh("git", ["remote", "set-url", "origin", "/nonexistent/path.git"], main)
    const r = await claim({ cwd: main, cfg: cfg(), id: "T-001" })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("git fetch")
    const off = await claim({ cwd: main, cfg: cfg(), id: "T-001", offline: true })
    expect(off.error).toBeUndefined()
    expect(off.ok).toBe(true)
  }, T)

  test("renderNewTask keeps $& and $1 in titles literally", () => {
    const t = renderNewTask(TEMPLATE, { id: "T-042", title: "Price $& and $1", epic: "E-01", area: "api", size: "S" })
    expect(t).toContain("# T-042. Price $& and $1")
    expect(t).toContain(`title: "Price $& and $1"`)
  })
})

describe("planWorktree", () => {
  test("creates plan/<slug> under the -wt dir and reuses it", async () => {
    const { main, dir } = repoWithOrigin(files)
    const a = await planWorktree({ cwd: main, cfg: cfg(), slug: "Epic Two" })
    expect(a.error).toBeUndefined()
    expect(a.branch).toBe("plan/epic-two")
    expect(a.worktree).toBe(path.join(dir, "app-wt", "plan-epic-two"))
    expect(fs.existsSync(a.worktree!)).toBe(true)
    const b = await planWorktree({ cwd: main, cfg: cfg(), slug: "Epic Two" })
    expect(b.ok).toBe(true)
    expect(b.worktree).toBe(a.worktree)
    expect(b.log.join("\n")).toContain("reusing")
  }, T)
})

describe("clean edges", () => {
  test("a worktree deleted by hand still lets the branch go", async () => {
    const { main } = repoWithOrigin(files)
    const r = await claim({ cwd: main, cfg: cfg(), id: "T-001" })
    const head = sh("git", ["rev-parse", "HEAD"], r.worktree!)
    sh("git", ["push", "-q", "origin", r.branch!], r.worktree!)
    fs.rmSync(r.worktree!, { recursive: true, force: true })
    const res = await clean({ cwd: main, cfg: cfg(), id: "T-001", prView: async () => ({ state: "MERGED", url: "u", headRefOid: head }) })
    expect(res.error).toBeUndefined()
    expect(res.ok).toBe(true)
    expect(sh("git", ["branch", "--list", r.branch!], main)).toBe("")
  }, T)

  test("after clean the main checkout is fast-forwarded to origin/main", async () => {
    const { main, origin, dir } = repoWithOrigin(files)
    const r = await claim({ cwd: main, cfg: cfg(), id: "T-001" })
    const head = sh("git", ["rev-parse", "HEAD"], r.worktree!)
    sh("git", ["push", "-q", "origin", r.branch!], r.worktree!)
    const other = path.join(dir, "other")
    sh("git", ["clone", "-q", origin, other], dir)
    fs.writeFileSync(path.join(other, "new.txt"), "n")
    sh("git", ["add", "-A"], other)
    sh("git", ["commit", "-qm", "upstream"], other)
    sh("git", ["push", "-q", "origin", "main"], other)
    const before = sh("git", ["rev-parse", "HEAD"], main)
    const res = await clean({ cwd: main, cfg: cfg(), id: "T-001", prView: async () => ({ state: "MERGED", url: "u", headRefOid: head }) })
    expect(res.error).toBeUndefined()
    const after = sh("git", ["rev-parse", "HEAD"], main)
    expect(after).not.toBe(before)
    expect(after).toBe(sh("git", ["rev-parse", "HEAD"], other))
  }, T)
})

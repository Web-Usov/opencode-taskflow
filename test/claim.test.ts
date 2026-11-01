import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { claim, clean, collectTaskIds, decideClean, nextTaskId, renderNewTask, resolveBranch, slugify } from "../src/core/claim.ts"
import { parseFrontmatter } from "../src/core/frontmatter.ts"
import { cfg, epicFile, repoWithOrigin, sh, taskFile, TEMPLATE } from "./helpers.ts"

describe("ids", () => {
  test("nextTaskId takes max + 1 with padding", () => {
    expect(nextTaskId(["T-001", "T-019", "T-007"])).toBe("T-020")
    expect(nextTaskId([])).toBe("T-001")
    expect(nextTaskId(["T-999"], 3)).toBe("T-1000")
  })
  test("slugify keeps latin words and cuts at a word boundary", () => {
    expect(slugify("Fix: the API (v2) error!")).toBe("fix-the-api-v2-error")
    expect(slugify("one two three four five six seven eight nine ten")).toBe("one-two-three-four-five-six-seven-eight")
    expect(slugify("Только кириллица")).toBe("")
  })
  test("renderNewTask fills the template and rejects unsafe titles", () => {
    const t = renderNewTask(TEMPLATE, { id: "T-042", title: "Add thing", epic: "E-03", area: "web", size: "M" })
    expect(parseFrontmatter(t).data).toMatchObject({ id: "T-042", title: "Add thing", epic: "E-03", area: "web", size: "M", status: "todo" })
    expect(t).toContain("# T-042. Add thing")
    expect(() => renderNewTask(TEMPLATE, { id: "T-1", title: 'a "b"', epic: "E-01", area: "api", size: "S" })).toThrow()
  })
  test("collectTaskIds sees files on refs and ids in branch names", () => {
    const out: Record<string, string> = {
      "for-each-ref --format=%(refname) refs/remotes/origin": "refs/remotes/origin/main\nrefs/remotes/origin/task/T-030-x",
      "for-each-ref --format=%(refname) refs/heads": "refs/heads/main",
      "ls-tree --name-only origin/main tasks/": "tasks/T-001-a.md\ntasks/_template.md",
      "ls-tree --name-only refs/remotes/origin/task/T-030-x tasks/": "tasks/T-001-a.md\ntasks/T-031-new.md",
      "branch -a --format=%(refname:short)": "main\norigin/task/T-030-x\ntask/T-044-local",
    }
    const ids = collectTaskIds((a) => {
      const k = a.join(" ")
      if (k in out) return out[k]!
      throw new Error("no ref")
    }, cfg(), "origin/main")
    expect(ids.sort()).toEqual(["T-001", "T-030", "T-031", "T-044"])
  })
})

describe("clean decisions", () => {
  const pr = { state: "MERGED", url: "u", headRefOid: "abc" }
  test("refuses an unmerged PR", () => {
    expect(decideClean({ pr: { ...pr, state: "OPEN" }, branch: "b", localHead: "abc", inBase: true })).toMatchObject({ ok: false })
  })
  test("allows when head matches, or contained in base or PR head", () => {
    expect(decideClean({ pr, branch: "b", localHead: "abc", inBase: false }).ok).toBe(true)
    expect(decideClean({ pr, branch: "b", localHead: "zzz", inBase: true }).ok).toBe(true)
    expect(decideClean({ pr, branch: "b", localHead: "zzz", inBase: false, inPrHead: true }).ok).toBe(true)
  })
  test("lists unpushed commits otherwise", () => {
    const r = decideClean({ pr, branch: "b", localHead: "zzz", inBase: false, unpushed: ["123 wip"] })
    expect(r.ok).toBe(false)
    expect((r as any).reason).toContain("123 wip")
  })
  test("resolveBranch prefers the branch field without fallback", () => {
    expect(resolveBranch({ id: "T-001", branchField: "task/T-009-old", localBranches: ["task/T-009-old"], prefix: "task/" })).toEqual({ branch: "task/T-009-old" })
    expect("error" in resolveBranch({ id: "T-001", branchField: "task/T-009-old", localBranches: ["task/T-001-a"], prefix: "task/" })).toBe(true)
    expect(resolveBranch({ id: "T-001", branchField: null, localBranches: ["main", "task/T-001-a"], prefix: "task/" })).toEqual({ branch: "task/T-001-a" })
  })
})

describe("claim and clean against a real git repo", () => {
  const files = {
    "tasks/_template.md": TEMPLATE,
    "epics/E-01-core.md": epicFile("E-01"),
    "tasks/T-001-first-task.md": taskFile({ id: "T-001", title: "First task" }),
    "tasks/T-002-second.md": taskFile({ id: "T-002", depends: ["T-001"] }),
    "tasks/README.md": "",
    ".env.local": "SECRET=1",
  }

  test("claims a ready task: worktree, branch, copied env, in_progress commit", () => {
    const { main, dir } = repoWithOrigin(files)
    const c = cfg({ setup: { copy: [{ to: "conf/.env", from: [".env.missing", ".env.local"] }], commands: ["echo setup-ran > setup.txt"] } })
    const r = claim({ cwd: main, cfg: c, id: "T-001" })
    expect(r.error).toBeUndefined()
    expect(r.ok).toBe(true)
    expect(r.branch).toBe("task/T-001-first-task")
    expect(r.worktree).toBe(path.join(dir, "app-wt", "t-001-first-task"))
    const wt = r.worktree!
    expect(fs.readFileSync(path.join(wt, "conf/.env"), "utf8")).toBe("SECRET=1")
    expect(fs.existsSync(path.join(wt, "setup.txt"))).toBe(true)
    expect(parseFrontmatter(fs.readFileSync(path.join(wt, "tasks/T-001-first-task.md"), "utf8")).data).toMatchObject({ status: "in_progress", branch: "task/T-001-first-task" })
    expect(sh("git", ["log", "-1", "--format=%s"], wt)).toBe("chore(tasks): start T-001 [T-001]")
    expect(fs.readFileSync(path.join(wt, "tasks/README.md"), "utf8")).toContain("**in_progress**")
    // a second claim of the same task is refused
    expect(claim({ cwd: main, cfg: c, id: "T-001" }).error).toContain("already exists")
  })

  test("refuses unready tasks and rolls back a failed setup", () => {
    const { main, dir } = repoWithOrigin(files)
    expect(claim({ cwd: main, cfg: cfg(), id: "T-002" }).error).toBe("T-002 depends on unfinished task(s): T-001")
    expect(claim({ cwd: main, cfg: cfg(), id: "T-404" }).error).toContain("not found on origin/main")
    const r = claim({ cwd: main, cfg: cfg({ setup: { commands: ["exit 3"] } }), id: "T-001" })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("exit 3")
    expect(fs.existsSync(path.join(dir, "app-wt", "t-001-first-task"))).toBe(false)
    expect(sh("git", ["branch", "--list", "task/T-001-first-task"], main)).toBe("")
  })

  test("creates and claims a new task with the next free id", () => {
    const { main } = repoWithOrigin(files)
    const r = claim({ cwd: main, cfg: cfg(), create: { title: "Follow up fix", epic: "E-01", area: "api", size: "S" } })
    expect(r.error).toBeUndefined()
    expect(r.id).toBe("T-003")
    const f = path.join(r.worktree!, "tasks/T-003-follow-up-fix.md")
    expect(parseFrontmatter(fs.readFileSync(f, "utf8")).data).toMatchObject({ id: "T-003", status: "in_progress", title: "Follow up fix" })
    expect(sh("git", ["log", "-1", "--format=%s"], r.worktree!)).toBe("chore(tasks): add and start T-003 [T-003]")
    expect(claim({ cwd: main, cfg: cfg(), create: { title: "X", epic: "E-77", area: "api", size: "S" } }).error).toContain("epic E-77 not found")
  })

  test("clean removes worktree and branch only after the PR is merged", () => {
    const { main } = repoWithOrigin(files)
    const c = cfg()
    const r = claim({ cwd: main, cfg: c, id: "T-001" })
    const head = sh("git", ["rev-parse", "HEAD"], r.worktree!)
    sh("git", ["push", "-q", "origin", r.branch!], r.worktree!)
    const open = clean({ cwd: main, cfg: c, id: "T-001", prView: () => ({ state: "OPEN", url: "u", headRefOid: head }) })
    expect(open.error).toContain("not MERGED")
    expect(fs.existsSync(r.worktree!)).toBe(true)
    const done = clean({ cwd: main, cfg: c, id: "T-001", remoteBranch: true, prView: () => ({ state: "MERGED", url: "u", headRefOid: head }) })
    expect(done.error).toBeUndefined()
    expect(fs.existsSync(r.worktree!)).toBe(false)
    expect(sh("git", ["branch", "--list", r.branch!], main)).toBe("")
    expect(sh("git", ["ls-remote", "--heads", "origin", r.branch!], main)).toBe("")
  })

  test("clean refuses to lose unpushed local commits", () => {
    const { main } = repoWithOrigin(files)
    const c = cfg()
    const r = claim({ cwd: main, cfg: c, id: "T-001" })
    const pushed = sh("git", ["rev-parse", "HEAD"], r.worktree!)
    fs.writeFileSync(path.join(r.worktree!, "x.txt"), "x")
    sh("git", ["add", "-A"], r.worktree!)
    sh("git", ["commit", "-qm", "local only"], r.worktree!)
    const res = clean({ cwd: main, cfg: c, id: "T-001", prView: () => ({ state: "MERGED", url: "u", headRefOid: pushed }) })
    expect(res.ok).toBe(false)
    expect(res.error).toContain("local only")
  })
})

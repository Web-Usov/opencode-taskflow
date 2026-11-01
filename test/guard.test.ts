import { describe, expect, test } from "bun:test"
import { badPush, guard, mergeCommands, relativize, roleRules, type Rule } from "../src/core/guard.ts"
import { cfg } from "./helpers.ts"

const layout = { base: "main", mainDir: "/r/app", worktreeParent: "/r/app-wt" }
const gctx = { base: "main", roots: ["/r/app", "/r/app-wt/t-001-x"], worktreeParent: "/r/app-wt" }
const sh = (agent: string, cmd: string, c = cfg()) => guard(c, { agent, action: "shell", resources: [cmd] }, gctx)

describe("guard: implementer shell bypasses", () => {
  for (const cmd of [
    "gh api -X PUT repos/o/r/pulls/1/merge",
    "env gh pr merge 3",
    "git push origin +task/T-1-x",
    "git push --force-with-lease origin x",
    "git push origin main",
    "git push origin HEAD:refs/heads/main",
    "git -C /x push origin main",
    "bash -c 'gh pr merge 1'",
  ]) {
    test(`denies ${cmd}`, () => expect(sh("implementer", cmd)).not.toBeNull())
  }
  for (const cmd of ["git push -u origin task/T-001-x", "git push origin main-feature"]) {
    test(`allows ${cmd}`, () => expect(sh("implementer", cmd)).toBeNull())
  }
  test("helpers", () => {
    expect(mergeCommands("a && gh pr merge 3 --squash; echo")).toEqual(["gh pr merge 3 --squash"])
    expect(badPush("git push origin feature", "main")).toBeNull()
    expect(badPush("git push origin :main", "main")).not.toBeNull()
  })
})

describe("guard: reviewer", () => {
  for (const cmd of ["gh pr merge 12 --squash --auto", "gh pr merge 12 --disable-auto", "gh api -X PUT repos/o/r/pulls/12/update-branch"]) {
    test(`allows ${cmd}`, () => expect(sh("reviewer", cmd)).toBeNull())
  }
  for (const cmd of ["gh pr merge 12 --admin --squash --auto", "gh pr merge 12 --squash", "gh api -X PUT repos/o/r/pulls/1/merge -f sha=a/pulls/1/update-branch"]) {
    test(`denies ${cmd}`, () => expect(sh("reviewer", cmd)).not.toBeNull())
  }
  test("autoMerge=false allows only --disable-auto", () => {
    const c = cfg({ review: { autoMerge: false } })
    expect(sh("reviewer", "gh pr merge 12 --squash --auto", c)).not.toBeNull()
    expect(sh("reviewer", "gh pr merge 12 --disable-auto", c)).toBeNull()
  })
})

describe("relativize", () => {
  test("absolute path in a worktree root", () => expect(relativize("/r/app-wt/t-001-x/docs/spec/a.md", gctx.roots, gctx.worktreeParent)).toBe("docs/spec/a.md"))
  test("under worktreeParent but unknown worktree", () => expect(relativize("/r/app-wt/t-009-y/docs/spec/a.md", gctx.roots, gctx.worktreeParent)).toBe("docs/spec/a.md"))
  test("relative ./x", () => expect(relativize("./x", gctx.roots, gctx.worktreeParent)).toBe("x"))
  test("planner may edit protected absolute paths; implementer may not", () => {
    const res = ["/r/app-wt/t-001-x/epics/E-01.md"]
    expect(guard(cfg(), { agent: "planner", action: "edit", resources: res }, gctx)).toBeNull()
    expect(guard(cfg(), { agent: "implementer", action: "edit", resources: res }, gctx)).not.toBeNull()
  })
})

/** OpenCode wildcard: `*` any characters (including `/` and spaces), `?` one character. */
function wildcardMatch(pattern: string, value: string): boolean {
  const re = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("")
  return new RegExp(`^${re}$`, "s").test(value)
}

/** Effect of the LAST matching rule, or null when nothing matches. */
function evaluate(rules: Rule[], action: string, resource: string): Rule["effect"] | null {
  let effect: Rule["effect"] | null = null
  for (const r of rules) if ((r.action === action || r.action === "*") && wildcardMatch(r.resource, resource)) effect = r.effect
  return effect
}

describe("static rules under OpenCode wildcard semantics", () => {
  const impl = roleRules(cfg(), "implementer", layout)
  test("implementer", () => {
    expect(evaluate(impl, "edit", "docs/spec/a.md")).toBe("deny")
    // absolute paths inside worktrees are left to the hook (static `*` would over-match at any depth)
    expect(evaluate(impl, "edit", "/r/app-wt/t-001-x/docs/spec/a.md")).toBeNull()
    expect(evaluate(impl, "edit", "/r/app-wt/t-001-x/src/docs/spec/a.md")).toBeNull()
    expect(evaluate(impl, "edit", "/r/app/docs/spec/a.md")).toBe("deny")
    expect(evaluate(impl, "edit", "src/a.ts")).not.toBe("deny")
    expect(evaluate(impl, "shell", "gh pr merge 1")).toBe("deny")
    expect(evaluate(impl, "taskflow.dispatch", "*")).toBe("deny")
    expect(evaluate(impl, "shell", "git push origin HEAD:main-feature")).toBeNull()
    expect(evaluate(impl, "shell", "git push origin HEAD:main")).toBe("deny")
    expect(evaluate(impl, "shell", "grep -rn x src")).toBeNull()
  })
  test("planner and qa allows are relative only (no over-matching absolute globs)", () => {
    const planner = roleRules(cfg(), "planner", layout)
    expect(evaluate(planner, "edit", "docs/spec/a.md")).toBe("allow")
    expect(evaluate(planner, "edit", "/r/app-wt/plan-x/src/docs/a.ts")).toBe("deny")
    const qa = roleRules(cfg(), "qa", layout)
    expect(evaluate(qa, "edit", "e2e/a.spec.ts")).toBe("allow")
    expect(evaluate(qa, "edit", "/r/app-wt/t-1-x/src/e2e/x.ts")).toBe("deny")
  })
  test("reviewer temp worktrees are narrow", () => {
    const rev = roleRules(cfg(), "reviewer", layout)
    expect(evaluate(rev, "shell", "git worktree add /tmp/review-12 origin/x")).toBe("allow")
    expect(evaluate(rev, "shell", "git -C /tmp/r push origin HEAD:task/T-1-x")).toBe("deny")
    expect(evaluate(rev, "shell", "git reset --hard HEAD~3")).toBe("deny")
  })
  test("reviewer", () => {
    const rev = roleRules(cfg(), "reviewer", layout)
    expect(evaluate(rev, "shell", "rm -rf x")).toBe("deny")
    expect(evaluate(rev, "shell", "gh pr view 1")).toBe("allow")
    expect(evaluate(rev, "shell", "gh pr merge 1 --admin --squash --auto")).toBe("deny")
    expect(evaluate(rev, "taskflow.write", "*")).toBe("deny")
  })
})

describe("round-2 guard fixes", () => {
  const c = cfg()
  const g = { base: "main", roots: ["/r/app", "/r/app-wt/t-001-x"], worktreeParent: "/r/app-wt" }
  const deny = (agent: string, cmd: string) => guard(c, { agent, action: "shell", resources: [cmd] }, g)
  test("no false positives on quoted text and look-alike branches", () => {
    expect(deny("implementer", 'git commit -m "docs: never git push main"')).toBeNull()
    expect(deny("implementer", 'git commit -m "explain the gh pr merge flow"')).toBeNull()
    expect(deny("implementer", 'grep -rn "gh pr merge" src')).toBeNull()
    expect(deny("implementer", "git push origin HEAD:main-feature")).toBeNull()
  })
  test("git global options and graphql merges are caught", () => {
    expect(deny("implementer", "git -c k=v push origin HEAD:main")).not.toBeNull()
    expect(deny("implementer", "git --no-pager push origin main")).not.toBeNull()
    expect(deny("implementer", "git push -uf origin x")).not.toBeNull()
    expect(deny("implementer", "gh api graphql -f query='mutation{mergePullRequest(input:{})}'")).not.toBeNull()
    expect(deny("implementer", "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{})}'")).not.toBeNull()
  })
  test("reviewer temp worktrees: only /tmp/review-*, no .., no --force", () => {
    expect(deny("reviewer", "git worktree add /tmp/review-12 origin/x")).toBeNull()
    expect(deny("reviewer", "git worktree remove /tmp/review-12")).toBeNull()
    expect(deny("reviewer", "git worktree remove /tmp/../r/app-wt/t-001-x --force")).not.toBeNull()
    expect(deny("reviewer", "git worktree remove /tmp/review-12 --force")).not.toBeNull()
    expect(deny("reviewer", "git worktree add /tmp/../r/x origin/y")).not.toBeNull()
  })
  test("absolute edits in a worktree are relativized precisely", () => {
    const edit = (agent: string, p: string) => guard(c, { agent, action: "edit", resources: [p] }, g)
    expect(edit("implementer", "/r/app-wt/t-001-x/epics/E-1.md")).not.toBeNull()
    expect(edit("implementer", "/r/app-wt/t-001-x/src/epics/x.ts")).toBeNull()
    expect(edit("implementer", "/r/app-wt/t-001-x/../t-001-x/docs/spec/a.md")).not.toBeNull()
    expect(edit("planner", "/r/app-wt/t-001-x/epics/E-1.md")).toBeNull()
  })
})

import { describe, expect, test } from "bun:test"
import { exclusive, fetchShared, run, runShell } from "../src/core/git.ts"
import { guard, roleRules, splitCommands } from "../src/core/guard.ts"
import { cfg, repoWithOrigin, sh } from "./helpers.ts"

const g = { base: "main", roots: ["/r/app"], worktreeParent: "/r/app-wt" }
const denied = (agent: string, cmd: string) => guard(cfg(), { agent, action: "shell", resources: [cmd] }, g) !== null

describe("shell analysis: wrappers, heredocs, redirects", () => {
  test.each([
    "bash -lc 'gh pr merge 1'",
    "sh -ec 'git push origin main'",
    "timeout 60 git push origin main",
    "nice -n 10 git push origin main",
    "sudo -u bob gh pr merge 2",
    "env -u X git push origin main",
    "env -i PATH=/x bash -c 'gh pr merge 1'",
    "xargs -n 1 gh pr merge",
    "eval 'gh pr merge 3'",
    "git push origin HEAD:main>/dev/null",
    "git push -uf origin x",
  ])("implementer denied: %s", (cmd) => {
    expect(denied("implementer", cmd)).toBe(true)
  })
  test.each([
    "git commit -F - <<'EOF'\ngh pr merge happens after review\nEOF",
    "cat > docs/x.md <<EOF\ngit push origin main\nEOF\necho ok",
    "cat <<-EOF > a\n\tgit push origin main\n\tEOF",
    "git push --follow-tags -u origin task/T-1-x",
    "git push --no-verify --set-upstream origin task/T-1-x",
    "gh api repos/o/r/commits?path=src/merge/x.ts",
    "gh api graphql -f query='{ viewer { login } }'",
  ])("implementer allowed: %s", (cmd) => {
    expect(denied("implementer", cmd)).toBe(false)
  })
  test("a command after a heredoc is still analysed", () => {
    expect(denied("implementer", "cat > a <<EOF\nx\nEOF\ngit push origin main")).toBe(true)
    expect(splitCommands("cat > a <<EOF\nx\nEOF\necho ok")).toEqual(["cat > a", "echo ok"])
  })
  test("reviewer may not create branches through temp worktrees or fetch refspecs", () => {
    expect(denied("reviewer", "git worktree add -B task/x /tmp/review-1 origin/x")).toBe(true)
    expect(denied("reviewer", "git fetch origin +x:refs/heads/task/x")).toBe(true)
    expect(denied("reviewer", "git fetch origin task/T-1-x")).toBe(false)
    expect(denied("reviewer", "git worktree add /tmp/review-1 origin/x")).toBe(false)
  })
  test("static rules no longer deny read-only gh api calls", () => {
    const rules = roleRules(cfg(), "implementer", { base: "main", mainDir: "/r/app", worktreeParent: "/r/app-wt" })
    expect(rules.some((r) => r.resource === "gh api graphql*")).toBe(false)
    expect(rules).toContainEqual({ action: "shell", resource: "gh api*/pulls/*/merge*", effect: "deny" })
  })
})

describe("process handling", () => {
  test("timeout kills the whole process group quickly", async () => {
    const t = Date.now()
    const r = await runShell("sleep 30 & sleep 30; echo done", "/tmp", { timeout: 300 })
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain("timed out")
    expect(Date.now() - t).toBeLessThan(5000)
  })
  test("abort resolves promptly", async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const t = Date.now()
    const r = await runShell("sleep 30", "/tmp", { signal: ac.signal })
    expect(r.ok).toBe(false)
    expect(Date.now() - t).toBeLessThan(5000)
  })
  test("a command that leaves a background child still resolves", async () => {
    const t = Date.now()
    const r = await runShell("(sleep 20 &) ; echo started", "/tmp")
    expect(r.ok).toBe(true)
    expect(r.stdout.trim()).toBe("started")
    expect(Date.now() - t).toBeLessThan(5000)
  })
  test("utf-8 output survives chunking", async () => {
    const r = await run("bash", ["-c", "for i in $(seq 1 3000); do printf 'Привет'; done"], "/tmp")
    expect(r.stdout).toBe("Привет".repeat(3000))
  })
  test("exclusive serialises per key and survives failures", async () => {
    const order: string[] = []
    const a = exclusive("k1", async () => {
      order.push("a1")
      await Bun.sleep(50)
      order.push("a2")
      throw new Error("boom")
    })
    const b = exclusive("k1", async () => {
      order.push("b")
      return 2
    })
    await expect(a).rejects.toThrow("boom")
    expect(await b).toBe(2)
    expect(order).toEqual(["a1", "a2", "b"])
  })
  test("fetchShared joins a running fetch and one caller's abort does not kill it", async () => {
    const { main } = repoWithOrigin({ "a.txt": "a" })
    const ac = new AbortController()
    const first = fetchShared(main, "origin", { signal: ac.signal })
    const second = fetchShared(main, "origin")
    ac.abort()
    expect(await first).toEqual({ ok: false, error: "aborted" })
    expect(await second).toEqual({ ok: true })
    expect(sh("git", ["rev-parse", "--verify", "origin/main"], main)).toMatch(/^[0-9a-f]{40}$/)
  })
})

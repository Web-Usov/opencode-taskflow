import { beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { repoWithOrigin, TEMPLATE, epicFile, taskFile, sh, write } from "./helpers.ts"

const T = 60_000

const CONFIG = JSON.stringify({
  agents: {
    implementer: { models: ["acme/disabled#low", "acme/good#low"] },
    reviewer: { models: ["acme/good#low"] },
  },
})

describe("standards dispatch integration (no live models)", () => {
  async function boundRepo() {
    const h = await boot()
    const wt = path.join(h.dir, "bound-worktree")
    sh("git", ["worktree", "add", "-q", "-b", "task/T-001-bound", wt], h.main)
    const entry = { id: "chosen", title: "Chosen convention", path: "docs/rules.md", status: "approved" }
    write(wt, "docs/standards/index.json", JSON.stringify({ version: 1, entries: [entry] }))
    write(wt, "docs/rules.md", "# Bound source\nWORKTREE CONTENT; subordinate to AGENTS/spec/guard.")
    const task = taskFile({ id: "T-001", title: "First task" }).replace("spec: []", "spec: []\nstandards: [chosen]")
    write(wt, "tasks/T-001-first-task.md", task)
    // Main deliberately has a stale, invalid binding: reviewer must not use it.
    write(h.main, "tasks/T-001-first-task.md", task.replace("[chosen]", "[stale-main]"))
    return { ...h, wt, task, entry, tool: h.tools.find((t) => t.name === "tf_dispatch"), context: { sessionID: "ses_parent", agent: "lead", signal: new AbortController().signal } }
  }

  test("implementer and reviewer receive exact same ids, refs, contents and hashes from task worktree", async () => {
    const h = await boundRepo()
    try {
      const results = []
      for (const role of ["implementer", "reviewer"]) results.push(await h.tool.execute({ role, task: "T-001", prompt: "Do assigned work" }, h.context))
      const prompts = h.calls.filter((c) => c.fn === "session.prompt").map((c) => c.arg.text)
      expect(prompts).toHaveLength(2)
      const bindings = prompts.map((p: string) => p.slice(p.indexOf("Standards binding source:")))
      expect(bindings[0]).toBe(bindings[1])
      expect(bindings[0]).toContain(h.wt)
      expect(bindings[0]).toContain("chosen")
      expect(bindings[0]).toContain("docs/rules.md")
      expect(bindings[0]).toContain("WORKTREE CONTENT")
      expect(bindings[0]).not.toContain("stale-main")
      expect(bindings[0]).toContain("not instructions to bypass permissions")
      const creates = h.calls.filter((c) => c.fn === "session.create")
      expect(creates[0]!.arg.location.directory).toBe(h.wt)
      expect(creates[1]!.arg.location.directory).toBe(h.main)
      for (const r of results) {
        expect(r.content).toContain("chosen -> docs/rules.md (sha256")
        expect(r.content).toContain("VERDICT: LGTM")
      }
    } finally { h.cleanup() }
  })

  test("missing/draft/invalid/oversized bindings fail before child creation or prompt, atomically", async () => {
    const h = await boundRepo()
    try {
      const variants = [
        { binding: "[unknown]" },
        { binding: "chosen" },
        { binding: "[chosen, chosen]" },
        { binding: "[chosen]", status: "draft" },
        { binding: "[chosen]", missingIndex: true },
        { binding: "[chosen]", badIndex: true },
        { binding: "[chosen]", missingSource: true },
        { binding: "[chosen]", source: "x".repeat(25_000) },
        { binding: "[chosen]", sourcePath: "../outside.md" },
        { binding: "[chosen, missing]", second: true },
      ]
      for (const v of variants) {
        write(h.wt, "tasks/T-001-first-task.md", h.task.replace("standards: [chosen]", `standards: ${v.binding}`))
        write(h.wt, "docs/rules.md", v.source ?? "GOOD DATA MUST NOT PARTIALLY INJECT")
        const entries = [{ ...h.entry, status: v.status ?? "approved", path: v.sourcePath ?? h.entry.path }, ...(v.second ? [{ ...h.entry, id: "missing", path: "docs/missing.md" }] : [])]
        write(h.wt, "docs/standards/index.json", v.badIndex ? "{broken" : JSON.stringify({ version: 1, entries }))
        if (v.missingIndex) fs.unlinkSync(path.join(h.wt, "docs/standards/index.json"))
        if (v.missingSource) fs.unlinkSync(path.join(h.wt, "docs/rules.md"))
        const before = h.calls.length
        for (const role of ["implementer", "reviewer"]) {
          const r = await h.tool.execute({ role, task: "T-001", prompt: "work" }, h.context)
          expect(r.content).toContain("ERROR: dispatch failed")
          expect(r.content).not.toContain("GOOD DATA")
        }
        expect(h.calls.slice(before).some((c) => ["session.create", "session.prompt"].includes(c.fn))).toBe(false)
      }
      const before = h.calls.length
      expect((await h.tool.execute({ role: "reviewer", task: "T-404", prompt: "work" }, h.context)).content).toContain("not found")
      expect(h.calls.slice(before).some((c) => c.fn === "session.create")).toBe(false)
    } finally { h.cleanup() }
  })
})

function makeRepo() {
  return repoWithOrigin({
    ".opencode/taskflow.jsonc": CONFIG,
    "tasks/_template.md": TEMPLATE,
    "epics/E-01-core.md": epicFile("E-01"),
    "tasks/T-001-first-task.md": taskFile({ id: "T-001", title: "First task" }),
    "tasks/README.md": "",
  })
}

/** A fake OpenCode plugin context that records transforms, hooks and session calls. */
function fakeCtx(directory: string) {
  const agents = new Map<string, any>()
  const commands: any[] = []
  const tools: any[] = []
  const hooks = new Map<string, (ev: any) => void>()
  const transforms = { agent: [] as Array<(e: any) => void>, command: [] as Array<(e: any) => void>, tool: [] as Array<(e: any) => void> }
  const calls: Array<{ fn: string; arg: any }> = []
  const spy = (fn: string, result: (arg: any) => any = () => undefined) => async (arg?: any) => {
    calls.push({ fn, arg })
    return result(arg)
  }
  const ctx: any = {
    location: { directory },
    options: undefined,
    agent: { transform: async (cb: any) => void transforms.agent.push(cb), reload: spy("agent.reload") },
    command: { transform: async (cb: any) => void transforms.command.push(cb), reload: spy("command.reload") },
    tool: { transform: async (cb: any) => void transforms.tool.push(cb) },
    permission: { hook: async (name: string, cb: any) => void hooks.set(name, cb) },
    model: {
      list: async () => ({
        data: [
          { providerID: "acme", id: "disabled", variants: [{ id: "low" }], enabled: false },
          { providerID: "acme", id: "good", variants: [{ id: "low" }], enabled: true },
        ],
      }),
    },
    session: {
      create: spy("session.create", () => ({ id: "ses_child" })),
      prompt: spy("session.prompt"),
      wait: spy("session.wait"),
      context: spy("session.context", () => [
        { type: "assistant", content: [{ type: "text", text: "VERDICT: LGTM" }] },
        { type: "idle", outcome: "succeeded" },
      ]),
      get: spy("session.get", () => ({ location: { directory } })),
      move: spy("session.move"),
      switchAgent: spy("session.switchAgent"),
      interrupt: spy("session.interrupt"),
    },
  }
  const replay = () => {
    agents.clear()
    commands.length = 0
    tools.length = 0
    const agentEditor = {
      update: (id: string, fn: (a: any) => void) => {
        const rec = agents.get(id) ?? {}
        fn(rec)
        agents.set(id, rec)
      },
    }
    const commandEditor = { add: (c: any) => void commands.push(c) }
    const toolEditor = { namespace: () => {}, add: (t: any) => void tools.push(t) }
    transforms.agent.forEach((cb) => cb(agentEditor))
    transforms.command.forEach((cb) => cb(commandEditor))
    transforms.tool.forEach((cb) => cb(toolEditor))
  }
  return { ctx, agents, commands, tools, hooks, calls, replay }
}

async function boot() {
  const repo = makeRepo()
  const f = fakeCtx(repo.main)
  const plugin = (await import("../src/index.ts")).default
  const cleanup: any = await plugin.setup(f.ctx)
  f.replay()
  return { ...repo, ...f, cleanup }
}

describe("plugin entry with a fake OpenCode context", () => {
  let h: Awaited<ReturnType<typeof boot>>
  beforeAll(async () => {
    h = await boot()
  }, T)

  test("registers five agents with the contract, mode and resolved model", () => {
    expect([...h.agents.keys()].sort()).toEqual(["implementer", "lead", "planner", "qa", "reviewer"])
    for (const a of h.agents.values()) expect(a.system).toContain("Taskflow contract")
    expect(h.agents.get("reviewer").mode).toBe("subagent")
    expect(h.agents.get("qa").mode).toBe("subagent")
    for (const r of ["lead", "planner", "implementer"]) expect(h.agents.get(r).mode).toBe("all")
    // the disabled model is skipped, the enabled one is chosen
    expect(h.agents.get("implementer").model).toEqual({ providerID: "acme", id: "good", variant: "low" })
    expect(h.agents.get("reviewer").model).toEqual({ providerID: "acme", id: "good", variant: "low" })
  })

  test("permissions carry the role rules", () => {
    const has = (role: string, action: string, resource: string, effect = "deny") =>
      h.agents.get(role).permissions.some((p: any) => p.action === action && p.resource === resource && p.effect === effect)
    expect(has("implementer", "edit", "docs/spec/*")).toBe(true)
    expect(has("implementer", "edit", `${h.main}/docs/spec/*`)).toBe(true)
    expect(has("implementer", "taskflow.dispatch", "*")).toBe(true)
    expect(has("reviewer", "taskflow.write", "*")).toBe(true)
  })

  test("13 prefixed commands and 12 tools with permission and codemode:false", () => {
    expect(h.commands).toHaveLength(13)
    for (const c of h.commands) expect(c.name.startsWith("tf-")).toBe(true)
    expect(h.tools).toHaveLength(12)
    for (const t of h.tools) {
      expect(["taskflow.read", "taskflow.write", "taskflow.dispatch"]).toContain(t.options.permission)
      expect(t.options.codemode).toBe(false)
    }
  })

  test("guard hook tightens implementer decisions only", () => {
    const hook = h.hooks.get("evaluate")!
    const wtDir = path.join(path.dirname(h.main), "app-wt", "t-001-x")
    const run = (ev: any) => {
      hook(ev)
      return ev
    }
    const edit = run({ agent: "implementer", action: "edit", resources: [`${wtDir}/epics/E-01.md`], effect: "allow" })
    expect(edit.effect).toBe("deny")
    expect(edit.message).toContain("protected")
    expect(run({ agent: "implementer", action: "shell", resources: ["bash -c 'gh pr merge 1'"], effect: "allow" }).effect).toBe("deny")
    expect(run({ agent: "implementer", action: "shell", resources: ["git push origin HEAD:main"], effect: "allow" }).effect).toBe("deny")
    expect(run({ agent: "build", action: "edit", resources: ["epics/E-01.md"], effect: "allow" }).effect).toBe("allow")
    const denied = run({ agent: "implementer", action: "edit", resources: ["epics/E-01.md"], effect: "deny" })
    expect(denied.effect).toBe("deny")
    expect(denied.message).toBeUndefined()
  })

  test("tf_dispatch creates a child session, prompts, waits and returns the verdict", async () => {
    const tool = h.tools.find((t) => t.name === "tf_dispatch")
    const before = h.calls.length
    const res = await tool.execute({ role: "reviewer", prompt: "x" }, { sessionID: "ses_parent", agent: "lead", signal: new AbortController().signal })
    expect(res.content).toContain("VERDICT: LGTM")
    const mine = h.calls.slice(before)
    expect(mine.map((c) => c.fn).filter((f) => ["session.create", "session.prompt", "session.wait", "session.context"].includes(f))).toEqual([
      "session.create",
      "session.prompt",
      "session.wait",
      "session.context",
    ])
    const create = mine.find((c) => c.fn === "session.create")!.arg
    expect(create.parentID).toBe("ses_parent")
    expect(create.agent).toBe("reviewer")
    expect(create.location.directory).toBe(h.main)
  })

  test("tf_dispatch refuses an implementer caller and an aborted signal", async () => {
    const tool = h.tools.find((t) => t.name === "tf_dispatch")
    let before = h.calls.length
    const denied = await tool.execute({ role: "reviewer", prompt: "x" }, { sessionID: "ses_p", agent: "implementer", signal: new AbortController().signal })
    expect(denied.content).toContain("ERROR")
    expect(denied.content).toContain("may not dispatch")
    const ac = new AbortController()
    ac.abort()
    const aborted = await tool.execute({ role: "reviewer", prompt: "x" }, { sessionID: "ses_p", agent: "lead", signal: ac.signal })
    expect(aborted.content).toContain("ERROR")
    expect(h.calls.slice(before).some((c) => c.fn === "session.create")).toBe(false)
  })

  test("/tf-next T-001 claims in code, moves the session and prompts as implementer", async () => {
    const next = h.commands.find((c) => c.name === "tf-next")
    await next.execute({ sessionID: "ses_user", prompt: { text: "T-001" }, delivery: undefined })
    const wt = path.join(path.dirname(h.main), "app-wt", "t-001-first-task")
    expect(fs.existsSync(wt)).toBe(true)
    const move = h.calls.find((c) => c.fn === "session.move")!.arg
    expect(move.directory).toBe(wt)
    expect(h.calls.find((c) => c.fn === "session.switchAgent")!.arg.agent).toBe("implementer")
    const prompt = h.calls.filter((c) => c.fn === "session.prompt").at(-1)!.arg
    expect(prompt.sessionID).toBe("ses_user")
    expect(prompt.text).toContain("CLAIMED T-001")
  }, T)
})

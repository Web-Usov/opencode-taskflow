import { beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { repoWithOrigin, TEMPLATE, epicFile, taskFile } from "./helpers.ts"

const T = 60_000

const CONFIG = JSON.stringify({
  agents: {
    implementer: { models: ["acme/disabled#low", "acme/good#low"] },
    reviewer: { models: ["acme/good#low"] },
  },
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

  test("10 prefixed commands and 11 tools with permission and codemode:false", () => {
    expect(h.commands).toHaveLength(10)
    for (const c of h.commands) expect(c.name.startsWith("tf-")).toBe(true)
    expect(h.tools).toHaveLength(11)
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

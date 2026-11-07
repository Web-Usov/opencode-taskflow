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
    const h = await boot({ agents: { implementer: { name: "builder" }, reviewer: { name: "auditor" } } })
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

  test("continuations retain task and configured role identity; repeated or omitted task revalidates before prompt", async () => {
    const h = await boundRepo()
    try {
      const created = await h.tool.execute({ role: "implementer", task: "T-001", prompt: "work" }, h.context)
      const sessionID = created.content.match(/child session: (\S+)/)![1]
      expect(h.sessions.get(sessionID).agent).toBe("builder")
      expect(h.sessions.get(sessionID).metadata.taskflowDispatch.task).toBe("T-001")
      for (const task of [undefined, "T-001"]) {
        const result = await h.tool.execute({ role: "implementer", sessionID, task, prompt: "continue" }, h.context)
        expect(result.content).toContain("chosen -> docs/rules.md")
        const prompt = h.calls.filter((c) => c.fn === "session.prompt").at(-1)!.arg.text
        expect(prompt).toContain("Task: T-001")
        expect(prompt).not.toContain("Standards: none explicitly selected")
      }
      const before = h.calls.filter((c) => c.fn === "session.prompt").length
      for (const request of [
        { role: "implementer", task: "T-002" },
        { role: "reviewer" },
        { role: "implementer", directory: h.main },
      ]) {
        expect((await h.tool.execute({ ...request, sessionID, prompt: "wrong association" }, h.context)).content).toContain("ERROR")
      }
      expect((await h.tool.execute({ role: "implementer", sessionID, prompt: "wrong parent" }, { ...h.context, sessionID: "other_parent" })).content).toContain("different parent")
      const child = h.sessions.get(sessionID)
      child.agent = "auditor"
      expect((await h.tool.execute({ role: "implementer", sessionID, prompt: "wrong actual agent" }, h.context)).content).toContain("identity/agent/parent")
      child.agent = "builder"
      const metadata = child.metadata
      child.metadata = { taskflowDispatch: { ...metadata.taskflowDispatch, task: "T-002" } }
      expect((await h.tool.execute({ role: "implementer", sessionID, prompt: "tampered metadata" }, h.context)).content).toContain("association changed")
      // Runtime association also protects a host that omits session metadata on get.
      delete child.metadata
      // A stale id or a draft is rejected even when task is omitted, including after an earlier valid continuation.
      for (const entries of [[], [{ ...h.entry, status: "draft" }]]) {
        write(h.wt, "docs/standards/index.json", JSON.stringify({ version: 1, entries }))
        for (const task of [undefined, "T-001"]) {
          expect((await h.tool.execute({ role: "implementer", sessionID, task, prompt: "invalid binding" }, h.context)).content).toContain("ERROR: dispatch failed")
        }
      }
      child.metadata = metadata
      expect(h.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(before)
      expect(h.calls.filter((c) => c.fn === "session.create")).toHaveLength(1)
    } finally { h.cleanup() }
  })

  test("session metadata recovers original binding after plugin reload, and fails closed when unavailable", async () => {
    const h = await boundRepo()
    let cleanup: any
    try {
      const created = await h.tool.execute({ role: "implementer", task: "T-001", prompt: "work" }, h.context)
      const sessionID = created.content.match(/child session: (\S+)/)![1]
      h.cleanup()
      const reloaded = fakeCtx(h.main, h.sessions)
      cleanup = await (await import("../src/index.ts")).default.setup(reloaded.ctx)
      reloaded.replay()
      const tool = reloaded.tools.find((t) => t.name === "tf_dispatch")
      expect((await tool.execute({ role: "implementer", sessionID, prompt: "recover task" }, h.context)).content).toContain("chosen -> docs/rules.md")
      expect(reloaded.calls.filter((c) => c.fn === "session.prompt").at(-1)!.arg.text).toContain("Task: T-001")
      const before = reloaded.calls.filter((c) => c.fn === "session.prompt").length
      expect((await tool.execute({ role: "implementer", sessionID, task: "T-002", prompt: "contradiction" }, h.context)).content).toContain("contradictory task identity")
      expect((await tool.execute({ role: "reviewer", sessionID, prompt: "wrong role" }, h.context)).content).toContain("role/agent")
      write(h.wt, "docs/standards/index.json", JSON.stringify({ version: 1, entries: [{ ...h.entry, status: "draft" }] }))
      expect((await tool.execute({ role: "implementer", sessionID, prompt: "draft after reload" }, h.context)).content).toContain("is draft")
      expect(reloaded.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(before)

      // Unknown legacy sessions cannot be rebound by supplying a task or by omitting one.
      h.sessions.set("ses_legacy", { id: "ses_legacy", parentID: "ses_parent", agent: "builder", location: { directory: h.wt } })
      for (const task of [undefined, "T-001"]) {
        expect((await tool.execute({ role: "implementer", sessionID: "ses_legacy", task, prompt: "legacy" }, h.context)).content).toContain("cannot recover child task/role association")
      }
      // A fresh setup cannot trust the old in-memory association once durable metadata is gone.
      cleanup()
      delete h.sessions.get(sessionID).metadata
      const unavailable = fakeCtx(h.main, h.sessions)
      cleanup = await (await import("../src/index.ts")).default.setup(unavailable.ctx)
      unavailable.replay()
      for (const task of [undefined, "T-001"]) {
        expect((await unavailable.tools.find((t) => t.name === "tf_dispatch").execute({ role: "implementer", sessionID, task, prompt: "no metadata" }, h.context)).content).toContain("cannot recover child task/role association")
      }
      expect(unavailable.calls.some((c) => c.fn === "session.prompt")).toBe(false)
    } finally { h.cleanup(); cleanup?.() }
  })

  test("a reviewer child id cannot run as implementer; taskless children cannot silently acquire a task", async () => {
    const h = await boundRepo()
    try {
      const created = await h.tool.execute({ role: "reviewer", task: "T-001", prompt: "review" }, h.context)
      const sessionID = created.content.match(/child session: (\S+)/)![1]
      expect(h.sessions.get(sessionID).agent).toBe("auditor")
      const before = h.calls.filter((c) => c.fn === "session.prompt").length
      expect((await h.tool.execute({ role: "implementer", sessionID, prompt: "wrong session id" }, h.context)).content).toContain("role/agent")
      expect(h.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(before)
      const taskless = await h.tool.execute({ role: "planner", prompt: "plan" }, h.context)
      const plannerID = taskless.content.match(/child session: (\S+)/)![1]
      const count = h.calls.filter((c) => c.fn === "session.prompt").length
      expect((await h.tool.execute({ role: "planner", sessionID: plannerID, task: "T-001", prompt: "bind silently" }, h.context)).content).toContain("contradictory task identity")
      expect(h.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(count)
    } finally { h.cleanup() }
  })
})

describe("durable task SOURCE identity regressions", () => {
  for (const role of ["implementer", "reviewer"]) for (const reload of [false, true]) {
    for (const attack of ["tasks path", "worktree move", "worktree selection", "task file rename", "directory replacement", "directory symlink", "task file symlink", "symlink alias path"]) {
      test(`${role} rejects changed ${attack}, reload=${reload}`, async () => {
        const h = await boot({}, true)
        let active = h
        let cleanup = h.cleanup
        try {
          const wt = path.join(h.dir, "source-worktree")
          sh("git", ["worktree", "add", "-q", "-b", "task/T-001-bound", wt], h.main)
          const context = { sessionID: "ses_parent", agent: "lead", signal: new AbortController().signal }
          const tool = () => active.tools.find((t) => t.name === "tf_dispatch")
          const created = await tool().execute({ role, task: "T-001", prompt: "original" }, context)
          const sessionID = created.content.match(/child session: (\S+)/)![1]
          expect(h.sessions.get(sessionID).location.directory).toBe(role === "reviewer" ? h.main : wt)
          const tasks = path.join(wt, ".taskflow/tasks")
          if (attack === "tasks path") {
            write(wt, "replacement-tasks/T-001-other.md", taskFile({ id: "T-001", title: "REPLACEMENT TASK" }))
            write(h.main, ".taskflow/config.jsonc", JSON.stringify({ paths: { tasks: "replacement-tasks" } }))
          } else if (attack === "worktree move") {
            sh("git", ["worktree", "move", wt, wt + "-moved"], h.main)
          } else if (attack === "worktree selection") {
            sh("git", ["branch", "-m", "unrelated"], wt)
          } else if (attack === "task file rename") {
            fs.renameSync(path.join(tasks, "T-001-first-task.md"), path.join(tasks, "T-001-renamed.md"))
          } else if (attack === "directory symlink") {
            fs.renameSync(tasks, tasks + "-old")
            fs.symlinkSync("tasks-old", tasks)
          } else if (attack === "directory replacement") {
            fs.renameSync(tasks, tasks + "-old")
            fs.cpSync(tasks + "-old", tasks, { recursive: true })
          } else if (attack === "task file symlink") {
            const file = path.join(tasks, "T-001-first-task.md")
            fs.renameSync(file, file + ".old")
            fs.symlinkSync(file + ".old", file)
          } else {
            fs.symlinkSync("tasks", path.join(wt, ".taskflow/alias"))
            write(h.main, ".taskflow/config.jsonc", JSON.stringify({ paths: { tasks: ".taskflow/alias" } }))
          }
          if (reload) {
            cleanup()
            const f = fakeCtx(h.main, h.sessions)
            cleanup = await (await import("../src/index.ts")).default.setup(f.ctx)
            f.replay()
            active = { ...h, ...f }
          }
          const before = active.calls.filter((c) => c.fn === "session.prompt").length
          const result = await tool().execute({ role, sessionID, prompt: "must not switch source" }, context)
          expect(result.content).toContain("ERROR")
          expect(active.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(before)
        } finally { cleanup() }
      }, T)
    }

    test(`${role} refreshes same source contents, with v2 source metadata; reload=${reload}`, async () => {
      const h = await boot({}, true)
      let active = h
      let cleanup = h.cleanup
      try {
        const wt = path.join(h.dir, "source-worktree")
        sh("git", ["worktree", "add", "-q", "-b", "task/T-001-bound", wt], h.main)
        const file = ".taskflow/tasks/T-001-first-task.md"
        write(wt, file, taskFile({ id: "T-001" }).replace("spec: []", "spec: []\nstandards: [chosen]"))
        write(wt, ".taskflow/standards/index.json", JSON.stringify({ version: 1, entries: [{ id: "chosen", title: "Chosen", path: ".taskflow/standards/rules.md", status: "approved" }] }))
        write(wt, ".taskflow/standards/rules.md", "BEFORE REFRESH")
        const context = { sessionID: "ses_parent", agent: "lead", signal: new AbortController().signal }
        const created = await active.tools.find((t) => t.name === "tf_dispatch").execute({ role, task: "T-001", prompt: "original" }, context)
        const sessionID = created.content.match(/child session: (\S+)/)![1]
        const binding = h.sessions.get(sessionID).metadata.taskflowDispatch
        expect(binding.version).toBe(2)
        expect(binding.taskSource.root).toBe(fs.realpathSync(wt))
        expect(binding.taskSource.file).toBe(fs.realpathSync(path.join(wt, file)))
        // Atomic editor replacement at the SAME file path remains valid: identity is not a content/inode snapshot.
        write(wt, "new-task.md", taskFile({ id: "T-001", title: "Updated same task" }).replace("spec: []", "spec: []\nstandards: [chosen]"))
        fs.renameSync(path.join(wt, "new-task.md"), path.join(wt, file))
        write(wt, ".taskflow/standards/rules.md", "AFTER REFRESH")
        if (reload) {
          cleanup()
          // Durable JSON metadata is an object, not a key-order-sensitive byte encoding.
          h.sessions.get(sessionID).metadata.taskflowDispatch.taskSource = Object.fromEntries(Object.entries(binding.taskSource).reverse())
          const f = fakeCtx(h.main, h.sessions)
          cleanup = await (await import("../src/index.ts")).default.setup(f.ctx)
          f.replay()
          active = { ...h, ...f }
        }
        const result = await active.tools.find((t) => t.name === "tf_dispatch").execute({ role, sessionID, prompt: "refresh" }, context)
        expect(result.content).not.toContain("ERROR")
        expect(active.calls.filter((c) => c.fn === "session.prompt").at(-1)!.arg.text).toContain("AFTER REFRESH")
        // V1 metadata does not contain a recoverable source association.
        h.sessions.get(sessionID).metadata.taskflowDispatch = { ...binding, version: 1 }
        const before = active.calls.filter((c) => c.fn === "session.prompt").length
        expect((await active.tools.find((t) => t.name === "tf_dispatch").execute({ role, sessionID, prompt: "old metadata" }, context)).content).toContain("ERROR")
        expect(active.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(before)
      } finally { cleanup() }
    }, T)
  }
})

describe("running host discovers ownership signature changes", () => {
  for (const signature of ["workflow", "finance"]) for (const remove of [false, true]) test(`${signature}, remove=${remove}`, async () => {
    const repo = repoWithOrigin({ "README.md": "app" })
    const add = () => {
      if (signature === "workflow") write(repo.main, "docs/taskflow.md", "Generated by opencode-taskflow")
      else {
        write(repo.main, "tasks/README.md", "Generated by scripts/tasks.mjs board")
        write(repo.main, "scripts/tasks.mjs", "// legacy")
        write(repo.main, "tasks/_template.md", TEMPLATE)
      }
    }
    if (remove) add()
    const f = fakeCtx(repo.main)
    const cleanup: any = await (await import("../src/index.ts")).default.setup(f.ctx)
    f.replay()
    try {
      if (!remove) add()
      else if (signature === "workflow") fs.unlinkSync(path.join(repo.main, "docs/taskflow.md"))
      else fs.unlinkSync(path.join(repo.main, "scripts/tasks.mjs"))
      const ctx = { sessionID: "ses_parent", signal: new AbortController().signal }
      await f.tools.find((t) => t.name === "tf_init").execute({}, ctx)
      expect(fs.existsSync(path.join(repo.main, remove ? ".taskflow/config.jsonc" : ".opencode/taskflow.jsonc"))).toBe(true)
      expect(fs.existsSync(path.join(repo.main, remove ? ".opencode/taskflow.jsonc" : ".taskflow/config.jsonc"))).toBe(false)
    } finally { cleanup() }
  }, T)

  test("ownership content changes invalidate cache even when mtime is unchanged", async () => {
    const repo = repoWithOrigin({ "README.md": "app", "docs/taskflow.md": "unrelated user document" })
    const file = path.join(repo.main, "docs/taskflow.md")
    const f = fakeCtx(repo.main)
    const cleanup: any = await (await import("../src/index.ts")).default.setup(f.ctx)
    f.replay()
    try {
      const stat = fs.statSync(file)
      fs.writeFileSync(file, "Generated by opencode-taskflow")
      fs.utimesSync(file, stat.atime, stat.mtime)
      await f.tools.find((t) => t.name === "tf_init").execute({}, { sessionID: "ses_parent", signal: new AbortController().signal })
      expect(fs.existsSync(path.join(repo.main, ".opencode/taskflow.jsonc"))).toBe(true)
      expect(fs.existsSync(path.join(repo.main, ".taskflow"))).toBe(false)
    } finally { cleanup() }
  }, T)

  test("running legacy host refreshes existence-aware ship fallback without init", async () => {
    const h = await boot()
    try {
      write(h.main, ".github/pull_request_template.md", "CUSTOM AGENT")
      write(h.main, ".github/PULL_REQUEST_TEMPLATE/human-review.md", "CUSTOM HUMAN")
      await h.tools.find((t) => t.name === "tf_models").execute({}, { sessionID: "ses_parent", signal: new AbortController().signal })
      h.replay()
      await h.commands.find((c) => c.name === "tf-ship").execute({ sessionID: "ses_parent", prompt: { text: "" }, delivery: undefined })
      const prompt = h.calls.filter((c) => c.fn === "session.prompt").at(-1)!.arg.text
      expect(prompt).toContain(".github/pull_request_template.md")
      expect(prompt).toContain(".github/PULL_REQUEST_TEMPLATE/human-review.md")
      expect(fs.readFileSync(path.join(h.main, ".github/pull_request_template.md"), "utf8")).toBe("CUSTOM AGENT")
      expect(fs.readFileSync(path.join(h.main, ".github/PULL_REQUEST_TEMPLATE/human-review.md"), "utf8")).toBe("CUSTOM HUMAN")
    } finally { h.cleanup() }
  }, T)
})

function makeRepo(central = false) {
  const files = {
    ".opencode/taskflow.jsonc": CONFIG,
    "tasks/_template.md": TEMPLATE,
    "epics/E-01-core.md": epicFile("E-01"),
    "tasks/T-001-first-task.md": taskFile({ id: "T-001", title: "First task" }),
    "tasks/README.md": "",
  }
  if (!central) return repoWithOrigin(files)
  return repoWithOrigin(Object.fromEntries(Object.entries(files).map(([file, content]) => [file === ".opencode/taskflow.jsonc" ? ".taskflow/config.jsonc" : file === "tasks/_template.md" ? ".taskflow/templates/task.md" : `.taskflow/${file}`, content])))
}

/** A fake OpenCode plugin context that records transforms, hooks and session calls. */
function fakeCtx(directory: string, sessions = new Map<string, any>()) {
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
      create: spy("session.create", (arg) => {
        const id = `ses_child_${sessions.size + 1}`
        const session = { ...arg, id }
        sessions.set(id, session)
        return session
      }),
      prompt: spy("session.prompt"),
      wait: spy("session.wait"),
      context: spy("session.context", () => [
        { type: "assistant", content: [{ type: "text", text: "VERDICT: LGTM" }] },
        { type: "idle", outcome: "succeeded" },
      ]),
      get: spy("session.get", (arg) => sessions.get(arg.sessionID) ?? { id: arg.sessionID, location: { directory } }),
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
  return { ctx, agents, commands, tools, hooks, calls, replay, sessions }
}

async function boot(overrides: Record<string, unknown> = {}, central = false) {
  const repo = makeRepo(central)
  if (Object.keys(overrides).length) write(repo.main, central ? ".taskflow/config.jsonc" : ".opencode/taskflow.jsonc", JSON.stringify({ ...JSON.parse(CONFIG), ...overrides }))
  const f = fakeCtx(repo.main)
  const plugin = (await import("../src/index.ts")).default
  const cleanup: any = await plugin.setup(f.ctx)
  f.replay()
  return { ...repo, ...f, cleanup }
}

describe("plugin entry with a fake OpenCode context", () => {
  test("central task dispatch and continuation preserve worker/reviewer sources and fail closed", async () => {
    const h = await boot({}, true)
    try {
      const wt = path.join(h.dir, "central-worktree")
      sh("git", ["worktree", "add", "-q", "-b", "task/T-001-bound", wt], h.main)
      write(wt, ".taskflow/standards/index.json", JSON.stringify({ version: 1, entries: [{ id: "central", title: "Central rule", path: ".taskflow/standards/rule.md", status: "approved" }] }))
      write(wt, ".taskflow/standards/rule.md", "CURRENT CENTRAL SOURCE")
      write(wt, ".taskflow/tasks/T-001-first-task.md", taskFile({ id: "T-001" }).replace("spec: []", "spec: []\nstandards: [central]"))
      const tool = h.tools.find((t) => t.name === "tf_dispatch")
      const context = { sessionID: "ses_parent", agent: "lead", signal: new AbortController().signal }
      const implementation = await tool.execute({ role: "implementer", task: "T-001", prompt: "implement" }, context)
      const sessionID = implementation.content.match(/child session: (\S+)/)![1]
      const review = await tool.execute({ role: "reviewer", task: "T-001", prompt: "review" }, context)
      expect(implementation.content).toContain("central -> .taskflow/standards/rule.md (sha256")
      expect(review.content).toContain(implementation.content.match(/central -> .*\)/)![0])
      const prompts = h.calls.filter((c) => c.fn === "session.prompt").map((c) => c.arg.text)
      expect(prompts[0].slice(prompts[0].indexOf("Standards binding source:"), prompts[0].indexOf("\n\nimplement"))).toBe(prompts[1].slice(prompts[1].indexOf("Standards binding source:"), prompts[1].indexOf("\n\nreview")))
      expect((await tool.execute({ role: "implementer", sessionID, prompt: "continue" }, context)).content).toContain("central -> .taskflow/standards/rule.md")
      write(wt, ".taskflow/standards/index.json", '{"version":1,"entries":[]}')
      const before = h.calls.filter((c) => c.fn === "session.prompt").length
      expect((await tool.execute({ role: "implementer", sessionID, prompt: "must fail" }, context)).content).toContain("unknown standards id")
      expect(h.calls.filter((c) => c.fn === "session.prompt")).toHaveLength(before)
    } finally { h.cleanup() }
  }, T)

  test("selected centralized config mtime reloads tool settings and registrations", async () => {
    const h = await boot({}, true)
    try {
      write(h.main, ".taskflow/config.jsonc", JSON.stringify({ ...JSON.parse(CONFIG), verify: { full: "central-verify" } }))
      fs.utimesSync(path.join(h.main, ".taskflow/config.jsonc"), new Date(), new Date(Date.now() + 2000))
      const doctor = h.tools.find((t) => t.name === "tf_models")
      expect((await doctor.execute({}, { sessionID: "ses_parent", signal: new AbortController().signal })).content).toContain("full=central-verify")
      expect(h.calls.some((c) => c.fn === "command.reload")).toBe(true)
      h.replay()
      expect(h.agents.get("implementer").system).toContain("central-verify")
    } finally { h.cleanup() }
  }, T)
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

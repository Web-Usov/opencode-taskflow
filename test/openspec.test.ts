import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { defaultConfig, loadConfig } from "../src/config.ts"
import { OpenSpec } from "../src/core/openspec.ts"
import { cleanChange, recordChangePR, startChange } from "../src/core/openspec-execution.ts"
import { changeIdentity, readExecution, recordDirectory, safePath, validateExecution, writeExecution } from "../src/core/openspec-source.ts"
import { run } from "../src/core/git.ts"
import { guard, roleRules } from "../src/core/guard.ts"
import { commandSpecs } from "../src/commands.ts"
import { rolePrompt } from "../src/roles.ts"
import { dispatchChange } from "../src/openspec-dispatch.ts"
import { runOwnedChild, UnknownChildState } from "../src/core/dispatch-ownership.ts"
import { buildTools } from "../src/tools.ts"
import { repoWithOrigin, sh, tmpdir, write } from "./helpers.ts"

const CLI = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const settings=JSON.parse(fs.readFileSync(path.join(__dirname,'settings.json'),'utf8'));
const args=process.argv.slice(2),root=process.cwd(),name=args[args.indexOf('--change')+1]||'demo';
fs.appendFileSync(path.join(__dirname,'calls.jsonl'),JSON.stringify({args,root})+'\\n');
if(settings.delay) setTimeout(go,settings.delay); else go();
function go(){
 if(settings.nonzero){console.error('intentional failure');process.exit(2)}
 if(settings.bad){console.log('{broken');return}
 if(settings.huge){console.log('x'.repeat(300000));return}
 if(args[0]==='--version'){console.log(settings.version||'1.16.1');return}
 const base={root:{path:settings.root||root,source:settings.source||'nearest'}};
 const dir=path.join(root,'openspec/changes',name),task=path.join(dir,'tasks.md');
 if(args[0]==='status'){
  if(args.includes('--all')) return console.log(JSON.stringify({...base,changes:[{changeName:'demo',schemaName:'spec-driven'}]}));
  return console.log(JSON.stringify({...base,changeName:name,schemaName:settings.schema||'spec-driven',changeRoot:dir}));
 }
 if(args[0]==='validate')return console.log(JSON.stringify({...base,items:settings.empty?[]:[{id:args[1],type:'change',valid:!settings.invalid}]}));
 const text=fs.readFileSync(task,'utf8'),done=text.includes('[x]');
 console.log(JSON.stringify({...base,changeName:name,schemaName:settings.schema||'spec-driven',changeDir:settings.changeDir||dir,
 contextFiles:settings.context||{proposal:[path.join(dir,'proposal.md')],tasks:[task]},
 state:settings.state||(done?'all_done':'ready'),progress:settings.progress||{total:1,complete:done?1:0,remaining:done?0:1},
 taskTrackingConfigured:settings.noTracking?false:true,tasks:[{id:'1',description:'Implement',done,sourcePath:settings.taskPath||task,line:1}],
 instruction:'native reference guidance',missingPrerequisites:['design','specs'],...(settings.unavailable?{unavailableTrackingFiles:[{path:task,reason:'EACCES'}]}:{})}));
}
`

function fixture() {
  const repo = repoWithOrigin({ "README.md": "base" })
  sh("git", ["checkout", "-qb", "planning"], repo.main)
  for (const [rel, text] of Object.entries({ "openspec/config.yaml": "schema: spec-driven\n", "openspec/changes/demo/.openspec.yaml": "schema: spec-driven\nskip_specs: true\n", "openspec/changes/demo/tasks.md": "- [ ] Implement\n", "openspec/changes/demo/proposal.md": "# Proposal\nChange scope\n" })) write(repo.main, rel, text)
  sh("git", ["add", "-A"], repo.main); sh("git", ["commit", "-qm", "plan off main"], repo.main)
  const bin = path.join(repo.dir, "bin")
  write(bin, "openspec", CLI); fs.chmodSync(path.join(bin, "openspec"), 0o755)
  write(bin, "settings.json", "{}")
  const cfg = defaultConfig("en"); cfg.backend = "openspec"; cfg.git.baseBranch = "main"; cfg.git.worktreeDir = path.join(repo.dir, "worktrees"); cfg.openspec.executable = path.join(bin, "openspec")
  const settings = (value: object) => write(bin, "settings.json", JSON.stringify(value))
  const calls = () => fs.readFileSync(path.join(bin, "calls.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s))
  return { ...repo, cfg, settings, calls, bin, adapter: new OpenSpec(cfg), signal: new AbortController().signal }
}

async function bootPlugin(h: ReturnType<typeof fixture>, options: any = h.cfg, directory = h.main) {
  const tools: any[] = [], commands: any[] = [], agents = new Map<string, any>(), hooks = new Map<string, any>()
  const sessions = new Map<string, any>([["parent", { id: "parent", location: { directory } }]])
  const prompts: any[] = [], creates: any[] = []
  const host: any = {
    get: async ({ sessionID }: any) => sessions.get(sessionID),
    create: async (input: any) => { const child = { ...structuredClone(input), id: `child-${creates.length}` }; creates.push(child); sessions.set(child.id, child); return child },
    prompt: async (input: any) => { prompts.push(input) }, wait: async () => {}, interrupt: async () => {}, context: async () => [],
  }
  const ctx: any = { location: { directory }, options, session: host,
    agent: { transform: async (fn: any) => fn({ update: (name: string, update: any) => { const a = {}; update(a); agents.set(name, a) } }), reload: async () => {} },
    command: { transform: async (fn: any) => fn({ add: (c: any) => commands.push(c) }), reload: async () => {} },
    tool: { transform: async (fn: any) => fn({ namespace: () => {}, add: (t: any) => tools.push(t) }) },
    permission: { hook: async (name: string, fn: any) => hooks.set(name, fn) }, model: { list: async () => [] },
  }
  const cleanup: any = await (await import("../src/index.ts")).default.setup(ctx)
  const call = (name: string, input: any = {}, context: any = {}) => tools.find((t) => t.name === name).execute(input, { sessionID: "parent", agent: "lead", signal: h.signal, ...context })
  return { tools, commands, agents, hooks, sessions, prompts, creates, host, ctx, cleanup, call }
}

describe("review regressions at registered plugin boundaries", () => {
  test("nested session locations are refused before normalization, including fresh nested setup and no-config locations", async () => {
    const h = fixture(), r = await startChange(h.main, h.cfg, "demo", true, h.signal), p = await bootPlugin(h)
    const refs = sh("git", ["for-each-ref", "--format=%(refname)"], h.main)
    const trees = sh("git", ["worktree", "list", "--porcelain"], h.main)
    const cliCount = () => fs.existsSync(path.join(h.bin, "calls.jsonl")) ? h.calls().length : 0
    const check = async (host: Awaited<ReturnType<typeof bootPlugin>>, directory: string) => {
      host.sessions.set("parent", { id: "parent", location: { directory } })
      const calls = cliCount(), prompts = host.prompts.length
      for (const [tool, input] of [["tf_status", {}], ["tf_openspec", { operation: "start", change: "demo", confirm: true }], ["tf_init", {}]] as const) expect((await host.call(tool, input)).content).toMatch(/caller policy.*(root|nested|subdirectory)/)
      await expect(host.commands.find((c) => c.name === "tf-next").execute({ sessionID: "parent", prompt: { text: "demo" } })).rejects.toThrow("caller policy")
      for (const action of ["edit", "shell"]) {
        const event = { agent: "implementer", sessionID: "parent", action, resources: [action === "edit" ? "src/code.ts" : "git status"], effect: "allow", message: "" }
        await host.hooks.get("evaluate")(event); expect(event.effect).toBe("deny"); expect(event.message).toContain("caller policy")
      }
      expect(cliCount()).toBe(calls); expect(host.prompts.length).toBe(prompts); expect(host.creates).toHaveLength(0)
      expect(sh("git", ["for-each-ref", "--format=%(refname)"], h.main)).toBe(refs)
      expect(sh("git", ["worktree", "list", "--porcelain"], h.main)).toBe(trees)
    }
    try {
      for (const [index, config] of [null, "opencode.json", "opencode.jsonc", ".opencode/opencode.jsonc"].entries()) {
        const nested = path.join(r.worktree, `subproject-${index}`); fs.mkdirSync(nested)
        if (config) write(nested, config, JSON.stringify({ plugins: [{ package: "opencode-taskflow", options: { backend: "standalone", setup: { commands: ["touch MUST-NOT-RUN"] }, agents: { implementer: { name: "nested-agent" } } } }], agents: { implementer: { system: "nested policy" } } }))
        await check(p, nested)
        const fresh = await bootPlugin(h, h.cfg, nested)
        try { await check(fresh, nested); await check(fresh, r.worktree) } finally { fresh.cleanup() }
        expect(fs.existsSync(path.join(nested, "MUST-NOT-RUN"))).toBe(false)
        p.sessions.set("parent", { id: "parent", location: { directory: r.worktree } })
        expect((await p.call("tf_status")).content).toContain('"version": "1.16.1"')
      }
      // Even lexical normalization must not erase an intermediate host-policy directory.
      const noncanonical = `${r.worktree}/subproject-0/..`
      await check(p, noncanonical)
      const fresh = await bootPlugin(h, h.cfg, noncanonical)
      try { await check(fresh, r.worktree) } finally { fresh.cleanup() }
    } finally { p.cleanup() }
  })

  for (const backend of ["openspec", "standalone"] as const) test(`${backend}: old role sessions cannot lose parsed hard guards across live rename, collision or reassignment`, async () => {
    const h = fixture(); h.cfg.backend = backend; h.cfg.protected = ["policy/**"]
    write(h.main, ".taskflow/config.jsonc", JSON.stringify(h.cfg)); sh("git", ["add", "-A"], h.main); sh("git", ["commit", "-qm", "role policy"], h.main)
    const p = await bootPlugin(h, null)
    p.sessions.set("old-session", { id: "old-session", agent: "implementer", location: { directory: h.main } })
    const shell = ["git -c foo=bar push origin HEAD:main", "env X=1 bash -c 'git -c foo=bar push origin HEAD:main'", "command git -c foo=bar push --force origin HEAD"]
    const files = [".taskflow/config.jsonc", "policy/human.md", ...(backend === "openspec" ? [".git", "opencode.jsonc"] : [])]
    const event = async (agent: string, sessionID: string, action: string, resource: string) => {
      const e = { agent, sessionID, action, resources: [resource], effect: "allow", message: "" }
      await p.hooks.get("evaluate")(e); return e
    }
    try {
      for (const command of shell) expect((await event("implementer", "old-session", "shell", command)).effect).toBe("deny")
      for (const [index, delta] of [
        { implementer: { ...h.cfg.agents.implementer, name: "renamed-implementer" } },
        { implementer: { ...h.cfg.agents.implementer, name: "reviewer" } },
        { implementer: { ...h.cfg.agents.implementer, name: "renamed-implementer" }, planner: { ...h.cfg.agents.planner, name: "implementer" } },
      ].entries()) {
        write(h.main, ".taskflow/config.jsonc", JSON.stringify({ ...h.cfg, agents: { ...h.cfg.agents, ...delta } }))
        fs.utimesSync(path.join(h.main, ".taskflow/config.jsonc"), new Date(), new Date(Date.now() + (index + 1) * 2000))
        for (const command of shell) { const e = await event("implementer", "old-session", "shell", command); expect(e.effect).toBe("deny"); expect(e.message).toContain("agent identity") }
        for (const file of files) for (const resource of [file, path.join(h.main, file)]) expect((await event("implementer", "old-session", "edit", resource)).effect).toBe("deny")
        expect((await event("implementer", "old-session", "edit", "src/ordinary.ts")).effect).toBe("deny")
        if (index === 1) { const e = await event("reviewer", "parent", "edit", "src/ordinary.ts"); expect(e.effect).toBe("deny"); expect(e.message).toContain("agent identity") }
        // Other still-valid current roles retain their parser-backed protections.
        expect((await event("qa", "parent", "shell", shell[0]!)).effect).toBe("deny")
      }
      const fresh = await bootPlugin(h, null)
      try {
        // A reloaded host must not reinterpret an existing plugin child as the newly assigned planner role either.
        fresh.sessions.set("bound-old", { id: "bound-old", agent: "implementer", location: { directory: h.main }, metadata: { [backend === "openspec" ? "taskflowOpenSpecDispatch" : "taskflowDispatch"]: { role: "implementer", agent: "implementer" } } })
        const stale = { agent: "implementer", sessionID: "bound-old", action: "edit", resources: [".taskflow/config.jsonc"], effect: "allow", message: "" }
        await fresh.hooks.get("evaluate")(stale); expect(stale.effect).toBe("deny"); expect(stale.message).toContain("agent identity")
        const e = { agent: "renamed-implementer", sessionID: "parent", action: "shell", resources: [shell[0]!], effect: "allow" }
        await fresh.hooks.get("evaluate")(e); expect(e.effect).toBe("deny")
        const edit = { ...e, action: "edit", resources: ["src/ordinary.ts"], effect: "allow" }
        await fresh.hooks.get("evaluate")(edit); expect(edit.effect).toBe("allow")
      } finally { fresh.cleanup() }
    } finally { p.cleanup() }
  })

  for (const layer of ["global", "project", "options"] as const) for (const kind of ["parse", "validation"] as const) test(`sanitized ${kind} diagnostics for ${layer} omit synthetic values at every registered boundary`, async () => {
    const h = fixture(), marker = "SYNTHETIC_SECRET_MUST_NOT_ECHO"
    const previousXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = path.join(h.dir, "isolated-config")
    let p: Awaited<ReturnType<typeof bootPlugin>> | undefined
    try {
      const base = { backend: "openspec", openspec: h.cfg.openspec, git: h.cfg.git, language: h.cfg.language }
      write(h.main, ".taskflow/config.jsonc", JSON.stringify(base))
      const bad = kind === "parse" ? `{"secret": ${marker}}` : JSON.stringify({ parallel: marker })
      if (layer === "global") write(process.env.XDG_CONFIG_HOME, "opencode/taskflow.jsonc", bad)
      if (layer === "project") write(h.main, ".taskflow/config.jsonc", kind === "parse" ? bad : JSON.stringify({ ...base, parallel: marker }))
      const options = layer === "options" ? kind === "parse" ? bad : { parallel: marker } : null
      p = await bootPlugin(h, options)
      const visible: string[] = []
      for (const tool of ["tf_status", "tf_models", "tf_openspec"]) visible.push((await p.call(tool, tool === "tf_openspec" ? { operation: "status" } : {})).content)
      try { await p.commands.find((c) => c.name === "tf-next").execute({ sessionID: "parent", prompt: { text: "demo" } }) } catch (error) { visible.push(String(error)) }
      for (const action of ["edit", "shell"]) {
        const e = { agent: "implementer", sessionID: "parent", action, resources: [action === "edit" ? "src/code.ts" : "git status"], effect: "allow", message: "" }
        await p.hooks.get("evaluate")(e); expect(e.effect).toBe("deny"); visible.push(e.message)
      }
      for (const text of visible) { expect(text).toContain("caller policy"); expect(text).not.toContain(marker); expect(text).toMatch(/parse|read|validation/) }
      expect(visible[0]).toContain(layer === "options" ? "options" : layer === "global" ? "taskflow.jsonc" : "config.jsonc")
      const sources = JSON.stringify(loadConfig(h.main, options).sources)
      expect(sources).not.toContain(marker); expect(sources).toMatch(/parse|read|validation/)
      if (layer === "project" && kind === "parse") {
        let diagnostic = ""
        try { changeIdentity(h.main, "demo", "spec-driven", "openspec/changes/demo/tasks.md") } catch (error) { diagnostic = String(error) }
        expect(diagnostic).toContain("config.jsonc"); expect(diagnostic).not.toContain(marker)
      }
      expect(p.prompts).toHaveLength(0); expect(p.creates).toHaveLength(0)
      expect(fs.existsSync(path.join(h.bin, "calls.jsonl"))).toBe(false)
    } finally { p?.cleanup(); if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg }
  })

  test("mandatory exact Git/config/instruction entries are protected in a real linked worktree, relative and absolute", async () => {
    const h = fixture(); h.cfg.protected = []
    const r = await startChange(h.main, h.cfg, "demo", true, h.signal), p = await bootPlugin(h)
    p.sessions.set("parent", { id: "parent", location: { directory: r.worktree } })
    expect(fs.statSync(path.join(r.worktree, ".git")).isFile()).toBe(true)
    const rules = roleRules(h.cfg, "implementer", { base: "main", mainDir: h.main, worktreeParent: h.cfg.git.worktreeDir })
    const staticDenied = (file: string) => { let denied = false; for (const rule of rules) if (rule.action === "edit" && new RegExp("^" + rule.resource.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(file)) denied = rule.effect === "deny"; return denied }
    try {
      for (const relative of [".git", "opencode.json", "opencode.jsonc", "AGENTS.md", "CLAUDE.md", ".opencode/opencode.jsonc", "openspec/config.yaml", "openspec/changes/demo/.openspec.yaml"]) {
        for (const resource of [relative, path.join(r.worktree, relative)]) {
          expect(staticDenied(resource)).toBe(true)
          const event = { agent: "implementer", sessionID: "parent", action: "edit", resources: [resource], effect: "allow" }
          await p.hooks.get("evaluate")(event)
          expect(event.effect).toBe("deny")
        }
      }
      for (const resource of ["src/implementation.ts", "openspec/changes/demo/tasks.md", path.join(r.worktree, "openspec/changes/demo/tasks.md")]) {
        expect(staticDenied(resource)).toBe(false)
        const event = { agent: "implementer", sessionID: "parent", action: "edit", resources: [resource], effect: "allow" }
        await p.hooks.get("evaluate")(event); expect(event.effect).toBe("allow")
      }
    } finally { p.cleanup() }
  })

  for (const failure of ["wait", "interrupt", "second-wait", "missing-wait", "bad-wait", "undefined-error", "prompt", "abort"] as const) test(`uncertain ${failure} retains dispatch ownership and active count until terminal confirmation`, async () => {
    const h = fixture(); h.cfg.parallel = 1
    await startChange(h.main, h.cfg, "demo", true, h.signal)
    const p = await bootPlugin(h), controller = new AbortController()
    let active = false, interrupts = 0, waits = 0
    p.host.prompt = async () => { active = true; if (failure === "prompt") throw new Error("prompt transport uncertainty"); if (failure === "abort") controller.abort() }
    p.host.wait = failure === "missing-wait" ? undefined : async () => { waits++; if (failure === "bad-wait") return null; if (failure === "undefined-error") throw undefined; throw new Error(waits === 1 ? "wait transport failure" : "stop wait failed") }
    p.host.interrupt = async () => { interrupts++; if (failure === "interrupt") throw new Error("interrupt unavailable") }
    try {
      const result = await p.call("tf_dispatch", { role: "implementer", change: "demo", prompt: "work" }, { signal: controller.signal })
      expect(result.content).toContain("ownership retained")
      expect(active).toBe(true); expect(interrupts).toBeGreaterThan(0)
      const lease = path.join(recordDirectory(h.main), "demo.dispatch.lock")
      expect(fs.existsSync(lease)).toBe(true)
      expect(JSON.parse(fs.readFileSync(lease, "utf8")).sessionID).toBe(p.creates[0].id)
      expect((await p.call("tf_status")).content).toContain('"state": "unknown"')
      expect((await p.call("tf_dispatch", { role: "reviewer", change: "demo", prompt: "must not overlap" })).content).toContain("locked")
      expect((await p.call("tf_dispatch", { role: "implementer", change: "demo", prompt: "still active" })).content).toContain("already running")
      await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("locked")
      expect(p.creates).toHaveLength(1)
      if (failure === "wait") {
        const reloaded = await bootPlugin(h)
        try {
          expect((await reloaded.call("tf_dispatch", { role: "reviewer", change: "demo", prompt: "reload must not bypass lease" })).content).toContain("locked")
          expect((await reloaded.call("tf_dispatch", { role: "implementer", change: "other", prompt: "reload must not undercount old child" })).content).toContain("already running")
        } finally { reloaded.cleanup() }
      }
    } finally { p.cleanup() }
  })

  test("accepted prompt then wait rejection interrupts and CONFIRMS idle before releasing ownership", async () => {
    const h = fixture(); await startChange(h.main, h.cfg, "demo", true, h.signal)
    const p = await bootPlugin(h); let active = false, waits = 0, interrupts = 0
    p.host.prompt = async () => { active = true }
    p.host.wait = async () => { if (++waits === 1) throw new Error("temporary wait failure"); expect(interrupts).toBe(1); active = false }
    p.host.interrupt = async () => { interrupts++ }
    try {
      const result = await p.call("tf_dispatch", { role: "implementer", change: "demo", prompt: "work" })
      expect(result.content).toContain("stop confirmed")
      expect(waits).toBe(2); expect(active).toBe(false)
      expect(fs.existsSync(path.join(recordDirectory(h.main), "demo.dispatch.lock"))).toBe(false)
      p.host.wait = async () => { active = false }
      expect((await p.call("tf_dispatch", { role: "reviewer", change: "demo", prompt: "safe now" })).content).toContain("child session")
    } finally { p.cleanup() }
  })

  test("prompt transport failure can recover only through stop confirmation; pending acceptance remains owned", async () => {
    const h = fixture(); await startChange(h.main, h.cfg, "demo", true, h.signal)
    const p = await bootPlugin(h); let interrupts = 0, waits = 0
    p.host.prompt = async () => { throw new Error("prompt may have been accepted") }
    p.host.interrupt = async () => { interrupts++ }
    p.host.wait = async () => { waits++ }
    try {
      expect((await p.call("tf_dispatch", { role: "implementer", change: "demo", prompt: "work" })).content).toContain("stop confirmed")
      expect(interrupts).toBe(1); expect(waits).toBe(1)
      expect(fs.existsSync(path.join(recordDirectory(h.main), "demo.dispatch.lock"))).toBe(false)
      const abort = new AbortController()
      p.host.prompt = () => new Promise(() => { abort.abort() })
      expect((await p.call("tf_dispatch", { role: "implementer", change: "demo", prompt: "uncertain pending prompt" }, { signal: abort.signal })).content).toContain("prompt acceptance remains unresolved")
      expect(fs.existsSync(path.join(recordDirectory(h.main), "demo.dispatch.lock"))).toBe(true)
      await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("locked")
    } finally { p.cleanup() }
  })

  test("execution timeout stops and confirms; hanging stop RPC has a bounded unknown outcome", async () => {
    let waits = 0, interrupts = 0
    const host = { prompt: async () => {}, interrupt: async () => { interrupts++ }, wait: async () => { if (++waits === 1) await new Promise(() => {}) } }
    await expect(runOwnedChild(host, "bounded-child", "work", new AbortController().signal, 10, 50)).rejects.toThrow("timed out; stop confirmed")
    expect(waits).toBe(2); expect(interrupts).toBe(1)
    const started = Date.now()
    await expect(runOwnedChild({ prompt: async () => {}, interrupt: () => new Promise(() => {}), wait: async () => { throw new Error("transport failed") } }, "unknown-child", "work", new AbortController().signal, 100, 20)).rejects.toBeInstanceOf(UnknownChildState)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("moved same-repository callers cannot use stale backend/executable/verify/setup/config through tools, commands or permissions", async () => {
    const h = fixture()
    write(h.main, ".taskflow/config.jsonc", JSON.stringify(h.cfg))
    sh("git", ["add", "-A"], h.main); sh("git", ["commit", "-qm", "execution policy"], h.main)
    const p = await bootPlugin(h, null), other = path.join(h.dir, "moved")
    sh("git", ["worktree", "add", "-qb", "moved", other, "HEAD"], h.main)
    p.sessions.set("parent", { id: "parent", location: { directory: other } })
    try {
      // Identical effective policy remains usable without a forced location change.
      expect((await p.call("tf_status")).content).toContain('"version": "1.16.1"')
      for (const config of [{ backend: "standalone" }, { backend: "openspec", verify: { full: "other-verify" } }, { backend: "openspec", setup: { commands: ["touch MUST-NOT-RUN"] } }, { backend: "openspec", openspec: { executable: "/missing/other-openspec" } }, "{malformed"]) {
        write(other, ".taskflow/config.jsonc", typeof config === "string" ? config : JSON.stringify({ ...h.cfg, ...config }))
        const before = h.calls().length, prompts = p.prompts.length
        for (const [tool, input] of [["tf_board", {}], ["tf_init", {}], ["tf_openspec", { operation: "start", change: "demo", confirm: true }], ["tf_dispatch", { role: "implementer", change: "demo", prompt: "forbidden" }]] as const) expect((await p.call(tool, input)).content).toContain("caller policy")
        await expect(p.commands.find((c) => c.name === "tf-next").execute({ sessionID: "parent", prompt: { text: "demo" } })).rejects.toThrow("caller policy")
        const event = { agent: "implementer", sessionID: "parent", action: "edit", resources: ["src/implementation.ts"], effect: "allow", message: "" }
        await p.hooks.get("evaluate")(event); expect(event.effect).toBe("deny"); expect(event.message).toContain("caller policy")
        expect(h.calls().length).toBe(before); expect(p.prompts.length).toBe(prompts); expect(p.creates).toHaveLength(0)
        expect(fs.existsSync(path.join(other, "MUST-NOT-RUN"))).toBe(false)
        expect(fs.existsSync(recordDirectory(h.main))).toBe(false)
      }
      write(other, ".taskflow/config.jsonc", JSON.stringify(h.cfg))
      write(other, "opencode.jsonc", '{"plugins":[{"package":"opencode-taskflow","options":{"backend":"standalone"}}]}')
      expect((await p.call("tf_init")).content).toContain("caller policy")
      fs.unlinkSync(path.join(other, "opencode.jsonc"))
      expect((await p.call("tf_status")).content).toContain('"version": "1.16.1"')
      p.host.get = async () => undefined
      expect((await p.call("tf_init")).content).toContain("caller policy unavailable")
    } finally { p.cleanup() }
  })

  test("standalone-to-native movement refuses direct legacy claim/writes; reload uses the caller's native lifecycle policy", async () => {
    const h = fixture(); h.cfg.backend = "standalone"
    write(h.main, ".taskflow/config.jsonc", JSON.stringify(h.cfg)); sh("git", ["add", "-A"], h.main); sh("git", ["commit", "-qm", "standalone source policy"], h.main)
    const other = path.join(h.dir, "native-caller")
    sh("git", ["worktree", "add", "-qb", "native-caller", other, "HEAD"], h.main)
    write(other, ".taskflow/config.jsonc", JSON.stringify({ ...h.cfg, backend: "openspec" }))
    sh("git", ["add", "-A"], other); sh("git", ["commit", "-qm", "opt into native execution"], other)
    const original = await bootPlugin(h, null)
    original.sessions.set("parent", { id: "parent", location: { directory: other } })
    try {
      expect((await original.call("tf_board")).content).toContain("caller policy")
      await expect(original.commands.find((c) => c.name === "tf-next").execute({ sessionID: "parent", prompt: { text: "T-001" } })).rejects.toThrow("caller policy")
      expect(fs.existsSync(path.join(other, ".taskflow/tasks"))).toBe(false)
      const reloaded = await bootPlugin(h, null, other)
      try {
        expect((await reloaded.call("tf_openspec", { operation: "start", change: "demo", confirm: true })).content).toContain('"phase": "claimed"')
        expect(reloaded.agents.get("implementer").system).toContain("execution extension")
        write(other, ".taskflow/config.jsonc", "{malformed")
      } finally { reloaded.cleanup() }
      const invalidReload = await bootPlugin(h, null, other)
      try { expect((await invalidReload.call("tf_init")).content).toContain("caller policy"); expect(invalidReload.prompts).toHaveLength(0); expect(fs.existsSync(path.join(other, ".taskflow/tasks"))).toBe(false) } finally { invalidReload.cleanup() }
    } finally { original.cleanup() }
  })

  test("reloaded policy changes cannot rebind an existing change child; explicit setup options retain highest precedence", async () => {
    const h = fixture()
    write(h.main, ".taskflow/config.jsonc", JSON.stringify(h.cfg)); sh("git", ["add", "-A"], h.main); sh("git", ["commit", "-qm", "execution policy"], h.main)
    const p = await bootPlugin(h, null)
    let sessionID: string
    try {
      expect((await p.call("tf_openspec", { operation: "start", change: "demo", confirm: true })).content).toContain('"phase": "claimed"')
      const dispatched = await p.call("tf_dispatch", { role: "implementer", change: "demo", prompt: "initial work" })
      sessionID = dispatched.content.match(/child session: (\S+)/)[1]
    } finally { p.cleanup() }
    write(h.main, ".taskflow/config.jsonc", JSON.stringify({ ...h.cfg, verify: { ...h.cfg.verify, full: "new-verify" } }))
    const reload = await bootPlugin(h, null)
    reload.sessions.set(sessionID!, p.sessions.get(sessionID!))
    try {
      const before = h.calls().length
      const result = await reload.call("tf_dispatch", { role: "implementer", sessionID: sessionID!, prompt: "must not silently rebind" })
      expect(result.content).toMatch(/caller policy|configuration changed/)
      expect(reload.prompts).toHaveLength(0); expect(h.calls().length).toBe(before)
    } finally { reload.cleanup() }
    const override = await bootPlugin(h) // Explicit ctx.options is intentionally higher precedence than project config.
    try { expect((await override.call("tf_models")).content).toContain('"full": null') } finally { override.cleanup() }
  })
})

describe("OpenSpec read-only adapter", () => {
  test("exact named machine commands, bounded reads, readiness independent of missing planning prerequisites, no mutation", async () => {
    const h = fixture()
    const before = sh("git", ["status", "--porcelain"], h.main)
    const c = await h.adapter.inspect(h.main, "demo", h.signal)
    expect(c.state).toBe("ready"); expect(c.missingPrerequisites).toEqual(["design", "specs"])
    expect(c.references).toHaveLength(2)
    expect(h.calls().map((c) => c.args)).toEqual([["--version"], ["status", "--change", "demo", "--json"], ["instructions", "apply", "--change", "demo", "--json"], ["validate", "demo", "--type", "change", "--json", "--no-interactive"]])
    expect(sh("git", ["status", "--porcelain"], h.main)).toBe(before)
    expect(fs.existsSync(path.join(h.main, ".taskflow"))).toBe(false)
  })
  test("missing CLI, unsupported version, malformed/nonzero/oversized and abort fail closed", async () => {
    const h = fixture()
    for (const settings of [{ version: "1.15.0" }, { bad: true }, { nonzero: true }, { huge: true }]) {
      h.settings(settings)
      await expect(h.adapter.inspect(h.main, "demo", h.signal)).rejects.toThrow()
    }
    h.settings({})
    await expect(new OpenSpec({ ...h.cfg, openspec: { executable: path.join(h.dir, "missing") } }).inspect(h.main, "demo")).rejects.toThrow("unavailable")
    const controller = new AbortController(); controller.abort()
    await expect(h.adapter.inspect(h.main, "demo", controller.signal)).rejects.toThrow("aborted")
    const result = await run("node", ["-e", "setTimeout(()=>{},10000)"], h.main, { timeout: 20, maxOutputBytes: 100 })
    expect(result.ok).toBe(false); expect(result.stderr).toContain("timed out")
    h.settings({ delay: 10_000 })
    const aborted = new AbortController(), pending = h.adapter.inspect(h.main, "demo", aborted.signal)
    setTimeout(() => aborted.abort(), 100)
    await expect(pending).rejects.toThrow("aborted")
    const huge = await run("node", ["-e", "process.stdout.write('x'.repeat(10000))"], h.main, { maxOutputBytes: 32, timeout: 1000 })
    expect(huge.ok).toBe(false); expect(huge.stdout).toBe(""); expect(huge.stderr).toContain("output budget")
  })
  test("rejects drift, partial tracking, unknown/custom/no-tracking schema and empty/invalid validation", async () => {
    const h = fixture()
    for (const settings of [{ root: h.dir }, { source: "implicit" }, { source: "global_default" }, { unavailable: true }, { schema: "custom" }, { noTracking: true }, { invalid: true }, { empty: true }, { changeDir: h.main }, { taskPath: "/outside/tasks.md" }, { context: { tasks: "not-array" } }, { progress: { total: 1, complete: 1, remaining: 1 } }]) {
      h.settings(settings)
      await expect(h.adapter.inspect(h.main, "demo", h.signal)).rejects.toThrow()
    }
    h.settings({}); write(h.main, "openspec/schemas/spec-driven/schema.yaml", "shadow")
    await expect(h.adapter.inspect(h.main, "demo")).rejects.toThrow("shadowed")
  })
  test("confinement: traversal, secret/hidden/dependency/ignored, untracked, symlink and unreadable context", async () => {
    const h = fixture()
    for (const name of ["../demo", "archive", "/demo", "demo/../other"]) await expect(h.adapter.inspect(h.main, name)).rejects.toThrow()
    for (const rel of ["../outside.md", ".hidden.md", "node_modules/x.md", "credentials.md"]) {
      const file = path.join(h.main, "openspec/changes/demo", rel)
      h.settings({ context: { tasks: [file] } })
      await expect(h.adapter.inspect(h.main, "demo")).rejects.toThrow()
    }
    h.settings({})
    const task = path.join(h.main, "openspec/changes/demo/tasks.md")
    fs.chmodSync(task, 0)
    await expect(h.adapter.inspect(h.main, "demo")).rejects.toThrow("unreadable")
    fs.chmodSync(task, 0o644)
    write(h.main, ".gitignore", "tasks.md\n")
    await expect(h.adapter.inspect(h.main, "demo")).rejects.toThrow("ignored")
    fs.unlinkSync(path.join(h.main, ".gitignore"))
    fs.renameSync(task, task + ".old"); fs.symlinkSync(task + ".old", task)
    await expect(h.adapter.inspect(h.main, "demo")).rejects.toThrow("symlink")
  })
})

describe("OpenSpec execution lifecycle with real git", () => {
  test("explicit intent, committed calling HEAD not main, no duplicate claim or planning mutation", async () => {
    const h = fixture()
    await expect(startChange(h.main, h.cfg, "demo", false, h.signal)).rejects.toThrow("explicit")
    write(h.main, "untracked-user", "preserve")
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("dirty/untracked")
    fs.unlinkSync(path.join(h.main, "untracked-user"))
    const source = sh("git", ["rev-parse", "HEAD"], h.main)
    expect(sh("git", ["ls-tree", "--name-only", "main", "openspec/"], h.main)).toBe("")
    const r = await startChange(h.main, h.cfg, "demo", true, h.signal)
    expect(r.sourceCommit).toBe(source)
    expect(sh("git", ["rev-parse", "HEAD"], r.worktree)).toBe(source)
    expect(sh("git", ["status", "--porcelain"], h.main)).toBe("")
    expect(sh("git", ["status", "--porcelain"], r.worktree)).toBe("")
    expect(validateExecution(h.main, "demo")).toEqual(r)
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("already")
    expect(fs.existsSync(path.join(r.worktree, ".taskflow"))).toBe(false)
  })
  test("collisions and failed/cancelled setup preserve all user content and commits", async () => {
    const h = fixture()
    sh("git", ["branch", "openspec/demo"], h.main)
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("collision")
    sh("git", ["branch", "-D", "openspec/demo"], h.main)
    h.cfg.setup.commands = ["printf user-work > untracked-user; exit 1"]
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("preserved")
    const r = readExecution(h.main, "demo")
    expect(r.phase).toBe("setup_failed")
    expect(fs.readFileSync(path.join(r.worktree, "untracked-user"), "utf8")).toBe("user-work")
    expect(sh("git", ["branch", "--show-current"], r.worktree)).toBe("openspec/demo")
    await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("no verified")
  })
  test("abort during configured setup preserves newly created ignored/untracked work", async () => {
    const h = fixture(), controller = new AbortController()
    h.cfg.setup.commands = ["printf keep > cancelled-user; sleep 20"]
    fs.mkdirSync(h.cfg.git.worktreeDir, { recursive: true })
    const watcher = fs.watch(h.cfg.git.worktreeDir, { recursive: true }, (_event, name) => { if (String(name).endsWith("cancelled-user")) controller.abort() })
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      await expect(startChange(h.main, h.cfg, "demo", true, controller.signal)).rejects.toThrow("preserved")
      const record = readExecution(h.main, "demo")
      expect(record.phase).toBe("setup_failed")
      expect(fs.existsSync(path.join(record.worktree, "cancelled-user"))).toBe(true)
      expect(fs.existsSync(record.worktree)).toBe(true)
    } finally { watcher.close(); clearTimeout(timeout) }
  })
  test("record confinement and schema/config/source substitution fail closed; checklist refresh is allowed", async () => {
    const h = fixture(); const r = await startChange(h.main, h.cfg, "demo", true, h.signal)
    write(r.worktree, "openspec/changes/demo/tasks.md", "- [x] Implement\n")
    expect(validateExecution(h.main, "demo").change).toBe("demo")
    write(r.worktree, "openspec/changes/demo/proposal.md", "unauthorized planning drift")
    expect(() => validateExecution(h.main, "demo")).toThrow("identity changed")
    write(r.worktree, "openspec/changes/demo/proposal.md", "# Proposal\nChange scope\n")
    write(r.worktree, "openspec/config.yml", "schema: custom\n")
    expect(() => validateExecution(h.main, "demo")).toThrow("identity changed")
    fs.unlinkSync(path.join(r.worktree, "openspec/config.yml"))
    const record = path.join(recordDirectory(h.main), "demo.json")
    fs.renameSync(record, record + ".old"); fs.symlinkSync(record + ".old", record)
    expect(() => readExecution(h.main, "demo")).toThrow("unsafe")
    expect(() => safePath(h.main, "openspec/../README.md")).toThrow("unsafe")
  })
  test("preflight rejects hidden-index/config ambiguity; exclusive atomic records never replace an existing association", async () => {
    const h = fixture()
    sh("git", ["update-index", "--skip-worktree", "README.md"], h.main)
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("skip-worktree")
    sh("git", ["update-index", "--no-skip-worktree", "README.md"], h.main)
    write(h.main, ".gitignore", ".taskflow/\n")
    sh("git", ["add", ".gitignore"], h.main); sh("git", ["commit", "-qm", "ignore local config"], h.main)
    write(h.main, ".taskflow/config.jsonc", '{"backend":"openspec"}')
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("not committed")
    fs.unlinkSync(path.join(h.main, ".taskflow/config.jsonc"))
    const dir = recordDirectory(h.main); fs.mkdirSync(dir, { recursive: true }); write(dir, "demo.lock", "other operation")
    await expect(startChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("locked")
    fs.unlinkSync(path.join(dir, "demo.lock"))
    const r = await startChange(h.main, h.cfg, "demo", true, h.signal)
    expect(() => writeExecution(h.main, r, true)).toThrow()
    expect(readExecution(h.main, "demo")).toEqual(r)
    const stale = readExecution(h.main, "demo"), current = readExecution(h.main, "demo")
    current.phase = "review"; writeExecution(h.main, current)
    stale.phase = "setup_failed"
    expect(() => writeExecution(h.main, stale)).toThrow("changed since read")
    expect(readExecution(h.main, "demo").phase).toBe("review")
    const task = path.join(r.worktree, r.identity.tracking)
    fs.renameSync(task, task + ".old"); fs.symlinkSync(task + ".old", task)
    expect(() => validateExecution(h.main, "demo")).toThrow("symlink")
  })
  test("guard permits only associated actual tracked checklist, not arbitrary task-shaped files or native planning", async () => {
    const h = fixture(); const r = await startChange(h.main, h.cfg, "demo", true, h.signal)
    const ctx = { base: "main", roots: [h.main, r.worktree], executionRoot: r.worktree }
    const edit = (file: string) => guard(h.cfg, { agent: "implementer", action: "edit", resources: [file] }, ctx)
    expect(edit("openspec/changes/demo/tasks.md")).toBeNull()
    for (const file of ["openspec/changes/other/tasks.md", "openspec/changes/demo/design.md", "openspec/specs/cap/spec.md", "openspec/config.yml", "openspec/schemas/custom/schema.yaml", ".taskflow/config.jsonc", "openspec/changes/demo/.openspec.yaml"]) expect(edit(file)).toContain("protected")
    expect(guard(h.cfg, { agent: "implementer", action: "edit", resources: ["openspec/changes/demo/tasks.md"] }, { ...ctx, executionRoot: h.main })).toContain("protected")
  })
  test("verified PR association and merged-only cleanup refuse dirty/untracked/extra/unpushed work and preserve native sources", async () => {
    const h = fixture(), r = await startChange(h.main, h.cfg, "demo", true, h.signal)
    write(r.worktree, "openspec/changes/demo/tasks.md", "- [x] Implement\n")
    sh("git", ["add", "-A"], r.worktree); sh("git", ["commit", "-qm", "implementation"], r.worktree)
    const head = sh("git", ["rev-parse", "HEAD"], r.worktree)
    let state = "OPEN", invalid = false
    const url = "https://github.com/example/app/pull/1"
    const gh = async (cmd: string, args: string[]) => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify(args[0] === "repo" ? { url: "https://github.com/example/app" } : { url, state, headRefName: invalid ? "other" : r.branch, headRefOid: head, baseRefName: "main", isCrossRepository: false }) })
    invalid = true
    await expect(recordChangePR(h.main, h.cfg, "demo", url, h.signal, gh)).rejects.toThrow("associated")
    invalid = false
    const associated = await recordChangePR(h.main, h.cfg, "demo", url, h.signal, gh)
    expect(associated.pr).toBe(url)
    await expect(cleanChange(h.main, h.cfg, "demo", false, h.signal, gh)).rejects.toThrow("explicit")
    await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal, gh)).rejects.toThrow("MERGED")
    state = "MERGED"
    write(r.worktree, "user-work", "keep")
    await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal, gh)).rejects.toThrow("lose")
    expect(fs.existsSync(r.worktree)).toBe(true)
    sh("git", ["add", "-A"], r.worktree); sh("git", ["commit", "-qm", "extra unpushed work"], r.worktree)
    await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal, gh)).rejects.toThrow("extra/unpushed")
    // A separate execution proves success without discarding the intentionally preserved extra commit above.
    const k = fixture(), clean = await startChange(k.main, k.cfg, "demo", true, k.signal)
    write(clean.worktree, "openspec/changes/demo/tasks.md", "- [x] Implement\n")
    sh("git", ["add", "-A"], clean.worktree); sh("git", ["commit", "-qm", "implementation"], clean.worktree)
    const cleanHead = sh("git", ["rev-parse", "HEAD"], clean.worktree)
    const merged = async (_cmd: string, args: string[]) => ({ ok: true, code: 0, stderr: "", stdout: JSON.stringify(args[0] === "repo" ? { url: "https://github.com/example/app" } : { url, state: "MERGED", headRefName: clean.branch, headRefOid: cleanHead, baseRefName: "main", isCrossRepository: false }) })
    await recordChangePR(k.main, k.cfg, "demo", url, k.signal, merged)
    write(k.main, ".git/info/exclude", "generated\n")
    write(clean.worktree, "generated/user.md", "ignored user work")
    await expect(cleanChange(k.main, k.cfg, "demo", true, k.signal, merged)).rejects.toThrow("ignored")
    expect(fs.readFileSync(path.join(clean.worktree, "generated/user.md"), "utf8")).toBe("ignored user work")
    fs.unlinkSync(path.join(clean.worktree, "generated/user.md")); fs.rmdirSync(path.join(clean.worktree, "generated"))
    await expect(cleanChange(k.main, k.cfg, "demo", true, k.signal, async () => ({ ok: false, code: 1, stdout: "", stderr: "unknown PR" }))).rejects.toThrow("unknown PR")
    expect((await cleanChange(k.main, k.cfg, "demo", true, k.signal, merged)).phase).toBe("cleaned")
    expect(fs.existsSync(clean.worktree)).toBe(false)
    expect(fs.existsSync(path.join(k.main, "openspec/changes/demo/tasks.md"))).toBe(true)
    expect(sh("git", ["branch", "--list", clean.branch], k.main)).toBe("")
  })
})

describe("change dispatch durable binding and host tools", () => {
  function fakeHost() {
    const sessions = new Map<string, any>(), prompts: any[] = [], creates: any[] = []
    return { sessions, prompts, creates, host: {
      get: async ({ sessionID }: any) => sessions.get(sessionID),
      create: async (input: any) => { const session = { id: `child_${sessions.size}`, ...structuredClone(input) }; sessions.set(session.id, session); creates.push(input); return session },
      prompt: async (input: any) => { prompts.push(input) }, wait: async () => {}, interrupt: async () => {},
      context: async () => [{ type: "assistant", content: [{ type: "text", text: "VERDICT: LGTM" }] }],
    } }
  }
  test("both roles share refs/hashes/source while reviewer cwd main; reload/omitted change refresh and contradictions denied", async () => {
    const h = fixture(), f = fakeHost(); const r = await startChange(h.main, h.cfg, "demo", true, h.signal)
    const input = { role: "implementer" as const, change: "demo", prompt: "implement", parentSessionID: "parent", signal: h.signal }
    const implementer = await dispatchChange(f.host, h.main, h.main, h.cfg, input, null)
    const reviewer = await dispatchChange(f.host, h.main, h.main, h.cfg, { ...input, role: "reviewer" }, null)
    expect(implementer.references).toEqual(reviewer.references)
    expect(implementer.directory).toBe(r.worktree); expect(reviewer.directory).toBe(h.main)
    expect(f.prompts[0].text.split("OpenSpec reference data")[1]).toBe(f.prompts[1].text.split("OpenSpec reference data")[1])
    // No in-memory cache exists: a new host object with JSON round-tripped sessions behaves like reload.
    const host = { ...f.host, get: async ({ sessionID }: any) => JSON.parse(JSON.stringify(f.sessions.get(sessionID))) }
    write(r.worktree, "openspec/changes/demo/tasks.md", "- [x] Implement\n")
    const continued = await dispatchChange(host, h.main, h.main, h.cfg, { ...input, change: undefined, sessionID: implementer.sessionID }, null)
    expect(continued.references).not.toEqual(implementer.references)
    const before = f.prompts.length
    const changed = structuredClone(h.cfg); changed.verify.full = "different-verify"
    await expect(dispatchChange(host, h.main, h.main, changed, { ...input, sessionID: implementer.sessionID }, null)).rejects.toThrow("configuration changed")
    for (const delta of [{ change: "other" }, { role: "reviewer" }, { directory: h.main }, { parentSessionID: "other" }, { task: "T-001" }]) await expect(dispatchChange(host, h.main, h.main, h.cfg, { ...input, sessionID: implementer.sessionID, ...delta } as any, null)).rejects.toThrow()
    expect(f.prompts.length).toBe(before)
    write(r.worktree, "openspec/config.yaml", "schema: changed\n")
    await expect(dispatchChange(host, h.main, h.main, h.cfg, { ...input, sessionID: implementer.sessionID }, null)).rejects.toThrow("identity changed")
  })
  test("OpenSpec mode doctor/init are no-write, legacy backlog tools blocked and commands never request T-tasks", async () => {
    const h = fixture()
    const layout = { base: "main", mainDir: h.main, worktreeParent: path.join(h.dir, "worktrees") }
    const host = { root: () => h.main, sessionRoot: async () => h.main, layout: () => layout, config: () => h.cfg, configSources: () => [], models: () => [], refreshModels: async () => {}, reloadRegistrations: async () => {}, dispatch: async () => { throw new Error("not expected") } }
    const tools = buildTools(host), ctx = { sessionID: "parent", signal: h.signal }
    for (const name of ["tf_init", "tf_models", "tf_status"]) expect(await tools.find((t) => t.name === name)!.execute({}, ctx)).toContain("1.16.1")
    for (const name of ["tf_start", "tf_set", "tf_board", "tf_clean", "tf_standards"]) expect(await tools.find((t) => t.name === name)!.execute({}, ctx)).toContain("disabled in OpenSpec")
    expect(fs.existsSync(path.join(h.main, ".taskflow"))).toBe(false)
    expect(commandSpecs(h.cfg, layout).every((c) => !c.claimArg)).toBe(true)
    expect(rolePrompt(h.cfg, "implementer", layout)).not.toContain("tf_board")
    const fresh = tmpdir(); expect(loadConfig(fresh, undefined, path.join(fresh, "absent")).config.backend).toBe("openspec")
  })
  test("actual plugin registration and tools/commands dispatch both roles and recover after reload without native takeover", async () => {
    const h = fixture(), f = fakeHost()
    const tools: any[] = [], commands: any[] = [], agents = new Map(), hooks = new Map()
    f.sessions.set("parent", { id: "parent", location: { directory: h.main } })
    const ctx: any = {
      location: { directory: h.main }, options: h.cfg,
      agent: { transform: async (callback: any) => callback({ update: (name: string, fn: any) => { const value = {}; fn(value); agents.set(name, value) } }), reload: async () => {} },
      command: { transform: async (callback: any) => callback({ add: (value: any) => commands.push(value) }), reload: async () => {} },
      tool: { transform: async (callback: any) => callback({ namespace: () => {}, add: (value: any) => tools.push(value) }) },
      permission: { hook: async (name: string, fn: any) => hooks.set(name, fn) }, model: { list: async () => [] }, session: f.host,
    }
    const plugin = (await import("../src/index.ts")).default
    let cleanup: any = await plugin.setup(ctx)
    const context = { sessionID: "parent", agent: "lead", signal: h.signal }
    try {
      expect(commands.every((c) => c.name.startsWith("tf-"))).toBe(true)
      expect(commands.some((c) => c.name.startsWith("opsx"))).toBe(false)
      expect(agents.get("implementer").system).toContain("execution extension")
      await commands.find((c) => c.name === "tf-next").execute({ sessionID: "parent", prompt: { text: "demo" } })
      expect(f.prompts.at(-1).text).toContain("explicitly asks")
      expect(fs.existsSync(recordDirectory(h.main))).toBe(false)
      expect((await tools.find((t) => t.name === "tf_openspec").execute({ operation: "start", change: "demo", confirm: true }, context)).content).toContain('"phase": "claimed"')
      const tool = tools.find((t) => t.name === "tf_dispatch")
      const result = await tool.execute({ role: "implementer", change: "demo", prompt: "work" }, context)
      const sessionID = result.content.match(/child session: (\S+)/)[1]
      expect(result.content).toContain("OpenSpec references")
      expect((await tool.execute({ role: "reviewer", change: "demo", prompt: "review" }, context)).content).toContain("VERDICT: LGTM")
      cleanup(); tools.length = 0; commands.length = 0
      cleanup = await plugin.setup(ctx)
      expect((await tools.find((t) => t.name === "tf_dispatch").execute({ role: "implementer", sessionID, prompt: "continue after reload" }, context)).content).toContain("VERDICT: LGTM")
      const event = { agent: "implementer", sessionID, action: "edit", resources: ["openspec/changes/demo/tasks.md"], effect: "allow" }
      await hooks.get("evaluate")(event)
      expect(event.effect).toBe("allow")
      let entered!: () => void, release!: () => void
      const waiting = new Promise<void>((resolve) => { entered = resolve })
      f.host.wait = async () => { entered(); await new Promise<void>((resolve) => { release = resolve }) }
      const resumed = tools.find((t) => t.name === "tf_dispatch")
      const pending = resumed.execute({ role: "implementer", sessionID, prompt: "one active change lease" }, context)
      await waiting
      try {
        expect((await resumed.execute({ role: "reviewer", change: "demo", prompt: "must not overlap" }, context)).content).toContain("locked")
        await expect(cleanChange(h.main, h.cfg, "demo", true, h.signal)).rejects.toThrow("locked")
      } finally { release() }
      expect((await pending).content).toContain("VERDICT: LGTM")
      expect(fs.readdirSync(recordDirectory(h.main)).some((name) => name.endsWith(".lock"))).toBe(false)
    } finally { cleanup() }
  })
})

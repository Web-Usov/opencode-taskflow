/**
 * opencode-taskflow: OpenSpec change execution for OpenCode V2, with a standalone Taskflow compatibility backend.
 *
 * - Registers role agents (lead, planner, implementer, reviewer, qa) with prompts, model chains and permission rules.
 *   A project agent file with the same name overrides any field it defines.
 * - Registers deterministic tools (`tf_*`) for the task system and the `tf_dispatch` orchestration primitive.
 * - Registers slash commands (`/tf-next`, `/tf-ship`, `/tf-review`, ...).
 * - Guards protected paths, merges and pushes to the base branch with a permission hook.
 *
 * Only types are imported from `@opencode/plugin`, so the plugin has no runtime dependencies.
 */
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import type { Plugin } from "@opencode/plugin"
import { agentChain, agentName, configStamp, loadConfig, parseJsonc, ROLES, type LoadedConfig, type Role, type TaskflowConfig } from "./config.ts"
import { commandSpecs } from "./commands.ts"
import { claim, worktreeParent } from "./core/claim.ts"
import { detectBaseBranch, mainCheckout, worktreePaths, worktreeRoot } from "./core/git.ts"
import { guard, roleRules, type RepoLayout } from "./core/guard.ts"
import { resolveChain, type AvailableModel } from "./core/models.ts"
import { info } from "./core/tasks.ts"
import { taskStandards, type StandardsContext } from "./core/standards.ts"
import { isTaskSourceIdentity, readTaskSource, type TaskSourceIdentity } from "./core/task-source.ts"
import { ROLE_DESCRIPTIONS, roleMode, rolePrompt } from "./roles.ts"
import { buildTools, childResult, dispatchChain, taskWorktree, type DispatchInput, type DispatchResult } from "./tools.ts"
import { dispatchChange } from "./openspec-dispatch.ts"
import { dispatchLeaseCount, executionLock } from "./core/openspec-execution.ts"
import { UnknownChildState } from "./core/dispatch-ownership.ts"
import { digest } from "./core/openspec-source.ts"

/** Host options belong to setup location. Never infer different-location options from the original ctx.options. */
function hostPolicy(root: string): string {
  const names = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]
  const candidates = names.map((relative) => ({ base: root, relative, key: `project:${relative}` }))
  const global = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
  for (const relative of ["opencode.json", "opencode.jsonc"]) candidates.push({ base: global, relative, key: `global:${path.join(global, relative)}` })
  // OpenCode host discovery also inherits ancestor configuration above the git boundary. Absolute ancestor identity
  // matters: identical bytes at a different path can resolve relative plugin/options differently.
  let ancestor = path.dirname(root)
  for (;;) {
    for (const relative of names) if (fs.existsSync(path.join(ancestor, relative))) candidates.push({ base: ancestor, relative, key: `ancestor:${path.join(ancestor, relative)}` })
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  return digest(candidates.map(({ base, relative, key }) => {
    let current = base
    for (const part of relative.split("/")) {
      current = path.join(current, part)
      let stat: fs.Stats
      try { stat = fs.lstatSync(current) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return `${key}:absent`; throw error }
      if (stat.isSymbolicLink()) throw new Error(`symlink host config unsupported: ${relative}`)
    }
    const stat = fs.statSync(current)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256_000 || !(stat.mode & 0o444)) throw new Error(`unsafe/unreadable host config: ${relative}`)
    const text = fs.readFileSync(current, "utf8")
    let value: unknown
    try { value = parseJsonc(text) } catch { throw new Error(`malformed OpenCode host config: ${key}`) }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid host config: ${relative}`)
    return `${key}:${digest(text)}`
  }).join("\n"))
}

type Ctx = Plugin.Context

const define = (p: Plugin.Plugin): Plugin.Plugin => p

export const PLUGIN_ID = "taskflow"

const modelRef = (m: { providerID: string; id: string; variant?: string }) => ({ providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) })
const modelString = (m: { providerID: string; id: string; variant?: string } | null) => (m ? `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}` : null)

interface DispatchBinding {
  version: 2
  role: Role
  agent: string
  task: string | null
  parentSessionID: string
  directory: string
  taskSource: TaskSourceIdentity | null
}
function dispatchBinding(value: any): DispatchBinding | null {
  if (!value || value.version !== 2 || !ROLES.includes(value.role) || value.role === "lead" || typeof value.agent !== "string" || !value.agent || !(value.task === null || (typeof value.task === "string" && value.task !== "")) || typeof value.parentSessionID !== "string" || !value.parentSessionID || typeof value.directory !== "string" || !path.isAbsolute(value.directory) || (value.task === null ? value.taskSource !== null : !isTaskSourceIdentity(value.taskSource))) return null
  // Normalize property order and detach host-returned nested values from the in-memory association cache.
  const s = value.taskSource as TaskSourceIdentity | null
  const taskSource = s ? { root: s.root, rootPath: s.rootPath, rootId: s.rootId, repository: s.repository, repositoryId: s.repositoryId, tasks: s.tasks, directoryIds: [...s.directoryIds], file: s.file } : null
  return { version: 2, role: value.role, agent: value.agent, task: value.task, parentSessionID: value.parentSessionID, directory: value.directory, taskSource }
}

export default define({
  id: PLUGIN_ID,
  async setup(ctx: Ctx) {
    const root = worktreeRoot(ctx.location.directory) ?? ctx.location.directory
    let mainDir = root
    try {
      mainDir = mainCheckout(root)
    } catch {
      /* not a git repository: the task tools report it */
    }

    // ---- config (re-read when the files change) ----
    let loaded: LoadedConfig = loadConfig(root, ctx.options)
    const registeredRoleNames = new Set(ROLES.map((role) => agentName(loaded.config, role)))
    let setupHostPolicy: string | undefined
    try { setupHostPolicy = hostPolicy(root) } catch { /* register diagnostics, but refuse actions until host config is fixed/reloaded */ }
    let stamp = configStamp(root)
    let registrationsStale = false
    const config = (): TaskflowConfig => {
      const now = configStamp(root)
      if (now !== stamp) {
        stamp = now
        loaded = loadConfig(root, ctx.options)
        registrationsStale = true
      }
      return loaded.config
    }
    // base-branch detection runs git: cache the layout (it changes only with the config or the remote HEAD)
    let layoutCache: { key: string; at: number; value: RepoLayout } | null = null
    const layout = (): RepoLayout => {
      const cfg = config()
      if (layoutCache && layoutCache.key === stamp && Date.now() - layoutCache.at < 60_000) return layoutCache.value
      const value = { base: detectBaseBranch(root, cfg.git.remote, cfg.git.baseBranch), mainDir, worktreeParent: worktreeParent(mainDir, cfg) }
      layoutCache = { key: stamp, at: Date.now(), value }
      return value
    }
    const reloadRegistrations = async () => {
      registrationsStale = false
      await Promise.all([ctx.agent.reload(), ctx.command.reload()])
    }
    const syncRegistrations = () => {
      config()
      if (registrationsStale) void reloadRegistrations().catch(() => {})
    }

    // ---- available models (for chain resolution) ----
    let available: AvailableModel[] = []
    let modelsKey = ""
    const refreshModels = async () => {
      try {
        const res: any = await ctx.model.list()
        const list: any[] = Array.isArray(res) ? res : (res?.data ?? [])
        const next = list
          .filter((m) => m.enabled !== false)
          .map((m) => ({ providerID: String(m.providerID), id: String(m.id), variants: (m.variants ?? []).map((v: any) => ({ id: String(v.id) })) }))
        const key = next.map((m) => `${m.providerID}/${m.id}`).sort().join(",")
        available = next
        if (key !== modelsKey) {
          modelsKey = key
          await ctx.agent.reload()
        }
      } catch {
        /* model registry not ready yet; keep the previous list */
      }
    }

    // ---- agents ----
    await ctx.agent.transform((editor) => {
      const cfg = config()
      registrationsStale = false
      let lay: RepoLayout
      try {
        lay = layout()
      } catch {
        return
      }
      for (const role of ROLES) {
        try {
          const a = cfg.agents[role]
            if (a?.disable) continue
            registeredRoleNames.add(agentName(cfg, role))
          const model = resolveChain(agentChain(cfg, role), available).model
          editor.update(agentName(cfg, role), (agent: any) => {
            agent.description = cfg.backend === "openspec" ? `OpenSpec ${role}: ${role === "planner" ? "native planning under human control; no second backlog" : "one selected change, bound execution worktree, verification and independent PR review"}` : ROLE_DESCRIPTIONS[role]
            agent.mode = roleMode(role)
            agent.system = rolePrompt(cfg, role, lay)
            if (model) agent.model = modelRef(model)
            agent.permissions = [...(agent.permissions ?? []), ...roleRules(cfg, role, lay), ...(a?.permissions ?? [])]
          })
        } catch {
          /* one broken role must not take down the others */
        }
      }
    })

    // ---- session -> worktree (not cached and NEVER falls back to stale setup policy/location) ----
    const sessionRoot = async (sessionID: string): Promise<string> => assertCallerPolicy(sessionID)

    const assertPolicyAt = (caller: string): string => {
      try {
        const cfg = config()
        if (fs.realpathSync(caller) !== caller) throw new Error("select a canonical worktree root")
        const gitRoot = worktreeRoot(caller)
        if (gitRoot && gitRoot !== caller) throw new Error("select the exact git worktree root, not a subdirectory policy")
        if (caller !== root && mainCheckout(caller) !== mainCheckout(root)) throw new Error("caller belongs to a different repository")
        const actual = loadConfig(caller, ctx.options)
        const errors = [...loaded.sources, ...actual.sources].filter((source) => !source.ok)
        if (errors.length) throw new Error(errors.map((source) => `${source.path}: ${source.error}`).join("; "))
        if (JSON.stringify(actual.config) !== JSON.stringify(cfg)) throw new Error("effective backend/executable/verify/setup or other Taskflow settings differ")
        if (!setupHostPolicy || hostPolicy(root) !== setupHostPolicy || hostPolicy(caller) !== setupHostPolicy) throw new Error("host OpenCode config differs from this setup location; caller-specific plugin options/agents cannot be inferred")
        return caller
      } catch (error) { throw new Error(`caller policy unavailable/differs: ${(error as Error).message}. Open/reload the plugin in the calling worktree (${caller}) before using Taskflow; no operation was started.`) }
    }
    const assertCallerPolicy = async (sessionID: string): Promise<string> => {
      let directory: unknown
      try {
        const response: any = await ctx.session.get({ sessionID: sessionID as any })
        directory = (response?.data ?? response)?.location?.directory
      } catch { /* no location means no authorization to use the setup root */ }
      if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("caller policy unavailable: host did not return the calling session location; reload/open the session in its actual worktree before retrying")
      return assertPolicyAt(worktreeRoot(directory) ?? path.resolve(directory))
    }

    // ---- commands ----
    await ctx.command.transform((editor) => {
      const cfg = config()
      let lay: RepoLayout
      try {
        lay = layout()
      } catch {
        return
      }
      for (const spec of commandSpecs(cfg, lay)) {
        const commandName = spec.name
        editor.add({
          name: spec.name,
          description: spec.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            await assertCallerPolicy(String(sessionID))
            const spec = commandSpecs(config(), layout()).find((candidate) => candidate.name === commandName)
            if (!spec) throw new Error("caller policy command registration changed; reload commands in the calling worktree")
            const args = prompt.text ?? ""
            let report: string | undefined
            let switchTo: Role | undefined = spec.switchTo
            if (spec.claimArg && args.trim()) {
              const r = await claim({ cwd: await sessionRoot(sessionID), cfg: config(), id: args.trim() })
              report = r.ok
                ? `CLAIMED ${r.id}: worktree ${r.worktree}, branch ${r.branch}.\n${r.log.map((l) => `  ${l}`).join("\n")}`
                : `CLAIM FAILED for ${args.trim()}: ${r.error}\n${r.log.map((l) => `  ${l}`).join("\n")}`
              if (r.ok && r.worktree) {
                // switch first: the agent exists in this location; the worktree location may not have booted yet
                switchTo = "implementer"
                const switched = await ctx.session.switchAgent({ sessionID, agent: agentName(config(), switchTo) as any }).then(
                  () => null,
                  (e: unknown) => String((e as Error)?.message ?? e),
                )
                if (switched) report += `\nNOTE: could not switch this session to the implementer agent (${switched}).`
                switchTo = undefined
                const moved = await ctx.session.move({ sessionID: sessionID as any, directory: r.worktree as any } as any).then(
                  () => null,
                  (e: unknown) => String((e as Error)?.message ?? e),
                )
                if (moved) {
                  report += `\nMOVE FAILED: this session is still in the main checkout (${moved}). Do NOT edit files from here: tell the human to open a new session in ${r.worktree} and stop.`
                }
              }
            }
            if (switchTo) {
              const err = await ctx.session.switchAgent({ sessionID, agent: agentName(config(), switchTo) as any }).then(
                () => null,
                (e: unknown) => String((e as Error)?.message ?? e),
              )
              if (err) report = `${report ?? ""}\nNOTE: could not switch this session to ${agentName(config(), switchTo)} (${err}).`
            }
            await ctx.session.prompt({ ...(prompt as any), sessionID, text: spec.render(args, report), delivery } as any)
          },
        })
      }
    })

    // ---- dispatch (child sessions) ----
    const running = new Map<Role, number>()
    // Host session metadata is durable across plugin reloads; cache only supports hosts that omit metadata on get.
    // No source snapshot or approval database: every continuation still loads the current task binding.
    const children = new Map<string, DispatchBinding>()
    const changeChildren = new Map<string, string>()
    const dispatch = async (input: DispatchInput): Promise<DispatchResult> => {
      if (input.signal.aborted) throw new Error("aborted")
      await assertCallerPolicy(input.parentSessionID)
      const cfg = config()
      const agent = agentName(cfg, input.role)
      let changeContinuation = false
      let continuedChange: unknown
      if (input.sessionID) {
        const response: any = await ctx.session.get({ sessionID: input.sessionID as any })
        changeContinuation = (response?.data ?? response)?.metadata?.taskflowOpenSpecDispatch !== undefined
        continuedChange = (response?.data ?? response)?.metadata?.taskflowOpenSpecDispatch?.change
      }
      if (input.change !== undefined || changeContinuation) {
        if (cfg.backend !== "openspec") throw new Error("OpenSpec dispatch requires backend=openspec")
        if (loaded.sources.some((source) => !source.ok)) throw new Error("invalid/unreadable Taskflow configuration; repair the reported config diagnostics before dispatch")
        const change = input.change ?? continuedChange
        if (typeof change !== "string") throw new Error("invalid OpenSpec change continuation")
        const sourceRoot = await sessionRoot(input.parentSessionID)
        if (input.role === "implementer" && Math.max(running.get("implementer") ?? 0, dispatchLeaseCount(sourceRoot)) >= cfg.parallel) throw new Error(`${cfg.parallel} implementer(s) already running or conservatively owned by held/unknown leases; confirm stopped children before manual recovery`)
        running.set(input.role, (running.get(input.role) ?? 0) + 1)
        let unresolved = false
        try {
          return await executionLock(sourceRoot, change, async () => {
            if (!available.length) await refreshModels()
            const model = resolveChain(agentChain(cfg, input.role), available).model
            return dispatchChange(ctx.session, sourceRoot, mainDir, cfg, input, model ? modelRef(model) : null, changeChildren, assertPolicyAt)
          }, "dispatch")
        } catch (error) { unresolved = error instanceof UnknownChildState; throw error }
        finally { if (!unresolved) running.set(input.role, Math.max(0, (running.get(input.role) ?? 1) - 1)) }
      }
      if (cfg.backend === "openspec") throw new Error("OpenSpec mode requires an explicit change for new dispatch; legacy task dispatch is disabled")
      let taskID = input.task
      let boundDirectory: string | undefined
      let boundSource: TaskSourceIdentity | null = null
      if (input.sessionID) {
        const response: any = await ctx.session.get({ sessionID: input.sessionID as any })
        const child = response?.data ?? response
        const cached = children.get(input.sessionID)
        const metadata = child?.metadata?.taskflowDispatch
        const stored = dispatchBinding(metadata)
        if (metadata !== undefined && !stored) throw new Error("invalid taskflow dispatch metadata; start a new child session")
        if (cached && stored && JSON.stringify(cached) !== JSON.stringify(stored)) throw new Error("child dispatch association changed; start a new child session")
        const binding = stored ?? cached
        if (!binding) throw new Error("cannot recover child task/role association; start a new child with explicit role and task (legacy or metadata-less session after reload)")
        if (child?.id !== input.sessionID || child.agent !== binding.agent || (child.parentID !== undefined && child.parentID !== binding.parentSessionID) || (!cached && child.parentID !== binding.parentSessionID)) throw new Error("child session identity/agent/parent does not match its dispatch association")
        if (binding.role !== input.role || binding.agent !== agent) throw new Error(`child role/agent is bound to ${binding.role}/${binding.agent}; it cannot be changed by continuation`)
        if (binding.parentSessionID !== input.parentSessionID) throw new Error("child session belongs to a different parent")
        if (input.task !== undefined && input.task !== binding.task) throw new Error(`child task is bound to ${binding.task ?? "no task"}; contradictory task identity`)
        if (child.location?.directory !== binding.directory || (input.directory !== undefined && path.resolve(mainDir, input.directory) !== binding.directory)) throw new Error("child working directory does not match its dispatch association")
        taskID = binding.task ?? undefined
        boundDirectory = binding.directory
        boundSource = binding.taskSource
        children.set(input.sessionID, binding)
      }
      let task: { size?: string; area?: string } | null = null
      let standards: StandardsContext = taskStandards(root, cfg, undefined)
      const wt = taskID ? taskWorktree(root, cfg, taskID) : null
      let taskSource: TaskSourceIdentity | null = null
      if (taskID) {
        const { doc, source } = readTaskSource(wt ?? root, cfg, taskID)
        if (input.sessionID && JSON.stringify(boundSource) !== JSON.stringify(source)) throw new Error("child task source identity changed (repository/worktree, task directory or file); start a new child session")
        taskSource = source
        task = info(doc)
        standards = taskStandards(source.root, cfg, doc.data!.standards)
      }
      // the reviewer reads the PR through git and never works inside the implementer's worktree
      const directory = boundDirectory ?? (input.directory ? path.resolve(mainDir, input.directory) : input.role === "reviewer" ? mainDir : (wt ?? mainDir))
      const { chain, category } = dispatchChain(cfg, input.role, task)
      if (!available.length) await refreshModels()
      const model = resolveChain(chain, available).model
      if (input.role === "implementer" && !input.sessionID && (running.get("implementer") ?? 0) >= cfg.parallel) {
        throw new Error(`${cfg.parallel} implementer(s) already running (config "parallel"); wait for one to finish`)
      }
      running.set(input.role, (running.get(input.role) ?? 0) + 1)
      try {
        let sessionID = input.sessionID
        if (!sessionID) {
          const binding: DispatchBinding = { version: 2, role: input.role, agent, task: taskID ?? null, parentSessionID: input.parentSessionID, directory, taskSource }
          const s: any = await ctx.session.create({
            parentID: input.parentSessionID as any,
            agent: agent as any,
            ...(model ? { model: modelRef(model) as any } : {}),
            location: { directory } as any,
            title: `${input.role}${taskID ? ` ${taskID}` : ""}${category ? ` [${category}]` : ""}`,
            metadata: { taskflowDispatch: { ...binding, taskSource: binding.taskSource ? { ...binding.taskSource, directoryIds: [...binding.taskSource.directoryIds] } : null } },
          })
          const id = s?.id ?? s?.data?.id
          if (typeof id !== "string" || !id) throw new Error("session.create returned no session id")
          sessionID = id
          children.set(id, binding)
        }
        const sid = sessionID
        if (input.signal.aborted) {
          await ctx.session.interrupt({ sessionID: sid as any } as any).catch(() => {})
          throw new Error("aborted")
        }
        const header = [taskID ? `Task: ${taskID}` : "", taskSource ? `Task source file: ${taskSource.file}` : "", `Working directory: ${directory} (run every shell command there).`, `Standards binding source: ${taskSource?.root ?? root}`, standards.text].filter(Boolean).join("\n")
        let timedOut = false
        const interrupt = () => void ctx.session.interrupt({ sessionID: sid as any } as any).catch(() => {})
        input.signal.addEventListener("abort", interrupt, { once: true })
        const timer = setTimeout(() => {
          timedOut = true
          interrupt()
        }, cfg.dispatch.timeoutMinutes * 60_000)
        try {
          await ctx.session.prompt({ sessionID: sid as any, text: `${header}\n\n${input.prompt}` } as any)
          if (input.signal.aborted) interrupt()
          await ctx.session.wait({ sessionID: sid as any } as any)
        } finally {
          clearTimeout(timer)
          input.signal.removeEventListener("abort", interrupt)
        }
        const messages: any = await ctx.session.context({ sessionID: sid as any } as any)
        const r = childResult(Array.isArray(messages) ? messages : (messages?.data ?? []))
        const error = timedOut ? `timed out after ${cfg.dispatch.timeoutMinutes} min and was interrupted${r.error ? `; ${r.error}` : ""}` : input.signal.aborted ? "aborted by the caller" : r.error
        return { sessionID: sid, agent, model: modelString(model), directory, text: r.text, outcome: r.outcome, error, standards: standards.sources.flatMap((s) => s.ids.map((id) => ({ id, path: s.path, sha256: s.sha256 }))) }
      } finally {
        running.set(input.role, Math.max(0, (running.get(input.role) ?? 1) - 1))
      }
    }

    // ---- tools ----
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "taskflow", description: config().backend === "openspec" ? "OpenSpec change execution and role orchestration (opencode-taskflow)" : "Task system and orchestration tools (opencode-taskflow)" })
      for (const t of buildTools({ root: () => root, sessionRoot, layout, config, configSources: () => loaded.sources, models: () => available, refreshModels, reloadRegistrations, dispatch })) {
        editor.add({
          name: t.name,
          description: t.description,
          input: t.input as any,
          options: { namespace: "taskflow", codemode: false, permission: t.permission },
          execute: async (input: any, context: any) => {
            syncRegistrations()
            try {
              await assertCallerPolicy(String(context.sessionID))
              if (t.name !== "tf_dispatch" && typeof input?.directory === "string" && input.directory) assertPolicyAt(path.resolve(input.directory))
            } catch (error) { return { content: `ERROR: ${(error as Error).message}` } }
            return { content: await t.execute(input ?? {}, { sessionID: String(context.sessionID), agent: context.agent ? String(context.agent) : undefined, signal: context.signal }) }
          },
        })
      }
    })

    // ---- guard ----
    let roots: string[] = []
    let rootsAt = 0
    await ctx.permission.hook("evaluate", (ev) => {
      if (ev.effect === "deny" || (ev.action !== "edit" && ev.action !== "shell")) return
      syncRegistrations()
      const cfg = loaded.config
      if (!registeredRoleNames.has(String(ev.agent)) && !ROLES.some((r) => agentName(cfg, r) === String(ev.agent))) return
      if (Date.now() - rootsAt > 10_000) {
        roots = worktreePaths(root)
        rootsAt = Date.now()
      }
      let lay: RepoLayout
      try {
        lay = layout()
      } catch {
        return
      }
      const evaluate = (executionRoot?: string) => {
        const reason = guard(cfg, { agent: ev.agent ? String(ev.agent) : undefined, action: ev.action, resources: ev.resources }, { base: lay.base, roots: roots.length ? roots : [root], worktreeParent: lay.worktreeParent, executionRoot })
        if (reason) { ev.effect = "deny"; ev.message = reason }
      }
      if (ev.sessionID) return assertCallerPolicy(String(ev.sessionID)).then(evaluate).catch((error) => { ev.effect = "deny"; ev.message = (error as Error).message })
      if (cfg.backend === "openspec") { ev.effect = "deny"; ev.message = "caller policy unavailable: permission event has no session location; reload in the calling worktree"; return }
      evaluate()
    })

    // The model registry may fill after this plugin's setup (provider plugins load in parallel, logins happen later).
    await refreshModels()
    const timers = [3_000, 15_000, 60_000].map((ms) => setTimeout(() => void refreshModels(), ms))
    return () => timers.forEach(clearTimeout)
  },
})

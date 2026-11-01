/**
 * opencode-taskflow: an OpenCode V2 plugin that runs the epic -> task -> worktree -> PR -> review -> merge workflow.
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
import type { Plugin } from "@opencode/plugin"
import { agentChain, agentName, configStamp, loadConfig, ROLES, type LoadedConfig, type Role, type TaskflowConfig } from "./config.ts"
import { commandSpecs } from "./commands.ts"
import { claim, worktreeParent } from "./core/claim.ts"
import { asString } from "./core/frontmatter.ts"
import { detectBaseBranch, mainCheckout, worktreePaths, worktreeRoot } from "./core/git.ts"
import { guard, roleRules, type RepoLayout } from "./core/guard.ts"
import { resolveChain, type AvailableModel } from "./core/models.ts"
import { info, loadTasks } from "./core/tasks.ts"
import { ROLE_DESCRIPTIONS, roleMode, rolePrompt } from "./roles.ts"
import { buildTools, childResult, dispatchChain, taskWorktree, type DispatchInput, type DispatchResult } from "./tools.ts"

type Ctx = Plugin.Context

const define = (p: Plugin.Plugin): Plugin.Plugin => p

export const PLUGIN_ID = "taskflow"

const modelRef = (m: { providerID: string; id: string; variant?: string }) => ({ providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) })
const modelString = (m: { providerID: string; id: string; variant?: string } | null) => (m ? `${m.providerID}/${m.id}${m.variant ? `#${m.variant}` : ""}` : null)

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
          const model = resolveChain(agentChain(cfg, role), available).model
          editor.update(agentName(cfg, role), (agent: any) => {
            agent.description = ROLE_DESCRIPTIONS[role]
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

    // ---- session -> worktree (not cached: sessions move, worktrees get removed) ----
    const sessionRoot = async (sessionID: string): Promise<string> => {
      try {
        const sess: any = await ctx.session.get({ sessionID: sessionID as any } as any)
        const dir = sess?.location?.directory ?? sess?.data?.location?.directory
        if (typeof dir === "string") return worktreeRoot(dir) ?? dir
      } catch {
        /* fall back to the plugin instance */
      }
      return root
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
        editor.add({
          name: spec.name,
          description: spec.description,
          execute: async ({ sessionID, prompt, delivery }) => {
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
    const dispatch = async (input: DispatchInput): Promise<DispatchResult> => {
      if (input.signal.aborted) throw new Error("aborted")
      const cfg = config()
      const agent = agentName(cfg, input.role)
      let task: { size?: string; area?: string } | null = null
      const wt = input.task ? taskWorktree(root, cfg, input.task) : null
      if (input.task) {
        const doc = loadTasks(wt ?? root, cfg).find((d) => asString(d.data?.id) === input.task)
        if (doc) task = info(doc)
      }
      // the reviewer reads the PR through git and never works inside the implementer's worktree
      const directory = input.directory ? path.resolve(mainDir, input.directory) : input.role === "reviewer" ? mainDir : (wt ?? mainDir)
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
          const s: any = await ctx.session.create({
            parentID: input.parentSessionID as any,
            agent: agent as any,
            ...(model ? { model: modelRef(model) as any } : {}),
            location: { directory } as any,
            title: `${input.role}${input.task ? ` ${input.task}` : ""}${category ? ` [${category}]` : ""}`,
          })
          const id = s?.id ?? s?.data?.id
          if (typeof id !== "string" || !id) throw new Error("session.create returned no session id")
          sessionID = id
        }
        const sid = sessionID
        if (input.signal.aborted) {
          await ctx.session.interrupt({ sessionID: sid as any } as any).catch(() => {})
          throw new Error("aborted")
        }
        const header = [input.task ? `Task: ${input.task}` : "", `Working directory: ${directory} (run every shell command there).`].filter(Boolean).join("\n")
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
        return { sessionID: sid, agent, model: modelString(model), directory, text: r.text, outcome: r.outcome, error }
      } finally {
        running.set(input.role, Math.max(0, (running.get(input.role) ?? 1) - 1))
      }
    }

    // ---- tools ----
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "taskflow", description: "Task system and orchestration tools (opencode-taskflow)" })
      for (const t of buildTools({ root: () => root, sessionRoot, layout, config, configSources: () => loaded.sources, models: () => available, refreshModels, reloadRegistrations, dispatch })) {
        editor.add({
          name: t.name,
          description: t.description,
          input: t.input as any,
          options: { namespace: "taskflow", codemode: false, permission: t.permission },
          execute: async (input: any, context: any) => {
            syncRegistrations()
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
      if (!ROLES.some((r) => agentName(cfg, r) === String(ev.agent))) return
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
      const reason = guard(cfg, { agent: ev.agent ? String(ev.agent) : undefined, action: ev.action, resources: ev.resources }, { base: lay.base, roots: roots.length ? roots : [root], worktreeParent: lay.worktreeParent })
      if (reason) {
        ev.effect = "deny"
        ev.message = reason
      }
    })

    // The model registry may fill after this plugin's setup (provider plugins load in parallel, logins happen later).
    await refreshModels()
    const timers = [3_000, 15_000, 60_000].map((ms) => setTimeout(() => void refreshModels(), ms))
    return () => timers.forEach(clearTimeout)
  },
})

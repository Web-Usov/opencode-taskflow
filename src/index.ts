/**
 * opencode-taskflow: an OpenCode V2 plugin that runs the epic -> task -> worktree -> PR -> review -> merge workflow.
 *
 * - Registers role agents (lead, planner, implementer, reviewer, qa) with prompts, model chains and permission rules.
 *   A project agent file with the same name overrides any field it defines.
 * - Registers deterministic tools (`tf_*`) for the task system and the `tf_dispatch` orchestration primitive.
 * - Registers slash commands (`/tf-next`, `/tf-ship`, `/tf-review`, ...).
 * - Guards protected paths and merges with a permission hook.
 *
 * Only types are imported from `@opencode/plugin`, so the plugin has no runtime dependencies.
 */
import type { Plugin } from "@opencode/plugin"
import { agentName, loadConfig, ROLES, type LoadedConfig, type Role } from "./config.ts"
import { commandSpecs } from "./commands.ts"
import { detectBaseBranch, worktreeRoot } from "./core/git.ts"
import { guard, roleRules } from "./core/guard.ts"
import { resolveChain, type AvailableModel } from "./core/models.ts"
import { asString } from "./core/frontmatter.ts"
import { info, loadTasks } from "./core/tasks.ts"
import { ROLE_DESCRIPTIONS, roleMode, rolePrompt } from "./roles.ts"
import { buildTools, dispatchChain, lastAssistantText, taskWorktree, type DispatchInput, type DispatchResult } from "./tools.ts"

type Ctx = Plugin.Context

const define = (p: Plugin.Plugin): Plugin.Plugin => p

export const PLUGIN_ID = "taskflow"

export default define({
  id: PLUGIN_ID,
  async setup(ctx: Ctx) {
    const root = worktreeRoot(ctx.location.directory) ?? ctx.location.directory
    let loaded: LoadedConfig = loadConfig(root, ctx.options)
    const config = () => {
      loaded = loadConfig(root, ctx.options)
      return loaded.config
    }
    const baseBranch = () => detectBaseBranch(root, loaded.config.git.remote, loaded.config.git.baseBranch)

    // ---- available models (for chain resolution) ----
    let available: AvailableModel[] = []
    let modelsKey = ""
    const refreshModels = async () => {
      try {
        const res: any = await ctx.model.list()
        const list: any[] = Array.isArray(res) ? res : (res?.data ?? [])
        const next = list.map((m) => ({ providerID: String(m.providerID), id: String(m.id), variants: (m.variants ?? []).map((v: any) => ({ id: String(v.id) })) }))
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
      const cfg = loaded.config
      const base = baseBranch()
      for (const role of ROLES) {
        const a = cfg.agents[role]
        if (a?.disable) continue
        const name = agentName(cfg, role)
        const model = resolveChain(a?.models ?? (a?.model ? [a.model] : []), available).model
        editor.update(name, (agent: any) => {
          agent.description = ROLE_DESCRIPTIONS[role]
          agent.mode = roleMode(role)
          agent.system = rolePrompt(cfg, role, base)
          if (model) agent.model = { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }
          agent.permissions = [...(agent.permissions ?? []), ...roleRules(cfg, role, base), ...(a?.permissions ?? [])]
        })
      }
    })

    // ---- commands ----
    await ctx.command.transform((editor) => {
      const cfg = loaded.config
      for (const spec of commandSpecs(cfg)) {
        editor.add({
          name: spec.name,
          description: spec.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            if (spec.switchTo) await ctx.session.switchAgent({ sessionID, agent: agentName(loaded.config, spec.switchTo) as any })
            await ctx.session.prompt({ ...(prompt as any), sessionID, text: spec.render(prompt.text ?? ""), delivery } as any)
          },
        })
      }
    })

    // ---- dispatch (child sessions) ----
    const running = new Map<Role, number>()
    const dispatch = async (input: DispatchInput): Promise<DispatchResult> => {
      const cfg = config()
      const agent = agentName(cfg, input.role)
      let task: { size?: string; area?: string } | null = null
      if (input.task) {
        const doc = loadTasks(root, cfg).find((d) => asString(d.data?.id) === input.task)
        if (doc) task = info(doc)
      }
      const directory = input.directory ?? (input.task ? taskWorktree(root, cfg, input.task) : null) ?? root
      const { chain, category } = dispatchChain(cfg, input.role, task)
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
            ...(model ? { model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) } as any } : {}),
            location: { directory } as any,
            title: `${input.role}${input.task ? ` ${input.task}` : ""}${category ? ` [${category}]` : ""}`,
          })
          sessionID = String(s?.id ?? s?.data?.id)
        }
        const header = [
          input.task ? `Task: ${input.task}` : "",
          `Working directory: ${directory} (run every shell command there).`,
        ]
          .filter(Boolean)
          .join("\n")
        const onAbort = () => void ctx.session.interrupt({ sessionID: sessionID as any } as any).catch(() => {})
        input.signal.addEventListener("abort", onAbort, { once: true })
        try {
          await ctx.session.prompt({ sessionID: sessionID as any, text: `${header}\n\n${input.prompt}` } as any)
          await ctx.session.wait({ sessionID: sessionID as any } as any)
        } finally {
          input.signal.removeEventListener("abort", onAbort)
        }
        const messages: any = await ctx.session.context({ sessionID: sessionID as any } as any)
        const list = Array.isArray(messages) ? messages : (messages?.data ?? [])
        return { sessionID, agent, model: model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : null, directory, text: lastAssistantText(list) }
      } finally {
        running.set(input.role, Math.max(0, (running.get(input.role) ?? 1) - 1))
      }
    }

    // ---- tools ----
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "taskflow", description: "Task system and orchestration tools (opencode-taskflow)" })
      for (const t of buildTools({
        root: () => root,
        config,
        configSources: () => loaded.sources,
        models: () => available,
        refreshModels,
        reloadRegistrations: async () => {
          config()
          await Promise.all([ctx.agent.reload(), ctx.command.reload()])
        },
        dispatch,
      })) {
        editor.add({
          name: t.name,
          description: t.description,
          input: t.input as any,
          options: { namespace: "taskflow", codemode: false },
          execute: async (input: any, context: any) => ({ content: await t.execute(input ?? {}, { sessionID: String(context.sessionID), signal: context.signal }) }),
        })
      }
    })

    // ---- guard ----
    await ctx.permission.hook("evaluate", (ev) => {
      if (ev.effect === "deny") return
      const reason = guard(loaded.config, { agent: ev.agent ? String(ev.agent) : undefined, action: ev.action, resources: ev.resources })
      if (reason) {
        ev.effect = "deny"
        ev.message = reason
      }
    })

    // The model registry may fill after this plugin's setup (provider plugins load in parallel): refresh now and once more.
    await refreshModels()
    const timer = setTimeout(() => void refreshModels(), 3000)
    return () => clearTimeout(timer)
  },
})

import path from "node:path"
import type { Role, TaskflowConfig } from "./config.ts"
import { agentChain, agentName, ROLES } from "./config.ts"
import { claim, clean, planWorktree } from "./core/claim.ts"
import { asString } from "./core/frontmatter.ts"
import { baseRefOf, detectBaseBranch, fetchShared, hasRemote, NET_TIMEOUT, run, tryGit } from "./core/git.ts"
import { TOOL_PERMISSION, type RepoLayout } from "./core/guard.ts"
import { init } from "./core/init.ts"
import { formatModelRef, resolveChain, routeCategory, type AvailableModel, type ModelRef } from "./core/models.ts"
import { check, info, loadTasks, loadTasksFromRef, notReadyReason, readyTasks, setStatus, summary, writeBoard, type Doc } from "./core/tasks.ts"
import { loadStandards, readStandardsIndex, standardIds, suggestStandards } from "./core/standards.ts"

/** What the tools need from the plugin host; injected so the tools are testable without OpenCode. */
export interface ToolHost {
  /** Worktree of the plugin instance (the location it was loaded for). */
  root: () => string
  /** Worktree of the calling session (falls back to `root`). */
  sessionRoot: (sessionID: string) => Promise<string>
  layout: () => RepoLayout
  config: () => TaskflowConfig
  configSources: () => Array<{ path: string; ok: boolean; error?: string }>
  models: () => AvailableModel[]
  refreshModels: () => Promise<void>
  reloadRegistrations: () => Promise<void>
  dispatch: (input: DispatchInput) => Promise<DispatchResult>
}

export interface DispatchInput {
  role: Role
  prompt: string
  task?: string
  directory?: string
  sessionID?: string
  parentSessionID: string
  callerAgent?: string
  signal: AbortSignal
}

export interface DispatchResult {
  sessionID: string
  agent: string
  model: string | null
  directory: string
  text: string
  outcome: string | null
  error: string | null
  standards?: Array<{ id: string; path: string; sha256: string }>
}

export interface ToolCallContext {
  sessionID: string
  agent?: string
  signal: AbortSignal
}

export interface ToolDef {
  name: string
  description: string
  /** Permission name used by role rules to hide the tool (`taskflow.read|write|dispatch`). */
  permission: string
  input: Record<string, unknown>
  execute: (input: any, ctx: ToolCallContext) => Promise<string>
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})
const str = (description: string) => ({ type: "string", description })
const bool = (description: string) => ({ type: "boolean", description })

/** Worktree directory checked out on the task's branch, if any. */
export function taskWorktree(root: string, cfg: TaskflowConfig, id: string): string | null {
  const blocks = (tryGit(["worktree", "list", "--porcelain"], root) ?? "").split("\n\n")
  for (const b of blocks) {
    const p = b.match(/^worktree (.*)$/m)?.[1]
    const br = b.match(/^branch refs\/heads\/(.*)$/m)?.[1]
    if (p && br?.startsWith(`${cfg.git.branchPrefix}${id}-`)) return p
  }
  return null
}

/** Model chain for a dispatch: implementer tasks may be routed to a category by size/area. */
export function dispatchChain(cfg: TaskflowConfig, role: Role, task: { size?: string; area?: string } | null): { chain: string[]; category: string | null } {
  if (role === "implementer" && task) {
    const category = routeCategory(cfg.routing, task)
    const models = category ? cfg.categories[category]?.models : undefined
    if (category && models?.length) return { chain: [...models, ...agentChain(cfg, role)], category }
  }
  return { chain: agentChain(cfg, role), category: null }
}

export function resolveRoleModels(cfg: TaskflowConfig, available: AvailableModel[]) {
  return ROLES.map((role) => {
    const chain = agentChain(cfg, role)
    const r = resolveChain(chain, available)
    return { role, agent: agentName(cfg, role), disabled: !!cfg.agents[role]?.disable, chain, model: r.model, skipped: r.skipped }
  })
}

const fmtModel = (m: ModelRef | null) => (m ? formatModelRef(m) : "(none available: inherits the session model)")

/**
 * Which roles may dispatch whom. The lead and non-taskflow agents (the human's own session) dispatch any role; other
 * taskflow roles may not dispatch at all (an implementer must not get its own PR reviewed and merged).
 */
export function mayDispatch(cfg: TaskflowConfig, callerAgent: string | undefined): boolean {
  const callerRole = ROLES.find((r) => agentName(cfg, r) === callerAgent)
  return !callerRole || callerRole === "lead"
}

export function buildTools(host: ToolHost): ToolDef[] {
  const cfgNow = () => host.config()
  const where = async (input: any, ctx: ToolCallContext) => (typeof input?.directory === "string" && input.directory ? path.resolve(input.directory) : await host.sessionRoot(ctx.sessionID))
  const baseRef = (root: string) => {
    const cfg = cfgNow()
    const ref = baseRefOf(root, cfg.git.remote, host.layout().base)
    return ref.includes("/") ? ref : null
  }
  const prState = async (url: string, root: string) => {
    const r = await run("gh", ["pr", "view", url, "--json", "state"], root, { timeout: NET_TIMEOUT })
    if (!r.ok) return null
    try {
      return JSON.parse(r.stdout).state as string
    } catch {
      return null
    }
  }
  /** Task docs as merged on the base (after a throttled fetch), falling back to the working tree. */
  const mergedDocs = async (root: string, signal: AbortSignal): Promise<{ docs: Doc[]; source: string }> => {
    const cfg = cfgNow()
    let note = ""
    if (hasRemote(root, cfg.git.remote)) {
      const f = await fetchShared(host.layout().mainDir, cfg.git.remote, { signal, maxAgeMs: 45_000 })
      if (!f.ok) note = ` (fetch failed: ${f.error}; data may be stale)`
    }
    const ref = baseRef(root)
    const docs = ref ? loadTasksFromRef(root, cfg, ref) : null
    return docs ? { docs, source: ref! + note } : { docs: loadTasks(root, cfg), source: "working tree" + note }
  }

  return [
    {
      name: "tf_standards",
      permission: TOOL_PERMISSION.read,
      description: "Read the session repository's reference index: list, deterministic suggest (not selection), explicitly load ids, or check all references. Approved only by default. Drafts require includeDrafts for human review and are never available to workers. Status is a routing hint, not authenticated sign-off. No arbitrary paths or network reads.",
      input: obj({ operation: { type: "string", enum: ["list", "suggest", "load", "check"] }, ids: { type: "array", items: { type: "string" } }, area: str("Area for relevance suggestions"), tags: { type: "array", items: { type: "string" } }, query: str("Relevance query; does not select or approve entries"), includeDrafts: bool("Explicitly show/load drafts for human review only; unavailable to workers") }, ["operation"]),
      async execute(input, ctx) {
        try {
          const cfg = cfgNow()
          const root = await host.sessionRoot(ctx.sessionID)
          const worker = (["implementer", "reviewer", "qa"] as Role[]).some((r) => ctx.agent === agentName(cfg, r))
          if (input.includeDrafts && worker) throw new Error("draft standards are for human/planner review, not worker context")
          if (!["list", "suggest", "load", "check"].includes(input.operation)) throw new Error("operation must be list, suggest, load or check")
          if (input.operation === "load") return loadStandards(root, cfg, standardIds(input.ids), input.includeDrafts === true).text
          const index = readStandardsIndex(root, cfg)
          if (!index) return `Standards index missing: ${cfg.standards.index}. Optional until ids are selected; no standards loaded.`
          const entries = input.operation === "suggest" ? suggestStandards(index, input) : index.entries.filter((e) => e.status === "approved" || input.includeDrafts === true)
          if (input.operation === "check") {
            for (const e of entries) loadStandards(root, cfg, [e.id], input.includeDrafts === true)
          }
          return JSON.stringify({ index: cfg.standards.index, notice: "Project reference data subordinate to AGENTS/spec/ADR and guard. Status is a routing hint, NOT authenticated human sign-off. Suggestions do not select entries.", operation: input.operation, entries }, null, 2)
        } catch (e) { return `ERROR: ${(e as Error).message}` }
      },
    },
    {
      name: "tf_status",
      permission: TOOL_PERMISSION.read,
      description: "Taskflow status of this session's worktree: counters per status and epic, ready tasks (as merged on the base branch), tasks in progress/blocked, board freshness, task-file problems; with gh=true also open PRs and recent CI runs.",
      input: obj({ gh: bool("Also query GitHub (open PRs with checks, recent runs)"), directory: str("Worktree to report on (default: this session's)") }),
      async execute(input, ctx) {
        const root = await where(input, ctx)
        const cfg = cfgNow()
        const all = loadTasks(root, cfg).filter((d) => d.data).map(info)
        const out = [summary(root, cfg), ""]
        const merged = await mergedDocs(root, ctx.signal)
        const ready = readyTasks(merged.docs)
        out.push(`Ready on ${merged.source} (${ready.length}): ${ready.map((t) => `${t.id} ${t.title} [${t.area}/${t.size}]`).join("; ") || "none"}`)
        for (const st of ["in_progress", "review", "blocked"]) {
          const ts = all.filter((t) => t.status === st)
          if (ts.length) out.push(`${st}: ${ts.map((t) => `${t.id}${t.branch ? ` (${t.branch})` : ""}${t.blocked_by.length ? ` blocked_by ${t.blocked_by.join(",")}` : ""}`).join("; ")}`)
        }
        const board = writeBoard(root, cfg, true)
        out.push(`Board ${cfg.paths.board}: ${board.stale ? "STALE (run tf_board)" : "up to date"}`)
        const c = check(root, cfg, { baseRef: baseRef(root) })
        out.push(c.ok ? "tf_check: OK" : `tf_check: ${c.errors.length} error(s):\n  - ${c.errors.join("\n  - ")}`)
        if (input?.gh) {
          const prs = await run("gh", ["pr", "list", "--json", "number,title,headRefName,isDraft,statusCheckRollup,mergeStateStatus,autoMergeRequest"], root, { timeout: NET_TIMEOUT, signal: ctx.signal })
          let list: Array<any> | null = null
          try {
            list = prs.ok ? (JSON.parse(prs.stdout) as Array<any>) : null
          } catch {
            list = null
          }
          if (list) {
            out.push("", `Open PRs (${list.length}):`)
            for (const p of list) {
              const checks = (p.statusCheckRollup ?? []) as Array<any>
              const failed = checks.filter((x) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(x.conclusion ?? x.state)).map((x) => x.name ?? x.context)
              const pending = checks.filter((x) => !x.conclusion && x.status && x.status !== "COMPLETED").length
              out.push(`  #${p.number} ${p.title} [${p.headRefName}] merge=${p.mergeStateStatus}${p.autoMergeRequest ? " auto-merge" : ""} checks: ${failed.length ? `FAILED ${failed.join(",")}` : pending ? `${pending} pending` : "ok"}`)
            }
          } else out.push(`gh pr list failed: ${prs.stderr.trim()}`)
          const runs = await run("gh", ["run", "list", "-L", "5"], root, { timeout: NET_TIMEOUT, signal: ctx.signal })
          if (runs.ok) out.push("", "Recent runs:", runs.stdout.trim())
        }
        return out.join("\n")
      },
    },
    {
      name: "tf_next",
      permission: TOOL_PERMISSION.read,
      description: "List ready tasks: status todo, all depends done, blocked_by empty, read from the base branch on the remote after a fetch (merged work counts without a pull). Ordered by id.",
      input: obj({ worktree: bool("Read the session's working tree instead of the remote base branch") }),
      async execute(input, ctx) {
        const root = await where(input, ctx)
        const cfg = cfgNow()
        const { docs, source } = input?.worktree ? { docs: loadTasks(root, cfg), source: "working tree" } : await mergedDocs(root, ctx.signal)
        const ready = readyTasks(docs)
        if (!ready.length) return `no ready tasks (source: ${source})\n\n${summary(root, cfg)}`
        return `source: ${source}\n` + ready.map((t) => `${t.id}\t${t.title}\tepic ${t.epic}\t${t.area}/${t.size}\tspec: ${t.spec.join(", ") || "-"}\t${t.file}`).join("\n")
      },
    },
    {
      name: "tf_task",
      permission: TOOL_PERMISSION.read,
      description: "Show one task: parsed fields, readiness, worktree (if claimed) and the full task file (from this session's worktree).",
      input: obj({ id: str("Task id, e.g. T-012"), directory: str("Worktree to read from (default: this session's)") }, ["id"]),
      async execute(input, ctx) {
        const root = await where(input, ctx)
        const cfg = cfgNow()
        const docs = loadTasks(root, cfg)
        const t = docs.find((d) => asString(d.data?.id) === input.id)
        if (!t) return `ERROR: task ${input.id} not found in ${cfg.paths.tasks}/ of ${root}`
        const i = info(t)
        const why = i.status === "todo" ? notReadyReason(docs, i.id) : null
        const wt = taskWorktree(root, cfg, i.id)
        return [
          `${i.id} ${i.title}`,
          `status ${i.status} · epic ${i.epic} · ${i.area}/${i.size} · depends ${i.depends.join(", ") || "-"} · blocked_by ${i.blocked_by.join(", ") || "-"}`,
          `spec ${i.spec.join(", ") || "-"} · acceptance ${i.acceptance.join(", ") || "-"} · branch ${i.branch ?? "-"} · pr ${i.pr ?? "-"}`,
          `standards (explicit ids): ${i.standards.join(", ") || "none"}`,
          i.status === "todo" ? `ready: ${why ? `no (${why})` : "yes"}` : "",
          wt ? `worktree: ${wt}` : "",
          `file: ${path.join(root, i.file)}`,
          "",
          t.text,
        ]
          .filter((l) => l !== "")
          .join("\n")
      },
    },
    {
      name: "tf_start",
      permission: TOOL_PERMISSION.write,
      description: "Claim a task: validate it on the base branch, create its worktree + branch, copy env files, run setup commands, set in_progress, regenerate the board and commit. `id` claims an existing task; `title`+`epic`+`area`+`size` create a follow-up task and claim it; `plan` = <slug> creates (or reuses) a planner worktree on plan/<slug> without claiming anything. Returns the absolute worktree path where all further work must happen.",
      input: obj({
        id: str("Existing task id to claim, e.g. T-012"),
        title: str("New task title (creates a task; requires epic, area, size)"),
        epic: str("Epic id for a new task, e.g. E-02"),
        area: str("Area for a new task"),
        size: str("Size for a new task (S|M)"),
        plan: str("Create/reuse the planner worktree plan/<slug> instead of claiming a task"),
        keep: bool("Keep the worktree if a step fails (default: roll back)"),
        offline: bool("Do not fetch; validate against local remote-tracking refs"),
      }),
      async execute(input, ctx) {
        const cfg = cfgNow()
        const cwd = await host.sessionRoot(ctx.sessionID)
        if (input.plan) {
          const r = await planWorktree({ cwd, cfg, slug: input.plan, offline: input.offline, signal: ctx.signal })
          return r.ok ? `✔ planner worktree\nworktree: ${r.worktree}\nbranch: ${r.branch}\n${r.log.map((l) => `  ${l}`).join("\n")}` : `ERROR: ${r.error}\n${r.log.join("\n")}`
        }
        const create = input.title ? { title: input.title, epic: input.epic, area: input.area, size: input.size } : undefined
        const r = await claim({ cwd, cfg, id: input.id, create, keep: input.keep, offline: input.offline, signal: ctx.signal })
        const log = r.log.map((l) => `  ${l}`).join("\n")
        if (!r.ok) return `ERROR: ${r.error}\n${log}`
        return `✔ ${r.id} claimed\nworktree: ${r.worktree}\nbranch: ${r.branch}\n${log}\nWork only in ${r.worktree}.${create ? " Fill in Goal / Context / Definition of Done in the new task file first." : ""}`
      },
    },
    {
      name: "tf_set",
      permission: TOOL_PERMISSION.write,
      description: "Set a task's status (todo|in_progress|review|done|blocked) and optionally branch/pr in this session's worktree (or `directory`), then regenerate the board. Does not commit.",
      input: obj(
        {
          id: str("Task id"),
          status: str("todo | in_progress | review | done | blocked"),
          branch: str("Branch name"),
          pr: str("PR url"),
          directory: str("Worktree to operate in (default: this session's)"),
        },
        ["id", "status"],
      ),
      async execute(input, ctx) {
        const root = await where(input, ctx)
        const cfg = cfgNow()
        const layout = host.layout()
        if (path.resolve(root) === path.resolve(layout.mainDir) && tryGit(["branch", "--show-current"], root) === layout.base) {
          return `ERROR: ${root} is the main checkout on ${layout.base}; task status changes belong in the task's worktree (pass directory)`
        }
        try {
          const msg = setStatus(root, cfg, input.id, input.status, { branch: input.branch, pr: input.pr })
          const b = writeBoard(root, cfg)
          return `${msg} (in ${root})\nboard ${b.written ? "regenerated" : "unchanged"} (${cfg.paths.board}); commit both files.`
        } catch (e) {
          return `ERROR: ${(e as Error).message}`
        }
      },
    },
    {
      name: "tf_check",
      permission: TOOL_PERMISSION.read,
      description: "Validate epics and tasks in this session's worktree (or `directory`): fields and enums, unique ids, file names, known epics/depends/spec ids, optional explicit approved standards bindings and their bounded sources, no cycles, done => pr + all DoD ticked + Result, in_progress => branch, id collisions with the base branch. gh=true also warns when a done task's PR is not merged.",
      input: obj({ gh: bool("Also check PR states with gh"), directory: str("Worktree to check (default: this session's)") }),
      async execute(input, ctx) {
        const root = await where(input, ctx)
        const cfg = cfgNow()
        const states = new Map<string, string | null>()
        if (input?.gh) {
          for (const t of loadTasks(root, cfg)) {
            const pr = asString(t.data?.pr)
            if (pr && /^https?:\/\//.test(pr) && asString(t.data?.status) === "done") states.set(pr, await prState(pr, root))
          }
        }
        const r = check(root, cfg, { baseRef: baseRef(root), prState: input?.gh ? (u) => states.get(u) ?? null : undefined })
        const board = writeBoard(root, cfg, true)
        const lines = [r.ok ? `tf_check OK (${r.epics} epics, ${r.tasks} tasks) in ${root}` : `tf_check FAILED (${r.errors.length}) in ${root}:\n  - ${r.errors.join("\n  - ")}`]
        for (const w of r.warnings) lines.push(`warning: ${w}`)
        if (board.stale) lines.push(`board ${cfg.paths.board} is STALE: run tf_board`)
        return lines.join("\n")
      },
    },
    {
      name: "tf_board",
      permission: TOOL_PERMISSION.write,
      description: "Regenerate the task board in this session's worktree (or `directory`) from task/epic frontmatter; check=true only reports staleness.",
      input: obj({ check: bool("Only report whether the board is stale"), directory: str("Worktree (default: this session's)") }),
      async execute(input, ctx) {
        const root = await where(input, ctx)
        const cfg = cfgNow()
        const b = writeBoard(root, cfg, !!input?.check)
        const state = input?.check ? (b.stale ? "STALE" : "up to date") : b.written ? "written" : "already up to date"
        return `${cfg.paths.board} in ${root}: ${state}\n${summary(root, cfg)}`
      },
    },
    {
      name: "tf_clean",
      permission: TOOL_PERMISSION.write,
      description: "After the task's PR is MERGED: remove its worktree and local branch (refuses if the PR is not merged or local commits would be lost), then fast-forward the main checkout to the base branch when it is clean. remote=true also deletes the remote branch.",
      input: obj({ id: str("Task id"), remote: bool("Also delete the remote branch") }, ["id"]),
      async execute(input, ctx) {
        const r = await clean({ cwd: host.layout().mainDir, cfg: cfgNow(), id: input.id, remoteBranch: input.remote, signal: ctx.signal })
        return r.ok ? `✔ ${r.log.join("\n")}` : `ERROR: ${r.error}\n${r.log.join("\n")}`
      },
    },
    {
      name: "tf_models",
      permission: TOOL_PERMISSION.read,
      description: "Doctor: config files in effect (and invalid values), base branch, verify commands, and the model each role and category resolves to from its chain (with skipped entries and reasons).",
      input: obj({}),
      async execute() {
        await host.refreshModels()
        const cfg = cfgNow()
        const available = host.models()
        const layout = host.layout()
        const lines = [`main checkout: ${layout.mainDir}`, `worktrees: ${layout.worktreeParent}`, `base branch: ${layout.base}`, "config sources:"]
        const src = host.configSources()
        lines.push(...(src.length ? src.map((s) => `  ${s.ok ? "ok " : "ERR"} ${s.path}${s.error ? ` (${s.error})` : ""}`) : ["  (defaults only)"]))
        lines.push(`verify: full=${cfg.verify.full ?? "-"} quick=${cfg.verify.quick ?? "-"} e2e=${cfg.verify.e2e ?? "-"}`)
        lines.push(`protected: ${cfg.protected.join(", ") || "-"}`, `available models: ${available.length}`, "", "roles:")
        for (const r of resolveRoleModels(cfg, available)) {
          lines.push(`  ${r.role} -> agent "${r.agent}"${r.disabled ? " (disabled)" : ""}: ${fmtModel(r.model)}`)
          for (const s of r.skipped) lines.push(`      skipped ${s.entry}: ${s.reason}`)
        }
        lines.push("", "categories:")
        for (const [name, c] of Object.entries(cfg.categories)) {
          const r = resolveChain(c.models, available)
          lines.push(`  ${name}: ${fmtModel(r.model)}${c.description ? ` (${c.description})` : ""}`)
          for (const s of r.skipped) lines.push(`      skipped ${s.entry}: ${s.reason}`)
        }
        lines.push("", `routing: ${cfg.routing.map((r) => `${JSON.stringify(r.when)} -> ${r.category}`).join("; ") || "(none)"}`)
        return lines.join("\n")
      },
    },
    {
      name: "tf_dispatch",
      permission: TOOL_PERMISSION.dispatch,
      description: "Run a role agent (planner|implementer|reviewer|qa) as a child session and wait for its final answer. Pass `task` to both implementer and reviewer: the exact approved standards binding is loaded from the task worktree before child creation (reviewer still runs from main). The implementer's task size/area may route its model. For planner pass `directory` = its plan worktree (tf_start plan). Pass `sessionID` to continue a child. Returns final message, outcome, errors, selected standards ids/paths/hashes.",
      input: obj(
        {
          role: str("planner | implementer | reviewer | qa"),
          prompt: str("Complete instructions; the child starts with a fresh context"),
          task: str("Task id this work belongs to"),
          directory: str("Working directory for the child (default: the task's worktree, else the main checkout)"),
          sessionID: str("Continue this child with its original role/task association (recovered from session metadata). Omitted task reuses it; contradictory task/role/parent/directory is rejected. Unrecoverable legacy sessions require a new child."),
        },
        ["role", "prompt"],
      ),
      async execute(input, ctx) {
        const role = input.role as Role
        if (!ROLES.includes(role) || role === "lead") return "ERROR: role must be one of planner, implementer, reviewer, qa"
        if (!mayDispatch(cfgNow(), ctx.agent)) return `ERROR: ${ctx.agent} may not dispatch other agents; only the lead (or the human's own session) does`
        try {
          const r = await host.dispatch({ role, prompt: input.prompt, task: input.task, directory: input.directory, sessionID: input.sessionID, parentSessionID: ctx.sessionID, callerAgent: ctx.agent, signal: ctx.signal })
          return [
            `child session: ${r.sessionID}`,
            `agent: ${r.agent} · model: ${r.model ?? "inherited"} · directory: ${r.directory} · outcome: ${r.outcome ?? "unknown"}`,
            `standards: ${r.standards?.map((s) => `${s.id} -> ${s.path} (sha256 ${s.sha256})`).join("; ") || "none explicitly selected"}`,
            r.error ? `ERROR in child: ${r.error}` : "",
            "",
            r.text || "(no final text)",
          ]
            .filter((l, i) => l !== "" || i === 3)
            .join("\n")
        } catch (e) {
          return `ERROR: dispatch failed: ${(e as Error).message}`
        }
      },
    },
    {
      name: "tf_init",
      permission: TOOL_PERMISSION.write,
      description: "Scaffold Taskflow using effective layout paths (fresh projects: only .taskflow/), without overwriting existing files or creating a live example epic. Empty standards index, process templates and workflow. External AGENTS/GitHub integrations require explicit opt-in. No migration or invented approvals.",
      input: obj({ language: str("Human language code for human-facing texts, e.g. ru or en"), agentsLink: bool("Explicitly opt in to creating/appending an AGENTS.md workflow link"), githubTemplate: bool("Explicitly opt in to adding a GitHub human-review template; never overwrite") }),
      async execute(input, ctx) {
        const root = await host.sessionRoot(ctx.sessionID)
        const r = init(root, cfgNow(), host.layout(), { human: input?.language, agentsLink: input?.agentsLink === true, githubTemplate: input?.githubTemplate === true })
        await host.reloadRegistrations()
        const d = r.detected
        return [
          `created in ${root}:\n${r.created.map((c) => `  + ${c}`).join("\n") || "  (nothing)"}`,
          r.skipped.length ? `kept existing:\n${r.skipped.map((c) => `  = ${c}`).join("\n")}` : "",
          `detected: package manager ${d.packageManager ?? "-"}, install ${d.install ?? "-"}, verify ${d.verify.full ?? "-"}, quick ${d.verify.quick ?? "-"}, e2e ${d.verify.e2e ?? "-"}, base ${d.baseBranch}, repo ${d.repo ?? "-"}`,
          `Review ${cfgNow().paths.config} (verify commands, CI checks, protected paths, areas, env files), then commit the scaffold. No existing files moved; legacy migration needs a separate approved inventory and plan.`,
        ]
          .filter(Boolean)
          .join("\n")
      },
    },
  ]
}

/** Last assistant text, plus the error of the last failed assistant message if any. */
export function lastAssistantText(messages: ReadonlyArray<any>): string {
  return childResult(messages).text
}

export function childResult(messages: ReadonlyArray<any>): { text: string; error: string | null; outcome: string | null } {
  let text = ""
  let error: string | null = null
  let outcome: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (outcome === null && m?.type === "idle" && typeof m.outcome === "string") outcome = m.outcome
    if (m?.type !== "assistant") continue
    if (error === null && m.error) error = typeof m.error === "string" ? m.error : (m.error.message ?? JSON.stringify(m.error))
    if (!text) {
      text = (m.content ?? [])
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
        .trim()
    }
    if (text && outcome !== null) break
  }
  return { text, error, outcome }
}

export { detectBaseBranch }

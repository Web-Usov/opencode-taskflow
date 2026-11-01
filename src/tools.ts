import fs from "node:fs"
import path from "node:path"
import type { Role, TaskflowConfig } from "./config.ts"
import { agentChain, agentName, ROLES } from "./config.ts"
import { claim, clean } from "./core/claim.ts"
import { asString } from "./core/frontmatter.ts"
import { detectBaseBranch, run, tryGit } from "./core/git.ts"
import { init } from "./core/init.ts"
import { formatModelRef, resolveChain, routeCategory, type AvailableModel, type ModelRef } from "./core/models.ts"
import { check, info, loadTasks, notReadyReason, readyTasks, setStatus, summary, writeBoard } from "./core/tasks.ts"

/** What the tools need from the plugin host; injected so the tools are testable without OpenCode. */
export interface ToolHost {
  root: () => string
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
  signal: AbortSignal
}

export interface DispatchResult {
  sessionID: string
  agent: string
  model: string | null
  directory: string
  text: string
}

export interface ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: any, ctx: { sessionID: string; signal: AbortSignal }) => Promise<string>
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

export function buildTools(host: ToolHost): ToolDef[] {
  const base = () => {
    const cfg = host.config()
    return detectBaseBranch(host.root(), cfg.git.remote, cfg.git.baseBranch)
  }
  const baseRef = () => {
    const cfg = host.config()
    const b = base()
    return tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${cfg.git.remote}/${b}`], host.root()) ? `${cfg.git.remote}/${b}` : null
  }
  const prState = (url: string) => {
    const r = run("gh", ["pr", "view", url, "--json", "state"], host.root())
    if (!r.ok) return null
    try {
      return JSON.parse(r.stdout).state as string
    } catch {
      return null
    }
  }

  return [
    {
      name: "tf_status",
      description: "Taskflow status: counters per status and epic, ready tasks, tasks in progress/blocked, board freshness, task-file problems; with gh=true also open PRs and recent CI runs.",
      input: obj({ gh: bool("Also query GitHub (open PRs with checks, recent runs)") }),
      async execute(input) {
        const root = host.root()
        const cfg = host.config()
        const docs = loadTasks(root, cfg)
        const all = docs.filter((d) => d.data).map(info)
        const out = [summary(root, cfg), ""]
        const ready = readyTasks(docs)
        out.push(`Ready (${ready.length}): ${ready.map((t) => `${t.id} ${t.title} [${t.area}/${t.size}]`).join("; ") || "none"}`)
        for (const st of ["in_progress", "review", "blocked"]) {
          const ts = all.filter((t) => t.status === st)
          if (ts.length) out.push(`${st}: ${ts.map((t) => `${t.id}${t.branch ? ` (${t.branch})` : ""}${t.blocked_by.length ? ` blocked_by ${t.blocked_by.join(",")}` : ""}`).join("; ")}`)
        }
        const board = writeBoard(root, cfg, true)
        out.push(`Board ${cfg.paths.board}: ${board.stale ? "STALE (run tf_board)" : "up to date"}`)
        const c = check(root, cfg, { baseRef: baseRef() })
        out.push(c.ok ? "tf_check: OK" : `tf_check: ${c.errors.length} error(s):\n  - ${c.errors.join("\n  - ")}`)
        if (input?.gh) {
          const prs = run("gh", ["pr", "list", "--json", "number,title,headRefName,isDraft,statusCheckRollup,mergeStateStatus,autoMergeRequest"], root)
          if (prs.ok) {
            const list = JSON.parse(prs.stdout) as Array<any>
            out.push("", `Open PRs (${list.length}):`)
            for (const p of list) {
              const checks = (p.statusCheckRollup ?? []) as Array<any>
              const failed = checks.filter((x) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(x.conclusion ?? x.state)).map((x) => x.name ?? x.context)
              const pending = checks.filter((x) => !x.conclusion && x.status && x.status !== "COMPLETED").length
              out.push(`  #${p.number} ${p.title} [${p.headRefName}] merge=${p.mergeStateStatus}${p.autoMergeRequest ? " auto-merge" : ""} checks: ${failed.length ? `FAILED ${failed.join(",")}` : pending ? `${pending} pending` : "ok"}`)
            }
          } else out.push(`gh pr list failed: ${prs.stderr.trim()}`)
          const runs = run("gh", ["run", "list", "-L", "5"], root)
          if (runs.ok) out.push("", "Recent runs:", runs.stdout.trim())
        }
        return out.join("\n")
      },
    },
    {
      name: "tf_next",
      description: "List ready tasks: status todo, all depends done, blocked_by empty. Ordered by id.",
      input: obj({}),
      async execute() {
        const root = host.root()
        const cfg = host.config()
        const ready = readyTasks(loadTasks(root, cfg))
        if (!ready.length) return `no ready tasks\n\n${summary(root, cfg)}`
        return ready.map((t) => `${t.id}\t${t.title}\tepic ${t.epic}\t${t.area}/${t.size}\tspec: ${t.spec.join(", ") || "-"}\t${t.file}`).join("\n") + `\n\n${summary(root, cfg)}`
      },
    },
    {
      name: "tf_task",
      description: "Show one task: parsed fields, readiness, worktree (if claimed) and the full task file.",
      input: obj({ id: str("Task id, e.g. T-012") }, ["id"]),
      async execute(input) {
        const root = host.root()
        const cfg = host.config()
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
      description: "Claim a task: validate it on the base branch, create its worktree + branch, copy env files, run setup commands, set in_progress, regenerate the board and commit. Pass `id` to claim an existing task, or `title`+`epic`+`area`+`size` to create a new follow-up task and claim it. Returns the absolute worktree path where all further work must happen.",
      input: obj({
        id: str("Existing task id to claim, e.g. T-012"),
        title: str("New task title (creates a task; requires epic, area, size)"),
        epic: str("Epic id for a new task, e.g. E-02"),
        area: str("Area for a new task"),
        size: str("Size for a new task (S|M)"),
        keep: bool("Keep the worktree if a step fails (default: roll back)"),
      }),
      async execute(input) {
        const cfg = host.config()
        const create = input.title ? { title: input.title, epic: input.epic, area: input.area, size: input.size } : undefined
        const r = claim({ cwd: host.root(), cfg, id: input.id, create, keep: input.keep })
        const log = r.log.map((l) => `  ${l}`).join("\n")
        if (!r.ok) return `ERROR: ${r.error}\n${log}`
        return `✔ ${r.id} claimed\nworktree: ${r.worktree}\nbranch: ${r.branch}\n${log}\nWork only in ${r.worktree}.${create ? " Fill in Goal / Context / Definition of Done in the new task file first." : ""}`
      },
    },
    {
      name: "tf_set",
      description: "Set a task's status (todo|in_progress|review|done|blocked) and optionally branch/pr in the CURRENT worktree's task file, then regenerate the board. Does not commit.",
      input: obj(
        {
          id: str("Task id"),
          status: str("todo | in_progress | review | done | blocked"),
          branch: str("Branch name"),
          pr: str("PR url"),
          directory: str("Worktree to operate in (default: this session's directory)"),
        },
        ["id", "status"],
      ),
      async execute(input) {
        const root = input.directory ?? host.root()
        const cfg = host.config()
        try {
          const msg = setStatus(root, cfg, input.id, input.status, { branch: input.branch, pr: input.pr })
          const b = writeBoard(root, cfg)
          return `${msg}\nboard ${b.written ? "regenerated" : "unchanged"} (${cfg.paths.board}); commit both files.`
        } catch (e) {
          return `ERROR: ${(e as Error).message}`
        }
      },
    },
    {
      name: "tf_check",
      description: "Validate epics and tasks: required fields and enums, unique ids, file names, known epics/depends/spec ids, no dependency cycles, done => pr + all DoD ticked + Result, in_progress => branch, id collisions with the base branch. gh=true also warns when a done task's PR is not merged.",
      input: obj({ gh: bool("Also check PR states with gh"), directory: str("Worktree to check (default: this session's directory)") }),
      async execute(input) {
        const root = input?.directory ?? host.root()
        const cfg = host.config()
        const r = check(root, cfg, { baseRef: baseRef(), prState: input?.gh ? prState : undefined })
        const board = writeBoard(root, cfg, true)
        const lines = [r.ok ? `tf_check OK (${r.epics} epics, ${r.tasks} tasks)` : `tf_check FAILED (${r.errors.length}):\n  - ${r.errors.join("\n  - ")}`]
        for (const w of r.warnings) lines.push(`warning: ${w}`)
        if (board.stale) lines.push(`board ${cfg.paths.board} is STALE: run tf_board`)
        return lines.join("\n")
      },
    },
    {
      name: "tf_board",
      description: "Regenerate the task board file from task/epic frontmatter (check=true only reports staleness).",
      input: obj({ check: bool("Only report whether the board is stale"), directory: str("Worktree (default: this session's directory)") }),
      async execute(input) {
        const root = input?.directory ?? host.root()
        const cfg = host.config()
        const b = writeBoard(root, cfg, !!input?.check)
        const state = input?.check ? (b.stale ? "STALE" : "up to date") : b.written ? "written" : "already up to date"
        return `${cfg.paths.board}: ${state}\n${summary(root, cfg)}`
      },
    },
    {
      name: "tf_clean",
      description: "After the task's PR is MERGED: remove its worktree and local branch (refuses if the PR is not merged or local commits would be lost). remote=true also deletes the remote branch.",
      input: obj({ id: str("Task id"), remote: bool("Also delete the remote branch") }, ["id"]),
      async execute(input) {
        const r = clean({ cwd: host.root(), cfg: host.config(), id: input.id, remoteBranch: input.remote })
        return r.ok ? `✔ ${r.log.join("\n")}` : `ERROR: ${r.error}\n${r.log.join("\n")}`
      },
    },
    {
      name: "tf_models",
      description: "Doctor: config files in effect, base branch, verify commands, and the model each role and category resolves to from its chain (with skipped entries and reasons).",
      input: obj({}),
      async execute() {
        await host.refreshModels()
        const cfg = host.config()
        const available = host.models()
        const lines = [`root: ${host.root()}`, `base branch: ${base()}`, "config sources:"]
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
      description: "Run a role agent (planner|implementer|reviewer|qa) as a child session and wait for its final answer. For the implementer pass `task` (its worktree becomes the working directory and its size/area may route the model). Pass `sessionID` to continue a previous child session (e.g. send review findings back to the same implementer). Returns the child's final message.",
      input: obj(
        {
          role: str("planner | implementer | reviewer | qa"),
          prompt: str("Complete instructions; the child starts with a fresh context"),
          task: str("Task id this work belongs to"),
          directory: str("Working directory for the child (default: the task's worktree, else this session's directory)"),
          sessionID: str("Continue this child session instead of creating a new one"),
        },
        ["role", "prompt"],
      ),
      async execute(input, ctx) {
        const role = input.role as Role
        if (!ROLES.includes(role) || role === "lead") return `ERROR: role must be one of planner, implementer, reviewer, qa`
        try {
          const r = await host.dispatch({ role, prompt: input.prompt, task: input.task, directory: input.directory, sessionID: input.sessionID, parentSessionID: ctx.sessionID, signal: ctx.signal })
          return `child session: ${r.sessionID}\nagent: ${r.agent} · model: ${r.model ?? "inherited"} · directory: ${r.directory}\n\n${r.text || "(no final text)"}`
        } catch (e) {
          return `ERROR: dispatch failed: ${(e as Error).message}`
        }
      },
    },
    {
      name: "tf_init",
      description: "Scaffold the taskflow process in this repository without overwriting anything: .opencode/taskflow.jsonc (with detected verify/setup commands), task template, epics README and example, PR templates, docs/taskflow.md, AGENTS.md section, task board.",
      input: obj({ language: str("Human language code for human-facing texts, e.g. ru or en") }),
      async execute(input) {
        const root = host.root()
        const cfg = host.config()
        const r = init(root, cfg, base(), { human: input?.language })
        await host.reloadRegistrations()
        const d = r.detected
        return [
          `created:\n${r.created.map((c) => `  + ${c}`).join("\n") || "  (nothing)"}`,
          r.skipped.length ? `kept existing:\n${r.skipped.map((c) => `  = ${c}`).join("\n")}` : "",
          `detected: package manager ${d.packageManager ?? "-"}, install ${d.install ?? "-"}, verify ${d.verify.full ?? "-"}, quick ${d.verify.quick ?? "-"}, e2e ${d.verify.e2e ?? "-"}, base ${d.baseBranch}, repo ${d.repo ?? "-"}`,
          "Review .opencode/taskflow.jsonc (verify commands, CI checks, protected paths, areas, env files), then commit the scaffold.",
        ]
          .filter(Boolean)
          .join("\n")
      },
    },
  ]
}

export function lastAssistantText(messages: ReadonlyArray<any>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== "assistant") continue
    const text = (m.content ?? [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

export const exists = (p: string) => fs.existsSync(p)

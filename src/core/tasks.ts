import fs from "node:fs"
import path from "node:path"
import { taskIdRe, type TaskflowConfig } from "../config.ts"
import { asList, asString, parseFrontmatter, sectionBody, setField, type Frontmatter } from "./frontmatter.ts"
import { tryGit } from "./git.ts"
import { taskStandards } from "./standards.ts"

export const TASK_STATUS = ["todo", "in_progress", "review", "done", "blocked"] as const
export const EPIC_STATUS = ["planned", "in_progress", "done", "accepted"] as const
export type TaskStatus = (typeof TASK_STATUS)[number]

export interface Doc {
  file: string
  name: string
  rel: string
  data: Frontmatter | null
  text: string
}

const toPosix = (p: string) => p.split(path.sep).join("/")

function loadDir(root: string, dir: string, filter: RegExp): Doc[] {
  const abs = path.join(root, dir)
  if (!fs.existsSync(abs)) return []
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith(".md") && filter.test(f))
    .sort()
    .map((f) => {
      const file = path.join(abs, f)
      const { data, text } = parseFrontmatter(fs.readFileSync(file, "utf8"))
      return { file, name: f, rel: toPosix(path.relative(root, file)), data, text }
    })
}

export const loadTasks = (root: string, cfg: TaskflowConfig) => loadDir(root, cfg.paths.tasks, /^T-.*\.md$/)

/** Task files as committed on a ref (e.g. `origin/main`), so readiness reflects merged work without a pull. */
export function loadTasksFromRef(root: string, cfg: TaskflowConfig, ref: string): Doc[] | null {
  const list = tryGit(["ls-tree", "--name-only", ref, `${cfg.paths.tasks}/`], root)
  if (list === null) return null
  return list
    .split("\n")
    .filter((f) => /^T-.*\.md$/.test(path.basename(f)))
    .sort()
    .map((f) => {
      const { data, text } = parseFrontmatter(tryGit(["show", `${ref}:${f}`], root) ?? "")
      return { file: path.join(root, f), name: path.basename(f), rel: f, data, text }
    })
}
export const loadEpics = (root: string, cfg: TaskflowConfig) => loadDir(root, cfg.paths.epics, /^E-.*\.md$/)

export const taskNum = (id: string) => parseInt(id.slice(2), 10)

/** Short view of a task for tools and prompts. */
export interface TaskInfo {
  id: string
  title: string
  status: string
  epic: string
  area: string
  size: string
  depends: string[]
  blocked_by: string[]
  spec: string[]
  acceptance: string[]
  standards: string[]
  branch: string | null
  pr: string | null
  file: string
}

export function info(t: Doc): TaskInfo {
  const d = t.data ?? {}
  return {
    id: asString(d.id) ?? "",
    title: asString(d.title) ?? "",
    status: asString(d.status) ?? "",
    epic: asString(d.epic) ?? "",
    area: asString(d.area) ?? "",
    size: asString(d.size) ?? "",
    depends: asList(d.depends),
    blocked_by: asList(d.blocked_by),
    spec: asList(d.spec),
    acceptance: asList(d.acceptance),
    standards: asList(d.standards),
    branch: asString(d.branch),
    pr: asString(d.pr),
    file: t.rel,
  }
}

// ---------- spec ----------

export interface SpecIndex {
  ids: Set<string>
  questions: Set<string>
  enabled: boolean
}

export function loadSpec(root: string, cfg: TaskflowConfig): SpecIndex {
  const s = cfg.spec
  if (!s) return { ids: new Set(), questions: new Set(), enabled: false }
  const ids = new Set<string>()
  const dir = path.join(root, s.dir)
  if (fs.existsSync(dir)) {
    const re = new RegExp(s.definition, "g")
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".md") && x !== "README.md").sort()) {
      for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(re)) {
        const id = m.slice(1).find((g) => g !== undefined)
        if (id) ids.add(id)
      }
    }
  }
  const questions = new Set<string>()
  if (s.questions) {
    const q = path.join(root, s.questions)
    if (fs.existsSync(q)) for (const m of fs.readFileSync(q, "utf8").matchAll(new RegExp(s.questionPattern, "g"))) questions.add(m[1]!)
  }
  return { ids, questions, enabled: true }
}

// ---------- check ----------

export interface CheckResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  epics: number
  tasks: number
}

/** Task file names (basenames) on `<remote>/<base>`; [] when git or the ref is unavailable. */
function baseTaskFiles(root: string, cfg: TaskflowConfig, baseRef: string | null): string[] {
  if (!baseRef) return []
  const out = tryGit(["ls-tree", "--name-only", baseRef, `${cfg.paths.tasks}/`], root)
  if (!out) return []
  return out
    .split("\n")
    .map((f) => path.basename(f))
    .filter((f) => /^T-\d+-.*\.md$/.test(f))
}

export interface CheckOptions {
  /** e.g. `origin/main`; enables the id-collision check. */
  baseRef?: string | null
  /** PR url -> state ("MERGED", "OPEN", ...); enables the "done but not merged" warning. */
  prState?: (url: string) => string | null
}

export function check(root: string, cfg: TaskflowConfig, opts: CheckOptions = {}): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []
  const err = (rel: string, msg: string) => errors.push(`${rel}: ${msg}`)
  const spec = loadSpec(root, cfg)
  const known = (id: string) => !spec.enabled || spec.ids.has(id)

  const epics = loadEpics(root, cfg)
  const epicIds = new Map<string, Frontmatter>()
  for (const e of epics) {
    const d = e.data
    if (!d) {
      err(e.rel, "missing frontmatter")
      continue
    }
    const id = asString(d.id) ?? ""
    if (!/^E-\d{2,}$/.test(id)) err(e.rel, `invalid id "${id}" (expected E-NN)`)
    else if (!e.name.startsWith(`${id}-`)) err(e.rel, `file name does not start with id ${id}`)
    if (epicIds.has(id)) err(e.rel, `duplicate epic id ${id}`)
    epicIds.set(id, d)
    if (!d.title) err(e.rel, "missing title")
    const status = asString(d.status) ?? ""
    if (!(EPIC_STATUS as readonly string[]).includes(status)) err(e.rel, `invalid status "${status}"`)
    const accepted = asString(d.accepted)
    if (status === "accepted" && !/^\d{4}-\d{2}-\d{2}$/.test(accepted ?? "")) err(e.rel, "status accepted requires accepted: YYYY-MM-DD")
    if (accepted && !/^\d{4}-\d{2}-\d{2}$/.test(accepted)) err(e.rel, `invalid accepted date "${accepted}"`)
    if ("spec" in d && !Array.isArray(d.spec)) err(e.rel, "spec must be a list")
    for (const s of asList(d.spec)) if (!known(s)) err(e.rel, `unknown spec rule ${s}`)
  }

  const tasks = loadTasks(root, cfg)
  const byId = new Map<string, Doc>()
  const accRe = cfg.spec ? new RegExp(cfg.spec.acceptancePattern) : null
  const idRe = taskIdRe(cfg)
  for (const t of tasks) {
    const d = t.data
    if (!d) {
      err(t.rel, "missing frontmatter")
      continue
    }
    const id = asString(d.id) ?? ""
    const fm = t.name.match(new RegExp(`^(T-\\d{${cfg.task.idPadding},})-[a-z0-9-]+\\.md$`))
    if (!fm) err(t.rel, "file name must match T-NNN-slug.md")
    if (!idRe.test(id)) err(t.rel, `invalid id "${id}" (expected T- and at least ${cfg.task.idPadding} digits)`)
    else if (fm && fm[1] !== id) err(t.rel, `file name id ${fm[1]} does not match frontmatter id ${id}`)
    if (byId.has(id)) err(t.rel, `duplicate task id ${id}`)
    byId.set(id, t)
    if (!d.title) err(t.rel, "missing title")
    const status = asString(d.status) ?? ""
    if (!(TASK_STATUS as readonly string[]).includes(status)) err(t.rel, `invalid status "${status}"`)
    if (!cfg.task.areas.includes(asString(d.area) ?? "")) err(t.rel, `invalid area "${d.area}" (${cfg.task.areas.join("|")})`)
    if (!cfg.task.sizes.includes(asString(d.size) ?? "")) err(t.rel, `invalid size "${d.size}" (${cfg.task.sizes.join("|")})`)
    if (!epicIds.has(asString(d.epic) ?? "")) err(t.rel, `unknown epic "${d.epic}"`)
    for (const k of ["depends", "blocked_by", "spec", "acceptance"]) {
      if (!Array.isArray(d[k])) err(t.rel, `${k} must be a list (use [])`)
    }
    if ("standards" in d) {
      try { taskStandards(root, cfg, d.standards) }
      catch (e) { err(t.rel, (e as Error).message) }
    }
    if (spec.enabled && cfg.spec?.questions) {
      for (const q of asList(d.blocked_by)) if (!spec.questions.has(q)) err(t.rel, `blocked_by ${q} not found in ${cfg.spec.questions}`)
    }
    for (const s of asList(d.spec)) if (!known(s)) err(t.rel, `unknown spec rule ${s}`)
    for (const a of asList(d.acceptance)) {
      if (accRe && !accRe.test(a)) err(t.rel, `acceptance "${a}" is not an acceptance id`)
      else if (!known(a)) err(t.rel, `unknown acceptance ${a}`)
    }
    if (status === "done") {
      if (!d.pr) err(t.rel, "status done requires pr")
      const dod = sectionBody(t.text, "Definition of Done")
      const open = (dod ?? "").split(/\r?\n/).filter((l) => /^\s*- \[ \]/.test(l))
      if (open.length) {
        err(t.rel, `status done but ${open.length} unchecked Definition of Done item(s): ${open.map((l) => l.trim().slice(0, 50)).join(" | ")}`)
      }
      if (!(sectionBody(t.text, "Result") ?? "").trim()) err(t.rel, 'status done requires a non-empty "## Result" section')
    }
    if ((status === "in_progress" || status === "review") && !d.branch) err(t.rel, `status ${status} requires branch`)
    if (!("branch" in d)) err(t.rel, "missing branch (use null)")
    if (!("pr" in d)) err(t.rel, "missing pr (use null)")
  }
  for (const t of tasks) {
    const id = asString(t.data?.id)
    for (const dep of asList(t.data?.depends)) {
      if (!byId.has(dep)) err(t.rel, `depends on unknown task ${dep}`)
      else if (dep === id) err(t.rel, "depends on itself")
    }
  }

  // id collision with a different task file on the base branch (two branches allocated the same id)
  const baseFiles = baseTaskFiles(root, cfg, opts.baseRef ?? null)
  for (const t of tasks) {
    const id = asString(t.data?.id)
    if (!id) continue
    const clash = baseFiles.find((f) => f !== t.name && f.startsWith(`${id}-`))
    if (clash) {
      err(t.rel, `task id ${id} is already used on ${opts.baseRef} by ${clash}; if the file was only renamed there, merge ${opts.baseRef} first, otherwise renumber this task (new id, file name, branch)`)
    }
  }

  // dependency cycles (DFS)
  const state = new Map<string, number>()
  const stack: string[] = []
  const visit = (id: string) => {
    if (state.get(id) === 2) return
    if (state.get(id) === 1) {
      errors.push(`dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(" -> ")}`)
      return
    }
    state.set(id, 1)
    stack.push(id)
    for (const dep of asList(byId.get(id)?.data?.depends)) if (byId.has(dep)) visit(dep)
    stack.pop()
    state.set(id, 2)
  }
  for (const id of byId.keys()) visit(id)

  if (opts.prState) {
    for (const t of tasks) {
      const pr = asString(t.data?.pr)
      if (!pr || !/^https?:\/\//.test(pr) || asString(t.data?.status) !== "done") continue
      const st = opts.prState(pr)
      if (st && st !== "MERGED") warnings.push(`${t.rel}: status done but PR is ${st}`)
    }
  }

  return { ok: errors.length === 0, errors, warnings, epics: epics.length, tasks: tasks.length }
}

// ---------- board ----------

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

/**
 * The committed board is a pure per-task listing without aggregates, so two PRs that change different tasks merge
 * textually clean and still equal the regenerated board. Tasks are separated by blank lines (adjacent changed lines would
 * conflict in a 3-way merge). Aggregates go to `summary`.
 */
export function renderBoard(root: string, cfg: TaskflowConfig): string {
  const epics = loadEpics(root, cfg)
    .filter((e) => e.data)
    .sort((a, b) => (asString(a.data!.id) ?? "").localeCompare(asString(b.data!.id) ?? ""))
  const tasks = loadTasks(root, cfg)
    .filter((t) => t.data)
    .sort((a, b) => taskNum(asString(a.data!.id) ?? "T-0") - taskNum(asString(b.data!.id) ?? "T-0"))
  const boardDir = path.dirname(path.join(root, cfg.paths.board))
  const lines = [...cfg.board.header]
  for (const e of epics) {
    const d = e.data!
    const accepted = asString(d.accepted)
    const id = asString(d.id) ?? ""
    lines.push(
      fill(cfg.board.epicLine, {
        id,
        title: asString(d.title) ?? "",
        status: asString(d.status) ?? "",
        accepted: accepted ? (cfg.language.human === "ru" ? `, принят ${accepted}` : `, accepted ${accepted}`) : "",
      }),
      "",
    )
    lines.push(fill(cfg.board.epicLink, { file: e.name, link: toPosix(path.relative(boardDir, e.file)) }), "")
    for (const t of tasks.filter((x) => asString(x.data!.epic) === id)) {
      const i = info(t)
      lines.push(
        fill(cfg.board.taskLine, {
          id: i.id,
          file: toPosix(path.relative(boardDir, t.file)),
          title: i.title,
          status: i.status,
          area: i.area,
          size: i.size,
          depends: i.depends.length ? i.depends.join(", ") : "—",
          pr: i.pr ? `[PR](${i.pr})` : "—",
          epic: i.epic,
        }),
        "",
      )
    }
  }
  return lines.join("\n")
}

/** Aggregate counters (never committed). */
export function summary(root: string, cfg: TaskflowConfig): string {
  const tasks = loadTasks(root, cfg).filter((t) => t.data)
  const count = (st: string) => tasks.filter((t) => asString(t.data!.status) === st).length
  const out = [`Total tasks: ${tasks.length} - ${TASK_STATUS.map((s) => `${s}: ${count(s)}`).join(", ")}`]
  const epics = loadEpics(root, cfg)
    .filter((x) => x.data)
    .sort((a, b) => (asString(a.data!.id) ?? "").localeCompare(asString(b.data!.id) ?? ""))
  for (const e of epics) {
    const id = asString(e.data!.id)
    const et = tasks.filter((t) => asString(t.data!.epic) === id)
    out.push(`  ${id} ${asString(e.data!.status)}: ${et.filter((t) => asString(t.data!.status) === "done").length}/${et.length} done`)
  }
  return out.join("\n")
}

export interface BoardResult {
  written: boolean
  stale: boolean
  path: string
}

export function writeBoard(root: string, cfg: TaskflowConfig, checkOnly = false): BoardResult {
  const file = path.join(root, cfg.paths.board)
  const content = renderBoard(root, cfg)
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const stale = current !== content
  if (!checkOnly && stale) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return { written: !checkOnly && stale, stale, path: cfg.paths.board }
}

// ---------- next ----------

/** todo tasks whose depends are done and blocked_by is empty, by id. */
export function readyTasks(docs: Doc[]): TaskInfo[] {
  const all = docs.filter((t) => t.data).map(info)
  const done = new Set(all.filter((t) => t.status === "done").map((t) => t.id))
  return all
    .filter((t) => t.status === "todo" && t.depends.every((d) => done.has(d)) && !t.blocked_by.length)
    .sort((a, b) => taskNum(a.id) - taskNum(b.id))
}

/** Why a task is not ready, or null if it is. */
export function notReadyReason(docs: Doc[], id: string): string | null {
  const all = docs.filter((t) => t.data).map(info)
  const t = all.find((x) => x.id === id)
  if (!t) return `${id} not found`
  if (t.status !== "todo") return `${id} has status "${t.status}", expected todo`
  if (t.blocked_by.length) return `${id} is blocked by ${t.blocked_by.join(", ")}`
  const notDone = t.depends.filter((d) => all.find((x) => x.id === d)?.status !== "done")
  if (notDone.length) return `${id} depends on unfinished task(s): ${notDone.join(", ")}`
  return null
}

// ---------- set ----------

export function setStatus(
  root: string,
  cfg: TaskflowConfig,
  id: string,
  status: string,
  opts: { branch?: string; pr?: string } = {},
): string {
  if (!taskIdRe(cfg).test(id)) throw new Error(`invalid task id "${id}"`)
  if (!(TASK_STATUS as readonly string[]).includes(status)) throw new Error(`invalid status "${status}" (${TASK_STATUS.join("|")})`)
  const t = loadTasks(root, cfg).find((x) => asString(x.data?.id) === id)
  if (!t) throw new Error(`task ${id} not found in ${cfg.paths.tasks}/`)
  let text = fs.readFileSync(t.file, "utf8")
  text = setField(text, "status", status)
  if (opts.branch !== undefined) text = setField(text, "branch", opts.branch)
  if (opts.pr !== undefined) text = setField(text, "pr", opts.pr)
  fs.writeFileSync(t.file, text)
  return `${id}: status=${status}${opts.branch ? ` branch=${opts.branch}` : ""}${opts.pr ? ` pr=${opts.pr}` : ""}`
}

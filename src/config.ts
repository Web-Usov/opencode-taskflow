import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Role = "lead" | "planner" | "implementer" | "reviewer" | "qa"
export const ROLES: readonly Role[] = ["lead", "planner", "implementer", "reviewer", "qa"]

export interface AgentConfig {
  /** Agent id registered in OpenCode. Defaults to the role name. */
  name?: string
  /** Shorthand for a one-entry `models` chain. */
  model?: string
  /** Ordered model chain, `provider/model#variant`; the first model OpenCode can serve wins. */
  models?: string[]
  disable?: boolean
  /** Extra permission rules appended after the generated ones (last match wins in OpenCode). */
  permissions?: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
}

export interface CategoryConfig {
  description?: string
  models: string[]
}

export interface RoutingRule {
  when: { size?: string; area?: string }
  category: string
}

/** A file to copy from the main checkout into a new worktree; the first existing candidate is copied to `to`. */
export interface CopySpec {
  to: string
  from: string[]
}

export interface TaskflowConfig {
  /** auto discovers existing standalone ownership; otherwise expects OpenSpec. */
  backend: "auto" | "openspec" | "standalone"
  openspec: { executable: string }
  language: { human: string; agent: string }
  git: {
    remote: string
    /** null = detect from `<remote>/HEAD`, else `main`, else `master`. */
    baseBranch: string | null
    branchPrefix: string
    /** Worktree parent directory, relative to the main checkout. `{repo}` = checkout directory name. */
    worktreeDir: string
  }
  paths: { config: string; tasks: string; epics: string; board: string; template: string; epicTemplate: string; workflow: string; plans: string; standardsGuide: string; prTemplate: string; humanReviewTemplate: string; milestones: string }
  task: { areas: string[]; sizes: string[]; idPadding: number }
  setup: { copy: Array<string | CopySpec>; commands: string[] }
  verify: { full: string | null; quick: string | null; e2e: string | null }
  ci: { checks: string[] }
  /** Paths only the planner edits and only a human merges (glob, `**` allowed). */
  protected: string[]
  /** Paths the QA agent may edit. */
  qaPaths: string[]
  spec: null | {
    dir: string
    /** Regex with one capture group per alternative; the first defined group is the rule id. */
    definition: string
    questions: string | null
    questionPattern: string
    acceptancePattern: string
  }
  board: { header: string[]; epicLine: string; epicLink: string; taskLine: string }
  review: { maxRounds: number; autoMerge: boolean; mergeMethod: "squash" | "merge" | "rebase" }
  parallel: number
  /** Child sessions started by tf_dispatch. */
  dispatch: { timeoutMinutes: number }
  /** Optional reference index; a missing index is harmless until ids are selected. */
  standards: { index: string; roots: string[]; maxContextChars: number }
  agents: Partial<Record<Role, AgentConfig>>
  categories: Record<string, CategoryConfig>
  routing: RoutingRule[]
  commandPrefix: string
}

const BOARD_RU = {
  header: [
    "# Доска задач (генерируется, не редактировать)",
    "",
    "> Файл создаётся инструментом `tf_board` (плагин opencode-taskflow). Источник правды — frontmatter файлов задач и эпиков. Сводные счётчики не хранятся в файле: их печатает `tf_status`.",
    "",
  ],
  epicLine: "## {id}. {title} — {status}{accepted}",
  epicLink: "Эпик: [{file}]({link})",
  taskLine: "- [{id}]({file}) {title} — **{status}** · {area} · {size} · depends: {depends} · {pr}",
}

const BOARD_EN = {
  header: [
    "# Task board (generated, do not edit)",
    "",
    "> Written by the `tf_board` tool (opencode-taskflow plugin). Source of truth: the frontmatter of task and epic files. Counters are not stored here; `tf_status` prints them.",
    "",
  ],
  epicLine: "## {id}. {title} — {status}{accepted}",
  epicLink: "Epic: [{file}]({link})",
  taskLine: "- [{id}]({file}) {title} — **{status}** · {area} · {size} · depends: {depends} · {pr}",
}

export function defaultConfig(humanLanguage = "ru", legacy = false): TaskflowConfig {
  return {
    backend: "auto",
    openspec: { executable: "openspec" },
    language: { human: humanLanguage, agent: "en" },
    git: { remote: "origin", baseBranch: null, branchPrefix: "task/", worktreeDir: "../{repo}-wt" },
    paths: legacy
      ? { config: ".opencode/taskflow.jsonc", tasks: "tasks", epics: "epics", board: "tasks/README.md", template: "tasks/_template.md", epicTemplate: "epics/_template.md", workflow: "docs/taskflow.md", plans: "docs/plans", standardsGuide: "docs/standards/README.md", prTemplate: "docs/taskflow-templates/pull-request.md", humanReviewTemplate: "docs/taskflow-templates/human-review.md", milestones: "docs/milestones" }
      : { config: ".taskflow/config.jsonc", tasks: ".taskflow/tasks", epics: ".taskflow/epics", board: ".taskflow/tasks/README.md", template: ".taskflow/templates/task.md", epicTemplate: ".taskflow/templates/epic.md", workflow: ".taskflow/workflow.md", plans: ".taskflow/plans", standardsGuide: ".taskflow/standards/README.md", prTemplate: ".taskflow/templates/pull-request.md", humanReviewTemplate: ".taskflow/templates/human-review.md", milestones: ".taskflow/milestones" },
    task: { areas: ["api", "web", "mobile", "infra", "docs"], sizes: ["S", "M"], idPadding: 3 },
    setup: { copy: [], commands: [] },
    verify: { full: null, quick: null, e2e: null },
    ci: { checks: [] },
    protected: ["docs/spec/**", "docs/decisions/**", legacy ? "epics/**" : ".taskflow/epics/**"],
    qaPaths: ["e2e/**"],
    spec: null,
    board: humanLanguage === "ru" ? BOARD_RU : BOARD_EN,
    review: { maxRounds: 3, autoMerge: true, mergeMethod: "squash" },
    parallel: 2,
    dispatch: { timeoutMinutes: 180 },
    standards: { index: legacy ? "docs/standards/index.json" : ".taskflow/standards/index.json", roots: legacy ? ["docs", "AGENTS.md"] : [".taskflow", "docs", "AGENTS.md"], maxContextChars: 24_000 },
    agents: {
      // Chains are tried in order; models your providers do not serve are skipped.
      // Reviewer deliberately prefers a different model family than the implementer (cross-model review).
      lead: { models: ["claude-code/claude-opus-5-5#high", "anthropic/claude-opus-5-5#high", "openai/gpt-6-astra#high"] },
      planner: { models: ["claude-code/claude-opus-5-5#high", "anthropic/claude-fable-5-1#high", "anthropic/claude-opus-5-5#high", "openai/gpt-6-astra#high"] },
      implementer: { models: ["claude-code/claude-opus-5-5#medium", "anthropic/claude-opus-5-5#medium", "openai/gpt-6.1-sol#medium"] },
      reviewer: { models: ["openai/gpt-6-astra#high", "chatgpt-subscription/gpt-6-astra#high", "claude-code/claude-opus-5-5#high", "anthropic/claude-opus-5-5#high"] },
      qa: { models: ["claude-code/claude-sonnet-5-5#medium", "anthropic/claude-sonnet-5-5#medium", "openai/gpt-6-luna-fast#low"] },
    },
    categories: {
      quick: { description: "small, well-specified change", models: ["claude-code/claude-sonnet-5-5#medium", "anthropic/claude-sonnet-5-5#medium", "openai/gpt-6-luna-fast#low"] },
      deep: { description: "multi-module change, tricky logic", models: ["claude-code/claude-opus-5-5#high", "anthropic/claude-opus-5-5#high", "openai/gpt-6-astra#high"] },
      visual: { description: "UI work", models: ["claude-code/claude-opus-5-5#high", "anthropic/claude-fable-5-1#high", "anthropic/claude-opus-5-5#high"] },
    },
    routing: [],
    commandPrefix: "tf-",
  }
}

// ---------- JSONC ----------

/**
 * JSONC: `//` and `/* *\/` comments, trailing commas and a leading BOM, all handled outside of strings only.
 */
export function parseJsonc(text: string): unknown {
  const src = text.replace(/^\uFEFF/, "")
  let out = ""
  let i = 0
  let inString = false
  /** Index in `src` after whitespace and comments starting at j. */
  const skipTrivia = (j: number): number => {
    for (;;) {
      while (j < src.length && /\s/.test(src[j]!)) j++
      if (src[j] === "/" && src[j + 1] === "/") {
        while (j < src.length && src[j] !== "\n") j++
      } else if (src[j] === "/" && src[j + 1] === "*") {
        j += 2
        while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++
        j += 2
      } else return j
    }
  }
  while (i < src.length) {
    const c = src[i]!
    if (inString) {
      out += c
      if (c === "\\") {
        out += src[i + 1] ?? ""
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
    } else if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      i = skipTrivia(i)
    } else if (c === ",") {
      const next = skipTrivia(i + 1)
      if (src[next] !== "}" && src[next] !== "]") out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out)
}

// ---------- merge ----------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Objects merge recursively; arrays and scalars replace. `__proto__`-style keys are dropped. */
export function deepMerge<T>(base: T, layer: unknown): T {
  if (!isPlainObject(layer)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(layer)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue
    const cur = out[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v
  }
  return out as T
}

// ---------- load ----------

export interface ConfigSource {
  path: string
  ok: boolean
  error?: string
}

export interface LoadedConfig {
  config: TaskflowConfig
  sources: ConfigSource[]
}

export function globalConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "taskflow.jsonc")
}

export function projectConfigPath(root: string): string {
  const central = path.join(root, ".taskflow/config.jsonc")
  const old = path.join(root, ".opencode/taskflow.jsonc")
  if (fs.existsSync(central)) return central
  return fs.existsSync(old) || hasLegacyLayout(root) ? old : central
}

/** Directory names alone are not evidence of ownership. */
function legacyLayoutSignature(root: string): [boolean, boolean, boolean, boolean] {
  const read = (rel: string) => { try { return fs.readFileSync(path.join(root, rel), "utf8") } catch { return "" } }
  return [/opencode-taskflow/.test(read("docs/taskflow.md")), /scripts\/tasks\.mjs/.test(read("tasks/README.md")), fs.existsSync(path.join(root, "scripts/tasks.mjs")), fs.existsSync(path.join(root, "tasks/_template.md"))]
}

export function hasLegacyLayout(root: string): boolean {
  const [workflow, board, script, template] = legacyLayoutSignature(root)
  return workflow || (board && script && template)
}

function readLayer(file: string, sources: ConfigSource[]): unknown {
  if (!fs.existsSync(file)) return undefined
  try {
    const value = parseJsonc(fs.readFileSync(file, "utf8"))
    sources.push({ path: file, ok: true })
    return value
  } catch (e) {
    sources.push({ path: file, ok: false, error: (e as Error).message })
    return undefined
  }
}

/**
 * defaults <- global config <- selected project config (.taskflow first, legacy fallback) <- plugin options.
 * The language of the defaults follows the last (highest-precedence) layer that sets `language.human`, so board texts
 * match it. Invalid values are replaced by their defaults field by field and reported as a `validation` source.
 */
export function loadConfig(root: string, options: unknown = undefined, globalPath = globalConfigPath()): LoadedConfig {
  const sources: ConfigSource[] = []
  const selected = projectConfigPath(root)
  const layers = [readLayer(globalPath, sources), readLayer(selected, sources), options]
  const explicitLegacy = layers.some((l) => isPlainObject(l) && isPlainObject(l.paths) && l.paths.tasks === "tasks" && (l.paths.epics === "epics" || l.paths.template === "tasks/_template.md"))
  const legacy = selected.endsWith("/.opencode/taskflow.jsonc") || (!fs.existsSync(selected) && (hasLegacyLayout(root) || explicitLegacy))
  if (fs.existsSync(path.join(root, ".taskflow/config.jsonc")) && fs.existsSync(path.join(root, ".opencode/taskflow.jsonc"))) sources.push({ path: path.join(root, ".opencode/taskflow.jsonc"), ok: true, error: "ignored: .taskflow/config.jsonc takes precedence; legacy project layer is not merged" })
  if (legacy) sources.push({ path: "(layout)", ok: true, error: "Legacy layout retained. No files moved. Migration requires a separately approved path inventory and move plan." })
  let human = "ru"
  for (const l of layers) {
    const lang = isPlainObject(l) && isPlainObject(l.language) ? l.language.human : undefined
    if (typeof lang === "string") human = lang
  }
  const defaults = defaultConfig(human, legacy)
  // Upgrade compatibility is read-only: prefer existing customized legacy checklists without requiring init.
  // Applying this to defaults BEFORE layers ensures every explicit global/project/options override still wins.
  if (legacy) {
    const existing = (rel: string) => { try { return fs.statSync(path.join(root, rel)).isFile() } catch { return false } }
    if (existing(".github/pull_request_template.md")) defaults.paths.prTemplate = ".github/pull_request_template.md"
    if (existing(".github/PULL_REQUEST_TEMPLATE/human-review.md")) defaults.paths.humanReviewTemplate = ".github/PULL_REQUEST_TEMPLATE/human-review.md"
  }
  let config = defaults
  for (const l of layers) {
    config = deepMerge(config, l)
    // within one layer `model` beats `models`; a later layer that sets only `models` overrides an earlier `model`
    if (isPlainObject(l) && isPlainObject(l.agents)) {
      for (const [role, a] of Object.entries(l.agents)) {
        const merged = (config.agents as Record<string, AgentConfig | undefined>)[role]
        if (isPlainObject(a) && "models" in a && !("model" in a) && merged) {
          config.agents = { ...config.agents, [role]: { ...merged, model: undefined } }
        }
      }
    }
  }
  const problems = validate(config, defaults)
  if (config.backend === "auto") config.backend = legacy || explicitLegacy ? "standalone" : discoverBackend(root)
  if (config.backend === "openspec" && /^(opsx|openspec)(?:[-:]|$)/i.test(config.commandPrefix)) {
    problems.push("commandPrefix: native OpenSpec prefixes are reserved; using tf- without replacing native commands")
    config.commandPrefix = "tf-"
  }
  // Discovery, not an inherited global path, determines the project config destination.
  config.paths.config = fs.existsSync(selected) ? path.relative(root, selected).split(path.sep).join("/") : defaults.paths.config
  if (problems.length) sources.push({ path: "(validation)", ok: false, error: problems.join("; ") })
  return { config, sources }
}

// ---------- validation ----------

type Check = (v: unknown) => boolean
const isStr: Check = (v) => typeof v === "string"
const isNonEmpty: Check = (v) => typeof v === "string" && v.trim() !== ""
const isStrOrNull: Check = (v) => v === null || typeof v === "string"
const isStrArray: Check = (v) => Array.isArray(v) && v.every((x) => typeof x === "string")
const isPosInt: Check = (v) => Number.isInteger(v) && (v as number) > 0
const isBool: Check = (v) => typeof v === "boolean"
const oneOf = (...xs: string[]): Check => (v) => typeof v === "string" && xs.includes(v)
const isCopyList: Check = (v) =>
  Array.isArray(v) && v.every((x) => typeof x === "string" || (isPlainObject(x) && typeof x.to === "string" && isStrArray(x.from)))
const isRouting: Check = (v) =>
  Array.isArray(v) && v.every((r) => isPlainObject(r) && isPlainObject(r.when) && typeof r.category === "string")
const isModelList: Check = (v) => v === undefined || isStrArray(v)

/** Field-level schema: path -> check. A failing field is reset to its default. */
const SCHEMA: Array<[string, Check]> = [
  ["backend", oneOf("auto", "openspec", "standalone")],
  ["openspec.executable", isNonEmpty],
  ["language.human", isStr], ["language.agent", isStr],
  ["git.remote", isNonEmpty], ["git.baseBranch", (v) => v === null || isNonEmpty(v)], ["git.branchPrefix", isNonEmpty], ["git.worktreeDir", isNonEmpty],
  ...["config", "tasks", "epics", "board", "template", "epicTemplate", "workflow", "plans", "standardsGuide", "prTemplate", "humanReviewTemplate", "milestones"].map((k): [string, Check] => [`paths.${k}`, isNonEmpty]),
  ["task.areas", isStrArray], ["task.sizes", isStrArray], ["task.idPadding", (v) => isPosInt(v) && (v as number) <= 9],
  ["setup.copy", isCopyList], ["setup.commands", isStrArray],
  ["verify.full", isStrOrNull], ["verify.quick", isStrOrNull], ["verify.e2e", isStrOrNull],
  ["ci.checks", isStrArray], ["protected", isStrArray], ["qaPaths", isStrArray],
  ["board.header", isStrArray], ["board.epicLine", isStr], ["board.epicLink", isStr], ["board.taskLine", isStr],
  ["review.maxRounds", isPosInt], ["review.autoMerge", isBool], ["review.mergeMethod", oneOf("squash", "merge", "rebase")],
  ["parallel", isPosInt], ["dispatch.timeoutMinutes", (v) => isPosInt(v) && (v as number) <= 1440], ["routing", isRouting], ["commandPrefix", isStr],
  ["standards.index", isNonEmpty], ["standards.roots", (v) => isStrArray(v) && (v as string[]).every((x) => x.trim() !== "")],
  ["standards.maxContextChars", (v) => isPosInt(v) && (v as number) <= 1_000_000],
]

const getPath = (o: any, p: string) => p.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o)
function setPath(o: any, p: string, v: unknown) {
  const keys = p.split(".")
  let cur = o
  for (const k of keys.slice(0, -1)) cur = cur[k] = isPlainObject(cur[k]) ? { ...cur[k] } : {}
  cur[keys[keys.length - 1]!] = v
}

/** Mutates `config` in place: invalid fields get their defaults. Returns the problems found. */
export function validate(config: TaskflowConfig, defaults: TaskflowConfig): string[] {
  const problems: string[] = []
  for (const [p, ok] of SCHEMA) {
    if (!ok(getPath(config, p))) {
      problems.push(`${p}: invalid value ${JSON.stringify(getPath(config, p))}, using the default`)
      setPath(config, p, getPath(defaults, p))
    }
  }
  if (!isPlainObject(config.spec) && config.spec !== null) {
    problems.push("spec: must be an object or null")
    config.spec = null
  } else if (config.spec) {
    for (const k of ["dir", "definition", "questionPattern", "acceptancePattern"] as const) {
      if (typeof config.spec[k] !== "string") {
        problems.push(`spec.${k}: must be a string; spec checks disabled`)
        config.spec = null
        break
      }
    }
    if (config.spec) {
      try {
        new RegExp(config.spec.definition)
        new RegExp(config.spec.questionPattern)
        new RegExp(config.spec.acceptancePattern)
      } catch (e) {
        problems.push(`spec: invalid regular expression (${(e as Error).message}); spec checks disabled`)
        config.spec = null
      }
    }
  }
  if (!isPlainObject(config.agents)) {
    problems.push("agents: must be an object")
    config.agents = defaults.agents
  }
  for (const role of ROLES) {
    const a = config.agents[role]
    if (a === undefined) continue
    if (!isPlainObject(a) || !isModelList(a.models) || (a.model !== undefined && !isStr(a.model)) || (a.name !== undefined && !isStr(a.name))) {
      problems.push(`agents.${role}: invalid, using the default`)
      config.agents[role] = defaults.agents[role]
    } else if (a.permissions !== undefined && !(Array.isArray(a.permissions) && a.permissions.every((r) => isPlainObject(r) && isStr(r.action) && isStr(r.resource) && oneOf("allow", "deny", "ask")(r.effect)))) {
      problems.push(`agents.${role}.permissions: invalid, ignored`)
      delete (a as AgentConfig).permissions
    }
  }
  if (!isPlainObject(config.categories)) {
    problems.push("categories: must be an object")
    config.categories = defaults.categories
  }
  for (const [name, c] of Object.entries(config.categories)) {
    if (!isPlainObject(c) || !isStrArray(c.models)) {
      problems.push(`categories.${name}: needs a models list; dropped`)
      delete config.categories[name]
    }
  }
  return problems
}

/** Task id pattern for the configured padding (`T-` + at least `idPadding` digits). */
export const taskIdRe = (cfg: TaskflowConfig) => new RegExp(`^T-\\d{${cfg.task.idPadding},}$`)

/** mtime fingerprint of the config files, to re-read them only when they change. */
export function configStamp(root: string, globalPath = globalConfigPath()): string {
  const candidates = [path.join(root, ".taskflow/config.jsonc"), path.join(root, ".opencode/taskflow.jsonc")]
  const files = [globalPath, ...candidates]
    .map((f) => {
      try {
        return String(fs.statSync(f).mtimeMs)
      } catch {
        return "-"
      }
    })
    .join("|")
  // Discovery and invalidation use exactly the same ownership predicates, even for same-mtime content changes.
  const templates = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/human-review.md"].map((rel) => {
    try { return fs.statSync(path.join(root, rel)).isFile() } catch { return false }
  })
  return files + "|" + discoverBackend(root) + "|" + (candidates.some((f) => fs.existsSync(f)) ? "configured" : JSON.stringify(legacyLayoutSignature(root))) + "|" + JSON.stringify(templates)
}

/** No ancestor search and no CLI calls at host registration. Existing Taskflow config retains compatibility. */
export function discoverBackend(root: string): "openspec" | "standalone" {
  let central = false
  try { const f = path.join(root, ".taskflow/workflow.md"); central = fs.statSync(f).size < 64_000 && /opencode-taskflow/.test(fs.readFileSync(f, "utf8")) } catch { /* no ownership signature */ }
  if ([".taskflow/config.jsonc", ".opencode/taskflow.jsonc"].some((p) => fs.existsSync(path.join(root, p))) || central || hasLegacyLayout(root)) return "standalone"
  return "openspec"
}

export function agentName(config: TaskflowConfig, role: Role): string {
  return config.agents[role]?.name ?? role
}

export function agentChain(config: TaskflowConfig, role: Role): string[] {
  const a = config.agents[role]
  if (!a) return []
  // `model` is the explicit shorthand: when a layer sets it, it beats the (possibly inherited default) chain.
  return a.model ? [a.model] : (a.models ?? [])
}

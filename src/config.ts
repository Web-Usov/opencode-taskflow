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
  language: { human: string; agent: string }
  git: {
    remote: string
    /** null = detect from `<remote>/HEAD`, else `main`, else `master`. */
    baseBranch: string | null
    branchPrefix: string
    /** Worktree parent directory, relative to the main checkout. `{repo}` = checkout directory name. */
    worktreeDir: string
  }
  paths: { tasks: string; epics: string; board: string; template: string }
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

export function defaultConfig(humanLanguage = "ru"): TaskflowConfig {
  return {
    language: { human: humanLanguage, agent: "en" },
    git: { remote: "origin", baseBranch: null, branchPrefix: "task/", worktreeDir: "../{repo}-wt" },
    paths: { tasks: "tasks", epics: "epics", board: "tasks/README.md", template: "tasks/_template.md" },
    task: { areas: ["api", "web", "mobile", "infra", "docs"], sizes: ["S", "M"], idPadding: 3 },
    setup: { copy: [], commands: [] },
    verify: { full: null, quick: null, e2e: null },
    ci: { checks: [] },
    protected: ["docs/spec/**", "docs/decisions/**", "epics/**"],
    qaPaths: ["e2e/**"],
    spec: null,
    board: humanLanguage === "ru" ? BOARD_RU : BOARD_EN,
    review: { maxRounds: 3, autoMerge: true, mergeMethod: "squash" },
    parallel: 2,
    dispatch: { timeoutMinutes: 180 },
    standards: { index: "docs/standards/index.json", roots: ["docs", "AGENTS.md"], maxContextChars: 24_000 },
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
  return path.join(root, ".opencode", "taskflow.jsonc")
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
 * defaults <- ~/.config/opencode/taskflow.jsonc <- <root>/.opencode/taskflow.jsonc <- plugin options.
 * The language of the defaults follows the last (highest-precedence) layer that sets `language.human`, so board texts
 * match it. Invalid values are replaced by their defaults field by field and reported as a `validation` source.
 */
export function loadConfig(root: string, options: unknown = undefined, globalPath = globalConfigPath()): LoadedConfig {
  const sources: ConfigSource[] = []
  const layers = [readLayer(globalPath, sources), readLayer(projectConfigPath(root), sources), options]
  let human = "ru"
  for (const l of layers) {
    const lang = isPlainObject(l) && isPlainObject(l.language) ? l.language.human : undefined
    if (typeof lang === "string") human = lang
  }
  const defaults = defaultConfig(human)
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
  ["language.human", isStr], ["language.agent", isStr],
  ["git.remote", isNonEmpty], ["git.baseBranch", (v) => v === null || isNonEmpty(v)], ["git.branchPrefix", isNonEmpty], ["git.worktreeDir", isNonEmpty],
  ["paths.tasks", isNonEmpty], ["paths.epics", isNonEmpty], ["paths.board", isNonEmpty], ["paths.template", isNonEmpty],
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
  return [globalPath, projectConfigPath(root)]
    .map((f) => {
      try {
        return String(fs.statSync(f).mtimeMs)
      } catch {
        return "-"
      }
    })
    .join("|")
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

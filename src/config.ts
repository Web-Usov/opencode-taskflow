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

/** Strips `//` and `/* *\/` comments and trailing commas outside of strings, then JSON.parse. */
export function parseJsonc(text: string): unknown {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === "\\") {
        out += text[i + 1] ?? ""
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
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
    } else {
      out += c
      i++
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
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
 * The language of the defaults follows the first layer that sets `language.human`, so board texts match it.
 */
export function loadConfig(root: string, options: unknown = undefined, globalPath = globalConfigPath()): LoadedConfig {
  const sources: ConfigSource[] = []
  const layers = [readLayer(globalPath, sources), readLayer(projectConfigPath(root), sources), options]
  let human = "ru"
  for (const l of layers) {
    const lang = isPlainObject(l) && isPlainObject(l.language) ? l.language.human : undefined
    if (typeof lang === "string") human = lang
  }
  let config = defaultConfig(human)
  for (const l of layers) config = deepMerge(config, l)
  return { config, sources }
}

export function agentName(config: TaskflowConfig, role: Role): string {
  return config.agents[role]?.name ?? role
}

export function agentChain(config: TaskflowConfig, role: Role): string[] {
  const a = config.agents[role]
  if (!a) return []
  return a.models ?? (a.model ? [a.model] : [])
}

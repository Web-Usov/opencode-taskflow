import path from "node:path"
import type { Role, TaskflowConfig } from "../config.ts"
import { agentName, ROLES } from "../config.ts"

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** Permission names of the tf_* tools (tool `options.permission`); rules with `resource: "*"` hide them per role. */
export const TOOL_PERMISSION = { read: "taskflow.read", write: "taskflow.write", dispatch: "taskflow.dispatch" } as const

/** Where the repository lives, so absolute edit paths can be matched too. */
export interface RepoLayout {
  base: string
  mainDir: string
  /** Parent directory of task/plan worktrees. */
  worktreeParent: string
}

/**
 * OpenCode wildcards: `*` matches anything (including `/` and spaces), `?` one character. `/**` in config becomes `/*`.
 */
export const toWildcard = (glob: string) => glob.replace(/\/\*\*$/, "/*").replace(/\*\*/g, "*")

/** Glob -> RegExp for the guard hook: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
        if (glob[i + 1] === "/") i++
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(resource: string, globs: readonly string[]): boolean {
  const r = resource.replace(/^\.\//, "")
  return globs.some((g) => globToRegExp(g).test(r))
}

/**
 * Repo-relative path of an edit resource. OpenCode reports files outside the session's directory as absolute paths, so an
 * absolute path inside any worktree root (or below the worktree parent) is made relative to that worktree.
 */
export function relativize(resource: string, roots: readonly string[], worktreeParent?: string): string {
  if (!path.isAbsolute(resource)) return resource.replace(/^\.\//, "")
  const norm = path.normalize(resource)
  const root = [...roots].sort((a, b) => b.length - a.length).find((r) => norm === r || norm.startsWith(r + path.sep))
  if (root) return path.relative(root, norm).split(path.sep).join("/")
  if (worktreeParent && norm.startsWith(worktreeParent + path.sep)) {
    // <parent>/<worktree-dir>/<repo-relative path>
    return path.relative(worktreeParent, norm).split(path.sep).slice(1).join("/")
  }
  return norm
}

const FORCE_PUSH = ["git push --force*", "git push -f*", "git push * --force*", "git push * -f*", "git push * +*", "git push --mirror*", "git push * --mirror*"]

/**
 * Static permission rules per role, appended after the agent's own rules (last match wins). They encode the role
 * contract; the guard hook repeats the critical ones precisely, because static wildcards cannot express everything.
 */
export function roleRules(cfg: TaskflowConfig, role: Role, layout: RepoLayout): Rule[] {
  const deny = (action: string, resource: string): Rule => ({ action, resource, effect: "deny" })
  const allow = (action: string, resource: string): Rule => ({ action, resource, effect: "allow" })
  const { base, mainDir, worktreeParent } = layout
  /** A repo-relative glob as resources: relative, inside the main checkout, inside any worktree. */
  const everywhere = (glob: string) => {
    const w = toWildcard(glob)
    return [w, `${mainDir}/${w}`, `${worktreeParent}/*/${w}`]
  }
  const common: Rule[] = [
    ...FORCE_PUSH.map((r) => deny("shell", r)),
    deny("shell", `git push * ${base}`),
    deny("shell", `git push * ${base} *`),
    deny("shell", `git push *:${base}*`),
    deny("shell", `git push *:refs/heads/${base}*`),
  ]
  const noMerge = [deny("shell", "gh pr merge*"), deny("shell", "*gh pr merge*"), deny("shell", "*gh api*/merge*")]
  const tools = (write: boolean, dispatch: boolean): Rule[] => [
    ...(write ? [] : [deny(TOOL_PERMISSION.write, "*")]),
    ...(dispatch ? [] : [deny(TOOL_PERMISSION.dispatch, "*")]),
  ]
  const protectedEdit = cfg.protected.flatMap(everywhere).map((r) => deny("edit", r))
  switch (role) {
    case "implementer":
      return [...common, ...noMerge, ...protectedEdit, ...tools(true, false)]
    case "qa":
      return [...common, ...noMerge, deny("edit", "*"), ...cfg.qaPaths.flatMap(everywhere).map((r) => allow("edit", r)), ...tools(false, false)]
    case "planner":
      return [
        ...common,
        ...noMerge,
        deny("edit", "*"),
        ...[`${cfg.paths.tasks}/**`, `${cfg.paths.epics}/**`, "docs/**", ...cfg.protected].flatMap(everywhere).map((r) => allow("edit", r)),
        ...tools(true, false),
      ]
    case "lead":
      return [...common, ...noMerge, deny("edit", "*"), ...tools(true, true)]
    case "reviewer": {
      const verify = [cfg.verify.full, cfg.verify.quick, cfg.verify.e2e].filter((c): c is string => !!c)
      const readOnly = [
        "git status*", "git diff*", "git log*", "git show*", "git ls-tree*", "git grep*", "git fetch*", "git worktree list*",
        "git worktree add /tmp/*", "git worktree remove /tmp/*", "git -C /tmp/*",
        "gh pr view*", "gh pr diff*", "gh pr checks*", "gh pr list*", "gh pr review*", "gh pr comment*",
        "gh run list*", "gh run view*", "gh api -X PUT repos/*/pulls/*/update-branch",
        "gh pr merge * --disable-auto",
        ...(cfg.review.autoMerge ? [`gh pr merge * --${cfg.review.mergeMethod} --auto`] : []),
      ]
      return [
        deny("edit", "*"),
        allow("edit", "/tmp/*"),
        allow("external_directory", "/tmp/*"),
        deny("shell", "*"),
        ...readOnly.map((r) => allow("shell", r)),
        ...verify.map((c) => allow("shell", `${c}*`)),
        deny("shell", "*--admin*"),
        deny("shell", "gh api * update_method*"),
        ...tools(false, false),
      ]
    }
  }
}

export interface GuardEvent {
  agent?: string
  action: string
  resources: readonly string[]
}

/** Every `gh pr merge ...` / `gh api ... /merge` occurrence in a command line (also inside `bash -c '...'`). */
export function mergeCommands(cmd: string): string[] {
  const out: string[] = []
  for (const m of cmd.matchAll(/\bgh\s+pr\s+merge\b[^;&|\n'"`)]*/g)) out.push(m[0].trim())
  for (const m of cmd.matchAll(/\bgh\s+api\b[^;&|\n'"`)]*\/merge\b[^;&|\n'"`)]*/g)) out.push(m[0].trim())
  return out
}

/** Why a `git push` in this command line would write the base branch or rewrite history, or null. */
export function badPush(cmd: string, base: string): string | null {
  for (const m of cmd.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?push\b([^;&|\n`)]*)/g)) {
    const args = m[1]!.trim().split(/\s+/).filter(Boolean).map((a) => a.replace(/^['"]|['"]$/g, ""))
    for (const a of args) {
      if (/^(--force|--force-with-lease|--force-if-includes|-f|--mirror|--delete|-d)(=|$)/.test(a)) return `"${m[0].trim()}" uses ${a}`
      if (a.startsWith("+")) return `"${m[0].trim()}" force-pushes through the refspec ${a}`
      if (a.startsWith("-")) continue
      const dst = a.includes(":") ? a.slice(a.lastIndexOf(":") + 1) : a
      if (dst === base || dst === `refs/heads/${base}`) return `"${m[0].trim()}" pushes to the base branch ${base}`
    }
  }
  return null
}

export interface GuardContext {
  base: string
  /** Absolute roots of every worktree of the repository. */
  roots: readonly string[]
  worktreeParent?: string
}

/**
 * Hard guard evaluated on permission decisions of taskflow roles. Returns a denial reason or null. It only tightens
 * (never turns a deny into an allow). Shell analysis is best effort: commands are matched as text.
 */
export function guard(cfg: TaskflowConfig, ev: GuardEvent, ctx: GuardContext): string | null {
  const role = ROLES.find((r) => agentName(cfg, r) === ev.agent)
  if (!role) return null
  if (ev.action === "edit" && role !== "planner") {
    const hit = ev.resources.map((r) => relativize(r, ctx.roots, ctx.worktreeParent)).find((r) => matchesAny(r, cfg.protected))
    if (hit) return `taskflow: ${hit} is a protected path (${cfg.protected.join(", ")}); only the planner changes it, through a PR a human merges`
  }
  if (ev.action === "shell") {
    for (const cmd of ev.resources) {
      const push = badPush(cmd, ctx.base)
      if (push) return `taskflow: ${push}; never push to ${ctx.base} or rewrite history`
      for (const merge of mergeCommands(cmd)) {
        if (role !== "reviewer") return `taskflow: only the reviewer enables merges (after VERDICT: LGTM); ${agentName(cfg, role)} may not run "${merge}"`
        const allowed = [/^gh pr merge \d+ --disable-auto$/]
        if (cfg.review.autoMerge) allowed.push(new RegExp(`^gh pr merge \\d+ --${cfg.review.mergeMethod} --auto$`))
        if (!allowed.some((re) => re.test(merge))) {
          return `taskflow: the reviewer may only run "gh pr merge <n> --${cfg.review.mergeMethod} --auto" or "gh pr merge <n> --disable-auto"${cfg.review.autoMerge ? "" : " (auto-merge is disabled: only --disable-auto)"}; got "${merge}"`
        }
      }
      if (role === "reviewer") {
        for (const m of cmd.matchAll(/\bgh\s+api\b[^;&|\n'"`)]*/g)) {
          if (!/^gh api -X PUT repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/.test(m[0].trim())) {
            return `taskflow: the reviewer may only call "gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch"; got "${m[0].trim()}"`
          }
        }
      }
    }
  }
  return null
}

import type { Role, TaskflowConfig } from "../config.ts"
import { agentName, ROLES } from "../config.ts"

export interface Rule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** OpenCode wildcards are prefix/suffix `*` patterns; `/**` in config becomes `/*`. */
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

const FORCE_PUSH = ["git push --force*", "git push -f*", "git push * --force*", "git push * -f*"]

/**
 * Permission rules per role, appended after the agent's own rules (last match wins). They encode the role contract;
 * the guard hook (`evaluate`) repeats the critical ones so a project agent file cannot drop them by accident.
 */
export function roleRules(cfg: TaskflowConfig, role: Role, baseBranch: string): Rule[] {
  const deny = (action: string, resource: string): Rule => ({ action, resource, effect: "deny" })
  const allow = (action: string, resource: string): Rule => ({ action, resource, effect: "allow" })
  const common: Rule[] = [...FORCE_PUSH.map((r) => deny("shell", r)), deny("shell", `git push * ${baseBranch}*`)]
  const protectedEdit = cfg.protected.map((p) => deny("edit", toWildcard(p)))
  const method = cfg.review.mergeMethod
  switch (role) {
    case "implementer":
      return [...common, deny("shell", "gh pr merge *"), ...protectedEdit]
    case "qa":
      return [...common, deny("shell", "gh pr merge *"), deny("edit", "*"), ...cfg.qaPaths.map((p) => allow("edit", toWildcard(p)))]
    case "planner":
      return [
        ...common,
        deny("shell", "gh pr merge *"),
        deny("edit", "*"),
        allow("edit", `${cfg.paths.tasks}/*`),
        allow("edit", `${cfg.paths.epics}/*`),
        allow("edit", "docs/*"),
        ...cfg.protected.map((p) => allow("edit", toWildcard(p))),
      ]
    case "lead":
      return [...common, deny("shell", "gh pr merge *"), deny("edit", "*")]
    case "reviewer": {
      const verify = [cfg.verify.full, cfg.verify.quick, cfg.verify.e2e].filter((c): c is string => !!c)
      const readOnly = [
        "git status*", "git diff*", "git log*", "git show*", "git ls-tree*", "git grep*", "git fetch*", "git worktree list*",
        "gh pr view*", "gh pr diff*", "gh pr checks*", "gh pr list*", "gh pr checkout*", "gh pr review*", "gh pr comment*",
        "gh run list*", "gh run view*", "gh api -X PUT repos/*/pulls/*/update-branch",
        `gh pr merge * --${method} --auto`, "gh pr merge * --disable-auto",
      ]
      return [
        deny("edit", "*"),
        allow("edit", "/tmp/*"),
        allow("external_directory", "/tmp/*"),
        deny("shell", "*"),
        ...readOnly.map((r) => allow("shell", r)),
        ...verify.map((c) => allow("shell", `${c}*`)),
        deny("shell", "gh api * update_method*"),
      ]
    }
  }
}

export interface GuardEvent {
  agent?: string
  action: string
  resources: readonly string[]
}

/**
 * Hard guard evaluated on every permission decision of a taskflow role. Returns a denial reason or null.
 * Only tightens: it never turns a deny into an allow.
 */
export function guard(cfg: TaskflowConfig, ev: GuardEvent): string | null {
  const role = ROLES.find((r) => agentName(cfg, r) === ev.agent)
  if (!role) return null
  if (ev.action === "edit" && role !== "planner") {
    const hit = ev.resources.find((r) => matchesAny(r, cfg.protected))
    if (hit) return `taskflow: ${hit} is a protected path (${cfg.protected.join(", ")}); only the planner changes it, through a PR a human merges`
  }
  if (ev.action === "shell" && role !== "reviewer") {
    const cmd = ev.resources.find((r) => /^\s*gh\s+pr\s+merge\b/.test(r))
    if (cmd) return `taskflow: only the reviewer enables merges (after VERDICT: LGTM); ${agentName(cfg, role)} may not run "${cmd}"`
  }
  return null
}

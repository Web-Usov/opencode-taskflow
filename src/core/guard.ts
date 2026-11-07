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

/** Process artifacts always require the planner/human gate, independent of project protected overrides. */
export function protectedPaths(cfg: TaskflowConfig): string[] {
  // An index/guide at the namespace root must not accidentally protect the task directory or board.
  const directory = (file: string) => {
    const dir = path.posix.dirname(file)
    return dir === "." || [cfg.paths.tasks, cfg.paths.board].some((p) => p === dir || p.startsWith(dir + "/")) ? [] : [`${dir}/**`]
  }
  return [...cfg.protected, cfg.paths.config, `${cfg.paths.epics}/**`, cfg.standards.index, cfg.paths.standardsGuide, ...directory(cfg.paths.standardsGuide), ...directory(cfg.standards.index), `${cfg.paths.plans}/**`, cfg.paths.workflow, cfg.paths.template, cfg.paths.epicTemplate, cfg.paths.prTemplate, cfg.paths.humanReviewTemplate, `${cfg.paths.milestones}/**`]
}

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
  const { base, mainDir } = layout
  /**
   * Static rules see edit resources relative to the session directory, or absolute outside it. Absolute variants are
   * emitted only for the main checkout (an exact prefix); worktree paths at unknown depth would over-match because `*`
   * also matches `/`, so absolute paths in worktrees are left to the guard hook, which resolves them precisely.
   */
  const everywhere = (glob: string) => {
    const w = toWildcard(glob)
    return [w, `${mainDir}/${w}`]
  }
  const common: Rule[] = [
    ...FORCE_PUSH.map((r) => deny("shell", r)),
    ...[`git push * ${base}`, `git push * ${base} *`, `git push *:${base}`, `git push *:${base} *`, `git push *:refs/heads/${base}`, `git push *:refs/heads/${base} *`].map((r) => deny("shell", r)),
  ]
  const noMerge = [
    deny("shell", "gh pr merge*"),
    deny("shell", "gh api*/pulls/*/merge*"),
    deny("shell", "gh api graphql*mergePullRequest*"),
    deny("shell", "gh api graphql*enablePullRequestAutoMerge*"),
  ]
  const tools = (write: boolean, dispatch: boolean): Rule[] => [
    ...(write ? [] : [deny(TOOL_PERMISSION.write, "*")]),
    ...(dispatch ? [] : [deny(TOOL_PERMISSION.dispatch, "*")]),
  ]
  const protectedEdit = protectedPaths(cfg).flatMap(everywhere).map((r) => deny("edit", r))
  switch (role) {
    case "implementer":
      return [...common, ...noMerge, ...protectedEdit, ...tools(true, false)]
    case "qa":
      return [...common, ...noMerge, deny("edit", "*"), ...cfg.qaPaths.map((g) => allow("edit", toWildcard(g))), ...tools(false, false)]
    case "planner":
      return [
        ...common,
        ...noMerge,
        deny("edit", "*"),
        ...[`${cfg.paths.tasks}/**`, cfg.paths.board, `${cfg.paths.epics}/**`, "docs/**", ...protectedPaths(cfg)].map((g) => allow("edit", toWildcard(g))),
        ...tools(true, false),
      ]
    case "lead":
      return [...common, ...noMerge, deny("edit", "*"), ...tools(true, true)]
    case "reviewer": {
      const verify = [cfg.verify.full, cfg.verify.quick, cfg.verify.e2e].filter((c): c is string => !!c)
      const readOnly = [
        "git status*", "git diff*", "git log*", "git show*", "git ls-tree*", "git grep*", "git fetch*", "git worktree list*",
        "git worktree add /tmp/review-*", "git worktree remove /tmp/review-*", "cd /tmp/review-*",
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

// ---------- shell analysis ----------

/** Splits a command line into shell words (quotes and backslashes honoured; no expansion). */
export function shellWords(cmd: string): string[] {
  const words: string[] = []
  let cur = ""
  let has = false
  let q: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (q) {
      if (c === q) q = null
      else if (c === "\\" && q === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      q = c
      has = true
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i]
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) words.push(cur)
      cur = ""
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has || cur) words.push(cur)
  return words
}

/**
 * Splits a script into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines outside quotes (quotes are kept).
 * Heredoc bodies (`<<EOF ... EOF`, `<<-EOF`, quoted delimiters) are data, not commands, and are dropped.
 */
export function splitCommands(script: string): string[] {
  const out: string[] = []
  let cur = ""
  let q: '"' | "'" | null = null
  const pendingHeredocs: Array<{ delim: string; strip: boolean }> = []
  const push = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ""
  }
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!
    if (q) {
      cur += c
      if (c === "\\" && q === '"' && i + 1 < script.length) cur += script[++i]
      else if (c === q) q = null
      continue
    }
    if (c === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(script.slice(i))
      if (m) {
        pendingHeredocs.push({ delim: m[3]!, strip: m[1] === "-" })
        i += m[0].length - 1
        continue
      }
    }
    if (c === "'" || c === '"') {
      q = c
      cur += c
    } else if (c === "\\" && i + 1 < script.length) {
      cur += c + script[++i]
    } else if (c === "\n") {
      push()
      // skip heredoc bodies that start after this newline
      while (pendingHeredocs.length) {
        const h = pendingHeredocs.shift()!
        let j = i + 1
        for (;;) {
          const end = script.indexOf("\n", j)
          const line = script.slice(j, end === -1 ? script.length : end)
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim || end === -1) {
            i = end === -1 ? script.length : end
            break
          }
          j = end + 1
        }
      }
    } else if (c === ";" || c === "|" || c === "&") {
      push()
    } else if ((c === ">" || c === "<") && !cur.endsWith(" ")) {
      cur += " " + c // a redirect ends the previous word: `HEAD:main>/dev/null`
    } else cur += c
  }
  push()
  return out
}

const WRAPPERS = new Set(["env", "command", "exec", "sudo", "doas", "nohup", "time", "nice", "xargs", "timeout", "stdbuf", "ionice", "setsid"])
/** Wrapper options that take a separate value (`nice -n 10`, `sudo -u bob`, `env -u X`, `xargs -n 1`). */
const WRAPPER_VALUE_OPTS = new Set(["-n", "-u", "-g", "-C", "-E", "-I", "-L", "-P", "-s", "-k", "--signal", "--kill-after"])
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"])

/** argv of every simple command in a command line, unwrapping `env`, `sudo`, `bash -c '...'` and similar. */
export function simpleCommands(cmd: string, depth = 0): string[][] {
  const result: string[][] = []
  for (const part of splitCommands(cmd)) {
    let w = shellWords(part).filter((x, i, all) => !/^\d*[<>]/.test(x) && !/^\d*[<>]/.test(all[i - 1] ?? "")) // drop redirects
    for (;;) {
      if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) {
        w = w.slice(1)
        continue
      }
      const head = w[0]?.split("/").pop()
      if (head && WRAPPERS.has(head)) {
        w = w.slice(1)
        while (w.length && w[0]!.startsWith("-")) w = WRAPPER_VALUE_OPTS.has(w[0]!) ? w.slice(2) : w.slice(1)
        if (head === "timeout" && w.length && /^\d/.test(w[0]!)) w = w.slice(1) // timeout DURATION cmd
        while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w = w.slice(1) // env K=V cmd
        continue
      }
      break
    }
    if (!w.length) continue
    const name = w[0]!.split("/").pop()!
    if (name === "eval" && depth < 3) {
      result.push(...simpleCommands(w.slice(1).join(" "), depth + 1))
      continue
    }
    // bash -c, bash -lc, sh -ec ...: the first argument after a short-option cluster containing "c" is the script
    const ci = w.findIndex((x, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x))
    if (SHELLS.has(name) && ci > 0 && w[ci + 1] !== undefined && depth < 3) {
      result.push(...simpleCommands(w[ci + 1]!, depth + 1))
      continue
    }
    result.push([name, ...w.slice(1)])
  }
  return result
}

/** git argv without global options: ["push", ...args] for `git -C x -c k=v --no-pager push ...`. */
function gitSubcommand(argv: string[]): string[] {
  let i = 1
  while (i < argv.length && argv[i]!.startsWith("-")) {
    const opt = argv[i]!
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"].includes(opt) ? 2 : 1
  }
  return argv.slice(i)
}

/** Every merge-capable gh invocation in a command line, normalised to "gh ..." strings. */
export function mergeCommands(cmd: string): string[] {
  const out: string[] = []
  for (const argv of simpleCommands(cmd)) {
    if (argv[0] !== "gh") continue
    if (argv[1] === "pr" && argv[2] === "merge") out.push(argv.join(" "))
    else if (argv[1] === "api") {
      const text = argv.slice(2).join(" ")
      if (/\/pulls\/\d+\/merge\b/.test(text) || /mergePullRequest|enablePullRequestAutoMerge|mergeBranch/.test(text)) out.push(argv.join(" "))
    }
  }
  return out
}

/** Why a `git push` in this command line would write the base branch or rewrite history, or null. */
export function badPush(cmd: string, base: string): string | null {
  for (const argv of simpleCommands(cmd)) {
    if (argv[0] !== "git") continue
    const sub = gitSubcommand(argv)
    if (sub[0] !== "push") continue
    const shown = argv.join(" ")
    for (const a of sub.slice(1)) {
      if (/^(--force|--force-with-lease|--force-if-includes|-f|--mirror|--delete|-d|--all|--prune)(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) return `"${shown}" uses ${a}`
      if (a.startsWith("+")) return `"${shown}" force-pushes through the refspec ${a}`
      if (a.startsWith("-")) continue
      const dst = a.includes(":") ? a.slice(a.lastIndexOf(":") + 1) : a
      if (dst === base || dst === `refs/heads/${base}`) return `"${shown}" pushes to the base branch ${base}`
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

const REVIEW_TMP = /^\/tmp\/review-[\w.-]+$/

/** The reviewer's shell is read-only; the hook re-checks the few write-ish commands its static rules allow. */
function reviewerShellProblem(argv: string[], cfg: TaskflowConfig): string | null {
  const shown = argv.join(" ")
  if (argv[0] === "gh" && argv[1] === "api") {
    const ok = argv.length === 5 && argv[2] === "-X" && argv[3] === "PUT" && /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/update-branch$/.test(argv[4]!)
    if (!ok) return `the reviewer may only call "gh api -X PUT repos/<owner>/<repo>/pulls/<n>/update-branch"; got "${shown}"`
  }
  if (argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge") {
    const allowed = [/^gh pr merge \d+ --disable-auto$/]
    if (cfg.review.autoMerge) allowed.push(new RegExp(`^gh pr merge \\d+ --${cfg.review.mergeMethod} --auto$`))
    if (!allowed.some((re) => re.test(shown))) {
      return `the reviewer may only run "gh pr merge <n> --${cfg.review.mergeMethod} --auto" or "gh pr merge <n> --disable-auto"${cfg.review.autoMerge ? "" : " (auto-merge is disabled: only --disable-auto)"}; got "${shown}"`
    }
  }
  if (argv[0] === "git") {
    const sub = gitSubcommand(argv)
    if (sub[0] === "worktree" && (sub[1] === "add" || sub[1] === "remove")) {
      const target = sub.slice(2).find((a) => !a.startsWith("-"))
      const branchy = sub.some((a) => ["-b", "-B", "--force", "-f", "--track"].includes(a))
      if (!target || !REVIEW_TMP.test(target) || branchy) {
        return `the reviewer may only add/remove its own throwaway worktrees /tmp/review-<n> (detached, no -b/-B/--force); got "${shown}"`
      }
    }
    if (sub[0] === "fetch" && sub.slice(1).some((a) => a.includes(":") || a.startsWith("+"))) {
      return `the reviewer fetches without refspecs that write local branches; got "${shown}"`
    }
  }
  return null
}

/**
 * Hard guard evaluated on permission decisions of taskflow roles. Returns a denial reason or null. It only tightens
 * (never turns a deny into an allow). Shell analysis parses shell words of each simple command (best effort: no
 * expansion, aliases or scripts are followed).
 */
export function guard(cfg: TaskflowConfig, ev: GuardEvent, ctx: GuardContext): string | null {
  const role = ROLES.find((r) => agentName(cfg, r) === ev.agent)
  if (!role) return null
  if (ev.action === "edit" && role !== "planner") {
    const hit = ev.resources.map((r) => relativize(r, ctx.roots, ctx.worktreeParent)).find((r) => matchesAny(r, protectedPaths(cfg)))
    if (hit) return `taskflow: ${hit} is a protected path (${protectedPaths(cfg).join(", ")}); only the planner changes it, through a PR a human merges`
  }
  if (ev.action === "shell") {
    for (const cmd of ev.resources) {
      const push = badPush(cmd, ctx.base)
      if (push) return `taskflow: ${push}; never push to ${ctx.base} or rewrite history`
      if (role === "reviewer") {
        for (const argv of simpleCommands(cmd)) {
          const problem = reviewerShellProblem(argv, cfg)
          if (problem) return `taskflow: ${problem}`
        }
      } else {
        const merge = mergeCommands(cmd)[0]
        if (merge) return `taskflow: only the reviewer enables merges (after VERDICT: LGTM); ${agentName(cfg, role)} may not run "${merge}"`
      }
    }
  }
  return null
}

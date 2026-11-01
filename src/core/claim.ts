import fs from "node:fs"
import path from "node:path"
import { taskIdRe, type CopySpec, type TaskflowConfig } from "../config.ts"
import { asList, asString, parseFrontmatter } from "./frontmatter.ts"
import { baseRefOf, detectBaseBranch, exclusive, fetchShared, git, hasRemote, mainCheckout, NET_TIMEOUT, run, runShell, tryGit } from "./git.ts"
import { setStatus, writeBoard } from "./tasks.ts"

// ---------- ids ----------

/**
 * Every task id already taken anywhere: task files on the base ref, task files in every remote and local ref (unmerged
 * PR branches carry task files whose ids are in no branch name) and ids in task branch names.
 */
export function collectTaskIds(gitFn: (args: string[]) => string, cfg: TaskflowConfig, baseRef: string): string[] {
  const ids = new Set<string>()
  const fromFiles = (out: string) => {
    for (const f of out.split("\n")) {
      const id = /(?:^|\/)(T-\d+)-[^/]*\.md$/.exec(f)?.[1]
      if (id) ids.add(id)
    }
  }
  const refs = new Set([baseRef])
  for (const prefix of [`refs/remotes/${cfg.git.remote}`, "refs/heads"]) {
    for (const r of gitFn(["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean)) refs.add(r)
  }
  for (const ref of refs) {
    try {
      fromFiles(gitFn(["ls-tree", "--name-only", ref, `${cfg.paths.tasks}/`]))
    } catch {
      /* ref without a tasks dir or an unreadable ref */
    }
  }
  const prefix = cfg.git.branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`(?:^|/)${prefix}(T-\\d+)-`)
  for (const b of gitFn(["branch", "-a", "--format=%(refname:short)"]).split("\n")) {
    const id = re.exec(b)?.[1]
    if (id) ids.add(id)
  }
  return [...ids]
}

export function nextTaskId(ids: string[], padding = 3): string {
  const max = ids.map((i) => Number(/^T-(\d+)$/.exec(i)?.[1] ?? 0)).reduce((a, b) => Math.max(a, b), 0)
  return `T-${String(max + 1).padStart(padding, "0")}`
}

export function slugify(title: string, maxLen = 40): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (words.length <= maxLen) return words
  const cut = words.slice(0, maxLen)
  return cut.slice(0, Math.max(cut.lastIndexOf("-"), 1)).replace(/-+$/, "")
}

export interface NewTask {
  id: string
  title: string
  epic: string
  area: string
  size: string
}

/** Turns the task template into a new task file (status todo; the claim sets in_progress afterwards). */
export function renderNewTask(template: string, t: NewTask): string {
  if (/[#\n"]/.test(t.title)) throw new Error("title must not contain #, quotes or newlines")
  // function replacements: a `$&` or `$1` in the title must stay literal
  return template
    .replace(/^id: .*$/m, () => `id: ${t.id}`)
    .replace(/^title: .*$/m, () => `title: "${t.title}"`)
    .replace(/^epic: [^\s#]*/m, () => `epic: ${t.epic}`)
    .replace(/^area: [^\s#]*/m, () => `area: ${t.area}`)
    .replace(/^size: [^\s#]*/m, () => `size: ${t.size}`)
    .replace(/^# T-0+\. .*$/m, () => `# ${t.id}. ${t.title}`)
}

/** Absolute parent directory of all task worktrees (`git.worktreeDir` with `{repo}` rendered). */
export function worktreeParent(mainDir: string, cfg: TaskflowConfig): string {
  return path.resolve(mainDir, cfg.git.worktreeDir.replaceAll("{repo}", path.basename(mainDir)))
}

export function worktreePath(mainDir: string, cfg: TaskflowConfig, id: string, slug: string): string {
  return path.join(worktreeParent(mainDir, cfg), `${id.toLowerCase()}-${slug}`)
}

/** Fetch the remote unless there is none; a failed fetch is an error unless `offline`. */
async function fetchRemote(mainDir: string, cfg: TaskflowConfig, log: string[], offline: boolean, signal?: AbortSignal): Promise<string | null> {
  const remote = cfg.git.remote
  if (!hasRemote(mainDir, remote)) {
    log.push(`no remote "${remote}": using local refs`)
    return null
  }
  if (offline) {
    log.push("offline: skipped git fetch")
    return null
  }
  const f = await fetchShared(mainDir, remote, { signal })
  if (!f.ok) return `git fetch ${remote} failed (${f.error}); fix the remote access or pass offline=true to use local refs`
  log.push(`git fetch ${remote}`)
  return null
}

function copySpecs(cfg: TaskflowConfig): CopySpec[] {
  return cfg.setup.copy.map((c) => (typeof c === "string" ? { to: c, from: [c] } : c))
}

// ---------- claim ----------

export interface ClaimInput {
  cwd: string
  cfg: TaskflowConfig
  id?: string
  create?: Omit<NewTask, "id">
  /** Keep the worktree when a step fails (default: roll back). */
  keep?: boolean
  /** Skip `setup.commands` (tests). */
  skipSetup?: boolean
  /** Do not fetch; validate against the local remote-tracking refs. */
  offline?: boolean
  signal?: AbortSignal
}

export interface ClaimResult {
  ok: boolean
  id?: string
  branch?: string
  worktree?: string
  log: string[]
  error?: string
}

/**
 * Claims a task: validate on `<remote>/<base>` (todo, depends done, blocked_by empty) -> fetch -> worktree on a new branch
 * from the base -> copy env files -> setup commands -> status in_progress + branch -> board -> claim commit.
 * With `create`, first writes a new task file from the template with the next free id.
 * On failure after the worktree exists, it is removed again unless `keep`.
 */
export async function claim(input: ClaimInput): Promise<ClaimResult> {
  // one claim per repository at a time: two claims of the same id must not both pass the existence checks
  let key = input.cwd
  try {
    key = mainCheckout(input.cwd)
  } catch {
    /* reported by claimUnlocked */
  }
  return exclusive(`claim:${key}`, () => claimUnlocked(input))
}

async function claimUnlocked(input: ClaimInput): Promise<ClaimResult> {
  const { cfg } = input
  const log: string[] = []
  const fail = (error: string): ClaimResult => ({ ok: false, log, error })

  let mainDir: string
  try {
    mainDir = mainCheckout(input.cwd)
  } catch {
    return fail(`${input.cwd} is not inside a git repository`)
  }
  const remote = cfg.git.remote
  const fetchError = await fetchRemote(mainDir, cfg, log, !!input.offline, input.signal)
  if (fetchError) return fail(fetchError)
  const base = detectBaseBranch(mainDir, remote, cfg.git.baseBranch)
  const baseRef = baseRefOf(mainDir, remote, base)
  log.push(`base: ${baseRef}`)
  const idRe = taskIdRe(cfg)

  const files = (tryGit(["ls-tree", "--name-only", baseRef, `${cfg.paths.tasks}/`], mainDir) ?? "").split("\n")
  const tasks = files
    .filter((f) => /\/T-\d+-.*\.md$/.test(f))
    .map((f) => ({ f, data: parseFrontmatter(git(["show", `${baseRef}:${f}`], mainDir)).data }))
    .filter((t) => t.data)

  let id: string
  let slug: string
  let newTaskText: string | null = null
  if (input.create) {
    const c = input.create
    if (!c.title?.trim()) return fail("title is required")
    if (!/^E-\d{2,}$/.test(c.epic ?? "")) return fail("epic must look like E-NN")
    if (!cfg.task.areas.includes(c.area)) return fail(`area must be one of ${cfg.task.areas.join("|")}`)
    if (!cfg.task.sizes.includes(c.size)) return fail(`size must be one of ${cfg.task.sizes.join("|")}`)
    slug = slugify(c.title)
    if (!slug) return fail("the title must contain latin letters or digits (it becomes the branch slug)")
    const epics = (tryGit(["ls-tree", "--name-only", baseRef, `${cfg.paths.epics}/`], mainDir) ?? "").split("\n")
    if (!epics.some((e) => path.basename(e).startsWith(`${c.epic}-`))) return fail(`epic ${c.epic} not found on ${baseRef}`)
    const template = tryGit(["show", `${baseRef}:${cfg.paths.template}`], mainDir)
    if (template === null) return fail(`${cfg.paths.template} not found on ${baseRef}`)
    id = nextTaskId(
      [...tasks.map((t) => asString(t.data!.id) ?? ""), ...collectTaskIds((a) => git(a, mainDir), cfg, baseRef)],
      cfg.task.idPadding,
    )
    try {
      newTaskText = renderNewTask(template, { id, ...c, title: c.title.trim() })
    } catch (e) {
      return fail((e as Error).message)
    }
  } else {
    if (!input.id || !idRe.test(input.id)) return fail(`invalid task id "${input.id ?? ""}"`)
    id = input.id
    const task = tasks.find((t) => asString(t.data!.id) === id)
    if (!task) return fail(`${id} not found on ${baseRef} (is the task file merged? Create it with \`create\`)`)
    const d = task.data!
    if (asString(d.status) !== "todo") return fail(`${id} has status "${asString(d.status)}", expected todo`)
    if (asList(d.blocked_by).length) return fail(`${id} is blocked by ${asList(d.blocked_by).join(", ")}`)
    const notDone = asList(d.depends).filter((dep) => asString(tasks.find((t) => asString(t.data!.id) === dep)?.data?.status) !== "done")
    if (notDone.length) return fail(`${id} depends on unfinished task(s): ${notDone.join(", ")}`)
    slug = path.basename(task.f, ".md").replace(/^T-\d+-/, "")
  }

  const branch = `${cfg.git.branchPrefix}${id}-${slug}`
  const wtPath = worktreePath(mainDir, cfg, id, slug)
  if (fs.existsSync(wtPath)) return fail(`${wtPath} already exists (continue there, or clean ${id})`)
  if (tryGit(["branch", "--list", branch], mainDir) || tryGit(["branch", "-r", "--list", `${remote}/${branch}`], mainDir)) {
    return fail(`branch ${branch} already exists locally or on ${remote}`)
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  const add = await run("git", ["worktree", "add", wtPath, "-b", branch, baseRef], mainDir, { timeout: NET_TIMEOUT })
  if (!add.ok) {
    // a killed/failed add may leave a half-made worktree and branch behind
    await run("git", ["worktree", "remove", "--force", wtPath], mainDir)
    await run("git", ["worktree", "prune"], mainDir)
    if (tryGit(["branch", "--list", branch], mainDir)) await run("git", ["branch", "-D", branch], mainDir)
    return fail(`git worktree add failed: ${add.stderr.trim()}`)
  }
  log.push(`worktree ${wtPath} on ${branch}`)

  try {
    for (const c of copySpecs(cfg)) {
      const src = c.from.map((f) => path.join(mainDir, f)).find((f) => fs.existsSync(f))
      if (src) {
        fs.mkdirSync(path.dirname(path.join(wtPath, c.to)), { recursive: true })
        fs.copyFileSync(src, path.join(wtPath, c.to))
        log.push(`copied ${path.relative(mainDir, src)} -> ${c.to}`)
      } else log.push(`warning: none of ${c.from.join(", ")} exists in the main checkout; ${c.to} not copied`)
    }
    if (!input.skipSetup) {
      for (const cmd of cfg.setup.commands) {
        const r = await runShell(cmd, wtPath, { signal: input.signal }) // no timeout: installs may take minutes
        if (!r.ok) throw new Error(`\`${cmd}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`)
        log.push(`ran ${cmd}`)
      }
    }
    if (newTaskText) {
      const file = path.join(wtPath, cfg.paths.tasks, `${id}-${slug}.md`)
      fs.writeFileSync(file, newTaskText)
      log.push(`created ${path.relative(wtPath, file)} from ${cfg.paths.template}`)
    }
    setStatus(wtPath, cfg, id, "in_progress", { branch })
    writeBoard(wtPath, cfg)
    const addTasks = await run("git", ["add", "--", cfg.paths.tasks, cfg.paths.board], wtPath)
    if (!addTasks.ok) throw new Error(`git add failed: ${addTasks.stderr.trim()}`)
    const subject = input.create ? `chore(tasks): add and start ${id} [${id}]` : `chore(tasks): start ${id} [${id}]`
    const commit = await run("git", ["commit", "-m", subject], wtPath, { timeout: NET_TIMEOUT })
    if (!commit.ok) throw new Error(`claim commit failed: ${(commit.stderr || commit.stdout).trim().slice(-2000)}`)
    log.push(`committed "${subject}"`)
  } catch (e) {
    const msg = (e as Error).message
    if (input.keep) {
      log.push(`kept worktree ${wtPath} and branch ${branch} for inspection`)
    } else {
      const rm = await run("git", ["worktree", "remove", "--force", wtPath], mainDir)
      const del = await run("git", ["branch", "-D", branch], mainDir)
      log.push(rm.ok && del.ok ? `rolled back: removed ${wtPath} and ${branch}` : `rollback incomplete: git worktree remove --force ${wtPath} && git branch -D ${branch}`)
    }
    return { ok: false, id, branch, worktree: wtPath, log, error: msg }
  }
  return { ok: true, id, branch, worktree: wtPath, log }
}

// ---------- planner worktree ----------

/**
 * Worktree for planner work (`plan/<slug>` from the base branch, no task claim): tasks, epics and spec changes are
 * prepared there and shipped as one PR. Reuses an existing worktree of that branch.
 */
export async function planWorktree(input: { cwd: string; cfg: TaskflowConfig; slug: string; offline?: boolean; signal?: AbortSignal }): Promise<ClaimResult> {
  const { cfg } = input
  const log: string[] = []
  const slug = slugify(input.slug)
  if (!slug) return { ok: false, log, error: "slug must contain latin letters or digits" }
  let mainDir: string
  try {
    mainDir = mainCheckout(input.cwd)
  } catch {
    return { ok: false, log, error: `${input.cwd} is not inside a git repository` }
  }
  const branch = `plan/${slug}`
  const wtPath = path.join(worktreeParent(mainDir, cfg), `plan-${slug}`)
  const existing = (tryGit(["worktree", "list", "--porcelain"], mainDir) ?? "").split("\n\n").find((b) => b.includes(`branch refs/heads/${branch}\n`) || b.endsWith(`branch refs/heads/${branch}`))
  if (existing) {
    const p = existing.match(/^worktree (.*)$/m)?.[1]
    if (p && fs.existsSync(p) && path.resolve(p) !== path.resolve(mainDir)) return { ok: true, branch, worktree: p, log: [`reusing worktree ${p} on ${branch}`] }
    if (p && path.resolve(p) === path.resolve(mainDir)) return { ok: false, log, error: `${branch} is checked out in the main checkout; switch it back to the base branch first` }
    await run("git", ["worktree", "prune"], mainDir)
  }
  const fetchError = await fetchRemote(mainDir, cfg, log, !!input.offline, input.signal)
  if (fetchError) return { ok: false, log, error: fetchError }
  const remote = cfg.git.remote
  const baseRef = baseRefOf(mainDir, remote, detectBaseBranch(mainDir, remote, cfg.git.baseBranch))
  const local = tryGit(["branch", "--list", branch], mainDir)
  const onRemote = tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], mainDir)
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  const args = local
    ? ["worktree", "add", wtPath, branch]
    : onRemote
      ? ["worktree", "add", "--track", "-b", branch, wtPath, `${remote}/${branch}`]
      : ["worktree", "add", wtPath, "-b", branch, baseRef]
  const add = await run("git", args, mainDir, { timeout: NET_TIMEOUT })
  if (!add.ok) return { ok: false, log, error: `git worktree add failed: ${add.stderr.trim()}` }
  log.push(`worktree ${wtPath} on ${branch}${local ? "" : onRemote ? ` tracking ${remote}/${branch}` : ` from ${baseRef}`}`)
  return { ok: true, branch, worktree: wtPath, log }
}

// ---------- clean ----------

export interface PrInfo {
  state: string
  url: string
  headRefOid: string
}

/**
 * May the local branch be deleted? Only when the PR is merged and nothing local would be lost: the branch HEAD equals the
 * PR head, or the branch is contained in the base or in the PR head (a server-side update-branch adds merge commits).
 */
export function decideClean(input: {
  pr: PrInfo
  branch: string
  localHead: string
  inBase: boolean
  inPrHead?: boolean
  unpushed?: string[]
}): { ok: true } | { ok: false; reason: string } {
  const { pr, branch, localHead, inBase, inPrHead = false, unpushed = [] } = input
  if (pr.state !== "MERGED") return { ok: false, reason: `PR ${pr.url} is ${pr.state}, not MERGED; refusing to clean` }
  if (localHead === pr.headRefOid || inBase || inPrHead) return { ok: true }
  const list = unpushed.length ? `\n  ${unpushed.join("\n  ")}` : " (could not be listed)"
  return {
    ok: false,
    reason:
      `local ${branch} (${localHead.slice(0, 9)}) differs from the merged PR head (${String(pr.headRefOid).slice(0, 9)}) ` +
      `and is not contained in the base branch; deleting it would lose commits that were never pushed:${list}\n` +
      `Push them (or open a follow-up PR) first, or delete the branch by hand if they are not needed.`,
  }
}

/** The task's local branch: the `branch:` field when set (no fallback), else the unique `<prefix><id>-*` branch. */
export function resolveBranch(input: {
  id: string
  branchField: string | null
  localBranches: string[]
  prefix: string
}): { branch: string } | { error: string } {
  const { id, branchField, localBranches, prefix } = input
  if (branchField && branchField !== "null") {
    if (localBranches.includes(branchField)) return { branch: branchField }
    return { error: `task file of ${id} says branch ${branchField}, but it does not exist locally; nothing to clean` }
  }
  const byId = localBranches.filter((b) => b.startsWith(`${prefix}${id}-`))
  if (byId.length === 1) return { branch: byId[0]! }
  return { error: `expected exactly one local branch for ${id}, found ${byId.length} matching ${prefix}${id}-*` }
}

export interface CleanInput {
  cwd: string
  cfg: TaskflowConfig
  id: string
  remoteBranch?: boolean
  /** Injectable for tests; default asks `gh pr view <branch>`. */
  prView?: (branch: string, cwd: string) => Promise<PrInfo | { error: string }>
  signal?: AbortSignal
}

export async function ghPrView(branch: string, cwd: string): Promise<PrInfo | { error: string }> {
  const r = await run("gh", ["pr", "view", branch, "--json", "state,url,headRefOid"], cwd, { timeout: NET_TIMEOUT })
  if (!r.ok) return { error: `cannot read the PR of ${branch} with gh (${r.stderr.trim()})` }
  try {
    return JSON.parse(r.stdout) as PrInfo
  } catch {
    return { error: `unexpected gh output: ${r.stdout.slice(0, 200)}` }
  }
}

export async function clean(input: CleanInput): Promise<{ ok: boolean; log: string[]; error?: string }> {
  const { cfg, id } = input
  const log: string[] = []
  if (!taskIdRe(cfg).test(id)) return { ok: false, log, error: `invalid task id "${id}"` }
  let mainDir: string
  try {
    mainDir = mainCheckout(input.cwd)
  } catch {
    return { ok: false, log, error: `${input.cwd} is not inside a git repository` }
  }
  const remote = cfg.git.remote
  const remoteExists = hasRemote(mainDir, remote)
  if (remoteExists) await fetchShared(mainDir, remote, { signal: input.signal })
  await run("git", ["worktree", "prune"], mainDir) // a worktree deleted by hand still pins its branch
  const base = detectBaseBranch(mainDir, remote, cfg.git.baseBranch)
  const baseRef = baseRefOf(mainDir, remote, base)

  let branchField: string | null = null
  const name = (tryGit(["ls-tree", "--name-only", baseRef, `${cfg.paths.tasks}/`], mainDir) ?? "")
    .split("\n")
    .find((f) => path.basename(f).startsWith(`${id}-`))
  if (name) branchField = asString(parseFrontmatter(tryGit(["show", `${baseRef}:${name}`], mainDir) ?? "").data?.branch)

  const localBranches = (tryGit(["branch", "--format=%(refname:short)"], mainDir) ?? "").split("\n").filter(Boolean)
  const resolved = resolveBranch({ id, branchField, localBranches, prefix: cfg.git.branchPrefix })
  if ("error" in resolved) return { ok: false, log, error: resolved.error }
  const branch = resolved.branch

  const pr = await (input.prView ?? ghPrView)(branch, mainDir)
  if ("error" in pr) return { ok: false, log, error: pr.error }
  const localHead = git(["rev-parse", branch], mainDir)
  const ok = (args: string[]) => tryGit(args, mainDir) !== null
  const inBase = ok(["merge-base", "--is-ancestor", branch, baseRef])
  if (remoteExists && pr.headRefOid && !ok(["cat-file", "-e", `${pr.headRefOid}^{commit}`])) {
    await run("git", ["fetch", remote, pr.headRefOid], mainDir, { timeout: NET_TIMEOUT, signal: input.signal })
  }
  const prHeadKnown = !!pr.headRefOid && ok(["cat-file", "-e", `${pr.headRefOid}^{commit}`])
  const inPrHead = prHeadKnown && ok(["merge-base", "--is-ancestor", branch, pr.headRefOid])
  const cmpBase = prHeadKnown ? pr.headRefOid : baseRef
  const unpushed = (tryGit(["log", "--oneline", `${cmpBase}..${branch}`], mainDir) ?? "").split("\n").filter(Boolean)
  const verdict = decideClean({ pr, branch, localHead, inBase, inPrHead, unpushed })
  if (!verdict.ok) return { ok: false, log, error: `${verdict.reason} [${id}]` }

  const wt = (tryGit(["worktree", "list", "--porcelain"], mainDir) ?? "")
    .split("\n\n")
    .map((b) => ({ p: b.match(/^worktree (.*)$/m)?.[1], br: b.match(/^branch refs\/heads\/(.*)$/m)?.[1] }))
    .find((w) => w.br === branch)?.p
  if (wt && fs.existsSync(wt)) {
    const rm = await run("git", ["worktree", "remove", wt], mainDir) // no --force: refuses a dirty worktree
    if (!rm.ok) return { ok: false, log, error: `git worktree remove ${wt} failed (dirty?): ${rm.stderr.trim()}` }
    log.push(`removed worktree ${wt}`)
  }
  const del = await run("git", ["branch", "-D", branch], mainDir)
  if (!del.ok) return { ok: false, log, error: `git branch -D ${branch} failed: ${del.stderr.trim()}` }
  log.push(`deleted local branch ${branch}`)
  if (input.remoteBranch && remoteExists) {
    const r = await run("git", ["push", remote, "--delete", branch], mainDir, { timeout: NET_TIMEOUT })
    log.push(r.ok ? `deleted ${remote}/${branch}` : `${remote}/${branch} already gone`)
  }
  if (remoteExists) await run("git", ["fetch", remote, "--prune"], mainDir, { timeout: NET_TIMEOUT })
  log.push(await fastForwardMain(mainDir, base, baseRef))
  log.push(`${id} cleaned`)
  return { ok: true, log }
}

/**
 * Brings the main checkout up to the base ref when it is safe (on the base branch, clean tree, fast-forward only), so
 * statuses merged in PRs become visible to tf_next. Otherwise says what to do.
 */
export async function fastForwardMain(mainDir: string, base: string, baseRef: string): Promise<string> {
  if (baseRef === base) return "main checkout: no remote ref to fast-forward to"
  const current = tryGit(["branch", "--show-current"], mainDir)
  if (current !== base) return `main checkout is on "${current}", not ${base}: update it by hand`
  const status = tryGit(["status", "--porcelain"], mainDir)
  if (status === null || status) return "main checkout has local changes (or git status failed): update it by hand (git pull --ff-only)"
  const r = await run("git", ["merge", "--ff-only", baseRef], mainDir, { timeout: NET_TIMEOUT })
  return r.ok ? `main checkout fast-forwarded to ${baseRef}` : `main checkout could not fast-forward (${r.stderr.trim()}): update it by hand`
}

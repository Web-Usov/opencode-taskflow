import fs from "node:fs"
import path from "node:path"
import type { TaskflowConfig } from "../config.ts"
import { worktreeParent } from "./claim.ts"
import { detectBaseBranch, git, hasRemote, mainCheckout, run, runShell, type RunOptions, type RunResult } from "./git.ts"
import { OpenSpec, type Runner } from "./openspec.ts"
import { changeName, digest, readExecution, recordDirectory, selectedRoot, validateExecution, writeExecution, type ExecutionRecord } from "./openspec-source.ts"

const opts = (signal?: AbortSignal): RunOptions => ({ signal, timeout: 120_000, maxOutputBytes: 256_000 })
const cleanTree = (root: string) => git(["status", "--porcelain", "--untracked-files=all"], root) === ""
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("aborted") }
const requireOK = (r: RunResult) => { if (!r.ok) throw new Error(r.stderr || r.stdout || "command failed") }

/** Persistent exclusive lock also serializes different plugin hosts/processes. Never break a stale lock automatically. */
export async function executionLock<T>(root: string, change: string, fn: () => Promise<T>, kind: "execution" | "dispatch" = "execution"): Promise<T> {
  const dir = recordDirectory(root)
  changeName(change)
  fs.mkdirSync(dir, { recursive: true })
  const lock = path.join(dir, `${change}${kind === "dispatch" ? ".dispatch" : ""}.lock`)
  let fd: number
  try { fd = fs.openSync(lock, "wx", 0o600) } catch { throw new Error(`execution locked: ${lock}; inspect the owning operation before manually removing a stale lock`) }
  const owned = fs.fstatSync(fd)
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, change, started: new Date().toISOString() }) + "\n")
    return await fn()
  } finally {
    fs.closeSync(fd)
    try { const current = fs.lstatSync(lock); if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lock) } catch { /* already removed; never remove a replacement */ }
  }
}

export async function startChange(root: string, cfg: TaskflowConfig, change: string, confirm: boolean, signal?: AbortSignal, adapter = new OpenSpec(cfg)): Promise<ExecutionRecord> {
  if (confirm !== true) throw new Error("explicit execution intent required: confirm=true only after the user asks to execute this selected change; CLI readiness is not approval")
  selectedRoot(root)
  changeName(change)
  return executionLock(root, change, async () => {
    checkAbort(signal)
    if (!cleanTree(root)) throw new Error("source worktree has dirty/untracked files; explicitly commit or relocate them yourself before claiming; Taskflow never stages, copies or stashes user work")
    const context = await adapter.inspect(root, change, signal)
    if (context.state !== "ready") throw new Error(`change is ${context.state}, expected ready for implementation`)
    const dir = recordDirectory(root)
    if (fs.existsSync(path.join(dir, `${change}.json`))) throw new Error("change already has an execution record; continue its associated worktree, do not claim again")
    const sourceCommit = git(["rev-parse", "HEAD"], root)
    if (/^[a-zS]/m.test(git(["ls-files", "-v"], root))) throw new Error("source has assume-unchanged/skip-worktree index entries; use a normal fully checked-out committed source before claiming")
    const plannedFiles = [...context.references.map((r) => r.path), "openspec/config.yaml", "openspec/config.yml", ".taskflow/config.jsonc", ".opencode/taskflow.jsonc", `openspec/changes/${change}/.openspec.yaml`]
    for (const relative of new Set(plannedFiles)) {
      const file = path.join(root, relative)
      if (!fs.existsSync(file)) continue
      let committed: string
      try { committed = git(["show", `${sourceCommit}:${relative}`], root) } catch { throw new Error(`source planning/config file is not committed: ${relative}; commit it explicitly first`) }
      if (committed !== fs.readFileSync(file, "utf8").trim()) throw new Error(`source planning/config differs from committed HEAD: ${relative}`)
    }
    const main = mainCheckout(root)
    const branch = `openspec/${change}`
    const worktree = path.join(worktreeParent(main, cfg), `openspec-${change}`)
    // No reuse, adoption, forced branch reset or unrelated destination deletion.
    if (fs.existsSync(worktree) || git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`, `refs/remotes/${cfg.git.remote}/${branch}`], root)) throw new Error("execution branch/worktree collision; choose the existing association explicitly, never overwrite it")
    if (hasRemote(root, cfg.git.remote)) {
      const remote = await run("git", ["ls-remote", "--heads", "--", cfg.git.remote, `refs/heads/${branch}`], root, opts(signal))
      requireOK(remote)
      if (remote.stdout.trim()) throw new Error("execution branch already exists on remote; do not duplicate/adopt another run without an explicit validated association")
    }
    let parent = path.dirname(worktree)
    while (!fs.existsSync(parent)) parent = path.dirname(parent)
    if (fs.realpathSync(parent) !== parent) throw new Error("symlink worktree parent unsupported")
    if (worktree === main || worktree.startsWith(main + path.sep) || main.startsWith(worktree + path.sep)) throw new Error("execution worktree must be separate from the main checkout")
    checkAbort(signal)
    if (!cleanTree(root) || git(["rev-parse", "HEAD"], root) !== sourceCommit) throw new Error("source changed during preflight")
    fs.mkdirSync(path.dirname(worktree), { recursive: true })
    const add = await run("git", ["worktree", "add", worktree, "-b", branch, sourceCommit], root, opts(signal))
    // Even a partial add is preserved: never force-delete a path possibly populated concurrently by a human.
    if (!add.ok) throw new Error(`worktree add failed: ${add.stderr}; any partial extension-created branch/worktree at ${worktree} was preserved; inspect it before retrying`)
    let record: ExecutionRecord | undefined
    let recordCreated = false
    try {
      const selected = await adapter.inspect(worktree, change, signal)
      record = { version: 1, change, sourceRoot: root, sourceCommit, configDigest: digest(JSON.stringify(cfg)), branch, worktree, identity: selected.identity, phase: "claimed" }
      writeExecution(root, record, true)
      recordCreated = true
      for (const spec of cfg.setup.copy) {
        checkAbort(signal)
        const copy = typeof spec === "string" ? { from: [spec], to: spec } : spec
        const confined = (base: string, rel: string) => {
          if (!rel || path.isAbsolute(rel) || rel.includes("\\") || rel.split("/").some((p) => !p || p === "." || p === ".." || p === ".git" || p === "openspec" || p === ".taskflow")) throw new Error("unsafe env copy path")
          let at = base
          for (const part of rel.split("/")) { at = path.join(at, part); if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw new Error("symlink env copy unsupported") }
          return at
        }
        const target = confined(worktree, copy.to)
        if (fs.existsSync(target)) throw new Error(`env copy refuses existing destination ${copy.to}`)
        const source = copy.from.map((rel) => confined(root, rel)).find((file) => fs.existsSync(file))
        if (!source) continue
        if (!fs.statSync(source).isFile()) throw new Error("env copy source is not a regular file")
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      }
      for (const command of cfg.setup.commands) { checkAbort(signal); requireOK(await runShell(command, worktree, opts(signal))) }
      checkAbort(signal)
      validateExecution(root, change)
      return record
    } catch (error) {
      if (record && recordCreated) {
        record.phase = "setup_failed"
        try { writeExecution(root, record) } catch { /* preserve a concurrently changed record, never overwrite it */ }
      }
      throw new Error(`${(error as Error).message}; preserved extension-created worktree/branch at ${worktree}. Inspect and repair it explicitly; no user work was removed.`)
    }
  })
}

async function associatedPR(root: string, cfg: TaskflowConfig, r: ExecutionRecord, url: string, signal?: AbortSignal, runner: Runner = run) {
  if (!/^https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+$/.test(url)) throw new Error("expected HTTPS pull request URL")
  const repository = await runner("gh", ["repo", "view", "--json", "url"], root, opts(signal))
  requireOK(repository)
  const repositoryURL = JSON.parse(repository.stdout).url
  if (typeof repositoryURL !== "string" || !url.startsWith(repositoryURL + "/pull/")) throw new Error("PR repository differs from the calling repository")
  const result = await runner("gh", ["pr", "view", url, "--json", "url,state,headRefName,headRefOid,baseRefName,isCrossRepository"], root, opts(signal))
  requireOK(result)
  const pr = JSON.parse(result.stdout)
  if (pr.url !== url || pr.headRefName !== r.branch || pr.baseRefName !== detectBaseBranch(root, cfg.git.remote, cfg.git.baseBranch) || pr.isCrossRepository !== false || !/^[a-f0-9]{40,64}$/.test(pr.headRefOid)) throw new Error("PR is not associated with the exact execution branch/base; cross-repository PRs unsupported")
  return pr
}

export async function recordChangePR(root: string, cfg: TaskflowConfig, change: string, url: string, signal?: AbortSignal, runner: Runner = run) {
  return executionLock(root, change, async () => {
    const r = validateExecution(root, change)
    if (r.configDigest !== digest(JSON.stringify(cfg))) throw new Error("execution configuration changed")
    if (r.pr && r.pr !== url) throw new Error("execution PR cannot be rebound")
    const context = await new OpenSpec(cfg).inspect(r.worktree, change, signal)
    if (JSON.stringify(context.identity) !== JSON.stringify(r.identity)) throw new Error("effective CLI/schema/config changed")
    if (context.state !== "all_done" || context.progress.remaining !== 0) throw new Error("native checklist is not complete")
    const pr = await associatedPR(root, cfg, r, url, signal, runner)
    if (!cleanTree(r.worktree) || git(["rev-parse", "HEAD"], r.worktree) !== pr.headRefOid) throw new Error("commit and push all implementation/checklist changes before associating PR")
    r.pr = url; r.head = pr.headRefOid; r.phase = "review"
    writeExecution(root, r)
    return r
  })
}

export async function cleanChange(root: string, cfg: TaskflowConfig, change: string, confirm: boolean, signal?: AbortSignal, runner: Runner = run) {
  if (confirm !== true) throw new Error("cleanup requires explicit confirm=true")
  return executionLock(root, change, () => executionLock(root, change, async () => {
    const r = validateExecution(root, change)
    if (r.configDigest !== digest(JSON.stringify(cfg))) throw new Error("execution configuration changed")
    if (!r.pr || !r.head) throw new Error("no verified associated PR")
    const pr = await associatedPR(root, cfg, r, r.pr, signal, runner)
    if (pr.state !== "MERGED") throw new Error("associated PR is not MERGED")
    if (git(["status", "--porcelain", "--untracked-files=all", "--ignored=matching"], r.worktree) || git(["rev-parse", "HEAD"], r.worktree) !== pr.headRefOid || pr.headRefOid !== r.head) throw new Error("cleanup would lose dirty/untracked/ignored work or extra/unpushed commits; remove generated ignored setup data yourself only after inspecting it")
    if (root === r.worktree) throw new Error("run cleanup from another worktree, not the worktree being removed")
    checkAbort(signal)
    requireOK(await run("git", ["worktree", "remove", r.worktree], root, opts(signal)))
    // -D is safe only for this exact recorded head confirmed as merged by gh; no remote deletion.
    if (git(["rev-parse", `refs/heads/${r.branch}`], root) !== r.head) throw new Error("branch moved during cleanup; branch preserved")
    requireOK(await run("git", ["branch", "-D", r.branch], root, opts(signal)))
    r.phase = "cleaned"; writeExecution(root, r)
    return r
  }, "dispatch"))
}

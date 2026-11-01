import { execFileSync, spawn } from "node:child_process"
import path from "node:path"

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Milliseconds; 0 or undefined = no timeout (setup commands like `pnpm install` may take minutes). */
  timeout?: number
  signal?: AbortSignal
  env?: Record<string, string>
}

/** Network/process calls never prompt: a credential or host-key prompt would hang the OpenCode server forever. */
const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" }

/**
 * Runs a command asynchronously without a shell. Never throws. Plugin code runs inside the OpenCode server, so anything
 * that can take more than a few milliseconds (fetch, push, gh, setup commands) must go through here, not a sync call.
 */
export function run(cmd: string, args: string[], cwd: string, opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ ok: false, code: null, stdout: "", stderr: "aborted" })
    let stdout = ""
    let stderr = ""
    let settled = false
    let killed = false
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...NON_INTERACTIVE, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] })
    const finish = (r: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(r)
    }
    const kill = (why: string) => {
      killed = true
      stderr += `\n${why}`
      child.kill("SIGTERM")
      setTimeout(() => child.kill("SIGKILL"), 5000).unref()
    }
    const onAbort = () => kill("aborted")
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = opts.timeout ? setTimeout(() => kill(`timed out after ${opts.timeout} ms`), opts.timeout) : undefined
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (e) => finish({ ok: false, code: null, stdout, stderr: `${stderr}${e.message}` }))
    child.on("close", (code) => finish({ ok: code === 0 && !killed, code, stdout, stderr }))
  })
}

/** A user-configured command line (setup/verify) through `bash -c`. */
export function runShell(command: string, cwd: string, opts: RunOptions = {}): Promise<RunResult> {
  return run("bash", ["-c", command], cwd, opts)
}

/** Default timeout for network git/gh calls. */
export const NET_TIMEOUT = 120_000

/**
 * Synchronous git for LOCAL, fast, read-only queries only (rev-parse, ls-tree, show, worktree list): they finish in
 * milliseconds and keep the pure task functions synchronous. Throws on failure.
 */
export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...NON_INTERACTIVE },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  }).trim()
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

/** Async git, returns trimmed stdout or throws with stderr. */
export async function gitAsync(args: string[], cwd: string, opts: RunOptions = {}): Promise<string> {
  const r = await run("git", args, cwd, opts)
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`)
  return r.stdout.trim()
}

/** Main checkout of the repository (parent of the common .git dir), from any worktree. */
export function mainCheckout(cwd: string): string {
  return path.dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd))
}

/** Top level of the current worktree. */
export function worktreeRoot(cwd: string): string | null {
  return tryGit(["rev-parse", "--show-toplevel"], cwd)
}

/** Absolute paths of every worktree of the repository (main checkout first). */
export function worktreePaths(cwd: string): string[] {
  return (tryGit(["worktree", "list", "--porcelain"], cwd) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
}

/** `baseBranch` from config, else `<remote>/HEAD`, else `main` or `master` if the remote (or local) has it. */
export function detectBaseBranch(cwd: string, remote: string, configured: string | null): string {
  if (configured) return configured
  const head = tryGit(["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], cwd)
  if (head?.startsWith(`${remote}/`)) return head.slice(remote.length + 1)
  for (const b of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${b}`], cwd)) return b
  }
  for (const b of ["main", "master"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], cwd)) return b
  }
  return "main"
}

/** `<remote>/<base>` when that ref exists, else the local base branch name. */
export function baseRefOf(cwd: string, remote: string, base: string): string {
  return tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${base}`], cwd) ? `${remote}/${base}` : base
}

export const hasRemote = (cwd: string, remote: string) => tryGit(["remote", "get-url", remote], cwd) !== null

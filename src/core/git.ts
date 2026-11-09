import { execFileSync, spawn } from "node:child_process"
import path from "node:path"

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  /** Combined stdout/stderr byte budget; exceeding it fails without returning partial data. */
  maxOutputBytes?: number
  /** Milliseconds; 0 or undefined = no timeout (setup commands like `pnpm install` may take minutes). */
  timeout?: number
  signal?: AbortSignal
  env?: Record<string, string>
}

/**
 * Calls never prompt: a credential prompt would hang forever. Processes also start in their own session (detached), so
 * ssh has no terminal to ask on; the user's own ssh settings (core.sshCommand, GIT_SSH) stay untouched.
 */
const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }

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
    // detached: own process group, so a timeout/abort can kill the whole tree (e.g. `pnpm install` and its children)
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...NON_INTERACTIVE, ...opts.env }, stdio: ["ignore", "pipe", "pipe"], detached: true })
    const finish = (r: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve(r)
    }
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          /* already gone */
        }
      }
    }
    const kill = (why: string) => {
      if (killed) return
      killed = true
      stderr += `\n${why}`
      signalGroup("SIGTERM")
      setTimeout(() => signalGroup("SIGKILL"), 3000).unref()
      // do not wait for grandchildren that keep the pipes open
      setTimeout(() => finish({ ok: false, code: null, stdout, stderr }), 3500).unref()
    }
    const onAbort = () => kill("aborted")
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const timer = opts.timeout ? setTimeout(() => kill(`timed out after ${opts.timeout} ms`), opts.timeout) : undefined
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    let bytes = 0
    const collect = (d: string, error: boolean) => {
      if (killed) return
      bytes += Buffer.byteLength(d)
      if (opts.maxOutputBytes && bytes > opts.maxOutputBytes) {
        stdout = ""
        stderr = ""
        kill("output budget exceeded")
        return
      }
      if (error) stderr += d
      else stdout += d
    }
    child.stdout.on("data", (d: string) => collect(d, false))
    child.stderr.on("data", (d: string) => collect(d, true))
    child.on("error", (e) => finish({ ok: false, code: null, stdout, stderr: `${stderr}${e.message}` }))
    child.on("close", (code) => finish({ ok: code === 0 && !killed, code, stdout, stderr }))
    // a command may exit while a background grandchild still holds the pipes (or was killed): resolve on exit after a
    // short grace period for the remaining output, then stop reading
    child.on("exit", (code) => {
      setTimeout(() => {
        finish({ ok: code === 0 && !killed, code, stdout, stderr })
        child.stdout.destroy()
        child.stderr.destroy()
      }, killed ? 200 : 500).unref()
    })
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

/**
 * One `git fetch` per repository at a time: concurrent callers join the running fetch (parallel fetches fight over ref
 * locks). Read-only callers may also reuse a successful fetch younger than `maxAgeMs`.
 */
const fetches = new Map<string, { at: number; done: boolean; pending: Promise<{ ok: boolean; error?: string }> }>()
export function fetchShared(mainDir: string, remote: string, opts: { maxAgeMs?: number; signal?: AbortSignal } = {}): Promise<{ ok: boolean; error?: string }> {
  const key = `${mainDir}\u0000${remote}`
  const prev = fetches.get(key)
  const withSignal = (p: Promise<{ ok: boolean; error?: string }>) => {
    // the shared fetch is not tied to one caller's signal; each caller only stops waiting
    const signal = opts.signal
    if (!signal) return p
    if (signal.aborted) return Promise.resolve({ ok: false, error: "aborted" })
    return Promise.race([p, new Promise<{ ok: boolean; error?: string }>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }), { once: true }))])
  }
  if (prev && (!prev.done || Date.now() - prev.at < (opts.maxAgeMs ?? 0))) return withSignal(prev.pending)
  const entry = { at: Date.now(), done: false, pending: Promise.resolve({ ok: true }) as Promise<{ ok: boolean; error?: string }> }
  entry.pending = run("git", ["fetch", remote], mainDir, { timeout: NET_TIMEOUT }).then((r) => {
    entry.done = true
    entry.at = Date.now()
    if (!r.ok) fetches.delete(key)
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().split("\n").pop() || "error" }
  })
  fetches.set(key, entry)
  return withSignal(entry.pending)
}

/** Runs `fn` exclusively per key (e.g. one claim per repository at a time). */
const locks = new Map<string, Promise<unknown>>()
export function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const tail = next.catch(() => undefined)
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

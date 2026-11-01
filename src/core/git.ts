import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

/** Runs a command without a shell. Never throws. */
export function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): RunResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString() + (r.error ? String(r.error.message) : ""),
  }
}

/** Runs a shell command line (used for user-configured setup/verify commands). Never throws. */
export function runShell(command: string, cwd: string): RunResult {
  return run("bash", ["-lc", command], cwd)
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim()
}

export function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

/** Main checkout of the repository (parent of the common .git dir), from any worktree. */
export function mainCheckout(cwd: string): string {
  return path.dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd))
}

/** Top level of the current worktree. */
export function worktreeRoot(cwd: string): string | null {
  return tryGit(["rev-parse", "--show-toplevel"], cwd)
}

/** `baseBranch` from config, else `<remote>/HEAD`, else `main` or `master` if the remote has it. */
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

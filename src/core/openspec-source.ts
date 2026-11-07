import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import { parseJsonc } from "../config.ts"
import { git, mainCheckout, tryGit } from "./git.ts"

export const digest = (text: string) => createHash("sha256").update(text).digest("hex")
export const changeName = (name: string) => {
  if (typeof name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || name.length > 100 || name === "archive") throw new Error("change must be an active lowercase kebab-case OpenSpec change name")
  return name
}

/** Strict selected-root policy: no symlink aliases, ancestor discovery, hidden children or dependency paths. */
export function safePath(root: string, relative: string, directory = false): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((s) => !s || s === "." || s === ".." || s.startsWith(".") || /^(node_modules|vendor|secrets?)$/i.test(s) || /(^|[._-])(credentials?|tokens?|private-key)([._-]|$)/i.test(s))) throw new Error(`unsafe OpenSpec path: ${relative}`)
  const target = path.join(root, relative)
  let current = root
  for (const part of relative.split("/")) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`symlink OpenSpec path unsupported: ${relative}`)
  }
  const stat = fs.statSync(target)
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw new Error(`not a regular ${directory ? "directory" : "file"}: ${relative}`)
  return target
}

export function selectedRoot(root: string): string {
  const resolved = path.resolve(root)
  if (fs.realpathSync(resolved) !== resolved || git(["rev-parse", "--show-toplevel"], resolved) !== resolved) throw new Error("select the exact canonical git worktree root; ancestor/root drift is unsupported")
  safePath(resolved, "openspec", true)
  safePath(resolved, "openspec/changes", true)
  return resolved
}

export function readReference(root: string, relative: string): { path: string; sha256: string; text: string } {
  const file = safePath(root, relative)
  if (!/\.(md|ya?ml|json)$/.test(relative) || /\.(env|pem|key)(\.|$)/i.test(relative)) throw new Error(`unsupported context format: ${relative}`)
  if (git(["ls-files", "--", relative], root) !== relative) throw new Error(`OpenSpec context must be tracked: ${relative}; commit it first`)
  if (tryGit(["check-ignore", "--no-index", "--", relative], root)) throw new Error(`ignored OpenSpec context refused: ${relative}`)
  if (!(fs.statSync(file).mode & 0o444)) throw new Error(`unreadable OpenSpec context: ${relative}`)
  if (fs.statSync(file).size > 64_000) throw new Error(`OpenSpec context budget exceeded: ${relative}`)
  // Tracked files may still match a newly added ignore rule; do not bypass that policy.
  const text = fs.readFileSync(file, "utf8")
  if (text.includes("\u0000")) throw new Error(`binary context unsupported: ${relative}`)
  return { path: relative, sha256: digest(text), text }
}

const inode = (file: string) => { const s = fs.statSync(file); return `${s.dev}:${s.ino}` }
export interface ChangeIdentity {
  root: string
  repository: string
  directories: string[]
  change: string
  schema: string
  configHash: string
  tracking: string
  runtimeHash: string
  planning: Array<{ path: string; sha256: string }>
}
export function changeIdentity(root: string, name: string, schema: string, tracking: string, runtimeHash = "", planningPaths: string[] = []): ChangeIdentity {
  root = selectedRoot(root)
  changeName(name)
  const directories = [root, safePath(root, "openspec", true), safePath(root, "openspec/changes", true), safePath(root, `openspec/changes/${name}`, true)]
  const repository = fs.realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root))
  const configs = ["openspec/config.yaml", "openspec/config.yml", ".taskflow/config.jsonc", ".opencode/taskflow.jsonc", `openspec/changes/${name}/.openspec.yaml`].map((rel) => {
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) return `${rel}:absent`
    // Only these exact metadata filenames may be hidden; all ancestors remain confined.
    let current = root
    for (const part of rel.split("/")) {
      current = path.join(current, part)
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`symlink configuration unsupported: ${rel}`)
    }
    const s = fs.statSync(file)
    if (!s.isFile() || s.nlink !== 1 || s.size > 64_000 || !(s.mode & 0o444)) throw new Error(`unsafe/unreadable configuration: ${rel}`)
    const text = fs.readFileSync(file, "utf8")
    if (rel.endsWith(".jsonc")) {
      const value = parseJsonc(text)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`malformed Taskflow configuration: ${rel}`)
    }
    return `${rel}:${digest(text)}`
  })
  const global = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "openspec/config.json")
  if (fs.existsSync(global)) {
    const s = fs.lstatSync(global)
    if (!s.isFile() || s.isSymbolicLink() || s.size > 64_000 || !(s.mode & 0o444)) throw new Error("unsafe/unreadable global OpenSpec config")
    const text = fs.readFileSync(global, "utf8")
    const value = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed global OpenSpec config")
    configs.push(`global:${global}:${digest(text)}`)
  } else configs.push(`global:${global}:absent`)
  const planning = [...new Set(planningPaths)].sort().map((file) => {
    if (!file.startsWith(`openspec/changes/${name}/`) || file === tracking) throw new Error("planning context identity escaped selected change")
    const ref = readReference(root, file)
    return { path: ref.path, sha256: ref.sha256 }
  })
  return { root, repository, directories: [...directories, repository].map(inode), change: name, schema, configHash: digest(configs.join("\n")), tracking, runtimeHash, planning }
}

export function recordDirectory(root: string): string {
  // Local execution associations are not a second tracked backlog and do not dirty the user's source tree.
  const common = fs.realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root))
  const dir = path.join(common, ".taskflow", "openspec")
  for (const file of [path.join(common, ".taskflow"), dir]) {
    if (!fs.existsSync(file)) continue
    if (!fs.lstatSync(file).isDirectory() || fs.lstatSync(file).isSymbolicLink()) throw new Error("unsafe execution record directory")
  }
  return dir
}

export interface ExecutionRecord {
  version: 1
  change: string
  sourceRoot: string
  sourceCommit: string
  configDigest: string
  worktree: string
  branch: string
  identity: ChangeIdentity
  phase: "claimed" | "setup_failed" | "review" | "cleaned"
  pr?: string
  head?: string
}
const recordRevisions = new WeakMap<ExecutionRecord, string>()
export function readExecution(root: string, change: string): ExecutionRecord {
  const file = path.join(recordDirectory(root), `${changeName(change)}.json`)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32_000) throw new Error("unsafe execution record")
  const text = fs.readFileSync(file, "utf8")
  const r = JSON.parse(text) as ExecutionRecord
  if (r.version !== 1 || r.change !== change || !path.isAbsolute(r.worktree ?? "") || !path.isAbsolute(r.sourceRoot ?? "") || !/^[a-f0-9]{40,64}$/.test(r.sourceCommit ?? "") || r.branch !== `openspec/${change}` || !["claimed", "setup_failed", "review", "cleaned"].includes(r.phase) || r.identity?.change !== change) throw new Error("invalid execution record")
  if (r.identity.repository !== fs.realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root))) throw new Error("execution record repository mismatch")
  if (!/^[a-f0-9]{64}$/.test(r.configDigest ?? "")) throw new Error("invalid execution config digest")
  if (r.identity.root !== r.worktree || r.identity.schema !== "spec-driven" || r.identity.tracking !== `openspec/changes/${change}/tasks.md` || !/^[a-f0-9]{64}$/.test(r.identity.configHash) || !/^[a-f0-9]{64}$/.test(r.identity.runtimeHash) || !Array.isArray(r.identity.directories) || r.identity.directories.length !== 5 || r.identity.directories.some((s) => typeof s !== "string")) throw new Error("invalid execution source identity")
  if (!Array.isArray(r.identity.planning) || r.identity.planning.some((ref) => typeof ref.path !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256))) throw new Error("invalid planning context identity")
  recordRevisions.set(r, digest(text))
  return r
}

export function writeExecution(root: string, record: ExecutionRecord, create = false): void {
  const dir = recordDirectory(root)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${changeName(record.change)}.json`)
  const text = JSON.stringify(record, null, 2) + "\n"
  if (Buffer.byteLength(text) > 32_000) throw new Error("execution record budget exceeded")
  if (!create) {
    const current = readExecution(root, record.change)
    if (!recordRevisions.has(record) || recordRevisions.get(record) !== recordRevisions.get(current)) throw new Error("execution record changed since read; refresh explicitly before updating")
  }
  const temp = path.join(dir, `${record.change}-${crypto.randomUUID()}.tmp`)
  try { fs.writeFileSync(temp, text, { flag: "wx", mode: 0o600 }); if (create) fs.linkSync(temp, file); else fs.renameSync(temp, file); recordRevisions.set(record, digest(text)) }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

export function validateExecution(root: string, change: string): ExecutionRecord {
  const r = readExecution(root, change)
  if (r.phase === "cleaned") throw new Error("execution already cleaned")
  if (mainCheckout(r.worktree) !== mainCheckout(root) || git(["branch", "--show-current"], r.worktree) !== r.branch || git(["merge-base", r.sourceCommit, "HEAD"], r.worktree) !== r.sourceCommit) throw new Error("execution worktree/branch/source commit changed")
  const identity = changeIdentity(r.worktree, change, r.identity.schema, r.identity.tracking, r.identity.runtimeHash, r.identity.planning.map((ref) => ref.path))
  if (JSON.stringify(identity) !== JSON.stringify(r.identity)) throw new Error("OpenSpec source/config/root identity changed; explicit new execution association required")
  readReference(r.worktree, r.identity.tracking)
  return r
}

import fs from "node:fs"
import path from "node:path"
import type { TaskflowConfig } from "../config.ts"
import { asString } from "./frontmatter.ts"
import { git } from "./git.ts"
import { repositoryRelativePath } from "./scaffold.ts"
import { loadTasks } from "./tasks.ts"

/** Source location/directory identity, NOT a task or standards content snapshot. */
export interface TaskSourceIdentity {
  root: string
  rootPath: string
  rootId: string
  repository: string
  repositoryId: string
  tasks: string
  directoryIds: string[]
  file: string
}

const identity = (file: string) => { const s = fs.statSync(file, { bigint: true }); return `${s.dev}:${s.ino}` }
const absolute = (v: unknown): v is string => typeof v === "string" && path.isAbsolute(v)
const fsID = (v: unknown): v is string => typeof v === "string" && /^\d+:\d+$/.test(v)

export function isTaskSourceIdentity(value: any): value is TaskSourceIdentity {
  if (!value || !absolute(value.root) || !absolute(value.rootPath) || !absolute(value.repository) || !absolute(value.file) || !fsID(value.rootId) || !fsID(value.repositoryId) || typeof value.tasks !== "string" || !Array.isArray(value.directoryIds) || !value.directoryIds.length || !value.directoryIds.every(fsID)) return false
  try { repositoryRelativePath(value.tasks) } catch { return false }
  return value.directoryIds.length === value.tasks.split("/").length
}

/** Resolve BEFORE child creation, then compare on EVERY continuation, including after plugin reload. */
export function readTaskSource(sourceRoot: string, cfg: TaskflowConfig, id: string) {
  repositoryRelativePath(cfg.paths.tasks)
  const rootPath = path.resolve(sourceRoot)
  const root = fs.realpathSync(rootPath)
  if (!fs.statSync(root).isDirectory()) throw new Error(`task source root is not a directory: ${sourceRoot}`)
  const repository = fs.realpathSync(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root))
  let directory = root
  const directoryIds: string[] = []
  for (const segment of cfg.paths.tasks.split("/")) {
    directory = path.join(directory, segment)
    // Do not normalize aliases into apparent continuity. Task directory aliases are not stable source identities.
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`task source directory must be a real directory, not a symlink: ${directory}`)
    directoryIds.push(identity(directory))
  }
  for (const name of fs.readdirSync(directory).filter((n) => /^T-.*\.md$/.test(n))) {
    if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(`task source must be a regular file, not a symlink: ${name}`)
  }
  const docs = loadTasks(root, cfg).filter((d) => asString(d.data?.id) === id)
  if (docs.length !== 1 || !docs[0]?.data) throw new Error(`task ${id} not found uniquely or missing frontmatter in ${root}`)
  const doc = docs[0]
  const source: TaskSourceIdentity = { root, rootPath, rootId: identity(root), repository, repositoryId: identity(repository), tasks: cfg.paths.tasks, directoryIds, file: fs.realpathSync(doc.file) }
  return { doc, source }
}

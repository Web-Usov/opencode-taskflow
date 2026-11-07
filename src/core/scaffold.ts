import fs from "node:fs"
import path from "node:path"

/** Portable spelling policy shared by deterministic scaffold/task-source filesystem checks. */
export function repositoryRelativePath(rel: string): void {
  if (!rel || /[\\:\x00-\x1f\x7f]/.test(rel) || path.posix.isAbsolute(rel) || rel.split("/").some((p) => !p || p === "." || p === "..")) {
    throw new Error(`unsafe repository-relative path: ${rel}`)
  }
}

const within = (root: string, file: string) => file === root || file.startsWith(root + path.sep)

/**
 * Preflight the COMPLETE write set before mkdir/write/append/board generation. Existing files are compatible;
 * directories/devices/dangling links at file destinations are not. Resolve every existing ancestor (including links),
 * so neither escaping aliases nor planned file/parent collisions can cause partial scaffolding. Not a race sandbox.
 */
export function preflightScaffold(root: string, destinations: readonly string[], directories: readonly string[] = []): void {
  const repo = fs.realpathSync(root)
  if (!fs.statSync(repo).isDirectory()) throw new Error(`scaffold root is not a directory: ${root}`)
  const targets = [...destinations.map((rel) => ({ rel, kind: "file" as const })), ...directories.map((rel) => ({ rel, kind: "directory" as const }))]
  const resolved = targets.map(({ rel, kind }) => {
    repositoryRelativePath(rel)
    let current = repo
    let identity: string | undefined
    const parts = rel.split("/")
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]!)
      let exists = true
      try { fs.lstatSync(current) }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw e }
      if (!exists) continue
      current = fs.realpathSync(current) // dangling links fail, rather than looking like absent destinations
      if (!within(repo, current)) throw new Error(`scaffold destination escapes repository: ${rel}`)
      const stat = fs.statSync(current)
      if (i < parts.length - 1 || kind === "directory" ? !stat.isDirectory() : !stat.isFile()) throw new Error(`incompatible scaffold destination type: ${rel}`)
      if (i === parts.length - 1 && kind === "file") {
        const id = fs.statSync(current, { bigint: true })
        identity = `${id.dev}:${id.ino}`
      }
    }
    return { rel, kind, file: current, identity }
  })
  for (let i = 0; i < resolved.length; i++) for (const other of resolved.slice(i + 1)) {
    const file = resolved[i]!
    if ((file.kind === "file" && within(file.file, other.file)) || (other.kind === "file" && within(other.file, file.file)) || (file.identity && file.identity === other.identity)) {
      throw new Error(`colliding scaffold destinations: ${file.rel} and ${other.rel}`)
    }
  }
}

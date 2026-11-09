import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { defaultConfig, deepMerge, type TaskflowConfig } from "../src/config.ts"

export const sh = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim()

export function tmpdir(prefix = "tf-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function write(root: string, rel: string, content: string) {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
}

export function cfg(overrides: unknown = {}): TaskflowConfig {
  // Historical task/epic fixtures deliberately exercise the supported legacy layout.
  return deepMerge(defaultConfig("en", true), deepMerge({ backend: "standalone", git: { baseBranch: "main" } }, overrides))
}

export function taskFile(o: {
  id: string
  title?: string
  status?: string
  epic?: string
  depends?: string[]
  blocked_by?: string[]
  area?: string
  size?: string
  branch?: string | null
  pr?: string | null
  dod?: string
  result?: string
}): string {
  const list = (l: string[] = []) => `[${l.join(", ")}]`
  return `---
id: ${o.id}
title: ${o.title ?? `Task ${o.id}`}
status: ${o.status ?? "todo"}          # todo | in_progress | review | done | blocked
epic: ${o.epic ?? "E-01"}
depends: ${list(o.depends)}
blocked_by: ${list(o.blocked_by)}
spec: []
acceptance: []
area: ${o.area ?? "api"}
size: ${o.size ?? "S"}
branch: ${o.branch ?? "null"}
pr: ${o.pr ?? "null"}
---

# ${o.id}. ${o.title ?? "Task"}

## Definition of Done

${o.dod ?? "- [ ] test passes"}

## Handoff log

## Result

${o.result ?? "<!-- filled at the end -->"}
`
}

export const epicFile = (id: string, title = "Epic", status = "planned") => `---
id: ${id}
title: ${title}
status: ${status}
accepted: null
spec: []
---

# ${id}. ${title}
`

/** A repo with a bare origin, `main` pushed, tasks/epics/template committed. Returns { origin, main }. */
export function repoWithOrigin(files: Record<string, string>): { origin: string; main: string; dir: string } {
  const dir = tmpdir("tf-repo-")
  const origin = path.join(dir, "origin.git")
  sh("git", ["init", "-q", "--bare", "-b", "main", origin], dir)
  const main = path.join(dir, "app")
  sh("git", ["clone", "-q", origin, main], dir)
  sh("git", ["checkout", "-q", "-b", "main"], main)
  for (const [rel, content] of Object.entries(files)) write(main, rel, content)
  sh("git", ["add", "-A"], main)
  sh("git", ["commit", "-qm", "init"], main)
  sh("git", ["push", "-q", "origin", "main"], main)
  return { origin, main, dir }
}

export const TEMPLATE = fs.readFileSync(path.join(import.meta.dir, "../templates/tasks/_template.md"), "utf8")

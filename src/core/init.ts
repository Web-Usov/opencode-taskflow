import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defaultConfig, type TaskflowConfig } from "../config.ts"
import { contract } from "../roles.ts"
import type { RepoLayout } from "./guard.ts"
import { detectBaseBranch, tryGit } from "./git.ts"
import { writeBoard } from "./tasks.ts"
import { standardFile } from "./standards.ts"

export const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../templates")

export interface Detected {
  packageManager: "pnpm" | "yarn" | "bun" | "npm" | null
  install: string | null
  verify: { full: string | null; quick: string | null; e2e: string | null }
  baseBranch: string
  repo: string | null
}

/** Best-effort detection of how the project installs and verifies itself. */
export function detect(root: string): Detected {
  const has = (f: string) => fs.existsSync(path.join(root, f))
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : has("package-lock.json") ? "npm" : null
  const install = pm === "pnpm" ? "pnpm install --frozen-lockfile --prefer-offline" : pm === "yarn" ? "yarn install --frozen-lockfile" : pm === "bun" ? "bun install --frozen-lockfile" : pm === "npm" ? "npm ci" : null
  let scripts: Record<string, string> = {}
  try {
    scripts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {}
  } catch {
    /* no package.json */
  }
  const runCmd = (s: string) => (pm === "npm" || !pm ? `npm run ${s}` : `${pm} ${s}`)
  const pick = (...names: string[]) => names.find((n) => n in scripts) ?? null
  const full = pick("verify", "check", "ci", "test")
  const quick = pick("verify:quick", "check:quick", "lint")
  const e2e = pick("e2e:smoke", "e2e", "test:e2e")
  let verify = { full: full ? runCmd(full) : null, quick: quick && quick !== full ? runCmd(quick) : null, e2e: e2e ? runCmd(e2e) : null }
  if (!pm) {
    if (has("Makefile") && /^test:/m.test(fs.readFileSync(path.join(root, "Makefile"), "utf8"))) verify = { ...verify, full: "make test" }
    else if (has("pyproject.toml")) verify = { ...verify, full: "pytest" }
    else if (has("go.mod")) verify = { ...verify, full: "go test ./..." }
    else if (has("Cargo.toml")) verify = { ...verify, full: "cargo test" }
  }
  const url = tryGit(["remote", "get-url", "origin"], root)
  const repo = url?.match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1] ?? null
  return { packageManager: pm, install, verify, baseBranch: detectBaseBranch(root, "origin", null), repo }
}

export function renderProjectConfig(d: Detected, human: string, standards = defaultConfig().standards): string {
  const j = (v: unknown) => JSON.stringify(v)
  return `{
  // opencode-taskflow project config. Global defaults: ~/.config/opencode/taskflow.jsonc. Reference: plugin README.
  "language": { "human": ${j(human)}, "agent": "en" },
  "git": { "remote": "origin", "baseBranch": ${j(d.baseBranch)}, "branchPrefix": "task/", "worktreeDir": "../{repo}-wt" },
  "task": { "areas": ["api", "web", "mobile", "infra", "docs"], "sizes": ["S", "M"] },
  // Files copied from the main checkout into every new worktree (git-ignored env files), and commands run there.
  "setup": { "copy": [], "commands": ${j(d.install ? [d.install] : [])} },
  "verify": { "full": ${j(d.verify.full)}, "quick": ${j(d.verify.quick)}, "e2e": ${j(d.verify.e2e)} },
  // Required CI checks (names of GitHub status checks).
  "ci": { "checks": [] },
  // Only the planner edits these; PRs touching them wait for the human.
  "protected": ["docs/spec/**", "docs/decisions/**", "epics/**"],
  "qaPaths": ["e2e/**"],
  // Reference index only: status is a routing hint, not authenticated human sign-off.
  "standards": ${j(standards)},
  "review": { "maxRounds": 3, "autoMerge": true, "mergeMethod": "squash" },
  "parallel": 2,
  // Model chains per role: first model your providers serve wins. Uncomment to override the global defaults.
  // "agents": { "implementer": { "models": ["anthropic/claude-opus-5-5#medium"] } },
  // Route implementer tasks to categories by size/area (categories are defined globally or here).
  "routing": [
    { "when": { "size": "S" }, "category": "quick" }
  ]
}
`
}

export interface InitResult {
  created: string[]
  skipped: string[]
  detected: Detected
}

/** Scaffolds the process files. Never overwrites an existing file. */
export function init(root: string, cfg: TaskflowConfig, layout: RepoLayout, opts: { human?: string } = {}): InitResult {
  const human = opts.human ?? cfg.language.human
  const created: string[] = []
  const skipped: string[] = []
  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel)
    if (fs.existsSync(abs)) {
      skipped.push(rel)
      return
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    created.push(rel)
  }
  const tpl = (rel: string) => fs.readFileSync(path.join(TEMPLATES_DIR, rel), "utf8")
  const detected = detect(root)

  // Validate scaffold destinations before writing; existing index/docs are never replaced.
  standardFile(root, cfg.standards.index, cfg)
  standardFile(root, "docs/standards/README.md", { ...cfg, standards: { ...cfg.standards, roots: [...cfg.standards.roots, "docs"] } })

  write(".opencode/taskflow.jsonc", renderProjectConfig(detected, human, cfg.standards))
  write(cfg.paths.template, tpl("tasks/_template.md"))
  write(path.join(cfg.paths.epics, "README.md"), tpl("epics/README.md"))
  const hasEpic = fs.existsSync(path.join(root, cfg.paths.epics)) && fs.readdirSync(path.join(root, cfg.paths.epics)).some((f) => /^E-\d+.*\.md$/.test(f))
  if (!hasEpic) write(path.join(cfg.paths.epics, "E-01-example.md"), tpl("epics/E-01-example.md"))
  write(".github/pull_request_template.md", tpl("github/pull_request_template.md"))
  write(".github/PULL_REQUEST_TEMPLATE/human-review.md", tpl(`github/PULL_REQUEST_TEMPLATE/human-review.${human === "ru" ? "ru" : "en"}.md`))
  write("docs/taskflow.md", `# Workflow\n\nGenerated by opencode-taskflow \`tf_init\`; regenerate or edit freely.\n\n${contract(cfg, layout)}\n`)
  write(cfg.standards.index, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n")
  const exampleRoot = cfg.standards.roots[0]!
  const examplePath = /\.(md|txt|rst|adoc)$/i.test(exampleRoot) ? exampleRoot : `${exampleRoot}/existing.md`
  const guide = tpl(`standards/README.${human === "ru" ? "ru" : "en"}.md`)
    .replaceAll("`index.json`", `\`${cfg.standards.index}\``)
    .replaceAll('"path": "docs/existing.md"', `"path": ${JSON.stringify(examplePath)}`)
    .replaceAll("`roots` (default `docs`, `AGENTS.md`)", `\`roots\` (${JSON.stringify(cfg.standards.roots)})`)
    .replaceAll("`roots` (по умолчанию `docs`, `AGENTS.md`)", `\`roots\` (${JSON.stringify(cfg.standards.roots)})`)
    .replaceAll("`maxContextChars` (24000)", `\`maxContextChars\` (${cfg.standards.maxContextChars})`)
  write("docs/standards/README.md", guide)

  const agentsMd = path.join(root, "AGENTS.md")
  const section = `\n## Workflow (opencode-taskflow)\n\nTasks, worktrees, PRs and reviews follow \`docs/taskflow.md\`. Roles: lead, planner, implementer, reviewer, qa. Start with \`/${cfg.commandPrefix}status\` or \`/${cfg.commandPrefix}next\`.\n`
  if (!fs.existsSync(agentsMd)) {
    fs.writeFileSync(agentsMd, `# Agent guide\n${section}`)
    created.push("AGENTS.md")
  } else if (!fs.readFileSync(agentsMd, "utf8").includes("opencode-taskflow")) {
    fs.appendFileSync(agentsMd, section)
    created.push("AGENTS.md (workflow section appended)")
  } else skipped.push("AGENTS.md")

  const board = writeBoard(root, cfg)
  if (board.written) created.push(cfg.paths.board)
  return { created, skipped, detected }
}

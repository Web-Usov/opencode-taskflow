import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defaultConfig, type TaskflowConfig } from "../config.ts"
import { contract } from "../roles.ts"
import type { RepoLayout } from "./guard.ts"
import { detectBaseBranch, tryGit } from "./git.ts"
import { writeBoard } from "./tasks.ts"
import { standardFile } from "./standards.ts"
import { preflightScaffold } from "./scaffold.ts"

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

export function renderProjectConfig(d: Detected, human: string, standards = defaultConfig().standards, effective?: TaskflowConfig): string {
  const cfg = effective ?? { ...defaultConfig(human), standards, verify: d.verify, setup: { copy: [], commands: d.install ? [d.install] : [] } }
  // Keep model selection inherited from global config/options, rather than freezing its chains into every project.
  const { agents: _agents, categories: _categories, ...project } = cfg
  return `// opencode-taskflow: effective project settings; existing product documents remain canonical.\n${JSON.stringify({ ...project, language: { ...cfg.language, human } }, null, 2)}\n`
}

export interface InitResult {
  created: string[]
  skipped: string[]
  detected: Detected
}

/** Scaffolds the process files. Never overwrites an existing file. */
export function init(root: string, cfg: TaskflowConfig, layout: RepoLayout, opts: { human?: string; agentsLink?: boolean; githubTemplate?: boolean } = {}): InitResult {
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
  // Persist the same effective verification/settings used in the generated workflow.
  const existingConfig = fs.existsSync(path.join(root, cfg.paths.config))
  cfg = {
    ...cfg,
    language: { ...cfg.language, human },
    board: JSON.stringify(cfg.board) === JSON.stringify(defaultConfig(cfg.language.human).board) ? defaultConfig(human).board : cfg.board,
    git: { ...cfg.git, baseBranch: cfg.git.baseBranch ?? detected.baseBranch },
    verify: existingConfig ? cfg.verify : {
      full: cfg.verify.full ?? detected.verify.full,
      quick: cfg.verify.quick ?? detected.verify.quick,
      e2e: cfg.verify.e2e ?? detected.verify.e2e,
    },
    setup: { ...cfg.setup, commands: cfg.setup.commands.length ? cfg.setup.commands : detected.install ? [detected.install] : [] },
  }

  // Every destination, including optional integrations and the generated board, is checked before the FIRST write.
  preflightScaffold(root, [
    cfg.paths.config, cfg.paths.template, `${cfg.paths.epics}/README.md`, cfg.paths.epicTemplate,
    cfg.paths.prTemplate, cfg.paths.humanReviewTemplate, cfg.paths.workflow, cfg.standards.index,
    cfg.paths.standardsGuide, cfg.paths.board,
    ...(opts.agentsLink ? ["AGENTS.md"] : []),
    ...(opts.githubTemplate && cfg.paths.humanReviewTemplate !== ".github/PULL_REQUEST_TEMPLATE/human-review.md" ? [".github/PULL_REQUEST_TEMPLATE/human-review.md"] : []),
  ], [cfg.paths.tasks])
  standardFile(root, cfg.standards.index, cfg)
  standardFile(root, cfg.paths.standardsGuide, { ...cfg, standards: { ...cfg.standards, roots: [...cfg.standards.roots, path.posix.dirname(cfg.paths.standardsGuide)] } })

  write(cfg.paths.config, renderProjectConfig(detected, human, cfg.standards, cfg))
  write(cfg.paths.template, tpl("tasks/_template.md").replaceAll("{{config}}", cfg.paths.config).replaceAll("{{epics}}", cfg.paths.epics))
  write(path.join(cfg.paths.epics, "README.md"), tpl("epics/README.md").replaceAll("../tasks/", path.posix.relative(cfg.paths.epics, cfg.paths.tasks) + "/"))
  write(cfg.paths.epicTemplate, tpl("epics/E-01-example.md"))
  write(cfg.paths.prTemplate, tpl("github/pull_request_template.md").replaceAll("{{humanReviewTemplate}}", cfg.paths.humanReviewTemplate))
  write(cfg.paths.humanReviewTemplate, tpl(`github/PULL_REQUEST_TEMPLATE/human-review.${human === "ru" ? "ru" : "en"}.md`))
  if (opts.githubTemplate) write(".github/PULL_REQUEST_TEMPLATE/human-review.md", tpl(`github/PULL_REQUEST_TEMPLATE/human-review.${human === "ru" ? "ru" : "en"}.md`))
  write(cfg.paths.workflow, `# Workflow\n\nGenerated by opencode-taskflow \`tf_init\`; regenerate or edit freely.\n\n${contract(cfg, layout)}\n`)
  write(cfg.standards.index, JSON.stringify({ version: 1, entries: [] }, null, 2) + "\n")
  const exampleRoot = cfg.standards.roots[0]!
  const examplePath = /\.(md|txt|rst|adoc)$/i.test(exampleRoot) ? exampleRoot : `${exampleRoot}/existing.md`
  const guide = tpl(`standards/README.${human === "ru" ? "ru" : "en"}.md`)
    .replaceAll("docs/plans/<slug>/shape.md", `${cfg.paths.plans}/<slug>/shape.md`)
    .replaceAll("`index.json`", `\`${cfg.standards.index}\``)
    .replaceAll('"path": "docs/existing.md"', `"path": ${JSON.stringify(examplePath)}`)
    .replaceAll("`roots` (default `docs`, `AGENTS.md`)", `\`roots\` (${JSON.stringify(cfg.standards.roots)})`)
    .replaceAll("`roots` (по умолчанию `docs`, `AGENTS.md`)", `\`roots\` (${JSON.stringify(cfg.standards.roots)})`)
    .replaceAll("`maxContextChars` (24000)", `\`maxContextChars\` (${cfg.standards.maxContextChars})`)
  write(cfg.paths.standardsGuide, guide)

  const agentsMd = path.join(root, "AGENTS.md")
  const section = `\n## Workflow (opencode-taskflow)\n\nTasks, worktrees, PRs and reviews follow \`${cfg.paths.workflow}\`. Roles: lead, planner, implementer, reviewer, qa. Start with \`/${cfg.commandPrefix}status\` or \`/${cfg.commandPrefix}next\`.\n`
  if (opts.agentsLink && !fs.existsSync(agentsMd)) {
    fs.writeFileSync(agentsMd, `# Agent guide\n${section}`)
    created.push("AGENTS.md")
  } else if (opts.agentsLink && !fs.readFileSync(agentsMd, "utf8").includes("opencode-taskflow")) {
    fs.appendFileSync(agentsMd, section)
    created.push("AGENTS.md (workflow section appended)")
  } else if (opts.agentsLink) skipped.push("AGENTS.md")

  // Init is non-overwriting even for an existing board; tf_board is the explicit regeneration action.
  if (fs.existsSync(path.join(root, cfg.paths.board))) skipped.push(cfg.paths.board)
  else if (writeBoard(root, cfg).written) created.push(cfg.paths.board)
  return { created, skipped, detected }
}

/** Optional actual-published-CLI smoke. No installation, init/update/archive, network PR or model calls. */
import fs from "node:fs"
import path from "node:path"
import { defaultConfig } from "../src/config.ts"
import { gitAsync } from "../src/core/git.ts"
import { OpenSpec } from "../src/core/openspec.ts"
import { startChange } from "../src/core/openspec-execution.ts"
import { dispatchChange } from "../src/openspec-dispatch.ts"

const executable = process.argv[2]
if (!executable || !path.isAbsolute(executable)) throw new Error("usage: bun scripts/smoke-openspec.ts /absolute/path/to/installed/openspec")
fs.mkdirSync("/tmp/opencode", { recursive: true })
const scratch = fs.mkdtempSync("/tmp/opencode/taskflow-openspec-smoke-")
for (const [key, directory] of Object.entries({ HOME: "home", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache" })) {
  process.env[key] = path.join(scratch, directory); fs.mkdirSync(process.env[key]!, { recursive: true })
}
const root = path.join(scratch, "app"); fs.mkdirSync(root)
const git = (args: string[]) => gitAsync(args, root)
const write = (relative: string, text: string) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const commit = async (message: string) => { await git(["add", "-A"]); await git(["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", message]) }
await git(["init", "-q", "-b", "main"])
write("README.md", "Disposable adapter smoke\n"); await commit("base")
await git(["checkout", "-qb", "planning"])
write("openspec/config.yaml", "schema: spec-driven\n")
write("openspec/changes/demo/.openspec.yaml", "schema: spec-driven\ncreated: 2026-11-07\nskip_specs: true\n")
write("openspec/changes/demo/proposal.md", "# Why\nVerify an execution-only adapter without changing product behavior.\n\n# What Changes\nAdd a smoke test.\n")
write("openspec/changes/demo/tasks.md", "## 1. Smoke\n\n- [ ] 1.1 Verify adapter smoke produces expected evidence\n")
write(".opencode/commands/opsx-apply.md", "Native command sentinel\n")
write(".opencode/skills/openspec-apply-change/SKILL.md", "Native skill sentinel\n")
await commit("committed change off main")
const source = await git(["rev-parse", "HEAD"])
const cfg = defaultConfig("en"); cfg.backend = "openspec"; cfg.openspec.executable = executable; cfg.git.baseBranch = "main"; cfg.git.worktreeDir = path.join(scratch, "worktrees")
const adapter = new OpenSpec(cfg)
const inventory = await adapter.inventory(root)
const selected = await adapter.inspect(root, "demo")
if (selected.state !== "ready") throw new Error("expected ready native change")
const execution = await startChange(root, cfg, "demo", true)
if (execution.sourceCommit !== source || await git(["status", "--porcelain"])) throw new Error("source was changed")
const sessions = new Map<string, any>(), prompts: any[] = []
const host = {
  get: async ({ sessionID }: any) => sessions.get(sessionID),
  create: async (input: any) => { const s = { ...input, id: `child-${sessions.size}` }; sessions.set(s.id, JSON.parse(JSON.stringify(s))); return s },
  prompt: async (input: any) => { prompts.push(input) }, wait: async () => {}, interrupt: async () => {}, context: async () => [],
}
const input = { change: "demo", prompt: "Read-only context smoke, no model executed", parentSessionID: "parent", signal: new AbortController().signal }
const implementation = await dispatchChange(host, root, root, cfg, { ...input, role: "implementer" }, null)
const review = await dispatchChange(host, root, root, cfg, { ...input, role: "reviewer" }, null)
if (JSON.stringify(implementation.references) !== JSON.stringify(review.references) || review.directory !== root || implementation.directory !== execution.worktree) throw new Error("dispatch source/cwd mismatch")
if (fs.readFileSync(path.join(root, ".opencode/commands/opsx-apply.md"), "utf8") !== "Native command sentinel\n") throw new Error("native command changed")
fs.writeFileSync(path.join(execution.worktree, "openspec/changes/demo/tasks.md"), "## 1. Smoke\n\n- [x] 1.1 Verify adapter smoke produces expected evidence\n")
const completed = await adapter.inspect(execution.worktree, "demo")
if (completed.state !== "all_done") throw new Error("native completion not observed")
await dispatchChange(host, root, root, cfg, { ...input, change: undefined, role: "implementer", sessionID: implementation.sessionID }, null)
console.log(JSON.stringify({ ok: true, scratch, testedVersion: inventory.version, sourceBranch: "planning", source, mainHasChange: !!(await git(["ls-tree", "--name-only", "main", "openspec/"])), execution, references: review.references, nativeCompletion: completed.state, childPrompts: prompts.length, sourceClean: !(await git(["status", "--porcelain"])) }, null, 2))

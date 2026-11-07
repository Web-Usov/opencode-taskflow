import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { defaultConfig, deepMerge, type TaskflowConfig } from "../src/config.ts"
import { init } from "../src/core/init.ts"
import { tmpdir, write } from "./helpers.ts"

function snapshot(root: string): unknown {
  const visit = (dir: string): unknown => Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name)
    const stat = fs.lstatSync(file)
    return [name, stat.isSymbolicLink() ? { link: fs.readlinkSync(file) } : stat.isDirectory() ? visit(file) : fs.readFileSync(file, "utf8")]
  }))
  return visit(root)
}

type Setup = (root: string, outside: string, c: TaskflowConfig) => TaskflowConfig
const cases: Array<[string, Setup, { agentsLink?: boolean; githubTemplate?: boolean }?]> = [
  ["default templates directory escapes", (r, o, c) => { fs.mkdirSync(path.join(r, ".taskflow")); fs.symlinkSync(o, path.join(r, ".taskflow/templates")); return c }],
  ["workflow traversal", (_r, _o, c) => deepMerge(c, { paths: { workflow: "../outside.md" } })],
  ["workflow symlink ancestor", (r, o, c) => { fs.symlinkSync(o, path.join(r, "alias")); return deepMerge(c, { paths: { workflow: "alias/workflow.md" } }) }],
  ["workflow symlink file", (r, o, c) => { fs.symlinkSync(path.join(o, "keep.md"), path.join(r, "workflow.md")); return deepMerge(c, { paths: { workflow: "workflow.md" } }) }],
  ["AGENTS symlink file", (r, o, c) => { fs.symlinkSync(path.join(o, "keep.md"), path.join(r, "AGENTS.md")); return c }, { agentsLink: true }],
  ["GitHub symlink parent", (r, o, c) => { fs.symlinkSync(o, path.join(r, ".github")); return c }, { githubTemplate: true }],
  ["AGENTS incompatible type", (r, _o, c) => { fs.mkdirSync(path.join(r, "AGENTS.md")); return c }, { agentsLink: true }],
  ["GitHub incompatible type", (r, _o, c) => { fs.mkdirSync(path.join(r, ".github/PULL_REQUEST_TEMPLATE/human-review.md"), { recursive: true }); return c }, { githubTemplate: true }],
  ["board incompatible type", (r, _o, c) => { fs.mkdirSync(path.join(r, c.paths.board), { recursive: true }); return c }],
  ["index incompatible type", (r, _o, c) => { fs.mkdirSync(path.join(r, c.standards.index), { recursive: true }); return c }],
  ["config incompatible type", (r, _o, c) => { fs.mkdirSync(path.join(r, c.paths.config), { recursive: true }); return c }],
  ["file as parent", (r, _o, c) => { write(r, ".taskflow/templates", "not a directory"); return c }],
  ["tasks directory incompatible with separate board", (r, _o, c) => { write(r, ".taskflow/items", "not a directory"); return deepMerge(c, { paths: { tasks: ".taskflow/items", board: ".taskflow/board.md" } }) }],
  ["tasks directory escape with separate board", (r, o, c) => { fs.mkdirSync(path.join(r, ".taskflow")); fs.symlinkSync(o, path.join(r, ".taskflow/items")); return deepMerge(c, { paths: { tasks: ".taskflow/items", board: ".taskflow/board.md" } }) }],
  ["same destination", (_r, _o, c) => deepMerge(c, { paths: { workflow: c.paths.template } })],
  ["planned file as parent", (_r, _o, c) => deepMerge(c, { paths: { workflow: ".taskflow/templates" } })],
  ["internal symlink alias collision", (r, _o, c) => { fs.mkdirSync(path.join(r, "in")); fs.symlinkSync("in", path.join(r, "alias")); return deepMerge(c, { paths: { workflow: "in/file.md", template: "alias/file.md" } }) }],
  ...["config", "template", "epicTemplate", "standardsGuide", "prTemplate", "humanReviewTemplate", "board", "epics"].map((key): [string, Setup] => [`unsafe ${key} destination`, (_r, _o, c) => deepMerge(c, { paths: { [key]: "../outside" } })]),
  ["unsafe index destination", (_r, _o, c) => deepMerge(c, { standards: { index: "../outside.json" } })],
  ...["/absolute.md", "https://host/file.md", "dir\\file.md", "dir/./file.md", "dir//file.md", "dir/../file.md", "file\n.md", "file\0.md"].map((bad): [string, Setup] => [`unsafe spelling ${JSON.stringify(bad)}`, (_r, _o, c) => deepMerge(c, { paths: { workflow: bad } })]),
]

for (const [name, setup, opts] of cases) test(`init preflight fails without side effects: ${name}`, () => {
  const root = tmpdir()
  const outside = tmpdir()
  write(outside, "keep.md", "EXTERNAL USER CONTENT")
  const cfg = setup(root, outside, defaultConfig("en"))
  const before = snapshot(root)
  const external = snapshot(outside)
  expect(() => init(root, cfg, { base: "main", mainDir: root, worktreeParent: root + "-wt" }, opts)).toThrow()
  expect(snapshot(root)).toEqual(before)
  expect(snapshot(outside)).toEqual(external)
})

test("init preserves existing compatible user files, including board, after successful preflight", () => {
  const root = tmpdir()
  const cfg = defaultConfig("en")
  for (const file of [cfg.paths.workflow, cfg.paths.template, cfg.paths.board, cfg.paths.config]) write(root, file, `USER ${file}`)
  init(root, cfg, { base: "main", mainDir: root, worktreeParent: root + "-wt" })
  for (const file of [cfg.paths.workflow, cfg.paths.template, cfg.paths.board, cfg.paths.config]) expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(`USER ${file}`)
})

test("confined compatible scaffold aliases remain valid when they do not collide", () => {
  const root = tmpdir()
  write(root, "inside/workflow.md", "Existing canonical workflow")
  fs.symlinkSync("inside", path.join(root, "alias"))
  const cfg = deepMerge(defaultConfig("en"), { paths: { workflow: "alias/workflow.md" } })
  const r = init(root, cfg, { base: "main", mainDir: root, worktreeParent: root + "-wt" })
  expect(r.skipped).toContain("alias/workflow.md")
  expect(fs.readFileSync(path.join(root, "inside/workflow.md"), "utf8")).toBe("Existing canonical workflow")
  expect(fs.existsSync(path.join(root, ".taskflow/config.jsonc"))).toBe(true)
})

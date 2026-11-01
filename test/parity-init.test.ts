import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { loadConfig } from "../src/config.ts"
import { detect, init } from "../src/core/init.ts"
import { check, renderBoard } from "../src/core/tasks.ts"
import { cfg, repoWithOrigin, tmpdir, write } from "./helpers.ts"

/**
 * The task system was extracted from a real project (finance). With the same configuration the plugin must render that
 * project's committed board byte for byte and find no errors. Skipped when the project is not on this machine.
 */
const FINANCE = process.env.TASKFLOW_PARITY_DIR ?? "/root/workspace/finance"
describe.skipIf(!fs.existsSync(path.join(FINANCE, "tasks/README.md")))("parity with the original scripts", () => {
  test("board and check match", () => {
    const { config } = loadConfig(
      FINANCE,
      {
        task: { areas: ["api", "mobile", "infra", "docs"] },
        spec: {
          dir: "docs/spec",
          definition: "\\*\\*\\[([A-Z]+-\\d{2,3})\\]\\*\\*|~~\\[([A-Z]+-\\d{2,3})\\]~~",
          questions: "docs/spec/99-open-questions.md",
          questionPattern: "\\*\\*\\[(Q-\\d+)\\]\\*\\*",
          acceptancePattern: "^AC-\\d+$",
        },
        board: {
          header: [
            "# Доска задач (генерируется, не редактировать)",
            "",
            "> Файл создаётся командой `node scripts/tasks.mjs board`. Источник правды — frontmatter файлов `tasks/T-*.md` и `epics/E-*.md`. Сводные счётчики не хранятся в файле: их печатает `pnpm tasks:board`.",
            "",
          ],
        },
      },
      "/nonexistent",
    )
    expect(renderBoard(FINANCE, config)).toBe(fs.readFileSync(path.join(FINANCE, "tasks/README.md"), "utf8"))
    expect(check(FINANCE, config).errors).toEqual([])
  })
})

describe("init", () => {
  test("detects pnpm scripts and scaffolds without overwriting", () => {
    const { main } = repoWithOrigin({
      "package.json": JSON.stringify({ scripts: { verify: "x", "verify:quick": "y", "e2e:smoke": "z" } }),
      "pnpm-lock.yaml": "",
      "AGENTS.md": "# Guide\n",
      ".github/pull_request_template.md": "mine",
    })
    const d = detect(main)
    expect(d).toMatchObject({ packageManager: "pnpm", verify: { full: "pnpm verify", quick: "pnpm verify:quick", e2e: "pnpm e2e:smoke" }, baseBranch: "main" })
    const r = init(main, cfg(), { base: "main", mainDir: main, worktreeParent: main + "-wt" }, { human: "ru" })
    expect(r.created).toContain(".opencode/taskflow.jsonc")
    expect(r.created).toContain("tasks/_template.md")
    expect(r.created).toContain("epics/E-01-example.md")
    expect(r.created).toContain("AGENTS.md (workflow section appended)")
    expect(r.skipped).toContain(".github/pull_request_template.md")
    expect(fs.readFileSync(path.join(main, ".github/pull_request_template.md"), "utf8")).toBe("mine")
    expect(fs.readFileSync(path.join(main, ".github/PULL_REQUEST_TEMPLATE/human-review.md"), "utf8")).toContain("Требуется ревью человека")
    const project = fs.readFileSync(path.join(main, ".opencode/taskflow.jsonc"), "utf8")
    expect(project).toContain('"full": "pnpm verify"')
    expect(project).toContain('"commands": ["pnpm install --frozen-lockfile --prefer-offline"]')
    // the scaffold itself is a valid task system
    const loaded = loadConfig(main, undefined, "/nonexistent").config
    expect(check(main, loaded).errors).toEqual([])
    // second run changes nothing
    expect(init(main, cfg(), { base: "main", mainDir: main, worktreeParent: main + "-wt" }).created).toEqual([])
  })

  test("detects non-JS projects", () => {
    const root = tmpdir()
    write(root, "go.mod", "module x")
    expect(detect(root).verify.full).toBe("go test ./...")
  })
})

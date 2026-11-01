import { describe, expect, test } from "bun:test"
import { agentChain, loadConfig, parseJsonc } from "../src/config.ts"
import { check } from "../src/core/tasks.ts"
import { cfg, epicFile, taskFile, tmpdir, write } from "./helpers.ts"

describe("parseJsonc edges", () => {
  test("', ]' inside a string is preserved", () => expect(parseJsonc(`{"cmd":"echo a, ]"}`)).toEqual({ cmd: "echo a, ]" }))
  test("leading BOM", () => expect(parseJsonc(`﻿{"a":1}`)).toEqual({ a: 1 }))
  test("comment between trailing comma and }", () => expect(parseJsonc(`{"a":1, // c\n /* d */ }`)).toEqual({ a: 1 }))
})

describe("loadConfig validation", () => {
  const load = (json: string) => {
    const root = tmpdir()
    write(root, ".opencode/taskflow.jsonc", json)
    return loadConfig(root, undefined, "/nonexistent")
  }
  test("protected as a string falls back to the default list", () => {
    const { config, sources } = load(`{ "protected": "docs/**" }`)
    expect(config.protected).toEqual(["docs/spec/**", "docs/decisions/**", "epics/**"])
    expect(sources.find((s) => s.path === "(validation)")).toMatchObject({ ok: false })
  })
  test("invalid mergeMethod falls back to squash", () => {
    expect(load(`{ "review": { "mergeMethod": "fast" } }`).config.review.mergeMethod).toBe("squash")
  })
  test("agents.implementer.model in the project layer beats the default chain", () => {
    const { config } = load(`{ "agents": { "implementer": { "model": "x/y#low" } } }`)
    expect(agentChain(config, "implementer")).toEqual(["x/y#low"])
  })
  test("an invalid spec regex disables spec and is reported", () => {
    const { config, sources } = load(`{ "spec": { "dir": "docs/spec", "definition": "(", "questions": null, "questionPattern": "x", "acceptancePattern": "y" } }`)
    expect(config.spec).toBeNull()
    expect(sources.find((s) => s.path === "(validation)")?.error).toContain("spec")
  })
})

describe("task.idPadding", () => {
  test("padding 2 accepts T-01-x.md and rejects T-1-x.md", () => {
    const root = tmpdir()
    const c = cfg({ task: { idPadding: 2 } })
    write(root, "epics/E-01-core.md", epicFile("E-01"))
    write(root, "tasks/T-01-x.md", taskFile({ id: "T-01" }))
    expect(check(root, c).errors).toEqual([])
    write(root, "tasks/T-1-x.md", taskFile({ id: "T-1" }))
    expect(check(root, c).errors.some((e) => e.includes("T-1-x.md"))).toBe(true)
  })
})

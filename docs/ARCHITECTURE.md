# Architecture

Audience: agents and maintainers. Language: English.

## Layout

```
index.ts               entry OpenCode loads from a configured plugin directory (re-exports src/index.ts)
src/index.ts           plugin setup: agents, commands, tools, guard hook, dispatch (child sessions), model refresh
src/config.ts          config schema, defaults, JSONC parser, layered loading
src/roles.ts           role prompts and the shared process contract (rendered from config)
src/commands.ts        slash command prompts
src/tools.ts           tf_* tool definitions (host-injected, testable without OpenCode)
src/core/frontmatter.ts flat YAML-subset frontmatter
src/core/tasks.ts      task/epic loading, check, board, ready, set (port of finance scripts/tasks.mjs)
src/core/claim.ts      claim (worktree), new-task ids, clean (port of task-start.mjs / task-clean.mjs)
src/core/models.ts     model chains and routing
src/core/guard.ts      per-role permission rules and the hard guard
src/core/init.ts       project detection and scaffolding
templates/             files tf_init copies into a project
test/                  bun tests (unit + real git repos + parity with finance)
scripts/e2e.sh         loads the plugin into the running OpenCode service and asserts through the HTTP API
```

## Decisions

1. **No runtime dependencies.** Only types come from `@opencode/plugin`; `Plugin.define` is an identity function, so it
   is re-declared locally. A plugin directory without `node_modules` loads as is.
2. **Root `index.ts`.** OpenCode 2.0.22 loads a configured local plugin directory through its root `index.ts`
   (package.json `exports` pointing into `src/` was not picked up), so the root file re-exports `src/index.ts`.
3. **Agents are registered by `editor.update` on an unknown id.** The V2 agent editor has no `add`; `update` with a new
   id creates the agent (verified on 2.0.22, undocumented). Agent files in the project override every field they define,
   which is how projects with their own agent files (finance) keep their prompts.
4. **Deterministic work is code, judgement is prompts.** Task validation, the board, claiming worktrees, cleaning and
   model resolution are tools with tests; review, implementation and planning are role prompts.
5. **The board stays merge-friendly.** One block per task, blank-line separated, no aggregates (finance T-022).
6. **The last PR commit sets `done`.** Branch protection forbids post-merge commits, so the squash merge lands code and
   status together (finance ADR 0009).
7. **Guard hook only tightens.** It runs for allow/ask decisions of taskflow roles and turns them into deny for protected
   edits (non-planner) and `gh pr merge` (non-reviewer). Configured denies are final in OpenCode anyway.
8. **Orchestration through child sessions.** `tf_dispatch` creates a child session (`parentID` = caller) with the role
   agent, the resolved model and `location.directory` = the task worktree, prompts it, waits for idle and returns the last
   assistant text. Re-dispatch with `sessionID` continues the same child (review rounds keep the implementer's context).
9. **Config is re-read per tool call**; agent/command registrations replay on `reload()` (after `tf_init` and when the
   model registry changes). The model list is refreshed at setup and once more 3 s later because provider plugins may
   register after this plugin's setup.

## Borrowed from oh-my-openagent

Role/category model chains with first-available resolution, size/area routing for implementer work, a doctor view of
the resolution, cross-model review by default. Not borrowed: hardcoded provider catalogues, keyword modes, the runtime
harness.

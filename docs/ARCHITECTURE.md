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
src/core/standards.ts  reference index, deterministic relevance, safe bounded source loading, task binding validation
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

10. **Nothing slow runs synchronously in the server.** Plugin code shares the OpenCode server's event loop: fetch, push,
    gh and setup commands go through the async `run` (own process group, killed as a group on timeout/abort, no prompts:
    `GIT_TERMINAL_PROMPT=0`, detached session). Only millisecond-scale local git queries are synchronous.
11. **One fetch per repository at a time.** `fetchShared` joins a running fetch (parallel fetches fight over ref locks);
    read-only tools reuse a fetch younger than 45 s. A claim fails when its fetch fails (stale refs could double-claim).
12. **Guard = static rules + hook.** Static rules (OpenCode wildcards: `*` matches `/` and spaces) cover relative paths
    and the main checkout; absolute paths inside worktrees are resolved by the hook (`relativize`), because a static
    `<parent>/*/<glob>` would match at any depth. Shell commands are parsed into shell words per simple command
    (unwrapping `env`, `sudo`, `bash -c`), so quoted text (`git commit -m "... gh pr merge ..."`, `grep`) is not a
    false positive and `git -c k=v push origin HEAD:main` is not a bypass. Still best effort: no expansion or aliases.
13. **Tool permissions per role.** Each tf_* tool has `options.permission` (`taskflow.read|write|dispatch`); role rules
    deny `taskflow.dispatch` to everyone but the lead and `taskflow.write` to reviewer and qa, which hides the tools.
    `tf_dispatch` also refuses taskflow callers other than the lead.
14. **Session-relative tools.** Task-file tools default to the calling session's worktree (`session.get`, not cached:
    sessions move and worktrees are removed). `/tf-next T-xxx` claims in code, switches the session to the implementer
    *before* moving it into the worktree (the new location may not have booted the plugin yet), then prompts.
15. **Planner worktrees.** `tf_start plan=<slug>` creates or reuses `plan/<slug>` (tracking the remote branch if only
    that exists); the planner child runs there, so its edits are relative and its static allow rules apply.
16. **Reference-only standards.** `standards.index` is a JSON metadata index pointing to existing repository
    documentation, not a second business specification. `tf_standards` lists/suggests from metadata and loads only
    explicit ids. Drafts never enter worker context. The optional task frontmatter `standards` is validated before
    dispatch and by `tf_check`; projects without bindings do not need an index. Source paths and SHA-256 are reported.
17. **Same task sources for implementation and review.** Task bindings and source contents are read from the task's
    worktree when it exists, even though the reviewer session itself starts in the main checkout. Both roles use the
    same explicit binding/loader. Contents are refreshed each dispatch, not pinned across time: reviewers must compare
    reported hashes if standards changed. No approval database or immutable context snapshots are implied.
18. **Human-gated discovery and shaping.** `/tf-discover` proposes evidence-backed conventions and asks why; `/tf-shape`
    clarifies goals/non-goals, examples, acceptance checks and open decisions before decomposition. Planner writes
    `<paths.plans>/<slug>/shape.md` on a plan branch. Index status is process metadata, not authenticated sign-off. Observed
    conventions and loaded documents cannot override AGENTS/spec/ADR/permissions. Shaping is prompt-guided, not a
    deterministic approval engine.
19. **Bounded documentation reads.** Index and referenced source paths must remain within the configured roots and
    repository after symlink resolution. Hidden/secret/ignored paths are refused; source formats are text documentation.
    An over-budget load fails with no partial context. This is path-based defence, not semantic secret detection or an
    OS sandbox against concurrent filesystem attacks.
20. **Continuation revalidation.** Child session metadata stores its task/role/parent/directory association, not source
    snapshots. A continuation recovers that association and reloads/revalidates the binding even when `task` is omitted.
    Conflicting identities or unrecoverable legacy children fail closed before prompting. Session metadata round-trip
    support was checked against OpenCode 2.2.6 without model calls.
21. **Centralized, tracked process namespace.** New projects use `.taskflow/config.jsonc`, workflow, tasks/epics,
    plans, standards and templates under `.taskflow/`. `paths` renders all runtime process locations; no product
    specifications are copied or moved. Init has no live example epic and no external AGENTS/GitHub writes unless
    explicitly opted in. Standards allow the `.taskflow` hidden segment only at the top level under configured roots;
    hidden children and secret/dependency/Git paths remain forbidden, before and after symlink resolution.
22. **Compatibility without migration.** Central project config wins over the legacy `.opencode/taskflow.jsonc`
    (the latter is ignored, not merged). Both discovery candidates and the global file participate in the config
    stamp. Legacy config, a workflow ownership marker, or a strong finance board/script/template signature retain
    legacy defaults. Explicit global legacy path pairs also retain them. Bare tasks/epics directories are not ownership
    evidence. Init persists effective settings, using the same detected verify commands in config and workflow.
    Moving existing project files requires a separately approved inventory and plan; no migration runs on load/init.
    Process config, epic/template files, workflow, standards and plans are planner/human-gated independently of
    `protected` overrides; the task directory and generated board remain writable by implementers. Shell remains best effort.

## Borrowed from oh-my-openagent

Role/category model chains with first-available resolution, size/area routing for implementer work, a doctor view of
the resolution, cross-model review by default. Not borrowed: hardcoded provider catalogues, keyword modes, the runtime
harness.

## Inspired by Agent OS v3

Standards discovery with human confirmation, a lightweight relevance index, selective context loading and requirements
shaping before decomposition. Implemented locally without installing Agent OS or copying its implementation. The
Taskflow execution/review/PR lifecycle remains unchanged; existing AGENTS/spec/ADR documents stay canonical. Shared
profile inheritance and synchronisation across projects are not part of this feature.

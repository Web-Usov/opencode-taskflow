# Changelog

## 0.2.0 — unreleased

- Reference-only standards index and optional task `standards` bindings. Existing tasks and finance board output remain
  compatible; no index is required until a task explicitly selects standards.
- Read-only `tf_standards` tool: list, deterministic suggestions, explicit bounded loading and validation. Source paths
  and SHA-256 are reported; drafts never enter worker context. Index approval labels are process hints, not signatures.
- Commands `/tf-discover`, `/tf-standards`, `/tf-shape`; planner clarifies requirements and human confirmation before
  decomposition, referencing canonical AGENTS/spec/ADR documents rather than duplicating them.
- Non-overwriting empty-index and bilingual-guide scaffolding. Standard/shape artifacts join the planner/human-review
  protected paths. No Agent OS installation or runtime dependencies.
- Shared reference-loading policy for implementer and reviewer, sourced from the task worktree. Missing, draft or
  unsafe bindings fail before launching a child; source contents are refreshed per dispatch, not immutable snapshots.

## 0.1.0 — 2026-11-01

First release. Generalises the agent workflow of the finance project into an OpenCode V2 plugin.

- Role agents `lead`, `planner`, `implementer`, `reviewer`, `qa`: prompts rendered from project config, model chains
  (first available model wins, `model` beats `models`, category routing by task size/area), per-role permission rules.
- Tools `tf_status`, `tf_next`, `tf_task`, `tf_start` (claim / new task / planner worktree), `tf_set`, `tf_check`,
  `tf_board`, `tf_clean`, `tf_models`, `tf_dispatch`, `tf_init`, with per-role tool permissions.
- Commands `/tf-next`, `/tf-ship`, `/tf-review`, `/tf-handoff`, `/tf-status`, `/tf-plan`, `/tf-drive`, `/tf-milestone`,
  `/tf-init`, `/tf-doctor`.
- Guard hook: protected paths (relative and absolute in worktrees), merges only by the reviewer in exact form, no pushes
  to the base branch or history rewrites; shell commands parsed into words (wrappers, `bash -c`, `eval`, heredocs).
- Async process handling (process-group kill on timeout/abort, no prompts), shared per-repo fetch, serialised claims.
- Config layering with validation, JSONC, live reload; parity with finance's task scripts (board byte-identical).
- Three independent review rounds; 132 unit/integration tests; live e2e against OpenCode 2.0.22.

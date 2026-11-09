# Changelog

## 0.2.0 — unreleased

- Permission routing now reads durable session ownership before treating renamed-away children as foreign after reload;
  invalid/conflicting owned metadata and unavailable identity fail closed, while confirmed unbound user agents remain
  unaffected. Registered native/published-CLI and standalone v2 child regressions cover pure rename and JSON round-trip reload.
- Final review hardening: retain actual host session/setup directory and explicitly refuse nested Git locations before
  action; deny stale/ambiguous/reassigned role identities without asynchronous reload gaps in native and standalone mode;
  sanitize config read/parse/validation diagnostics at source and registered action boundaries, with paths/classes only.
- Review hardening: mandatory protection for linked-worktree `.git`, root OpenCode config and root AGENTS/CLAUDE;
  post-prompt failure/abort/timeout confirms idle before releasing ownership, retaining unknown leases and active slots
  otherwise. Caller-policy checks cover moved-session tools, direct commands, explicit targets and permission hooks;
  different/invalid/unknown policy requires a location reload instead of stale setup/verify/backend behavior.
- Product pivot: execution extension for existing OpenSpec, without a second planning backlog or mandatory Taskflow init.
  Tested published CLI 1.16.1, repo-local roots and unshadowed built-in spec-driven only. Native commands/skills/artifacts
  remain unchanged by registration/diagnosis/claim. Custom schemas/stores/other versions fail explicitly.
- `tf_openspec` status/inspect/start/pr/clean, change-aware `tf_dispatch`, mode-aware tf commands/prompts and edit guard.
  One change/worktree/branch/PR, explicit execution intent, committed calling-worktree HEAD, bounded async CLI reads,
  complete confined context and selected validation; no installs, native init/update/archive or approval claims.
- Local execution associations in git-common-dir `.taskflow/openspec`, separate change metadata and durable dispatch key;
  independent reviewer uses the same source worktree from main. Setup failure preserves work; cleanup requires associated
  MERGED PR and exact pushed head with no dirty/untracked/extra work. No automatic remote deletion or base fast-forward.
- Backend discovery retains existing standalone projects; fresh missing-OpenSpec projects diagnose dependencies.
  Explicit `backend: standalone` retains the previous initialization workflow. Existing task metadata v2 is unchanged.
- Standalone projects keep all Taskflow process artifacts under tracked `.taskflow/`, with configurable workflow, plans and
  templates. Central config takes precedence over legacy project config; existing legacy layouts remain supported,
  without automatic moves. Init no longer creates a live sample epic or touches AGENTS/GitHub without explicit opt-in.
- Config/workflow detection stays consistent; central standards reads retain hidden-path and symlink confinement.
  Planner/human protections cover effective metadata paths while task updates remain available to implementers.
- Scaffold preflights every destination before writing, rejecting traversal, escaping symlinks, incompatible types
  and collisions without partial output. Durable dispatch metadata v2 binds task source identity independently of
  child execution location; source-root/file substitutions fail closed while ordinary content refresh stays supported.
- Ownership-signature changes invalidate running-host config caches; existing legacy GitHub checklists remain selected
  read-only without re-init, unless explicitly overridden.
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

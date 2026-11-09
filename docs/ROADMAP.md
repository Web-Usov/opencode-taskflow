# Roadmap

## Current direction: OpenSpec execution extension

- First release: existing OpenSpec 1.16.1 with unshadowed built-in spec-driven, repo-local roots; one change/worktree/PR.
- Keep native planning/artifacts/skills and user commands canonical; no Taskflow backlog or automatic archive.
- Next: independently test more published releases before widening compatibility; effective custom-schema resolution and
  arbitrary tracking need a dedicated authority/path contract. No-tracking/manual completion and external stores/worksets
  are explicitly unsupported in this MVP, not silently mapped to synthetic tasks.
- Expand isolated native-host and live disposable-PR evidence; no claims based solely on fake-host metadata tests.
- Failed setup resume/repair UX, stale-lock diagnosis and read-only execution history listing need follow-up work.
- Existing standalone task metadata/API compatibility remains; no expansion of the custom planner or automatic migration.

The list below records historical standalone ideas, **not commitments for the OpenSpec MVP**.

## 0.1 (this release)

- Role agents with model chains and permission rules; guard hook.
- `tf_*` tools: status, next, task, start (claim/new), set, check, board, clean, models, dispatch, init.
- Commands: next, ship, review, handoff, status, plan, drive, milestone, init, doctor.
- Parity with finance's task scripts (board byte-identical, same check results).

## Next

- **Standards profiles across projects**: optional reusable engineering standards with explicit project overrides;
  keep project-specific business rules local. Discovery/indexing/shaping are already implemented on the standards branch.

- **Live PR loop test** against a throwaway GitHub repository (ship → review → auto-merge → clean); today the e2e script
  covers everything up to the push, the PR/merge part is covered by unit tests and prompts only.
- **Event-driven model refresh** (`ctx.event.subscribe` on provider/model updates) instead of fixed retries; skip
  `status: deprecated` models.

- **Runtime model fallback**: use the `session.hook("retry")` to switch a child session to the next model of its chain
  on rate limits / provider errors (OMO's `runtime_fallback`).
- **Spec coverage tool** (`tf_spec`): rule-id definitions, dangling references, test coverage report (finance
  `spec-check.mjs`), configurable scan roots.
- **Commit message check** helper for projects without lefthook (`type(scope): subject [T-NNN]`, 100 chars).
- **Machine lock** for heavy e2e runs (finance `with-lock.mjs`) as a tool wrapper.
- **Migrate finance** to the plugin: replace `.opencode/commands` and agent files, keep project config.
- **Background drive**: `/tf-drive` with a notification when a human decision is needed.

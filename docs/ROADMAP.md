# Roadmap

## 0.1 (this release)

- Role agents with model chains and permission rules; guard hook.
- `tf_*` tools: status, next, task, start (claim/new), set, check, board, clean, models, dispatch, init.
- Commands: next, ship, review, handoff, status, plan, drive, milestone, init, doctor.
- Parity with finance's task scripts (board byte-identical, same check results).

## Next

- **Runtime model fallback**: use the `session.hook("retry")` to switch a child session to the next model of its chain
  on rate limits / provider errors (OMO's `runtime_fallback`).
- **Spec coverage tool** (`tf_spec`): rule-id definitions, dangling references, test coverage report (finance
  `spec-check.mjs`), configurable scan roots.
- **Commit message check** helper for projects without lefthook (`type(scope): subject [T-NNN]`, 100 chars).
- **Machine lock** for heavy e2e runs (finance `with-lock.mjs`) as a tool wrapper.
- **Migrate finance** to the plugin: replace `.opencode/commands` and agent files, keep project config.
- **Background drive**: `/tf-drive` with a notification when a human decision is needed.

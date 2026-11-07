---
id: T-000
title: Short imperative title
status: todo          # todo | in_progress | review | done | blocked
epic: E-01            # epics/E-xx-*.md
depends: []           # [T-001, T-002] - must be done before this task starts
blocked_by: []        # [Q-01] - open questions that block the task
spec: []              # rule IDs this task implements, e.g. [OP-05]
standards: []         # Optional exact approved reference ids; never inferred from suggestions
acceptance: []        # acceptance criteria ids, e.g. [AC-06]
area: api             # see .opencode/taskflow.jsonc task.areas
size: S               # S | M  (one agent session, ~300-500 changed lines max)
branch: null          # set by tf_start, e.g. task/T-000-slug
pr: null              # PR url, set by the last commit of the PR
---

# T-000. Title

<!--
Format rules (checked by the tf_check tool):
- File name `T-NNN-slug.md`, id equals the file prefix.
- Frontmatter is flat: scalars, inline lists `[a, b]`, `null`. One key per line.
- `in_progress`/`review` require `branch`; `done` requires `pr`, no unchecked `- [ ]` in Definition of Done and a non-empty Result.
- Claim with `tf_start` (worktree + branch + in_progress); change status with `tf_set`.
- A task is a vertical slice (feature + tests) that fits one agent session.
-->

## Goal

One or two sentences: the observable outcome.

## Context

- Files and modules to start from (paths).
- ADRs and spec rule IDs (never line numbers).

## Definition of Done

Every item must be verifiable by a command or a named test.

- [ ] `it('RULE-01: ...')` passes
- [ ] The verify command is green
- [ ] Task file updated (status, branch, pr, Result)

## Out of scope

- Things that belong to other tasks.

## Handoff log

<!-- Append-only. One entry per interrupted session: date, done, next, branch/commit, gotchas, Q-proposal if blocked. -->

## Result

<!-- Filled at the end: what changed, deviations, follow-ups. -->

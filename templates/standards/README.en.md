# Standards index: references, not a second specification

`index.json` starts empty: `{ "version": 1, "entries": [] }`.
Entry: `{ "id": "existing-rule", "title": "Title", "description": "Scope", "path": "docs/existing.md", "areas": ["api"], "tags": ["testing"], "status": "draft" }`.
`description`, `areas` and `tags` are optional. Multiple entries may reference one file.

Reference existing AGENTS.md, specifications and ADRs; do not copy business requirements.
Code observations are proposals with evidence, exceptions and rationale questions, never rules overriding AGENTS/spec/ADR or guard.
Only planner writes human-confirmed changes on a `plan/<slug>` branch, through a human-merge PR.
New proposals remain `draft` until explicit human approval. `approved` is a routing hint, NOT authenticated human attribution or sign-off.

`tf_standards`: `list`, `suggest`, `load` with exact `ids`, `check`. Suggestions never select entries.
Drafts require explicit `includeDrafts: true` for human review, never implementer/reviewer/qa context.
Optional task frontmatter `standards: [existing-rule]` binds references; old tasks need no index.
Dispatch loads the same selected references from the task worktree for implementer and reviewer, reporting hashes; invalid bindings stop dispatch.

Configuration `standards`: `index`, `roots` (default `docs`, `AGENTS.md`), `maxContextChars` (24000).
Only repo-contained relative documentation paths (`.md`, `.txt`, `.rst`, `.adoc`) under allowed roots are readable. Hidden/secret/Git-ignored files, node_modules and escaping symlinks are denied. The only hidden-segment exception is top-level `.taskflow` when explicitly included in allowed roots; hidden children remain forbidden. No network reads.
The budget includes headers and contents; excess fails without partial loading or truncation. Split oversized sources at their canonical location rather than copying them into the index.

Shape before decomposition: goal, non-goals, examples, edge cases, acceptance/verification, code/design references, standards and unresolved decisions.
Planner persists `docs/plans/<slug>/shape.md` with explicit Draft, Open questions and Human confirmation sections. Silence is not approval; local labels are process metadata. No silent specification changes.

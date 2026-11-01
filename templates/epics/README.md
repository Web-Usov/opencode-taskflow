# Epics

An epic is a user-facing chunk of value that closes with a **milestone**. Epics are written for the product owner (in the
human language of the project); detailed agent tasks live in `../tasks/`.

## File format

`E-NN-slug.md` with frontmatter:

```yaml
---
id: E-01
title: Short title
status: planned        # planned | in_progress | done | accepted
accepted: null         # YYYY-MM-DD, set only by the human
spec: []               # spec rule ids
---
```

Sections: Value for the user, Key features, Spec coverage, Milestone acceptance criteria, Out of scope.

- `done`: every task of the epic is merged (set by the planner/lead).
- `accepted`: set **only by the human** after walking through the milestone acceptance criteria.
- The task list of an epic is generated on the board (`tf_board`), not maintained here.

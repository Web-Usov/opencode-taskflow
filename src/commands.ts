import type { Role, TaskflowConfig } from "./config.ts"
import { agentName } from "./config.ts"
import type { RepoLayout } from "./core/guard.ts"
import { langName } from "./roles.ts"

export interface CommandSpec {
  name: string
  description: string
  /** Switch the session to this role's agent before prompting. */
  switchTo?: Role
  /**
   * Claim the task named by the argument in code before prompting; on success the session moves into the worktree and
   * switches to the implementer. `render` receives the claim report.
   */
  claimArg?: boolean
  render: (args: string, claimReport?: string) => string
}

/** Slash commands: thin prompts that drive the deterministic `tf_*` tools and the role agents. */
export function commandSpecs(cfg: TaskflowConfig, layout: RepoLayout): CommandSpec[] {
  const base = layout.base
  const p = cfg.commandPrefix
  const human = langName(cfg.language.human)
  const v = cfg.verify
  const reviewer = agentName(cfg, "reviewer")
  const planner = agentName(cfg, "planner")
  return [
    {
      name: `${p}next`,
      description: "Show ready tasks and recommend one, or claim task T-xxx (worktree, branch, in_progress) and start implementing",
      claimArg: true,
      render: (a, report) =>
        a.trim()
          ? `${report ?? ""}\n\nIf the claim above FAILED, explain the reason to the human (blocked, unfinished depends, not todo, fetch error) and stop. Otherwise this session now runs in the task's worktree as the implementer: call \`tf_task\` with id "${a.trim()}", print the spec rule IDs it cites and a short plan, then implement the task following your procedure (tests first, verify, then /${p}ship).`
          : `Call \`tf_next\`. List the ready tasks one line each (id, title, area, size, spec rules). Check work already in flight (\`gh pr list\`, \`tf_status\`) and recommend ONE task that does not touch the same module as an in-flight task, with a one-line reason. Do not start it.`,
    },
    {
      name: `${p}ship`,
      description: "Preflight, push, open the PR from the template, mark the task done; never merges",
      switchTo: "implementer",
      render: (a) => `Ship the current task branch. ${a.trim() ? `Notes: ${a.trim()}\n` : ""}Stop and report on the first failure.
1. Preflight: you are in a task worktree on \`${cfg.git.branchPrefix}T-NNN-slug\` (not the base branch); \`git fetch ${cfg.git.remote}\` and merge \`${cfg.git.remote}/${base}\` if behind (never rebase + force-push; on a board conflict run \`tf_board\`). ${v.full ? `\`${v.full}\` is green` : "The project's verify gate is green"}${v.e2e ? ` (and \`${v.e2e}\` for UI work)` : ""}. Every Definition of Done item is ticked and \`## Result\` is filled.
2. Protected paths (\`git diff ${cfg.git.remote}/${base} --name-only\` against ${cfg.protected.join(", ")}): an implementation task must have none (stop); a planner PR that has some uses the human-review template.
3. Commit what is left (\`type(scope): subject [T-NNN]\`, stage everything), \`git push -u ${cfg.git.remote} <branch>\`.
4. \`gh pr create --title "type(scope): subject [T-NNN]" --body-file <file>\`: body from \`.github/pull_request_template.md\` (agent-only PR, ${langName(cfg.language.agent)}) or \`.github/PULL_REQUEST_TEMPLATE/human-review.md\` (human-merge PR, ${human}), with the exact verify commands and named tests.
5. ONE commit marking the task done: \`tf_set\` status done with the PR url, \`tf_board\`, \`tf_check\` (must pass), commit \`docs(tasks): mark T-NNN done [T-NNN]\`, push.
6. Wait ~30s, then \`gh pr checks <n> --watch\` (retry if no checks are registered yet). Report the result.
7. Do NOT merge. Print the PR url and say the next step is /${p}review <pr>.`,
    },
    {
      name: `${p}review`,
      description: "Review a PR (number, url or T-xxx) with the read-only reviewer agent",
      render: (a) => `Review target: ${a.trim() || "(missing: ask for a PR number or task id)"}.
If it is a task id, find its PR (\`gh pr list --state open --search "<id>"\` or the task's \`pr\` field). Then call \`tf_dispatch\` with role "reviewer" and a prompt containing the PR number/url and the task id; the ${reviewer} agent posts the verdict and decides about auto-merge. Report its verdict block and merge decision verbatim. On CHANGES REQUESTED, list the findings as the next steps for the implementer.`,
    },
    {
      name: `${p}handoff`,
      description: "Save work in progress: WIP commit, push and a Handoff log entry",
      switchTo: "implementer",
      render: (a) => `Pause the current task safely so another session can continue. Notes: ${a.trim() || "(none)"}
1. Identify the task from the branch (\`git branch --show-current\` -> \`${cfg.git.branchPrefix}T-NNN-slug\`) and its file. On the base branch: stop and tell the user.
2. Append to \`## Handoff log\` (never rewrite earlier entries): date (\`date -I\`), Done (what works, which DoD items), Next (ordered steps), State (branch, SHA after the WIP commit, failing tests, gotchas), and a Q-proposal in ${human} if blocked (then \`tf_set\` status blocked and tell the human a decision is needed).
3. \`git add -A && git commit -m "wip(<scope>): <what is done> [T-NNN]"\`, push.
4. \`git status --short\` must be empty; print the branch, SHA and the entry.`,
    },
    {
      name: `${p}status`,
      description: "Project status: board, ready tasks, open PRs and CI",
      render: () => `Call \`tf_status\` with gh=true, then produce a compact report: counts per status and per epic; tasks in progress/blocked with branches; open PRs and whether their checks pass; anything red on the base branch; one to three concrete next actions. Answer in ${human}.`,
    },
    {
      name: `${p}plan`,
      description: "Decompose an epic (E-xx) or an idea into tasks with the planner agent",
      render: (a) => `Planning request: ${a.trim() || "(missing: ask which epic or idea)"}.
First call \`tf_start\` with \`plan\` = a short latin slug for this request (it creates or reuses the \`plan/<slug>\` worktree). Then call \`tf_dispatch\` with role "planner", \`directory\` = that worktree and a prompt that asks the ${planner} agent to decompose the request into tasks (or draft the epic first if it does not exist), following its work modes, and ship it as one PR from that branch. Report the PR url and the task list it proposes, in ${human}.`,
    },
    {
      name: `${p}drive`,
      description: "Orchestrate: claim ready tasks, implement, review until LGTM, merge (lead agent)",
      switchTo: "lead",
      render: (a) => `Drive ${a.trim() ? `\`${a.trim()}\`` : "the ready tasks"} through the taskflow loop: claim (\`tf_start\`), implement (\`tf_dispatch\` implementer in the worktree), review (\`tf_dispatch\` reviewer), fix rounds up to ${cfg.review.maxRounds}, clean after merge. A task id means that task only; an epic id means its ready tasks; nothing means the ready tasks in id order. At most ${cfg.parallel} implementers in parallel and never two on the same module. Stop and report to the human (${human}) on blocked tasks, human-merge PRs and exhausted review rounds.`,
    },
    {
      name: `${p}milestone`,
      description: "Prepare the milestone acceptance report for an epic (E-xx)",
      render: (a) => `Prepare the milestone report for epic ${a.trim() || "(missing: ask for E-xx)"}: call \`tf_start\` with \`plan\` = "milestone-<epic id>", then \`tf_dispatch\` role "planner" with \`directory\` = that worktree: verify all its tasks are done with merged PRs (\`tf_check\` with gh=true), run the full verify${v.e2e ? ` and e2e (\`${v.e2e}\`)` : ""} on an up-to-date base, and write \`docs/milestones/<E-xx>-report.md\` in ${human}: summary, merged PRs table, rule/AC coverage, demo scenario from the epic's acceptance criteria, risks, what the human should check. Open (not merge) a human-review PR with the report (and the epic status change to done). Never set \`accepted\`. Report where it is and how to accept, in ${human}.`,
    },
    {
      name: `${p}init`,
      description: "Set up the taskflow process in this repository (non-destructive)",
      render: (a) => `Call \`tf_init\`${a.trim() ? ` (language: ${a.trim()})` : ""}. Then read the created \`.opencode/taskflow.jsonc\` and the repository (package.json scripts, CI workflows, AGENTS.md) and propose concrete corrections: verify commands, CI check names, protected paths, task areas, env files to copy into worktrees. Apply them only after the human agrees. Explain in ${human} what was created and how to start (/${p}plan, /${p}next, /${p}drive).`,
    },
    {
      name: `${p}doctor`,
      description: "Diagnose taskflow: config sources, resolved models per role, task file check",
      render: () => `Call \`tf_models\` and \`tf_check\`. Report in ${human}: config files in effect, the model each role and category resolves to (and skipped chain entries with reasons), problems in task files, and concrete fixes.`,
    },
  ]
}

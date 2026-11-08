# OpenSpec execution integration

Taskflow is an OpenCode V2/OpenChamber plugin extending an **existing** OpenSpec installation, not an OpenSpec plugin API,
fork, replacement CLI or host-independent runner. OpenSpec owns all planning/checklist content. Native commands, skills,
schema/config/spec files are not modified by registration, diagnosis, attachment or claim. No mandatory Taskflow init.

## Tested boundary

- Published npm `@fission-ai/openspec` **1.16.1**, Node >=22.12; Linux/Bun plugin tests. No version-range promise.
- Normal canonical Git worktrees with `openspec/changes/<kebab-case-name>` and unshadowed built-in `spec-driven` schema.
- Custom schemas (including custom/no tracking), project/user overrides of spec-driven, external/default stores, worksets,
  symlink roots/artifacts, alternate layouts and other versions are unsupported and diagnosed without repair/mutation.
- HOME/XDG remain the user's actual environment. Project yaml/yml, change metadata, relevant global config and executable/
  built-in schema fingerprints participate in source binding. Shadowed schemas are rejected, never overridden with --schema.
- Missing CLI/project: user installs/sets up OpenSpec through its native workflow. Never automatic npx/install/upgrade/init.

Optional `.taskflow/config.jsonc` or plugin options:

```jsonc
{
  "backend": "openspec",
  "openspec": { "executable": "openspec" },
  "git": { "baseBranch": "main", "remote": "origin", "worktreeDir": "../{repo}-wt" },
  "verify": { "full": "bun run check" },
  "ci": { "checks": ["test"] },
  "setup": { "copy": [], "commands": [] }
}
```

Executable is one PATH name or absolute executable path, **not a shell command**. Native CLI reads use argument arrays, cwd=selected root,
20s timeout and 256KB combined output budget, AbortSignal/process-group termination. Context is limited to 64KB/file
and 64K characters total; over-budget loads fail rather than silently truncate. Configured setup commands use a shell
intentionally, with 120s timeout/output bounds; treat configuration as human-controlled executable policy.

## API

`tf_openspec` operations:

- `status`: read-only version/root/active change inventory; partial CLI failures are errors, not empty success.
- `inspect, change`: named status + apply instructions + selected-change validation; independently read/confine/hash
  all concrete context paths. Returns live progress, missing prerequisites, warnings, references and bounded context.
- `start, change, confirm:true`: **only after explicit user request to execute this change**. CLI ready and successful
  validation are independent gates, not proof of approval. Requires clean tracked/untracked caller source at committed
  HEAD; no main-source assumption, auto-commit/stash or transfer of unrelated changes. Creates `openspec/<change>` branch
  and `openspec-<change>` worktree, refuses collisions/duplicate execution, re-probes then performs configured env/setup.
- `pr, change, pr:<https URL>`: verify native all_done/no remaining/degraded tracking, clean worktree, exact local HEAD
  equal to gh PR head, same calling repository/branch/base and no cross-repository PR. Associate one PR; never rebind URLs.
- `clean, change, confirm:true`: from another worktree, require associated PR **MERGED**, exact associated pushed head,
  no dirty/untracked/**ignored**/extra/unpushed work. Inspect/remove generated ignored setup data yourself first; the plugin
  will not assume ignored files are disposable. Remove only associated worktree/local branch. Preserve native change/specs.

`tf_dispatch` adds `change` (mutually exclusive with legacy `task`). New implementer/reviewer/qa children require a
claimed change. Implementer/qa run in execution worktree; reviewer runs in main with **the same live change source**.
Continuation with `sessionID` can omit change, but contradictions in parent/role/agent/change/source/config/schema/
reference paths/worktree/directory are rejected before prompt. Non-checklist planning references are bound by hash and
changes require human repair/re-authorization rather than silently continuing with new scope. Checklist progress/content refresh is permitted and hashes
are reported again. No model calls occur during diagnosis/readiness; dispatch explicitly runs the selected child model.

`tf_status/tf_next/tf_check/tf_models/tf_init` diagnose OpenSpec read-only in this mode. No backlog scaffold is created.
`tf_start/tf_set/tf_board/tf_clean/tf_task/tf_standards` are standalone APIs and explicitly disabled; use tf_openspec.
The lifecycle tool is a write-permission tool; reviewer/qa use read-only status tools and supplied dispatch context.
Implementer may associate its own PR only from its exact execution worktree; start/clean require lead or the human session.

### Session moves and policy ownership

Configuration precedence remains defaults → global Taskflow config → selected project Taskflow config → the host's plugin
`ctx.options`. Options belong to the location where this plugin instance was set up; the plugin does **not** pretend that
original options are newly discovered caller-specific options. Before every registered tool, direct command action and
taskflow-role permission decision with a session, it resolves the actual session worktree and freshly loads its effective
Taskflow config/sources with that same explicit options layer. A different backend, executable, verify/setup policy,
invalid/unreadable config, different repository, unavailable host location, or differing host OpenCode configuration
fails closed **before** mutation, native CLI/setup or prompt. Explicit directory targets are checked too.

Same-policy worktree moves remain usable. Otherwise open/reload the plugin in the actual calling worktree; there is no
silent backend/policy switch inside an old instance. Root and `.opencode` OpenCode config plus inherited ancestor/global
host config are fingerprinted; changed host inputs require a location reload rather than guessed agent/plugin options.
**Nested Git subdirectory sessions are unsupported in this MVP, even without a nested config.** The actual host session
directory is retained before any Git-root normalization; a subdirectory is refused before OpenSpec CLI, prompt, setup or
mutation. This includes direct `opencode.json`/`opencode.jsonc` and `.opencode/opencode.jsonc` policy below the worktree root:
they are never silently skipped in favor of parent options. A plugin instance set up at a nested location is diagnostics-
only/refusing: moving its session to the root does not validate that instance's original nested `ctx.options`. Open a
fresh root-location instance instead. Git root discovery remains a read-only repository check, not host-policy selection.
Native dispatch also checks execution-source and reviewer-directory policy before prompting. After reload, execution
records/child bindings still refuse genuine config/source rebinding. Equal effective policy is not approval of changed
planning content: source hashes impose their separate stronger constraint. The getter never falls back to setup location
when session lookup fails. Legacy session-less permission-hook events retain their legacy static/hard checks; native
events without a session fail closed, and legacy events with a session get the same caller-policy check.
Registered role identity is remembered as name→role history for the loaded host, not mere name membership. Old names
after a rename, duplicate role names, reassignment of an old name to another role, disabled roles and not-yet-registered
new names are denied until a safely configured role session/location is available. No asynchronous reload gap falls back
to an unrecognized role in the parsed hard guard. This applies to native and standalone permissions, and to role identities
presented at registered tool/session boundaries. Valid current roles retain their ordinary hard checks.
For plugin-owned children the persisted declared role/agent binding also constrains the session after reload; an old child
cannot become a newly assigned planner/lead merely because its name was reused. This only tightens permissions; metadata
is not authenticated approval, and no role/source binding is automatically rewritten.

Taskflow config diagnostics expose source path and read/parse/validation class, never raw parser text, offending values,
regular expressions or user-controlled category keys. `loadConfig` sources are sanitized too (optional `errorClass`), so
doctor/configSources consumers cannot reintroduce those fragments; action gates independently avoid interpolating raw
`source.error`. Invalid effective configuration still refuses action and names contributing global/project/options layers.

## Commands and human gates

`/tf-doctor`, `/tf-status`, `/tf-next`, `/tf-drive`, `/tf-ship`, `/tf-review`, `/tf-handoff`, `/tf-milestone`, `/tf-init` are mode-aware.
Planning-related tf commands direct the user back to existing native OpenSpec planning under human control. No opsx
commands/skills are replaced. Start is not implicit on plugin load or an empty command; explicit intent is mandatory.
Planner/human controls proposal/design/spec/config/schema. Implementer may edit only the **actual tracked checklist**
inside the associated execution worktree while doing user-authorized implementation. No competing Markdown parser,
automatic checkbox writer, stable positional-ID mapping or per-checkbox branch/task entity is introduced.
Mandatory native edit protection includes the exact `.git` entry (a regular pointer file in linked worktrees), `.git/**`,
root `opencode.json`/`opencode.jsonc`, `.opencode/**`, and root project instruction documents `AGENTS.md`/`CLAUDE.md`, as
well as native planning/config/schema/state. These gates do not depend on configurable `protected` overrides. Static
worktree-parent patterns conservatively cover process filenames at nested depths; the hard hook checks the actual caller.

Upstream apply readiness does **not** require all planning artifacts. MissingPrerequisites are surfaced without adding
a universal four-artifact gate; selected-change validation is separately mandatory. `all_done`/zero remaining do not
mean tested, approved, merged or safe to archive. Any unavailable tracking file or unreadable concrete context is fatal.
Ship/review use configured verification/CI and independent review; these judgement steps remain prompt-driven, not a
deterministic proof engine. Shell guards are best effort, not a sandbox. Branch protection/required CI remain essential.

## Ownership, failure and compatibility

Project `.taskflow` is optional execution config only in this mode. Local absolute execution associations are stored in
`<git-common-dir>/.taskflow/openspec/<change>.json`, outside canonical OpenSpec and outside tracked source. Records contain
version/change/source commit/branch/worktree/PR/phase and source identities, **no copied task/requirement text or approval**.
Exclusive per-change lock files serialize multiple hosts; atomic record creation/replacement refuses unsafe existing paths.
Dispatch holds a separate per-change lease (no concurrent agents on one change); cleanup acquires both lifecycle and
dispatch locks, so it cannot remove a worktree still owned by a running child. Stale leases require human inspection.
On prompt-transport error (which may have accepted work), wait error, cancellation or timeout, dispatch requests interruption
then independently confirms idle through the SDK `session.wait` contract. That SDK method returns `Promise<void>`: a
fulfilled void wait is terminal confirmation, not a missing state payload. A successful interrupt alone is **never** proof.
Stop confirmation has a 5s total budget; missing/rejected/hanging/unexpected wait results or unresolved prompt acceptance
preserve an `unknown` lease with child id and recovery instructions. The in-host running slot also remains occupied; status
reports unknown ownership. Another child and cleanup stay blocked across plugin reload.
Held/unknown leases conservatively consume implementer capacity even after reload (regardless of their role),
so resetting in-memory counters cannot hide a potentially active child. Manual recovery requires the stop evidence below.
No force-break/recovery command is
provided: confirm the exact child has stopped in the host, manually inspect/remove that exact lease, then reload the plugin
to clear its conservatively retained in-host slot. Never remove ownership merely because a transport request failed.
This is deterministic preflight, not OS isolation against arbitrary concurrent filesystem attacks or an authenticated DB.
The selected CLI executable is user-controlled trusted software; version/shape/fingerprint probes are compatibility
checks, not cryptographic attestation of an installation or a defence against a malicious replacement executable.

Failed/cancelled setup preserves the worktree/branch and all user content, recording `setup_failed` when association was
created. No forced removal on failure. Inspect and repair manually; there is not yet an automatic resume/repair operation.
A failure before record creation reports the preserved path; do not adopt/reclaim it silently. Stale locks require human
inspection before manual removal. Cleaned records remain local tombstones, preventing accidental duplicate execution.
No remote branch deletion, automatic base update, OpenSpec archive or spec promotion runs here.

`backend:auto` retains standalone when a Taskflow config/ownership signature exists; otherwise it expects OpenSpec.
If both systems exist, explicitly select `openspec`. Explicit `standalone` keeps old init/tasks/epics/standards/layout
behavior. No migration, copying, deletion or rewriting of old planning files occurs. Legacy `taskflowDispatch` metadata
v2 remains unchanged; change children use separate `taskflowOpenSpecDispatch` metadata version 1. Old task continuations
are not silently rebound into native changes.

## Evidence

`bun run check` includes fake executable + real git + fake host/plugin registration/commands/dispatch tests. Optional:

```sh
bun scripts/smoke-openspec.ts /absolute/path/to/already-installed/openspec
```

Creates an isolated disposable project under `/tmp/opencode`, uses the **actual installed** CLI without init/install,
plans on a non-main branch, claims its committed HEAD, compares both roles' refs/cwd and observes native completion.
No paid model or live PR/push/merge/archive calls. Parent/native-host verification is a separate evidence layer;
fake-host tests alone are not advertised as a live model/PR workflow test.

#!/usr/bin/env bash
# End-to-end check against the running OpenCode service (opencode >= 2.0.22 on PATH).
#
#   bash scripts/e2e.sh            # load the plugin into a scratch repo, assert agents/commands/models via the HTTP API
#   LIVE=1 bash scripts/e2e.sh     # additionally drive a real session: tf_init, guard denial, tf_start, tf_dispatch
#   LIVE_MODEL=opencode/big-pickle # model for the live part (default: a free OpenCode model)
#
# Uses a throwaway repo under $TMPDIR; nothing outside it is modified.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tf-e2e-XXXX")"
APP="$WORK/app"
LIVE_MODEL="${LIVE_MODEL:-opencode/deepseek-v4.1-flash-free}"
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.com GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.com

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok   $*"; }

git init -q --bare -b main "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$APP" 2>/dev/null
cd "$APP"
git checkout -q -b main
echo '{"name":"app","scripts":{"test":"echo tests-ok","lint":"echo lint-ok"}}' > package.json
echo "# App" > README.md
mkdir -p .opencode
printf '{ "plugins": ["%s"] }\n' "$PLUGIN_DIR" > .opencode/opencode.jsonc
LIVE_CHAIN="\"$LIVE_MODEL\""
cat > .opencode/taskflow.jsonc <<EOF
{
  "language": { "human": "en" },
  "verify": { "full": "npm test" },
  "agents": {
    "lead": { "models": [$LIVE_CHAIN] }, "planner": { "models": [$LIVE_CHAIN] },
    "implementer": { "models": [$LIVE_CHAIN] }, "reviewer": { "models": [$LIVE_CHAIN] }, "qa": { "models": [$LIVE_CHAIN] }
  }
}
EOF
git add -A && git commit -qm init && git push -q origin main

Q="location%5Bdirectory%5D=$APP"
opencode api delete "/api/debug/location?$Q" >/dev/null 2>&1 || true
opencode api get "/api/agent?$Q" >/dev/null
sleep 6 # model refresh + agent reload

agents="$(opencode api get "/api/agent?$Q")"
for role in lead planner implementer reviewer qa; do
  echo "$agents" | python3 -c "
import json,sys
a=[x for x in json.load(sys.stdin)['data'] if x['id']=='$role']
assert a, 'agent $role missing'
a=a[0]
assert 'Taskflow contract' in (a.get('system') or ''), 'no contract in prompt'
m=a.get('model') or {}
assert f\"{m.get('providerID')}/{m.get('id')}\"=='$LIVE_MODEL', f'model {m}'
" || fail "agent $role"
  ok "agent $role registered with prompt and model $LIVE_MODEL"
done
echo "$agents" | python3 -c "
import json,sys
a=[x for x in json.load(sys.stdin)['data'] if x['id']=='implementer'][0]
assert {'action':'edit','resource':'docs/spec/*','effect':'deny'} in a['permissions']
assert {'action':'shell','resource':'gh pr merge*','effect':'deny'} in a['permissions']
" || fail "implementer permissions"
ok "implementer permissions deny protected edits and merges"

cmds="$(opencode api get "/api/command?$Q")"
echo "$agents" | python3 -c "
import json,sys
a=[x for x in json.load(sys.stdin)['data'] if x['id']=='implementer'][0]
assert {'action':'taskflow.dispatch','resource':'*','effect':'deny'} in a['permissions']
" || fail "implementer may dispatch"
ok "implementer cannot dispatch other agents"

for c in tf-next tf-ship tf-review tf-handoff tf-status tf-plan tf-drive tf-milestone tf-init tf-doctor; do
  echo "$cmds" | grep -q "\"$c\"" || fail "command $c missing"
done
ok "10 commands registered"

if [[ "${LIVE:-}" != "1" ]]; then
  echo "PASS (static). LIVE=1 for the session part. Workdir: $WORK"
  exit 0
fi

run() { timeout 600 opencode run -m "$LIVE_MODEL" --auto "$@" 2>&1 | tail -40; }

echo "--- live: tf_init + commit"
run "Call the tool tf_init with language en. Then run: git add -A && git commit -m 'chore: taskflow scaffold' && git push origin main. Reply DONE when finished."
[[ -f tasks/_template.md && -f docs/taskflow.md ]] || fail "tf_init did not scaffold"
git log -1 --format=%s | grep -q scaffold || fail "scaffold not committed"
ok "tf_init scaffolded and committed"

cat > tasks/T-001-hello-file.md <<'EOF'
---
id: T-001
title: Add hello file
status: todo
epic: E-01
depends: []
blocked_by: []
spec: []
acceptance: []
area: api
size: S
branch: null
pr: null
---

# T-001. Add hello file

## Goal

A file `hello.txt` containing `hello` exists at the repository root.

## Definition of Done

- [ ] `hello.txt` contains `hello`
- [ ] `npm test` is green

## Out of scope

- Anything else.

## Handoff log

## Result
EOF
git add -A && git commit -qm "docs(tasks): add T-001" && git push -q origin main

echo "--- live: guard denies protected edits for the implementer"
run --agent implementer "Use your write tool to create the file epics/E-99-x.md with the content 'x'. Report exactly whether the tool call was allowed or rejected and the error text."
[[ ! -f epics/E-99-x.md ]] || fail "implementer wrote a protected path"
ok "protected path stayed untouched"

echo "--- live: tf_start + tf_dispatch implementer"
run --agent lead "1) Call tf_start with id T-001. 2) Call tf_dispatch with role implementer, task T-001 and this prompt: 'In your working directory create hello.txt containing exactly hello, then run: git add -A && git commit -m \"feat(api): add hello file [T-001]\". Do not push, do not open a PR. Reply with the commit hash.' 3) Report the child session id and its answer."
WT="$WORK/app-wt/t-001-hello-file"
[[ -d "$WT" ]] || fail "worktree $WT missing"
[[ "$(cat "$WT/hello.txt" 2>/dev/null)" == "hello" ]] || fail "implementer did not create hello.txt in the worktree"
git -C "$WT" log -1 --format=%s | grep -q "T-001" || fail "implementer commit missing"
ok "worktree claimed and implementer committed in it"

echo "--- live: implementer cannot dispatch, guard covers absolute worktree paths"
run --agent implementer "1) Try to call the tool tf_dispatch with role reviewer and prompt 'x' and report the exact result. 2) Use your write tool to create the file $WT/epics/E-98-x.md (absolute path) with content 'x' and report whether it was allowed."
[[ ! -f "$WT/epics/E-98-x.md" ]] || fail "implementer wrote a protected path inside the worktree"
ok "absolute protected path inside the worktree stayed untouched"

echo "--- live: /tf-next T-002 runs the claim in code, switches to the implementer and moves the session"
sed 's/T-001/T-002/g; s/hello-file/bye-file/; s/Add hello file/Add bye file/; s/hello.txt/bye.txt/g' tasks/T-001-hello-file.md > tasks/T-002-bye-file.md
sed -i 's/^status: .*/status: todo/; s/^branch: .*/branch: null/' tasks/T-002-bye-file.md
git add -A && git commit -qm "docs(tasks): add T-002" && git push -q origin main
SID="$(opencode api post /api/session -d "{\"location\":{\"directory\":\"$APP\"},\"model\":{\"providerID\":\"${LIVE_MODEL%%/*}\",\"id\":\"${LIVE_MODEL#*/}\"}}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("data",d)["id"])')"
opencode api post "/api/session/$SID/command" -d '{"name":"tf-next","text":"T-002"}' >/dev/null
sleep 15
opencode api get "/api/session/$SID" | python3 -c "
import json,sys
d=json.load(sys.stdin); d=d.get('data',d)
assert d.get('agent')=='implementer', d.get('agent')
assert d['location']['directory'].endswith('/app-wt/t-002-bye-file'), d['location']
" || fail "/tf-next did not switch/move the session"
opencode api post "/api/session/$SID/interrupt" -d '{}' >/dev/null 2>&1 || true
ok "/tf-next claimed T-002, switched to implementer and moved into the worktree"

echo "PASS (live). Workdir: $WORK"

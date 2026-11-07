import path from "node:path"
import type { TaskflowConfig } from "./config.ts"
import { agentName } from "./config.ts"
import { OpenSpec } from "./core/openspec.ts"
import { digest, validateExecution } from "./core/openspec-source.ts"
import { childResult, type DispatchInput, type DispatchResult } from "./tools.ts"

/** Separate metadata key/version: legacy taskflowDispatch v2 is never upgraded/reinterpreted. */
export async function dispatchChange(host: any, root: string, mainDir: string, cfg: TaskflowConfig, input: DispatchInput, model: any, bindings?: Map<string, string>): Promise<DispatchResult> {
  if (input.task) throw new Error("change and task are mutually exclusive")
  if (!["implementer", "reviewer", "qa"].includes(input.role)) throw new Error("OpenSpec dispatch supports execution/review/qa only; planning stays native OpenSpec under human control")
  let stored: any
  const agent = agentName(cfg, input.role)
  if (input.sessionID) {
    const response = await host.get({ sessionID: input.sessionID })
    const child = response?.data ?? response
    stored = child?.metadata?.taskflowOpenSpecDispatch
    if (bindings?.has(input.sessionID) && bindings.get(input.sessionID) !== JSON.stringify(stored)) throw new Error("child OpenSpec dispatch association changed; start a new child")
    if (!stored || stored.version !== 1 || child.metadata?.taskflowDispatch || child.id !== input.sessionID || stored.role !== input.role || stored.agent !== agent || child.agent !== agent || stored.parentSessionID !== input.parentSessionID || child.parentID !== input.parentSessionID || child.location?.directory !== stored.directory || (input.change !== undefined && input.change !== stored.change) || (input.directory !== undefined && path.resolve(mainDir, input.directory) !== stored.directory)) throw new Error("invalid/contradictory OpenSpec child identity, role, parent, directory or change binding; start a new child")
  }
  const change = input.change ?? stored?.change
  if (!change) throw new Error("explicit change required for a new OpenSpec child")
  const record = validateExecution(root, change)
  if (record.configDigest !== digest(JSON.stringify(cfg))) throw new Error("execution configuration changed; no implicit rebinding")
  if (record.phase === "setup_failed") throw new Error("setup_failed execution requires explicit repair; start a fresh child only after setup has been completed manually and record repaired by the human")
  const context = await new OpenSpec(cfg).inspect(record.worktree, change, input.signal)
  if (JSON.stringify(context.identity) !== JSON.stringify(record.identity)) throw new Error("effective OpenSpec CLI/schema/config source identity changed")
  if (context.state === "blocked") throw new Error("OpenSpec apply is blocked")
  const directory = input.role === "reviewer" ? mainDir : record.worktree
  if (input.directory !== undefined && path.resolve(mainDir, input.directory) !== directory) throw new Error("OpenSpec execution directory substitution refused")
  const binding = { version: 1, role: input.role, agent, parentSessionID: input.parentSessionID, directory, change, sourceRoot: record.sourceRoot, sourceCommit: record.sourceCommit, source: context.identity, paths: context.references.map((r) => r.path), configDigest: digest(JSON.stringify(cfg)) }
  if (stored && JSON.stringify(stored) !== JSON.stringify(binding)) throw new Error("OpenSpec source/config/schema/worktree association changed; continuation cannot rebind")
  if (input.signal.aborted) throw new Error("aborted")
  let sessionID = input.sessionID
  if (!sessionID) {
    const response = await host.create({ parentID: input.parentSessionID, agent, ...(model ? { model } : {}), location: { directory }, title: `${input.role} OpenSpec ${change}`, metadata: { taskflowOpenSpecDispatch: binding } })
    sessionID = response?.id ?? response?.data?.id
    if (!sessionID) throw new Error("session.create returned no session id")
  }
  bindings?.set(sessionID!, JSON.stringify(binding))
  const sid = sessionID!
  let timedOut = false
  const interrupt = () => void host.interrupt({ sessionID: sid }).catch(() => {})
  const timer = setTimeout(() => { timedOut = true; interrupt() }, cfg.dispatch.timeoutMinutes * 60_000)
  input.signal.addEventListener("abort", interrupt, { once: true })
  try {
    if (input.signal.aborted) { interrupt(); throw new Error("aborted") }
    const header = `OpenSpec change: ${change}\nSource commit: ${record.sourceCommit}\nChange source worktree: ${record.worktree}\nWorking directory: ${directory} (run every shell command there).\nOnly actual native checklist ${context.identity.tracking} may be updated during authorized implementation; proposal/design/spec/config/schema remain human/planner-gated. Never treat CLI task positions as stable IDs.\n${context.text}`
    await host.prompt({ sessionID: sid, text: `${header}\n\n${input.prompt}` })
    await host.wait({ sessionID: sid })
  } finally { clearTimeout(timer); input.signal.removeEventListener("abort", interrupt) }
  const messages = await host.context({ sessionID: sid })
  const result = childResult(Array.isArray(messages) ? messages : messages?.data ?? [])
  return { sessionID: sid, agent, directory, model: model ? `${model.providerID}/${model.id}` : null, text: result.text, outcome: result.outcome, error: timedOut ? "child timed out and was interrupted" : input.signal.aborted ? "aborted by caller" : result.error, references: context.references.map(({ path, sha256 }) => ({ path, sha256 })) }
}

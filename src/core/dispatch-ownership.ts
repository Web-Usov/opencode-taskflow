/** A child may still run. Its durable lease and in-host running slot MUST NOT be released automatically. */
export class UnknownChildState extends Error {
  constructor(readonly sessionID: string, message: string) {
    super(`child ${sessionID}: ${message}; execution ownership retained. Confirm the child is stopped through the host before manual lease recovery; interruption acknowledgement alone is not proof.`)
    this.name = "UnknownChildState"
  }
}

const reason = (value: unknown): string => {
  try { return String(value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value) ?? value).slice(0, 2048) }
  catch { return "unreadable host failure" }
}

function bounded<T>(operation: () => Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host stop-confirmation deadline exceeded")), milliseconds) })]).finally(() => clearTimeout(timer))
}

/** SDK wait is Promise<void>: successful fulfillment is its idle/terminal guarantee, NOT a state payload.
 * Missing methods, rejection, unexpected payloads or an unsettled prompt are not terminal evidence. */
export async function runOwnedChild(host: any, sessionID: string, text: string, signal: AbortSignal, timeoutMs: number, stopTimeoutMs = 5000): Promise<void> {
  const wait = async () => {
    if (typeof host.wait !== "function") throw new Error("host wait unavailable; no terminal confirmation")
    const response = await host.wait({ sessionID })
    if (response !== undefined) throw new Error("unexpected host wait result; expected SDK void idle confirmation")
  }
  let promptSettled = false, timer: ReturnType<typeof setTimeout> | undefined
  let cancelled!: () => void
  const abort = new Promise<never>((_, reject) => { cancelled = () => reject(new Error("aborted by caller")) })
  signal.addEventListener("abort", cancelled, { once: true })
  try {
    if (signal.aborted) { promptSettled = true; throw new Error("aborted before prompt") }
    const execution = (async () => {
      try { await host.prompt({ sessionID, text }) } finally { promptSettled = true }
      await wait()
    })()
    await Promise.race([execution, abort, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("child execution timed out")), timeoutMs) })])
    if (signal.aborted) throw new Error("aborted by caller")
  } catch (error) {
    // A rejected prompt transport can still have accepted work. Never assume a successful interrupt means idle.
    const deadline = Date.now() + stopTimeoutMs
    let interruptProblem = "", interruptSettled = false
    try { await bounded(async () => { try { await host.interrupt({ sessionID }) } finally { interruptSettled = true } }, Math.max(1, deadline - Date.now())) }
    catch (failure) { interruptProblem = `; interrupt: ${reason(failure)}` }
    try {
      await bounded(wait, Math.max(1, deadline - Date.now()))
      if (!promptSettled) throw new Error("prompt acceptance remains unresolved; a late prompt could still start work")
      if (!interruptSettled) throw new Error("interrupt request remains unresolved; a late request could affect continued work")
    } catch (failure) {
      throw new UnknownChildState(sessionID, `${reason(error)}${interruptProblem}; stop not confirmed: ${reason(failure)}`)
    }
    throw new Error(`child ${sessionID}: ${reason(error)}${interruptProblem}; stop confirmed by host wait`)
  } finally { clearTimeout(timer); signal.removeEventListener("abort", cancelled) }
}

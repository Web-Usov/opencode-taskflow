/**
 * Flat YAML-subset frontmatter used by task and epic files:
 * `key: scalar`, `key: [a, b]`, `null`, `# comments`. Nested structures are not supported on purpose:
 * agents edit these files and a flat format keeps diffs and merges trivial.
 */

export type Scalar = string | null | string[]
export type Frontmatter = Record<string, Scalar>

function parseScalar(raw: string): Scalar {
  const v = raw.trim()
  if (v === "null" || v === "~" || v === "") return null
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim()
    return inner === "" ? [] : inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
  }
  return v.replace(/^["']|["']$/g, "")
}

/** A comment starts with " #" outside of quotes; values in these files never contain " #". */
function stripComment(line: string): string {
  const i = line.search(/\s#/)
  return i === -1 ? line : line.slice(0, i)
}

export function parseFrontmatter(text: string): { data: Frontmatter | null; text: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { data: null, text }
  const data: Frontmatter = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    const km = line.match(/^([A-Za-z_][\w-]*):(.*)$/)
    if (!km) continue
    data[km[1]!] = parseScalar(stripComment(km[2]!))
  }
  return { data, text }
}

/** Replaces (or appends) `key: value` inside the frontmatter, keeping a trailing `# comment`. */
export function setField(text: string, key: string, value: string): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) throw new Error("no frontmatter")
  const re = new RegExp(`^${key}:[^\\S\\r\\n]*([^\\r\\n#]*?)([^\\S\\r\\n]+#[^\\r\\n]*)?$`, "m")
  let fm = m[1]!
  const comment = fm.match(re)?.[2] ?? ""
  const line = `${key}: ${value}${comment}`
  fm = re.test(fm) ? fm.replace(re, () => line) : `${fm}\n${line}`
  return text.replace(m[1]!, () => fm)
}

/** Body of a `## <heading>` section with HTML comments removed (until the next `## ` or EOF). */
export function sectionBody(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = text.match(new RegExp(`^## ${escaped}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))
  return m ? m[1]!.replace(/<!--[\s\S]*?-->/g, "") : null
}

export const asList = (v: Scalar | undefined): string[] => (Array.isArray(v) ? v : [])
export const asString = (v: Scalar | undefined): string | null => (typeof v === "string" ? v : null)

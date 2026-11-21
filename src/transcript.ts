// Discussion file format: a `# title` line followed by entries.
// Each entry starts with a marker comment written only by this module:
//
//   <!-- ask:entry author="codex" at="2026-11-20T21:41:12Z" cwd="/path" -->
//
//   ### 2 · codex
//
//   body...

export interface Entry {
  author: string; // "user" | agent name
  at: string; // ISO timestamp
  to?: string; // user entries directed at a specific agent
  cwd?: string; // agent entries: directory the agent ran in
  body: string;
}

export interface Discussion {
  title: string;
  entries: Entry[];
}

const MARKER_PREFIX = "<!-- ask:";
// `s` flag: `.` must also match U+2028/U+2029, which survive split("\n") (defense in depth;
// quote() already escapes them).
const ENTRY_MARKER = /^<!-- ask:entry (.*) -->$/s;
const ATTR = /(\w+)="((?:[^"\\]|\\.)*)"/g;
// Matches marker-like lines (allowing leading whitespace) so they can be neutralized.
const FORGED_MARKER = /^(\s*)<!-- ask:/gm;

/** Rewrites lines that look like entry markers so body text can never forge an entry. */
export function neutralize(body: string): string {
  return body.replace(FORGED_MARKER, "$1<!-- ask-quoted:");
}

/** First non-empty line of the question, whitespace-collapsed. */
export function toTitle(question: string): string {
  const firstLine = question.split("\n").find((l) => l.trim() !== "") ?? "";
  return firstLine.replace(/\s+/g, " ").trim() || "(untitled)";
}

export function formatHeader(question: string): string {
  return `# ${toTitle(question)}\n`;
}

export function heading(entry: Pick<Entry, "author" | "to">): string {
  return entry.to ? `${entry.author} → ${entry.to}` : entry.author;
}

/**
 * @param n the entry's 1-based position in the discussion, shown in the heading so the user
 *   can follow agents' "entry N" references (agents see the same numbers in their prompt).
 */
export function formatEntry(entry: Entry, n: number): string {
  const attrs: [string, string | undefined][] = [
    ["author", entry.author],
    ["to", entry.to],
    ["at", entry.at],
    ["cwd", entry.cwd],
  ];
  const attrText = attrs
    .filter((a): a is [string, string] => a[1] !== undefined)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(" ");
  // The body is written verbatim apart from marker neutralization. Everything else in this
  // string is delimiter that toEntry() strips: "" / heading / "" before the body,
  // and one "" after it.
  const body = neutralize(entry.body);
  return `\n${MARKER_PREFIX}entry ${attrText} -->\n\n### ${n} · ${heading(entry)}\n\n${body}\n`;
}

export function parse(markdown: string): Discussion {
  const lines = markdown.split("\n");
  const title = extractTitle(markdown);

  const entries: Entry[] = [];
  let current: { attrs: Record<string, string>; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    entries.push(toEntry(current.attrs, current.lines));
  };

  for (const line of lines) {
    const match = ENTRY_MARKER.exec(line);
    if (match) {
      flush();
      current = { attrs: parseAttrs(match[1] ?? ""), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  return { title, entries };
}

export function extractTitle(markdown: string): string {
  const titleLine = markdown.split("\n").find((l) => l.startsWith("# "));
  return titleLine ? titleLine.slice(2).trim() : "(untitled)";
}

function toEntry(attrs: Record<string, string>, lines: string[]): Entry {
  const author = attrs.author ?? "unknown";
  const body = stripDelimiters(lines, heading({ author, to: attrs.to }));

  const entry: Entry = { author, at: attrs.at ?? "", body };
  if (attrs.to !== undefined) entry.to = attrs.to;
  if (attrs.cwd !== undefined) entry.cwd = attrs.cwd;
  return entry;
}

/**
 * Removes exactly the lines formatEntry() adds around the body, so bodies round-trip
 * byte-for-byte (leading indentation, trailing newlines). The heading may lack the entry
 * number (files written before numbering). Hand-edited entries that don't match the
 * written layout fall back to trimming blank lines and the heading.
 */
function stripDelimiters(lines: string[], headingText: string): string {
  const isHeading = (line = "") => {
    const m = /^### (?:\d+ · )?(.*)$/s.exec(line);
    return m?.[1] === headingText;
  };
  let bodyLines: string[];
  if (lines[0] === "" && isHeading(lines[1]) && lines[2] === "") {
    bodyLines = lines.slice(3);
    if (bodyLines.at(-1) === "") bodyLines.pop();
  } else {
    bodyLines = [...lines];
    while (bodyLines[0]?.trim() === "") bodyLines.shift();
    if (isHeading(bodyLines[0]?.trim())) bodyLines.shift();
    while (bodyLines[0]?.trim() === "") bodyLines.shift();
    while (bodyLines.at(-1)?.trim() === "") bodyLines.pop();
  }
  return bodyLines.join("\n");
}

function parseAttrs(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of text.matchAll(ATTR)) {
    const [, key, raw] = m;
    if (key !== undefined && raw !== undefined)
      attrs[key] = JSON.parse(`"${raw}"`) as string;
  }
  return attrs;
}

// JSON string quoting, plus escaping ">" so a value can never close the comment ("-->"),
// and U+2028/U+2029, which JSON.stringify leaves literal, so the marker stays one plain line.
function quote(value: string): string {
  return JSON.stringify(value)
    .replace(/>/g, "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

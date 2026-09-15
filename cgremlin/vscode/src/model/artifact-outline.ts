/**
 * Phase 17 §3 — the structure an artifact actually has, read out of its text.
 *
 * The contract of §4 is what the agents write; this is what the tab reads. Its one rule is
 * **parse, never assume**: every export returns `null` or an empty list where it did not find the
 * shape, and the pane draws nothing for that. A fabricated `0 findings` would tell the user the
 * change is clean, which is a claim this module has no evidence for (MG-17j).
 *
 * Both finding forms are accepted — the new one-field-per-line shape and the legacy
 * three-fields-on-one-line shape that is sitting in the sessions directory today (§4e).
 *
 * Pure module: no DOM, no editor API (MG-B1).
 */

export type VerdictTone = 'pass' | 'fail' | 'blocked' | 'mixed' | 'neutral';

export interface Verdict {
  tone: VerdictTone;
  /** The label as written — the vocabulary is the contract's, never re-worded here. */
  label: string;
  /** The sentence after the em dash, or `''` where the artifact gave none. */
  sentence: string;
}

export interface Finding {
  anchor: string;
  number: number;
  title: string;
  severity: string | null;
  where: string | null;
  status: string | null;
}

export interface SeverityCount {
  word: string;
  count: number;
}

/** §3: the tone comes from the glyph, mapped in exactly one place. */
const TONES: Record<string, VerdictTone> = {
  '\u2705': 'pass',
  '\u274C': 'fail',
  '\u{1F6A7}': 'blocked',
  '\u26A0\uFE0F': 'mixed',
  '\u26A0': 'mixed',
  '\u{1F504}': 'mixed',
  '\u{1F4AC}': 'neutral',
};

/** §3: the chrome prints the WORD with a dot, never the emoji (phase 11 §2). */
const SEVERITIES: Record<string, string> = {
  '\u{1F534}': 'Critical',
  '\u{1F7E0}': 'High',
  '\u{1F7E1}': 'Perf',
  '\u{1F527}': 'Maintainability',
  '\u{1F4CB}': 'PM/AC',
  '\u{1F3A8}': 'Design',
};

/** The order the strip counts in, so two runs of the same review read the same way. */
const SEVERITY_ORDER: readonly string[] = [
  'Critical',
  'High',
  'Perf',
  'Maintainability',
  'PM/AC',
  'Design',
];

const EM_DASH = ' — ';

function lines(text: string): string[] {
  return text.split('\n');
}

/**
 * The artifact's own `# ` title, removed.
 *
 * MG-17a: the tab's `<h1>` is the only title in the document, so the one every artifact carries
 * as its first line is taken off here and thrown away — the pane is named by its tab.
 */
export function stripLeadingH1(text: string): { title: string | null; body: string } {
  const all = lines(text);
  let at = 0;
  while (at < all.length && all[at].trim() === '') at += 1;
  const match = /^#\s+(.+?)\s*$/.exec(all[at] ?? '');
  if (match === undefined || match === null) return { title: null, body: text };
  return { title: match[1], body: all.slice(at + 1).join('\n').replace(/^\n+/, '') };
}

/** `<glyph> Request changes — sentence` → the three parts. The glyph is optional. */
function readVerdictValue(raw: string): Verdict {
  let rest = raw.trim();
  let tone: VerdictTone = 'neutral';
  for (const [glyph, value] of Object.entries(TONES)) {
    if (!rest.startsWith(glyph)) continue;
    tone = value;
    rest = rest.slice(glyph.length).trim();
    break;
  }
  const at = rest.indexOf(EM_DASH);
  if (at < 0) return { tone, label: rest, sentence: '' };
  return { tone, label: rest.slice(0, at).trim(), sentence: rest.slice(at + EM_DASH.length).trim() };
}

/**
 * The contract's bold line first, then the two legacy forms — a trailing `## Verdict` section
 * (old reviews) and the frozen `- Verdict:` line of `## QA Verdict` (old and new QA alike).
 */
export function verdictOf(text: string): Verdict | null {
  const all = lines(text);
  for (const line of all) {
    const bold = /^\*\*Verdict:\*\*\s*(.+?)\s*$/.exec(line);
    if (bold !== null) return readVerdictValue(bold[1]);
  }
  for (let at = 0; at < all.length; at += 1) {
    if (!/^#{2,3}\s+Verdict\s*$/.test(all[at])) continue;
    for (let next = at + 1; next < all.length; next += 1) {
      if (/^#{1,6}\s/.test(all[next])) break;
      if (all[next].trim() !== '') return readVerdictValue(all[next]);
    }
  }
  for (const line of all) {
    const bullet = /^\s*-\s*Verdict:\s*(.+?)\s*$/.exec(line);
    if (bullet !== null) return readVerdictValue(bullet[1]);
  }
  return null;
}

/** The review's fourth line, unchanged from `prompts.ts:247`. */
export function ticketAnswerOf(text: string): string | null {
  for (const line of lines(text)) {
    const match = /^\*\*Does it do what the ticket asked\?\*\*\s*(.+?)\s*$/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

/** A severity glyph → its word; a bare word is taken as written, a glyph-less unknown is `null`. */
function readSeverity(raw: string): string | null {
  const value = raw.trim();
  for (const [glyph, word] of Object.entries(SEVERITIES)) {
    if (value.startsWith(glyph)) return word;
  }
  const bare = /^([A-Za-z][\w/ -]*)$/.exec(value);
  if (bare === null) return null;
  const match = SEVERITY_ORDER.find((word) => word.toLowerCase() === bare[1].trim().toLowerCase());
  return match ?? bare[1].trim();
}

/** A `Where` value is code only (§4d), so the backticks come off and nothing else is read. */
function readCode(raw: string): string {
  return raw.trim().replace(/^`+|`+$/g, '').trim();
}

interface FieldReader {
  severity: string | null;
  where: string | null;
  status: string | null;
}

/**
 * Both shapes, read off the block that follows a `### N.` heading.
 *
 * The new shape is one `- **Field:** value` per line; the legacy shape puts all three on one line
 * separated by runs of spaces. A single scan over the block handles both: every `**Field:**` in
 * the block is matched wherever it sits, and its value runs to the next `**` or to end of line.
 */
function readFields(block: readonly string[]): FieldReader {
  const out: FieldReader = { severity: null, where: null, status: null };
  const FIELD = /\*\*(Severity|Where|Status):\*\*\s*([^*\n]*)/g;
  for (const line of block) {
    for (let m = FIELD.exec(line); m !== null; m = FIELD.exec(line)) {
      const value = m[2].trim();
      if (value === '') continue;
      if (m[1] === 'Severity' && out.severity === null) out.severity = readSeverity(value);
      else if (m[1] === 'Where' && out.where === null) out.where = readCode(value);
      else if (m[1] === 'Status' && out.status === null) out.status = value;
    }
  }
  return out;
}

/**
 * The findings, in document order.
 *
 * The anchor is the artifact's own `<a id="…"></a>` where it wrote one — that is the id
 * `webview/markdown.ts` synthesises a `<span>` for, and therefore the id the `[N](#fN)` links in
 * the summary table jump to. Where the artifact wrote none (every legacy file), `f<N>` is used,
 * which is what those older files' tables already pointed at.
 */
export function findingsOf(text: string): Finding[] {
  const all = lines(text);
  const out: Finding[] = [];
  for (let at = 0; at < all.length; at += 1) {
    const heading = /^###\s+(\d+)\.\s+(.+?)\s*$/.exec(all[at]);
    if (heading === null) continue;
    let end = at + 1;
    while (end < all.length && !/^#{1,3}\s/.test(all[end]) && !/^<a id="/.test(all[end])) end += 1;
    const fields = readFields(all.slice(at + 1, end));
    const number = Number(heading[1]);
    let anchor = `f${number}`;
    for (let back = at - 1; back >= 0 && at - back <= 3; back -= 1) {
      const tag = /^<a id="([A-Za-z][\w-]*)"><\/a>\s*$/.exec(all[back].trim());
      if (tag !== null) {
        anchor = tag[1];
        break;
      }
      if (all[back].trim() !== '') break;
    }
    out.push({ anchor, number, title: heading[2], ...fields });
  }
  return out;
}

/**
 * §3: counted off the finding DETAILS. The `## What I found` table repeats every severity, so
 * counting the whole document would report each finding twice.
 */
export function severityCountsOf(text: string): SeverityCount[] {
  const tally = new Map<string, number>();
  for (const finding of findingsOf(text)) {
    if (finding.severity === null) continue;
    tally.set(finding.severity, (tally.get(finding.severity) ?? 0) + 1);
  }
  const known = SEVERITY_ORDER.filter((word) => tally.has(word));
  const extra = [...tally.keys()].filter((word) => !SEVERITY_ORDER.includes(word)).sort();
  return [...known, ...extra].map((word) => ({ word, count: tally.get(word) ?? 0 }));
}

/**
 * §3: a repo-relative `path:line`, and nothing else.
 *
 * Exactness is the point — this decides which `<code>` in a rendered review becomes a clickable
 * address. `npm run build:88` must not, so the path has to carry a real extension, and line 0
 * does not exist in an editor.
 */
export function fileRefOf(text: string): { path: string; line: number } | null {
  const match = /^([\w./-]+\.[A-Za-z0-9]+):(\d+)(?:-L?\d+)?$/.exec(text.trim());
  if (match === null) return null;
  const line = Number(match[2]);
  return Number.isInteger(line) && line >= 1 ? { path: match[1], line } : null;
}

/**
 * §20 — what the engine reads back out of REVIEW.md: its findings (by stable anchor) and its
 * verdict. The shape is the contract the agents are shown (REVIEW_CONTRACT_EXAMPLE,
 * src/pipeline/prompts.ts); the table row and the detail block each carry a Status, and a
 * finding is dismissed when EITHER says so (the contract keeps them equal; a hand edit may not).
 */
export interface ReviewFinding {
  /** `f1`, `f2`, … — stable across re-reviews, but a fresh review restarts them (S2-27). */
  anchor: string;
  number: number;
  title: string | null;
  severity: string | null;
  /** `Where` (a path:line) or, for 📋/🎨 findings, `Route`. */
  where: string | null;
  /** The detail block's Status, else the table row's. */
  status: string | null;
  dismissed: boolean;
}

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment';

const TABLE_ROW = /^\|\s*\[(\d+)\]\(#(f\d+)\)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/;
const ANCHOR = /^<a id="(f\d+)"><\/a>$/;
// dotAll (`s`): with `.` unable to match a stray `\r` (or U+2028/9), the `\s+`/`.+` overlap
// backtracks quadratically — 40k spaces then `\r` took >1 s, synchronously (6a review).
const DETAIL_HEADING = /^###\s+\d+\.\s+(.+)$/s;
const FIELD = /^-\s+\*\*(Severity|Where|Route|Status):\*\*\s*(.*)$/s;
const SECTION = /^#{1,2}\s/;
/** The Status SAYS dismissed (`🔇 dismissed`, `dismissed`) — not merely mentions it (`open (not dismissed)`, `un-dismissed`). */
const DISMISSED = /^\W*dismissed\b/iu;
const VERDICT = /^\*\*Verdict:\*\*\s*(✅|🔄|💬)/mu;

interface Draft {
  anchor: string;
  number: number;
  title: string | null;
  severity: string | null;
  where: string | null;
  tableStatus: string | null;
  detailStatus: string | null;
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function unticked(value: string): string {
  return value.trim().replace(/^`(.*)`$/, '$1');
}

export function parseReviewFindings(text: string): ReviewFinding[] {
  const drafts = new Map<string, Draft>();
  const draftFor = (anchor: string): Draft => {
    let draft = drafts.get(anchor);
    if (draft === undefined) {
      draft = { anchor, number: Number(anchor.slice(1)), title: null, severity: null, where: null, tableStatus: null, detailStatus: null };
      drafts.set(anchor, draft);
    }
    return draft;
  };
  let current: Draft | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const row = TABLE_ROW.exec(line);
    if (row) {
      const draft = draftFor(row[2]);
      draft.number = Number(row[1]);
      if (draft.severity === null) draft.severity = orNull(row[3]);
      if (draft.where === null) draft.where = orNull(unticked(row[4]));
      if (draft.title === null) draft.title = orNull(row[5]);
      draft.tableStatus = orNull(row[6]);
      continue;
    }
    const anchor = ANCHOR.exec(line);
    if (anchor) {
      current = draftFor(anchor[1]);
      continue;
    }
    if (current === null) continue;
    if (SECTION.test(line)) {
      current = null;
      continue;
    }
    const heading = DETAIL_HEADING.exec(line);
    if (heading) {
      current.title = heading[1].trim();
      continue;
    }
    const field = FIELD.exec(line);
    if (field) {
      if (field[1] === 'Severity') current.severity = orNull(field[2]);
      else if (field[1] === 'Status') current.detailStatus = orNull(field[2]);
      else current.where = orNull(unticked(field[2]));
    }
  }
  return [...drafts.values()]
    .sort((a, b) => a.number - b.number)
    .map((d) => ({
      anchor: d.anchor,
      number: d.number,
      title: d.title,
      severity: d.severity,
      where: d.where,
      status: d.detailStatus ?? d.tableStatus,
      dismissed: DISMISSED.test(d.detailStatus ?? '') || DISMISSED.test(d.tableStatus ?? ''),
    }));
}

/** Line 2 of REVIEW.md: `**Verdict:** <glyph> <label> — …`. */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  const match = VERDICT.exec(text);
  if (match === null) return null;
  return match[1] === '✅' ? 'approve' : match[1] === '🔄' ? 'request_changes' : 'comment';
}

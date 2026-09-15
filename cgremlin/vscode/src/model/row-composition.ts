/**
 * THE row composer (Phase 14).
 *
 * One module owns every visible line a work item draws: its identity keys (L1), its description
 * (L2), its repo tail and its signal cells (L3), the PR label a chip or a part shows, and the
 * age/size/tier/CI/activity tokens the cells are made of. The collapsed row, the expanded parts
 * and the Item tab ALL read it — no second place may compose a line.
 *
 * Why it is a module of its own: the live complaint on a merged PR's row was that L1 showed a
 * bare `aplaceformom/grace-frontend#2061`, L2 showed the same bare head as prose, and the author,
 * the age, the ticket and the merged state were all missing. Those are four lines that degraded
 * at once, and the fix has to be one edit in one place — which is only true if there IS one
 * place. `test/row-composition.guard.test.ts` is the guard that keeps it so: no module outside
 * this one may build a `<repo>#<number>` label of its own.
 *
 * Pure: no editor API, no DOM, no clock of its own (a `now` is always an argument).
 */
import type {
  CiStatus,
  QaVerdict,
  RowMetaCell,
  SizeTier,
  WorkAgentMode,
  WorkItem,
  WorkItemAgent,
  WorkItemPr,
  WorkListKind,
} from './work-items';

/**
 * THE `<owner>/<repo>#<number>` label, and THE `pr:` reference built from it.
 *
 * Eleven sites used to build one or the other out of a template literal, which is how a row could
 * say `aplaceformom/grace-frontend#2061` while the tab said something else about the same PR.
 */
export function prLabel(pr: { repo: string; number: number }): string {
  return `${pr.repo}#${pr.number}`;
}

export function prRefOf(pr: { repo: string; number: number }): string {
  return `pr:${prLabel(pr)}`;
}

/**
 * Merged and closed are the terminal states: the code is in (or gone) and no
 * verb points forward any more.
 *
 * The parameter is deliberately `string`-wide: the wire's `state` and the
 * panel's own display wording (`prState`) coincide EXACTLY on the two
 * terminal values, so the Item tab's `TabPr.state` — which is the display
 * wording — can be asked the same question without a second field.
 */
export function isLandedPr(pr: { state?: string | null } | undefined): boolean {
  return pr?.state === 'merged' || pr?.state === 'closed';
}

/**
 * "The code is in." Every one of the item's PRs has landed — which SINKS the
 * row rather than hiding it: the ticket behind it may well still be in UAT,
 * and that is exactly the context the user asked to keep.
 */
export function isLandedItem(item: { prs: readonly { state?: string | null }[] }): boolean {
  return item.prs.length > 0 && item.prs.every((pr) => isLandedPr(pr));
}

/**
 * §2 L1 — the keys, and nothing else.
 *
 * `labelOf` used to build `grace-frontend#4821 — Fix pagination on the offer list`: fourteen
 * identical characters of repo prefix on every row of the list, then the one thing that differed,
 * then an ellipsis where the sidebar ran out. The prefix moves to L3 (as its last path segment
 * alone) and the prose to L2, so what is left here is short enough that it never truncates.
 *
 * The one list with neither a ticket nor a PR is the investigations list, and there the session
 * title IS the identifier — it is the only name that work has.
 */
export function identityOf(item: WorkItem): string {
  return identityKeysOf(item).join(' ');
}

export function identityKeysOf(item: WorkItem): string[] {
  const keys: string[] = [];
  if (item.ticket !== null) keys.push(item.ticket.key);
  // The FIRST PR only: a second `#88` on the same line is the other PR's number, which reads as
  // part of the first one. Every PR is named in the block the row opens into (§4).
  const primary = item.prs[0];
  if (primary !== undefined) keys.push(`#${primary.number}`);
  return keys.length === 0 ? [item.title] : keys;
}

/**
 * §2 L2 — the prose, once. Empty means the line is not rendered, not that it is blank.
 *
 * Item 1: it is a CHAIN, because the first two rungs are both empty on real data — the core seeds
 * a ticket candidate with `summary: ''` when the key came from a PR and was not in the JQL
 * snapshot, and a session-only item has neither a ticket nor a PR. A row that then draws `HB-627`
 * and nothing else is the "no title on it" complaint, so every rung that names the work is tried:
 * the ticket summary, the first PR's title, the item's own title, and finally the branch — the
 * last place a PR always carries a name of some kind.
 *
 * The one rung never taken is one that repeats L1: an investigation's own title IS its identity
 * (`identityKeysOf`), and saying it twice is not a description. The session's `intent` would sit
 * between the PR title and the item title and deliberately does not — `WorkItemAgent` does not
 * carry it on the wire, and deriving it here would invent a second source for it.
 */
export function descriptionOf(item: WorkItem): string {
  const identity = identityKeysOf(item).join(' ');
  const rungs = [
    item.ticket?.summary ?? '',
    item.prs[0]?.title ?? '',
    titleProse(item.title),
    item.prs[0]?.branch ?? '',
  ];
  for (const rung of rungs) {
    const text = rung.trim();
    if (text !== '' && text !== identity) return text;
  }
  return '';
}

/**
 * The prose half of a core-built `WorkItem.title`, which is `acme/legacy#9 — Bump the toolchain`
 * or `HB-627 — Caregiver inbox reshuffle`: everything after the first em-dash separator.
 *
 * The head is the identity L1 already draws, and putting it back on L2 would restore the very
 * `grace-frontend#4821 — Fix pagination` line §2 broke apart. A title with no separator is prose
 * already; a title that is ONLY a head (the PR whose title the wire never carried) leaves nothing,
 * and the chain moves on to the branch.
 */
const BARE_HEAD = /^(?:[\w.-]+\/[\w.-]+#\d+|[A-Z][A-Z0-9]+-\d+)$/;

export function titleProse(title: string): string {
  const at = title.indexOf(' — ');
  const prose = (at === -1 ? title : title.slice(at + 3)).trim();
  // Phase 14: a title that is ONLY a head (`aplaceformom/grace-frontend#2061`, `HB-6210`) is not
  // prose. Returning it here is what put the bare head on L2 under the bare head on L1 — the
  // user's "L2 `aplaceformom/grace-frontend#2061` (the bare head, no prose)". L1 already says it;
  // the chain moves on to the branch instead.
  return BARE_HEAD.test(prose) ? '' : prose;
}

/** §2 L3's first and only shrinkable token: `apfm/grace-frontend` reads as `grace-frontend`. */
export function repoTailOf(item: WorkItem): string {
  // The PR names the repo; where there is no PR (a ticket-led row, or one
  // whose PR left the inventory) the SESSION does, and the work has a repo
  // from the moment a session exists. A ticket with neither legitimately
  // shows no repo at all — there is nothing yet to name.
  const repo = item.prs[0]?.repo ?? item.agents.find((a) => (a.repo ?? '') !== '')?.repo ?? '';
  return repo === '' ? '' : (repo.split('/').pop() ?? '');
}

export const MODE_LETTER: Record<WorkAgentMode, string> = {
  review: 'R',
  respond: 'C',
  investigation: 'I',
  development: 'D',
  qa: 'Q',
};

/** The same geometric marks the parts use (`model/item-parts`), and for the same reason. */
export const MODE_GLYPH: Record<WorkAgentMode, string> = {
  review: '◈',
  respond: '❝',
  investigation: '∴',
  development: '◆',
  qa: '⛋',
};

export const MODE_NAME: Record<WorkAgentMode, string> = {
  review: 'Review',
  respond: 'Respond',
  investigation: 'Investigation',
  development: 'Development',
  qa: 'QA verification',
};

/**
 * Phase 15 §8 — the ONE place a QA phase becomes a word, so the collapsed row, the expanded
 * part and the Item tab cannot disagree about what a verification is doing.
 *
 * The engine's phases are `queued | verifying | ready | not_ready | failed | closed | abandoned`
 * (R69). Two of them are re-worded here and nowhere else:
 *  - `not_ready` reads `not ready` — a row is prose, not an enum. R79 folds the Blocked verdict
 *    into this same phase (evaluateQa's `outcome`), so the PHASE alone cannot tell a real
 *    not-ready verdict from a run the agent could not perform at all — Gap 1's `verdict`
 *    parameter is what does: `blocked` reads `blocked`, anything else reads `not ready`;
 *  - `failed` reads `failed` — a run that died wrote no verdict at all. It used to read
 *    `blocked` as a softer word, but Gap 1 gives `blocked` a real, different meaning (the QA
 *    VERDICT of that name), and conflating the two is exactly the ambiguity Gap 1 removes: a run
 *    failure is already said by `run_failed` on the needs-you strip, so nothing is hidden by the
 *    more literal word.
 */
const QA_STATE_TEXT: Record<string, string> = {
  not_ready: 'not ready',
  failed: 'failed',
};

export function qaStateText(phase: string, verdict: QaVerdict | null = null): string {
  if (phase === 'not_ready' && verdict === 'blocked') return 'blocked';
  return QA_STATE_TEXT[phase] ?? phase;
}

/** Claim, then a live run, then the gate — the precedence the tree used before the panel (R18). */
export function agentGlyph(agent: WorkItemAgent): string {
  if (agent.claimed) return '◉';
  if (agent.running) return '⟳';
  if (agent.needsYou) return '!';
  return '';
}

/** The one-or-two character badge a row draws per agent. */
export function agentBadge(agent: WorkItemAgent): string {
  return `${MODE_LETTER[agent.mode] ?? '?'}${agentGlyph(agent)}`;
}

const CI_DOTS: Record<CiStatus, string> = {
  success: '●',
  pending: '◐',
  failure: '✕',
  none: '',
};

export function ciDot(ci: CiStatus | null): string {
  return ci === null ? '' : (CI_DOTS[ci] ?? '');
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** MG-12 again: no fabricated `0 files`. */
export function sizeOf(pr: WorkItemPr | undefined): string {
  if (pr === undefined || pr.changedFiles === null) return '—';
  const files = `${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'}`;
  if (pr.additions === null && pr.deletions === null) return files;
  return `${files} +${pr.additions ?? 0}/−${pr.deletions ?? 0}`;
}

/**
 * R47: who is already on it — **with the date**, which is the whole question that group asks.
 *
 * `@DavidAPFM commented` cannot tell a comment from this morning from one from three weeks
 * ago, so the age goes on the line. What the wire carries is `{ reviewedBy, commentedBy, lastAt }`
 * and ONE timestamp for the PR, not one per actor — so every interaction is dated by the same
 * `lastAt`, and none of them is dated by a clock invented here (MG-12).
 *
 * The bots are already gone: the core drops them, and the team-only review requests with them.
 * There is deliberately no bot test of ANY kind here — `core/src/work/bot-login.ts` holds the one
 * predicate in the project and MG-4 enforces that it is the only one. A second one here would
 * drift, and would drift silently.
 */
export type HumanActivityKind = 'reviewed' | 'commented';

export interface HumanInteraction {
  login: string;
  kind: HumanActivityKind;
  /** The PR's verdict, and only where exactly one reviewer can own it. */
  verdict: string | null;
  /** `2d ago`, `5h ago`, `<1h ago` — or `—` when the engine sent no timestamp. */
  age: string;
}

/** Every login the core sent, which is every login that survived its bot filter. */
function humans(logins: readonly string[] | null | undefined): string[] {
  return [...(logins ?? [])];
}

function ago(lastAt: string | null, now: number): string {
  const age = compactAge(lastAt, now);
  return age === '—' ? '—' : `${age} ago`;
}

/** The verdict, only when one reviewer can own it: pinning it on the first of two is a lie. */
function soleVerdict(pr: WorkItemPr, reviewers: readonly string[]): string | null {
  return reviewers.length === 1 ? reviewText(pr.reviewDecision ?? null) : null;
}

/** Every human interaction the core reported, reviewers first — the expanded row's own list. */
export function humanInteractions(pr: WorkItemPr | undefined, now: number): HumanInteraction[] {
  if (pr === undefined) return [];
  const reviewers = humans(pr.humanActivity?.reviewedBy);
  const commenters = humans(pr.humanActivity?.commentedBy);
  const age = ago(pr.humanActivity?.lastAt ?? null, now);
  const verdict = soleVerdict(pr, reviewers);
  return [
    ...reviewers.map((login): HumanInteraction => ({ login, kind: 'reviewed', verdict, age })),
    ...commenters.map((login): HumanInteraction => ({ login, kind: 'commented', verdict: null, age })),
  ];
}

/** The one line the collapsed row shows: the stronger kind, every handle in it, and the age. */
export function humanActivitySummary(pr: WorkItemPr | undefined, now: number): string {
  if (pr === undefined) return '';
  const reviewers = humans(pr.humanActivity?.reviewedBy);
  const commenters = humans(pr.humanActivity?.commentedBy);
  // A review outranks a comment: it is the stronger thing to have happened, and both share the
  // one timestamp, so there is no "most recent" to pick between them.
  const who = reviewers.length > 0 ? reviewers : commenters;
  if (who.length === 0) {
    const requested = humans(pr.reviewRequests);
    return requested.length > 0 ? `@${requested[0]} requested` : '';
  }
  const verb = reviewers.length > 0 ? 'reviewed' : 'commented';
  const age = compactAge(pr.humanActivity?.lastAt ?? null, now);
  // `@dana reviewed 43h` — no glyph, no parenthesised verdict, no `ago`. The verdict is the PR's
  // state and belongs to the PR part of the submenu (§4); this line answers "who, and when".
  return [who.map((login) => `@${login}`).join(', '), verb, age === '—' ? '' : age]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * §2 L3 — the signals line, as one token per cell and NO separators.
 *
 * The `·`-joined sentence is gone: it was one of the two treatments that made ten rows look
 * alike, and it was also what got ellipsised. The repo tail leads (it is the only shrinkable
 * child), then the tokens each list needs, right-packed so the tier and the number line up down
 * the column. Emoji prefixes go with the separators — except an agent's mode glyph, which is the
 * one place a glyph is the name of a thing rather than decoration.
 */
/** §2 L3 — the signal cells, the ONE place they are composed. */
export function rowMetaCells(
  item: WorkItem,
  list: WorkListKind,
  parts: { age: string; size: string; tier: string; activity: string; repo: string },
): RowMetaCell[] {
  const primary = item.prs[0];
  const cells: RowMetaCell[] = [];

  const pushAgent = (agent: WorkItemAgent): void => {
    cells.push(phaseCell(agent));
    if (agent.running) cells.push(runningCell());
  };

  if (list === 'investigations') {
    for (const agent of item.agents) pushAgent(agent);
    cells.push({ kind: 'age', text: parts.age });
    return cells;
  }

  if (parts.repo !== '') cells.push({ kind: 'repo', text: parts.repo });

  // Straight after the repo, because it changes what every token after it
  // means: `grace · merged · UAT · 3d` reads "the code is in, the ticket is
  // not done yet". Muted, one word, no glyph and no tooltip (§3).
  if (isLandedPr(primary)) {
    cells.push({
      kind: 'prState',
      text: primary?.state === 'closed' ? 'closed' : 'merged',
      label: primary?.state === 'closed' ? 'PR closed without merging' : 'PR merged',
      tone: 'muted',
    });
  }

  // The ONE thing each list's row answers (§1), in the slot the eye lands on after the repo.
  if (list === 'waitingForReview') {
    const landed = landedOf(primary);
    if (landed !== '') cells.push({ kind: 'landed', text: landed });
  } else if (list === 'myWork') {
    if (item.ticket !== null) cells.push({ kind: 'ticketStatus', text: item.ticket.status });
    for (const agent of item.agents) pushAgent(agent);
  } else if (item.agents.length > 0) {
    // An agent of ours outranks the author and the activity line wherever the
    // row sits: "what is happening to this PR right now" is the answer the
    // user is after, and a row whose review has just been started must not
    // keep reading `@jane · 2w`. This is presentation, not membership — the
    // group the row is IN stays the core's answer (D2).
    for (const agent of item.agents) pushAgent(agent);
  } else if (item.parkingLotGroup === 'someoneOnIt' && parts.activity !== '') {
    cells.push({ kind: 'activity', text: parts.activity });
  } else if (primary?.author !== null && primary?.author !== undefined) {
    cells.push({ kind: 'author', text: `@${primary.author}` });
  }

  cells.push({ kind: 'age', text: parts.age });
  cells.push({ kind: 'tier', text: parts.tier });
  // The `—` stays: a row whose size took its R45 default says it has none, never a zero (MG-12).
  cells.push({ kind: 'size', text: parts.size });

  const ci = ciCell(primary?.ci ?? null);
  if (ci !== null) cells.push(ci);
  return cells;
}

function phaseCell(agent: WorkItemAgent): RowMetaCell {
  const glyph = MODE_GLYPH[agent.mode] ?? '•';
  if (agent.mode !== 'qa') return { kind: 'agentPhase', text: `${glyph} ${agent.phase}` };
  // §8's one toned cell: a verification that came back short of ready is the top of my work,
  // and the row has to say so without a second composition site (R72 does the ordering).
  const bad = agent.phase === 'not_ready' || agent.phase === 'failed';
  const text = qaStateText(agent.phase, agent.qaVerdict ?? null);
  const cell: RowMetaCell = { kind: 'agentPhase', text: `${glyph} ${text}` };
  return bad ? { ...cell, tone: 'bad' } : cell;
}

/**
 * The one token that says an agent is WORKING right now, beside the stage it
 * is working on. A word, not a spinner and not an emoji: the user's complaint
 * was that a started review was indistinguishable from one that never began.
 */
function runningCell(): RowMetaCell {
  return { kind: 'running', text: 'running', label: 'an agent is running', tone: 'active' };
}

const CI_CELLS: Record<CiStatus, RowMetaCell | null> = {
  // A green dot needs no word; a red one does (§3). The dot alone was hover-only, which is the
  // defect: the one build state worth acting on was the one the user could not see.
  success: { kind: 'ci', text: '', tone: 'good', label: 'CI passing' },
  pending: { kind: 'ci', text: 'CI pending', tone: 'warn', label: 'CI pending' },
  failure: { kind: 'ci', text: 'CI failing', tone: 'bad', label: 'CI failing' },
  none: null,
};

/** §2.2 rule 9 amended by §3: a dot for green, words for everything the user must act on. */
export function ciCell(ci: CiStatus | null): RowMetaCell | null {
  if (ci === null) return null;
  const cell = CI_CELLS[ci] ?? null;
  return cell === null ? null : { ...cell };
}

const REVIEW_TEXT: Record<string, string> = {
  REVIEW_REQUIRED: 'review required',
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
};

function reviewText(decision: string | null): string | null {
  if (decision === null || decision === '') return null;
  return REVIEW_TEXT[decision] ?? null;
}

/**
 * P1-8: what actually landed on my own PR. The verdict first, then who delivered it — "a review
 * arrived" with no name is the state the user said tells him nothing.
 */
export function landedOf(pr: WorkItemPr | undefined): string {
  if (pr === undefined) return '';
  const who = pr.humanActivity?.reviewedBy[0] ?? pr.humanActivity?.commentedBy[0] ?? null;
  const by = who === null ? '' : `@${who} `;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return `${by}requested changes`;
  if (pr.reviewDecision === 'APPROVED') return `${by}approved`;
  if (who !== null) return `${by}review arrived`;
  return '';
}

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * §2.2 rule 7: `4h`, `12d`, `6w`. The word "opened" cost seven characters in a 300 px sidebar,
 * which is how the size ended up ellipsised. `—` for a defaulted date stays (MG-12), and a
 * clock skew that puts the date in the future reads `<1h` rather than a negative age.
 */
export function compactAge(createdAt: string | null, now: number): string {
  if (createdAt === null) return '—';
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return '—';
  const elapsed = Math.max(0, now - at);
  if (elapsed >= 14 * DAY_MS) return `${Math.floor(elapsed / WEEK_MS)}w`;
  if (elapsed >= 2 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  if (elapsed >= HOUR_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return '<1h';
}

const FILE_TIERS: [number, SizeTier][] = [
  [3, 'S'],
  [10, 'M'],
  [25, 'L'],
];
const LINE_TIERS: [number, SizeTier][] = [
  [50, 'S'],
  [300, 'M'],
  [1000, 'L'],
];

function bucket(value: number, table: [number, SizeTier][]): SizeTier {
  for (const [limit, tier] of table) if (value <= limit) return tier;
  return 'XL';
}

/**
 * P1-6, §2.2 rule 6: the harsher of the file count and the line count — a one-file 1800-line
 * generated diff is not an S. The core's own `sizeTier` wins when the engine sends one, so the
 * CLI and the panel cannot disagree; an older engine gets the same arithmetic locally.
 * Unknown is `—`, never a fabricated `S` (MG-12).
 */
export function tierOf(pr: WorkItemPr | undefined): string {
  if (pr === undefined) return '—';
  if (pr.sizeTier !== undefined && pr.sizeTier !== null) return pr.sizeTier;
  const lines =
    pr.additions === null && pr.deletions === null ? null : (pr.additions ?? 0) + (pr.deletions ?? 0);
  if (pr.changedFiles === null && lines === null) return '—';
  const byFiles = pr.changedFiles === null ? null : bucket(pr.changedFiles, FILE_TIERS);
  const byLines = lines === null ? null : bucket(lines, LINE_TIERS);
  const order: SizeTier[] = ['S', 'M', 'L', 'XL'];
  const worst = Math.max(
    byFiles === null ? -1 : order.indexOf(byFiles),
    byLines === null ? -1 : order.indexOf(byLines),
  );
  return order[worst];
}


/**
 * Phase 9's cross-package guards — the ones no single package can assert on its own.
 *
 * Each of these is a claim about BOTH `cgremlin/core/src` and `cgremlin/vscode/src` at once: one
 * bot predicate, no HTML across the boundary, nothing that writes to GitHub. They live in this
 * package because the dependency already runs this way (the extension bundles the engine), so
 * reaching into `../core/src` adds no new coupling.
 *
 * Three of the plan's DoD greps are recorded in its errata as written-wrong rather than
 * implemented-wrong; each is narrowed here, with the reason, to the thing it was actually after.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const CORE_SRC = path.resolve(__dirname, '../../core/src');
const VSCODE_SRC = path.resolve(__dirname, '../src');

interface SourceFile {
  /** Relative to the repo's `cgremlin/`, so a failure names the file the way a human would. */
  label: string;
  path: string;
  text: string;
}

function sourcesUnder(root: string, label: string): SourceFile[] {
  const found: SourceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}/${entry}`);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      found.push({ label: `${prefix}/${entry}`, path: full, text: readFileSync(full, 'utf8') });
    }
  };
  walk(root, label);
  return found;
}

const CORE = sourcesUnder(CORE_SRC, 'core/src');
const VSCODE = sourcesUnder(VSCODE_SRC, 'vscode/src');
const BOTH = [...CORE, ...VSCODE];

/** `<file>:<1-based line>` for every line of every file matching `pattern`. */
function hits(files: readonly SourceFile[], pattern: RegExp): string[] {
  const found: string[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, index) => {
      if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(line)) {
        found.push(`${file.label}:${index + 1}`);
      }
    });
  }
  return found;
}

/** The file with every comment blanked out — prose naming a verb is not a call to it. */
function code(file: SourceFile | undefined): string {
  return (file?.text ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A line that is only a comment. Prose naming a forbidden verb is not a call to it. */
function isProse(files: readonly SourceFile[], location: string): boolean {
  const [label, lineNumber] = location.split(':');
  const file = files.find((candidate) => candidate.label === label);
  const line = file?.text.split('\n')[Number(lineNumber) - 1] ?? '';
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

describe('MG-4: there is exactly ONE bot predicate', () => {
  it('no file but core/src/work/bot-login.ts carries the `[bot]` literal', () => {
    const offenders = hits(BOTH, /\[bot\]/).filter(
      (location) => !location.startsWith('core/src/work/bot-login.ts:'),
    );
    expect(offenders).toEqual([]);
  });

  it('and that predicate really is what every caller uses', () => {
    // A second `endsWith('[bot]')` would pass the grep above if it lived in bot-login.ts, so the
    // callers are checked too: anything that READS an `is_bot` flag must hand it to `isBotLogin`
    // rather than branch on it. Declaring the field on a parse schema (`is_bot: z.boolean()`) is
    // not a decision, and is what lets the flag survive parsing at all (U1).
    const deciders = BOTH.filter((file) => {
      if (file.label.endsWith('work/bot-login.ts')) return false;
      return /\bis_bot\b(?!\s*:\s*z\.)/.test(code(file));
    });
    expect(deciders.length).toBeGreaterThan(0);
    for (const file of deciders) {
      expect(file.text, `${file.label} decides bot-ness without isBotLogin`).toMatch(/isBotLogin/);
    }
  });
});

/**
 * MG-10 / R33. The plan's DoD grep is `[A-Za-z]Html\b` over both `src` trees "hits nothing in
 * src/jira, src/work, src/api or any postMessage payload type" — but run bare it also hits the
 * extension's own `escapeHtml`, which is REQUIRED: `src/webview/*` is the one place that builds
 * markup, and escaping is how it stays safe (MG-B7). The guard is the scoped one.
 */
describe('MG-10: no HTML crosses the port, the API or postMessage', () => {
  const BOUNDARY = [
    'core/src/jira',
    'core/src/work',
    'core/src/api',
    'core/src/gh',
    'core/src/inventory',
    'vscode/src/model/item-tab-protocol.ts',
    'vscode/src/model/panel-protocol.ts',
    'vscode/src/model/work-items.ts',
    'vscode/src/core-client.ts',
  ];

  it('no identifier ending in `Html` exists anywhere on the boundary', () => {
    const boundary = BOTH.filter((file) => BOUNDARY.some((prefix) => file.label.startsWith(prefix)));
    expect(boundary.length).toBeGreaterThan(10);
    expect(hits(boundary, /[A-Za-z]Html\b/)).toEqual([]);
  });

  it('the only `*Html` identifiers in either package are the webview escaper and its callers', () => {
    const owners = new Set(
      hits(BOTH, /[A-Za-z]Html\b/).map((location) => location.split(':')[0]),
    );
    const allowed = ['vscode/src/model/escape-html.ts', 'vscode/src/webview/'];
    expect([...owners].filter((file) => !allowed.some((ok) => file.startsWith(ok)))).toEqual([]);
    // …and the escaper is really there, so this is not passing on an empty set.
    expect(owners.has('vscode/src/model/escape-html.ts')).toBe(true);
  });
});

/**
 * MG-14 / R55. Two DoD greps, both recorded in the plan's errata as written too wide:
 *  - `grep -rn "mutation" core/src` is NOT empty — `pipeline-service.ts` says "pre-run mutation"
 *    in a comment about session state. The claim is about the GraphQL operation kind;
 *  - the `gh pr comment|review|merge|…` grep legitimately hits `permission-guard.ts`, whose whole
 *    job is to DENY those verbs to the agent, plus the comment that points at it.
 */
describe('MG-14: the ENGINE writes to GitHub nowhere, and the agent only through the helpers', () => {
  it('no GraphQL document in the core contains a mutation operation', () => {
    // The operation kind, not the English word: `mutation Name(`, `mutation {`, `mutation(`.
    expect(hits(CORE, /\bmutation\s*[({A-Z]/)).toEqual([]);
    // And the one file that speaks GraphQL at all carries no `mutation` in any form.
    const graphql = CORE.filter((file) => /graphql/i.test(file.text));
    expect(graphql.map((file) => file.label)).toContain('core/src/gh/review-threads.ts');
    for (const file of graphql) expect(file.text, file.label).not.toMatch(/mutation/);
  });

  it('no source builds a mutating `gh` argv — the only hits are the deny-list and its comment', () => {
    const pattern = /gh (pr (comment|review|merge|edit|close|ready)|api .*-X (POST|PATCH|PUT|DELETE))|review-request/;
    const offenders = hits(BOTH, pattern).filter(
      (location) =>
        // R55's enforcement point: the guard exists precisely to name these verbs and refuse them.
        !location.startsWith('core/src/workspace/permission-guard.ts:') && !isProse(BOTH, location),
    );
    expect(offenders).toEqual([]);
  });

  it('the permission guard really denies them rather than merely mentioning them', () => {
    const guard = CORE.find((file) => file.label.endsWith('workspace/permission-guard.ts'));
    expect(guard).toBeDefined();
    for (const verb of ['gh pr review', 'gh pr comment', 'gh pr merge', 'gh pr close']) {
      expect(guard?.text).toContain(`Bash(${verb}:*)`);
    }
    expect(guard?.text).toMatch(/deny/i);
  });

  /**
   * Phase 20 REVERSED R55's "never answer": the respond agent now does reply, through two
   * scoped helpers (`.cgremlin/post-review`, `.cgremlin/post-comment`) that have this one repo
   * and this one PR number compiled into them, with every `gh` write verb denied outright.
   *
   * So the guard pins the CURRENT policy rather than the old one. The brief's posting
   * INSTRUCTIONS must reach for no `gh` write of any kind and must route the replies through
   * the helper; the denial section that follows still has to enumerate the verbs, so the brief
   * cannot pass by going silent about them, and the helpers have to exist in the core that
   * writes them into the worktree.
   */
  it('the respond brief routes every reply through the scoped helper, and instructs no `gh` write', () => {
    const prompts = CORE.find((file) => file.label.endsWith('pipeline/prompts.ts'));
    const brief = /export function renderRespondBrief[\s\S]*?\n}/.exec(prompts?.text ?? '')?.[0] ?? '';
    expect(brief).not.toBe('');

    // 1. The route, named, and named as the whole of the agent's authority to write.
    expect(brief).toContain('.cgremlin/post-review');
    expect(brief).toContain('.cgremlin/post-comment');
    expect(brief).toMatch(/whole of your authority to write to GitHub/);
    expect(brief).toMatch(/post-review[^\n]*ONE review/);

    // 2. A `gh` write verb may appear in EXACTLY one place in the brief: the paragraphs that
    //    refuse it. The posting steps ("When", "How") sit BELOW those, so a slice is not enough
    //    — every occurrence is located and has to fall inside the refusal.
    const from = brief.indexOf('**What is denied.**');
    const to = brief.indexOf('**If a helper exits non-zero');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const GH_WRITE = /gh (pr (review|comment|create|merge|close|edit|ready)|api)\b/g;
    const stray: string[] = [];
    for (let m = GH_WRITE.exec(brief); m !== null; m = GH_WRITE.exec(brief)) {
      if (m.index < from || m.index > to) stray.push(m[0]);
    }
    expect(stray).toEqual([]);

    // 3. …and the refusal really does name them, so silence cannot pass for safety.
    const denial = brief.slice(from, to);
    for (const verb of ['gh api', 'gh pr review', 'gh pr comment', 'gh pr merge']) {
      expect(denial, verb).toContain(verb);
    }

    // 4. A failed post is reported as NOT delivered rather than assumed (prompts.ts's own rule).
    expect(brief).toMatch(/NOT delivered/);
  });

  it('the helpers the brief sends the agent to are really written by the core', () => {
    const helpers = CORE.find((file) => file.label.endsWith('workspace/post-helpers.ts'));
    expect(helpers?.text ?? '').toContain('post-review');
    expect(helpers?.text ?? '').toContain('post-comment');
    // And the guard still allows exactly those two while denying the raw verbs (asserted above).
    const guard = CORE.find((file) => file.label.endsWith('workspace/permission-guard.ts'));
    expect(guard?.text ?? '').toContain('.cgremlin/post-review');
  });
});

/**
 * MG-1's cross-package half: `src/work` is a GROUPING over attention, so it may not take a
 * session lock, read a session document or touch the filesystem.
 */
describe('MG-1: nothing in core/src/work reaches for session state', () => {
  it('takes no lock and reads no session', () => {
    const work = CORE.filter((file) => file.label.startsWith('core/src/work/'));
    expect(work.length).toBeGreaterThan(0);
    for (const file of work) {
      // Comments blanked: `work-item-service.ts` explains MG-1 by NAMING `lock.enter`.
      expect(code(file), file.label).not.toMatch(/withLock|lock\.enter|SessionStore|readFile|node:fs/);
    }
  });

  /**
   * The plan's DoD also greps `src/work` for the literal `'reviewing'` — recorded in the errata
   * as inverted. R47 REQUIRES that literal: it is the name of the parking lot's first group,
   * which is what replaced the fourth list.
   */
  it("still names the parking lot's `reviewing` GROUP (R47)", () => {
    const workItem = CORE.find((file) => file.label.endsWith('work/work-item.ts'));
    expect(workItem?.text).toMatch(/'reviewing'/);
    // …and it is a group, never a list.
    expect(workItem?.text).toMatch(/ParkingLotGroup = 'reviewing'/);
    expect(workItem?.text).toMatch(
      /WorkListKind = 'parkingLot' \| 'myWork' \| 'investigations' \| 'waitingForReview'/,
    );
  });
});

describe('R41: item.changed is registered everywhere it has to be', () => {
  it('is in the event map, in ENGINE_EVENT_TYPES, and logged by serve()', () => {
    const events = CORE.find((file) => file.label.endsWith('engine/events.ts'));
    expect(events?.text).toMatch(/'item\.changed':/);
    expect(events?.text).toMatch(/'item\.changed',/);
    /**
     * The plan's DoD says `item.changed` appears once in `serve.ts`; errata: it appears TWICE,
     * like every other event — `events.on(...)` and the `logLine` inside it.
     */
    const serve = CORE.find((file) => file.label.endsWith('host/serve.ts'));
    expect((serve?.text.match(/item\.changed/g) ?? []).length).toBe(2);
  });

  it('carries an address, never a whole WorkItem (the 256-frame ring)', () => {
    const events = CORE.find((file) => file.label.endsWith('engine/events.ts'));
    const payload = /'item\.changed': \{[^}]*\}/.exec(events?.text ?? '')?.[0] ?? '';
    expect(payload).toContain('id: string');
    expect(payload).not.toMatch(/item:/);
  });
});

describe('R63: ATTENTION_REASONS is pinned across the packages', () => {
  it('the extension never re-derives the reason list the core owns', () => {
    // The extension reads `attention.reasons` as opaque strings (R47's D2): a second copy of the
    // list here would be a second rule about which reasons mean "needs you".
    const model = VSCODE.find((file) => file.label.endsWith('model/work-items.ts'));
    expect(model?.text).toMatch(/reasons: string\[\]/);
    expect(model?.text).not.toMatch(/ATTENTION_REASONS/);
  });
});

/**
 * Defect 5 — what the agent is DOING, as one line per thing done.
 *
 * `ClaudeCodeRunner` forwarded only `type: 'text'` parts, so the live Output pane showed the
 * agent's occasional prose and nothing else: a working agent looked identical to a wedged one
 * (one `run.output` frame in 45 seconds, measured against a real run). Everything a coding agent
 * actually spends its time on — the reads, the edits, the shell, the test runs — is a `tool_use`
 * part, and its answer a `tool_result`.
 *
 * Three rules this module exists to keep:
 *  - a line says what HAPPENED, not what was sent: `Edited src/foo.ts`, never a JSON blob. The
 *    pane is scanned, and progress has to be tellable from thrashing at a glance;
 *  - tool INPUT is never dumped. A `Write` input is an entire new file and a `Bash` input can
 *    carry a credential, so each known tool contributes the one or two fields that name the
 *    subject (a path, a command, a pattern) and an unknown tool contributes its KEYS only;
 *  - tool RESULTS are capped harder than inputs — a test run or a file read is enormous — to a
 *    head/tail excerpt with a visible `... N lines omitted ...` marker between them.
 *
 * What comes out is still untrusted text. It leaves the engine as `run.output`, and `run.output`
 * is redacted on the way out (`api/event-stream.redactRunOutput`) exactly as agent prose already
 * was: this module deliberately does NOT redact, so there is one redaction point and not two.
 *
 * Pure module — no I/O, no process, no engine types.
 */

/** One line of the work log, hard-capped. Long enough for a path plus a verb, short enough to scan. */
export const TOOL_LINE_MAX = 160;
/** Excerpt shape for a result: the first lines, the last line, and a marker for the rest. */
const RESULT_HEAD_LINES = 3;
const RESULT_TAIL_LINES = 1;
/** Ids remembered so a result can name its tool. Bounded — a long run must not grow a map forever. */
const MAX_TRACKED_CALLS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** One line, whitespace-collapsed and capped. A multi-line command becomes its first line plus a marker. */
function oneLine(text: string): string {
  const firstBreak = text.indexOf('\n');
  const head = firstBreak < 0 ? text : `${text.slice(0, firstBreak)} ...`;
  const flat = head.replace(/\s+/g, ' ').trim();
  return flat.length <= TOOL_LINE_MAX ? flat : `${flat.slice(0, TOOL_LINE_MAX - 4)} ...`;
}

/** The subject of a known tool. NEVER a whole input — the named fields only. */
function describeKnown(name: string, input: Record<string, unknown>): string | null {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case 'Read':
      return file === null ? null : `Read ${file}`;
    case 'Write':
      return file === null ? null : `Wrote ${file}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file === null ? null : `Edited ${file}`;
    case 'Bash':
    case 'BashOutput': {
      const command = str(input.command);
      return command === null ? null : `Ran: ${command}`;
    }
    case 'Grep': {
      const pattern = str(input.pattern);
      if (pattern === null) return null;
      return file === null ? `Searched for ${pattern}` : `Searched for ${pattern} in ${file}`;
    }
    case 'Glob': {
      const pattern = str(input.pattern);
      return pattern === null ? null : `Listed files matching ${pattern}`;
    }
    case 'Task':
    case 'Agent': {
      const to = str(input.subagent_type) ?? 'an agent';
      const what = str(input.description);
      return what === null ? `Delegated to ${to}` : `Delegated to ${to}: ${what}`;
    }
    case 'Skill': {
      const skill = str(input.skill);
      return skill === null ? null : `Loaded skill ${skill}`;
    }
    case 'TodoWrite':
      return 'Updated the todo list';
    case 'WebFetch': {
      const url = str(input.url);
      return url === null ? null : `Fetched ${url}`;
    }
    case 'WebSearch': {
      const query = str(input.query);
      return query === null ? null : `Searched the web for ${query}`;
    }
    default:
      return null;
  }
}

/** The fallback: the tool's name and the SHAPE of its input. Keys are safe; values are not. */
function describeUnknown(name: string, input: unknown): string {
  if (!isRecord(input)) return `Used ${name}`;
  const keys = Object.keys(input);
  return keys.length === 0 ? `Used ${name}` : `Used ${name} (${keys.join(', ')})`;
}

/** An array-shaped result (`[{type:'text',text}]`) reads through its text blocks; a string is itself. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      out.push(block.text);
    }
  }
  return out.join('\n');
}

/** The head/tail excerpt, each line capped, with the marker only where something was actually cut. */
function excerpt(body: string): { lines: string[]; total: number } {
  const all = body.split('\n');
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  if (all.length <= RESULT_HEAD_LINES + RESULT_TAIL_LINES + 1) {
    return { lines: all.map(oneLine), total: all.length };
  }
  const omitted = all.length - RESULT_HEAD_LINES - RESULT_TAIL_LINES;
  return {
    lines: [
      ...all.slice(0, RESULT_HEAD_LINES).map(oneLine),
      `... ${omitted} lines omitted ...`,
      ...all.slice(all.length - RESULT_TAIL_LINES).map(oneLine),
    ],
    total: all.length,
  };
}

/**
 * The work log for ONE agent handle. Holds only the id→tool-name map that lets a result name its
 * call, which is what keeps the log readable when several tools run at once.
 */
export class ToolActivityLog {
  private readonly names = new Map<string, string>();

  /** One line for a `tool_use` part, or `null` for any other part. Ends in a newline. */
  noteToolUse(part: unknown): string | null {
    if (!isRecord(part) || part.type !== 'tool_use') return null;
    const name = str(part.name);
    if (name === null) return null;
    const id = str(part.id);
    if (id !== null) {
      if (this.names.size >= MAX_TRACKED_CALLS) {
        const oldest = this.names.keys().next();
        if (oldest.done !== true) this.names.delete(oldest.value);
      }
      this.names.set(id, name);
    }
    const input = part.input;
    const known = isRecord(input) ? describeKnown(name, input) : null;
    return `${oneLine(known ?? describeUnknown(name, input))}\n`;
  }

  /** The capped answer to a call, or `null` for any other part. Ends in a newline. */
  noteToolResult(part: unknown): string | null {
    if (!isRecord(part) || part.type !== 'tool_result') return null;
    const id = str(part.tool_use_id);
    const name = id === null ? undefined : this.names.get(id);
    if (id !== null) this.names.delete(id);
    const status = part.is_error === true ? 'failed' : 'ok';
    const subject = name === undefined ? status : `${name} ${status}`;
    const body = resultText(part.content);
    if (body.trim() === '') return `  -> ${subject}, no output\n`;
    const { lines, total } = excerpt(body);
    const header = `  -> ${subject}, ${total} ${total === 1 ? 'line' : 'lines'}`;
    return [header, ...lines.map((line) => `     ${line}`)].join('\n') + '\n';
  }
}

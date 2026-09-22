import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolActivityLog, TOOL_LINE_MAX } from '../../src/agent/tool-activity';

/**
 * Defect 5 — the pane was blank because the runner forwarded prose only. The fixture is REAL:
 * records lifted verbatim (long strings truncated) from a live Claude Code run's transcript.
 */
const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/claude-stream-json-tool-activity.json'), 'utf8'),
) as { records: Array<{ type: string; message: { content: unknown[] } }> };

function partAt(index: number): unknown {
  return FIXTURE.records[index].message.content[0];
}

describe('ToolActivityLog — a tool call becomes one readable line', () => {
  it('turns a real Bash tool_use into one capped line naming the command', () => {
    const line = new ToolActivityLog().noteToolUse(partAt(1));
    expect(line).not.toBeNull();
    expect(line?.endsWith('\n')).toBe(true);
    const text = (line as string).trimEnd();
    expect(text.split('\n')).toHaveLength(1);
    expect(text.startsWith('Ran: cd /Users/')).toBe(true);
    expect(text.endsWith(' ...')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(TOOL_LINE_MAX);
  });

  it('names the file a real Write touched and never carries its body', () => {
    const line = new ToolActivityLog().noteToolUse(partAt(3)) as string;
    const input = (partAt(3) as { input: { content: string; file_path: string } }).input;
    expect(line.trimEnd()).toBe(`Wrote ${input.file_path}`);
    expect(line).not.toContain(input.content.slice(0, 40));
  });

  it('names the file a real Edit touched and never carries either side of the edit', () => {
    const part = partAt(5) as { input: { file_path: string; old_string: string } };
    const line = new ToolActivityLog().noteToolUse(part) as string;
    expect(line.trimEnd()).toBe(`Edited ${part.input.file_path}`);
    expect(line).not.toContain(part.input.old_string.slice(0, 30));
  });

  it('says who a real Agent delegation went to, not the prompt it carried', () => {
    const part = partAt(11) as { input: { prompt: string } };
    const line = new ToolActivityLog().noteToolUse(part) as string;
    expect(line.trimEnd()).toBe('Delegated to general-purpose: PM review of PLAN.md');
    expect(line).not.toContain(part.input.prompt.slice(0, 30));
  });

  it('names a real Skill load', () => {
    expect((new ToolActivityLog().noteToolUse(partAt(13)) as string).trimEnd()).toBe(
      'Loaded skill grace-analytics-events',
    );
  });

  it('reduces an unknown (MCP) tool to its name and its input KEYS, never their values', () => {
    const part = partAt(15) as { input: { args: string } };
    const line = new ToolActivityLog().noteToolUse(part) as string;
    expect(line.trimEnd()).toBe('Used mcp__platform-mcp__atlassian_call (tool, args)');
    expect(line).not.toContain('HB-1492');
  });

  it('ignores a text part — prose is forwarded by the runner, not by this log', () => {
    expect(new ToolActivityLog().noteToolUse(partAt(0))).toBeNull();
  });
});

describe('ToolActivityLog — a tool result is capped with a visible truncation marker', () => {
  it('caps a real 4000-character result to a head/tail excerpt and says what it cut', () => {
    const log = new ToolActivityLog();
    log.noteToolUse(partAt(1));
    const body = (partAt(2) as { content: string }).content;
    const line = log.noteToolResult(partAt(2)) as string;
    expect(line).not.toBeNull();
    expect(line.length).toBeLessThan(1000);
    expect(line.length).toBeLessThan(body.length / 4);
    expect(line).toMatch(/^ {2}-> Bash ok, \d+ lines\n/);
    expect(line).toMatch(/\n {5}\.\.\. \d+ lines omitted \.\.\.\n/);
    expect(line).toContain(body.split('\n')[0].slice(0, 20));
    expect(line.endsWith('\n')).toBe(true);
  });

  it('marks a real failed result as failed', () => {
    const log = new ToolActivityLog();
    log.noteToolUse(partAt(7));
    const line = log.noteToolResult(partAt(8)) as string;
    expect(line.startsWith('  -> AskUserQuestion failed,')).toBe(true);
  });

  it('reads a real array-shaped result through its text blocks', () => {
    const line = new ToolActivityLog().noteToolResult(partAt(10)) as string;
    expect(line).toContain('# Available Atlassian Tools');
    expect(line.length).toBeLessThan(1000);
  });

  it('says so when a result is empty rather than printing a blank line', () => {
    const line = new ToolActivityLog().noteToolResult({
      type: 'tool_result',
      tool_use_id: 'toolu_x',
      content: '',
    }) as string;
    expect(line.trimEnd()).toBe('  -> ok, no output');
  });

  it('ignores anything that is not a tool_result', () => {
    expect(new ToolActivityLog().noteToolResult(partAt(0))).toBeNull();
  });
});

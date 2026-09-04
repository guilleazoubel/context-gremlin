import { describe, expect, it } from 'vitest';
import type { AgentRunner } from '../../src/agent/agent-runner';

export interface ContractFixture {
  makeRunner(): AgentRunner; // fresh adapter bound to the fixture binary
  echoPrompt: string; // a prompt the fixture echoes
  expectedEcho: (prompt: string) => string; // e.g. p => `echo: ${p}`
  hangPrompt: string; // fixture never exits
  failPrompt: string; // fixture exits non-zero
}

export function describeAgentRunnerContract(name: string, fixture: ContractFixture): void {
  describe(`AgentRunner contract: ${name}`, () => {
    it('start returns distinct handle ids for two starts', async () => {
      const runner = fixture.makeRunner();
      const a = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const b = await runner.start({ sessionId: 'b', workingDirectory: process.cwd() });
      expect(a.id).not.toBe(b.id);
    });

    it('sendPrompt forwards the echoed text via onOutput stdout and resolves', async () => {
      const runner = fixture.makeRunner();
      const handle = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const stdout: string[] = [];
      runner.onOutput(handle, (chunk) => {
        if (chunk.stream === 'stdout') stdout.push(chunk.data);
      });
      await runner.sendPrompt(handle, fixture.echoPrompt);
      expect(stdout).toContain(fixture.expectedEcho(fixture.echoPrompt));
    });

    it('onExit fires exactly once per sendPrompt, with code 0 on success, and BEFORE sendPrompt resolves', async () => {
      const runner = fixture.makeRunner();
      const handle = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const exits: Array<{ code: number | null; signal: string | null }> = [];
      const order: string[] = [];
      runner.onExit(handle, (result) => {
        exits.push(result);
        order.push('exit');
      });
      await runner.sendPrompt(handle, fixture.echoPrompt);
      order.push('resolved');
      expect(exits).toHaveLength(1);
      expect(exits[0].code).toBe(0);
      expect(order).toEqual(['exit', 'resolved']);
    });

    it('failPrompt exits non-zero (or with a signal) but sendPrompt still resolves — never rejects on a failing turn', async () => {
      const runner = fixture.makeRunner();
      const handle = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const exits: Array<{ code: number | null; signal: string | null }> = [];
      runner.onExit(handle, (result) => exits.push(result));
      await expect(runner.sendPrompt(handle, fixture.failPrompt)).resolves.not.toThrow();
      expect(exits).toHaveLength(1);
      expect(exits[0].code !== 0 || exits[0].signal !== null).toBe(true);
    });

    it('hangPrompt + stop() resolves sendPrompt (signal or null code), and a further sendPrompt on the same handle still works', async () => {
      const runner = fixture.makeRunner();
      const handle = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const exits: Array<{ code: number | null; signal: string | null }> = [];
      runner.onExit(handle, (result) => exits.push(result));
      const pending = runner.sendPrompt(handle, fixture.hangPrompt);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runner.stop(handle);
      await expect(pending).resolves.not.toThrow();
      expect(exits).toHaveLength(1);
      expect(exits[0].signal !== null || exits[0].code === null).toBe(true);

      const stdout: string[] = [];
      runner.onOutput(handle, (chunk) => {
        if (chunk.stream === 'stdout') stdout.push(chunk.data);
      });
      await runner.sendPrompt(handle, fixture.echoPrompt);
      expect(stdout).toContain(fixture.expectedEcho(fixture.echoPrompt));
    });

    it('multiple onOutput and onExit listeners on the same handle all fire', async () => {
      const runner = fixture.makeRunner();
      const handle = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const outA: unknown[] = [];
      const outB: unknown[] = [];
      const exitA: unknown[] = [];
      const exitB: unknown[] = [];
      runner.onOutput(handle, (chunk) => outA.push(chunk));
      runner.onOutput(handle, (chunk) => outB.push(chunk));
      runner.onExit(handle, (result) => exitA.push(result));
      runner.onExit(handle, (result) => exitB.push(result));
      await runner.sendPrompt(handle, fixture.echoPrompt);
      expect(outA.length).toBeGreaterThan(0);
      expect(outB.length).toBeGreaterThan(0);
      expect(exitA).toHaveLength(1);
      expect(exitB).toHaveLength(1);
    });

    it('getResumeId is defined after a successful turn, and start({ resumeId }) seeds it before any prompt is sent', async () => {
      const runner = fixture.makeRunner();
      const seeded = await runner.start({ sessionId: 'a', workingDirectory: process.cwd(), resumeId: 'seed-id' });
      expect(runner.getResumeId?.(seeded)).toBe('seed-id');

      const fresh = await runner.start({ sessionId: 'b', workingDirectory: process.cwd() });
      expect(runner.getResumeId?.(fresh)).toBeUndefined();
      await runner.sendPrompt(fresh, fixture.echoPrompt);
      expect(runner.getResumeId?.(fresh)).toBeDefined();
    });

    it('a READ_STDIN-style prompt exits 0 — the CLI is spawned with stdin closed, not left open (the Phase 2a hang regression)', async () => {
      const runner = fixture.makeRunner();
      const handle = await runner.start({ sessionId: 'a', workingDirectory: process.cwd() });
      const exits: Array<{ code: number | null; signal: string | null }> = [];
      runner.onExit(handle, (result) => exits.push(result));
      await runner.sendPrompt(handle, 'READ_STDIN');
      expect(exits).toEqual([{ code: 0, signal: null }]);
    });

    it('an unknown handle throws an error whose name ends with UnknownAgentHandleError', async () => {
      const runner = fixture.makeRunner();
      const fake = { id: 'does-not-exist' };
      try {
        await runner.sendPrompt(fake, 'x');
        expect.unreachable('sendPrompt should have thrown for an unknown handle');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name.endsWith('UnknownAgentHandleError')).toBe(true);
      }
    });
  });
}

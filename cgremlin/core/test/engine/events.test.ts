import { describe, expect, it } from 'vitest';
import { EngineEvents } from '../../src/engine/events';

describe('EngineEvents', () => {
  it('delivers to subscribers of the type only and supports unsubscribe', () => {
    const ev = new EngineEvents();
    const got: string[] = [];
    const off = ev.on('run.output', (p) => got.push(p.chunk.data));
    ev.on('run.started', () => got.push('started'));
    ev.emit('run.output', { sessionId: 's', stage: 'review', chunk: { stream: 'stdout', data: 'a' } });
    off();
    ev.emit('run.output', { sessionId: 's', stage: 'review', chunk: { stream: 'stdout', data: 'b' } });
    expect(got).toEqual(['a']);
  });
  it('a throwing subscriber does not prevent later subscribers from receiving the event', () => {
    const ev = new EngineEvents();
    let second = 0;
    ev.on('run.started', () => { throw new Error('boom'); });
    ev.on('run.started', () => { second += 1; });
    ev.emit('run.started', { session: {} as never, stage: 'review' });
    expect(second).toBe(1);
  });
});

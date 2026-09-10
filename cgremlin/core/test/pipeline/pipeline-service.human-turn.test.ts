import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CORE_ROOT = path.resolve(__dirname, '../..');
const INVARIANT_FIXTURE = path.join(CORE_ROOT, 'test/fixtures/pipeline-service-locking-invariant.txt');
const PIPELINE_SERVICE = path.join(CORE_ROOT, 'src/pipeline/pipeline-service.ts');

describe('MG-A9 locking-invariant-unchanged', () => {
  it('(a) pipeline-service.ts lines 1-14 are byte-identical to the committed pre-Phase-7 fixture', async () => {
    const expected = await readFile(INVARIANT_FIXTURE, 'utf8');
    const actual = (await readFile(PIPELINE_SERVICE, 'utf8')).split('\n').slice(0, 14).join('\n');
    // The fixture was captured with `sed -n '1,14p'`, which emits a trailing newline.
    expect(`${actual}\n`).toBe(expected);
  });
});

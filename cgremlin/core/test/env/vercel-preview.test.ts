import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseVercelPreviewComment, pickPreviewProject, previewUrlWithBypass } from '../../src/env/vercel-preview';

const capture = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/gh/pr-comments-vercel.json'), 'utf8'),
) as {
  comments: { author: { login: string }; body: string }[];
};
const bodies = capture.comments.map((c) => c.body);
const vercelBodies = capture.comments.filter((c) => c.author.login === 'vercel').map((c) => c.body);

function encode(payload: unknown): string {
  return `[vc]: #hash:${Buffer.from(JSON.stringify(payload)).toString('base64')}\nsome trailing text`;
}
const oneProject = { isMonorepo: false, type: 'github', projects: [
  { name: 'p', projectId: 'prj_1', rootDirectory: null, inspectorUrl: 'https://vercel.com/s/p/1', previewUrl: 'p-git-b.example.com', nextCommitStatus: 'DEPLOYED', liveFeedback: { resolved: 0, unresolved: 0, total: 0, link: '' } },
] };

describe('parseVercelPreviewComment', () => {
  it('decodes the real grace-frontend comment into its four projects', () => {
    const projects = parseVercelPreviewComment(bodies);
    expect(projects.map((p) => p.name).sort()).toEqual(
      ['grace-frontend-dev', 'grace-frontend-storybook', 'grace-ops', 'grace-portal'],
    );
    const dev = projects.find((p) => p.name === 'grace-frontend-dev')!;
    expect(dev.previewUrl).toMatch(/^grace-frontend-dev-git-.+\.preview\.findcare\.dev\.aplaceformom\.com$/);
    expect(dev.inspectorUrl).toMatch(/^https:\/\/vercel\.com\/grace-0118bc61\/grace-frontend-dev\//);
    expect(dev.nextCommitStatus).toBe('DEPLOYED');
  });
  it('ignores the blanked non-vercel bodies', () => {
    expect(parseVercelPreviewComment(vercelBodies)).toEqual(parseVercelPreviewComment(bodies));
  });
  it('accepts a null previewUrl', () => {
    const nulled = { ...oneProject, projects: [{ ...oneProject.projects[0], previewUrl: null, nextCommitStatus: 'IGNORED' }] };
    expect(parseVercelPreviewComment([encode(nulled)])[0].previewUrl).toBeNull();
  });
  it('skips the "Deployment failed for project …" comment variant', () => {
    expect(parseVercelPreviewComment(['Deployment failed for project [grace-frontend-storybook](https://vercel.com/x) …'])).toEqual([]);
  });
  it('returns [] when no body carries the marker', () => {
    expect(parseVercelPreviewComment(['just a comment', ''])).toEqual([]);
  });
  it('returns [] for no bodies at all', () => {
    expect(parseVercelPreviewComment([])).toEqual([]);
  });
  it('skips a body whose base64 is not decodable JSON and keeps a later valid one', () => {
    expect(parseVercelPreviewComment(['[vc]: #h:!!!!not-base64-json!!!!', encode(oneProject)]).map((p) => p.name)).toEqual(['p']);
  });
  it('skips a payload that decodes but fails the schema', () => {
    expect(parseVercelPreviewComment([encode({ isMonorepo: true, type: 'github', projects: [{ name: 'x' }] })])).toEqual([]);
  });
  it('only reads the marker at the start of a line', () => {
    expect(parseVercelPreviewComment([`prefix [vc]: #h:${Buffer.from('{}').toString('base64')}`])).toEqual([]);
  });
  it('tolerates missing base64 padding', () => {
    const raw = Buffer.from(JSON.stringify(oneProject)).toString('base64').replace(/=+$/, '');
    expect(parseVercelPreviewComment([`[vc]: #h:${raw}`]).map((p) => p.name)).toEqual(['p']);
  });
  it('takes the first marker-bearing body when several exist', () => {
    const second = { ...oneProject, projects: [{ ...oneProject.projects[0], name: 'q' }] };
    expect(parseVercelPreviewComment([encode(oneProject), encode(second)]).map((p) => p.name)).toEqual(['p']);
  });
});

describe('pickPreviewProject', () => {
  it('finds by exact name', () => {
    expect(pickPreviewProject(parseVercelPreviewComment(bodies), 'grace-portal')?.name).toBe('grace-portal');
  });
  it('is case sensitive and returns null for an unknown name', () => {
    const projects = parseVercelPreviewComment(bodies);
    expect(pickPreviewProject(projects, 'Grace-Portal')).toBeNull();
    expect(pickPreviewProject(projects, 'nope')).toBeNull();
  });
  it('returns null for an empty project list', () => {
    expect(pickPreviewProject([], 'p')).toBeNull();
  });
});

describe('previewUrlWithBypass', () => {
  it('builds the legacy query-param form and encodes the secret', () => {
    expect(previewUrlWithBypass('host.example.com', 'a b&c')).toBe(
      'https://host.example.com/?x-vercel-protection-bypass=a%20b%26c&x-vercel-set-bypass-cookie=true',
    );
  });
});

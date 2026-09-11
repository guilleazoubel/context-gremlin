/**
 * MG-B7, the renderer half (R40).
 *
 * The Item tab renders *artifact bodies* with a bundled `markdown-it` configured `html: false`,
 * and *every other string* — a PR title, a Jira comment author, an error — through one
 * `escapeHtml`. Both halves are asserted here over the XSS corpus R40 names, plus the verbatim
 * `REVIEW.md` contract sample as a golden file.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, escapeAttribute } from '../src/model/escape-html';
import { MARKDOWN_OPTIONS, renderArtifact } from '../src/webview/markdown';

const CORPUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[x](javascript:alert(1))',
  '<iframe src="https://evil.example"></iframe>',
  '<!-- a comment that contains --> and keeps going -->',
  '```\n</script><script>alert(1)</script>\n```',
  '<svg onload=alert(1)>',
  '[click](  JaVaScRiPt:alert(1)  )',
];

const NON_MARKDOWN = [
  'Fix <script>alert(1)</script> in the parser',
  'jane" onmouseover="alert(1)',
  "o'brien & sons <b>",
];

/**
 * "Inert" is about *markup*, not about the characters: escaped text is allowed to read
 * `onerror=` or `javascript:`, which is exactly what "rendered as text" means. So these look for
 * a real tag, a real attribute inside a tag, and a real `href`.
 */
function inert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<svg/i);
  expect(html).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i);
  expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
}

describe('MG-B7 the artifact renderer is configured html:false, linkify:true', () => {
  it('pins the two options the security argument rests on', () => {
    expect(MARKDOWN_OPTIONS.html).toBe(false);
    expect(MARKDOWN_OPTIONS.linkify).toBe(true);
  });

  it('renders every XSS-corpus entry inert, as escaped text', () => {
    for (const source of CORPUS) {
      const html = renderArtifact(source);
      inert(html);
    }
    expect(renderArtifact('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('linkifies a bare URL but never a javascript: one', () => {
    expect(renderArtifact('see https://github.com/acme/web/pull/1')).toContain(
      '<a href="https://github.com/acme/web/pull/1"',
    );
    inert(renderArtifact('[x](javascript:alert(1))'));
  });
});

describe('MG-B7 every non-markdown string goes through escapeHtml', () => {
  it('escapes the five characters that matter, and is safe in an attribute', () => {
    for (const value of NON_MARKDOWN) {
      inert(`<div>${escapeHtml(value)}</div>`);
      // An escaped attribute value cannot close its own quote, open a tag or start a new
      // attribute — which is the property, rather than the absence of the characters.
      expect(escapeAttribute(value)).not.toMatch(/["'<>]/);
    }
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('keeps a PR title and a Jira comment author inert inside real row markup', () => {
    const title = 'Fix <script>alert(1)</script>';
    const author = 'jane" onmouseover="alert(1)';
    const row = `<div class="row" title="${escapeAttribute(title)}"><span>${escapeHtml(
      title,
    )}</span><span>@${escapeHtml(author)}</span></div>`;
    inert(row.replace(/title="[^"]*"/, 'title="x"'));
    expect(escapeAttribute(author)).not.toMatch(/["'<>]/);
    expect(row).toContain('&lt;script&gt;');
  });

  it('assigns innerHTML nowhere in src/webview except through the renderer', () => {
    const dir = path.resolve(__dirname, '../src/webview');
    const offenders: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      fs.readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/\.innerHTML\s*=/.test(line)) return;
          // The one legal assignment is the rendered artifact body; it is tagged so this grep
          // can see the difference between "markdown-it output" and "a string I built".
          if (line.includes('SAFE_HTML')) return;
          offenders.push(`${name}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('R40 the REVIEW.md contract sample (golden)', () => {
  const sample = fs.readFileSync(
    path.resolve(__dirname, 'support/fixtures/review-sample.md'),
    'utf8',
  );
  const html = renderArtifact(sample);

  it('keeps the table and its four severity rows', () => {
    expect(html).toContain('<table>');
    for (const severity of ['🔴 Critical', '🔧 Maintainability', '📋 PM/AC', '🎨 Design']) {
      expect(html).toContain(severity);
    }
    // Five rows in the findings table (header + four severities) and two in the history table.
    expect((html.match(/<tr>/g) ?? []).length).toBe(7);
  });

  it('keeps the external link intact', () => {
    expect(html).toContain('<a href="https://github.com/');
  });

  it('renders the <a id="fN"></a> anchors as TEXT, the accepted html:false trade', () => {
    expect(html).toContain('&lt;a id=&quot;f1&quot;&gt;');
    expect(html).not.toContain('<a id="f1">');
  });

  it('still resolves the footnote references to in-page links the tab implements itself', () => {
    // `[1](#f1)` is a markdown link and survives; the *target* is synthesised by the tab, since
    // the anchor element itself is now text.
    expect(html).toContain('href="#f1"');
    expect(html).toContain('<span id="f1">');
    inert(html);
  });
});

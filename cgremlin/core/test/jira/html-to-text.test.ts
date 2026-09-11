import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../src/jira/html-to-text';

describe('htmlToText (R33) — the renderedFields flattener', () => {
  it('paragraphs and <br> become newlines', () => {
    expect(htmlToText('<p>one</p><p>two<br>three</p>')).toBe('one\n\ntwo\nthree');
  });

  it('<ul>/<li> become "- " lines', () => {
    expect(htmlToText('<p>list:</p><ul><li>alpha</li><li>beta</li></ul>')).toBe('list:\n\n- alpha\n- beta');
  });

  it('<ol>/<li> become numbered lines', () => {
    expect(htmlToText('<ol><li>first</li><li>second</li></ol>')).toBe('1. first\n2. second');
  });

  it('<pre><code> becomes a fenced block', () => {
    expect(htmlToText('<p>see</p><pre><code>const a = 1;</code></pre>')).toBe('see\n\n```\nconst a = 1;\n```');
  });

  it('markup inside a code block is left alone, not treated as markup', () => {
    expect(htmlToText('<pre><code>&lt;b&gt;not bold&lt;/b&gt;</code></pre>')).toBe('```\n<b>not bold</b>\n```');
  });

  it('<a href> becomes "text (href)"', () => {
    expect(htmlToText('<p>see <a href="https://example.com/x">the docs</a> please</p>')).toBe(
      'see the docs (https://example.com/x) please',
    );
  });

  it('<img> becomes "[image: alt]"', () => {
    expect(htmlToText('<p><img src="a.png" alt="a diagram"></p>')).toBe('[image: a diagram]');
    expect(htmlToText('<p><img src="a.png"></p>')).toBe('[image]');
  });

  it('decodes &amp;, &lt;, &#39; and &nbsp;', () => {
    expect(htmlToText('<p>a &amp; b &lt; c &#39;d&#39; e&nbsp;f</p>')).toBe("a & b < c 'd' e f");
  });

  it('decodes a double-encoded entity EXACTLY once', () => {
    expect(htmlToText('<p>&amp;lt;</p>')).toBe('&lt;');
  });

  it('an unterminated tag does not eat the rest of the document', () => {
    expect(htmlToText('<p>before <b unterminated and then more text')).toBe('before <b unterminated and then more text');
  });

  it('strips inline markup and keeps its text', () => {
    expect(htmlToText('<p><strong>bold</strong> and <em>italic</em></p>')).toBe('bold and italic');
  });

  it('returns the empty string for empty or whitespace-only input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p>   </p>')).toBe('');
  });

  // R33 — a <script>/<style> body is not prose. Stripping the TAGS alone left
  // the JavaScript or the CSS behind as "text" in a brief and in the tab.
  it('drops a <script> body, not just its tags', () => {
    expect(htmlToText('<p>before</p><script>var x = 1 < 2;</script><p>after</p>')).toBe('before\n\nafter');
  });

  it('drops a <style> body, not just its tags', () => {
    expect(htmlToText('<p>before</p><style>.a { color: red; }</style><p>after</p>')).toBe('before\n\nafter');
  });

  it('drops both, case-insensitively and with attributes on the opening tag', () => {
    const html = [
      '<h1>Title</h1>',
      '<STYLE type="text/css" media="screen">body { margin: 0 }</STYLE>',
      '<p>Real content.</p>',
      '<SCRIPT type="text/javascript">alert("nope"); if (a && b) { c(); }</SCRIPT>',
      '<p>More content.</p>',
    ].join('');
    expect(htmlToText(html)).toBe('Title\n\nReal content.\n\nMore content.');
  });

  it('an UNTERMINATED script or style drops everything to the end of the input', () => {
    expect(htmlToText('<p>before</p><script>var x = 1;<p>after</p>')).toBe('before');
    expect(htmlToText('<p>before</p><style media="all">.a { color: red; }<p>after</p>')).toBe('before');
  });
});

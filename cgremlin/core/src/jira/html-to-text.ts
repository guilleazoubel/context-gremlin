/**
 * R33 — the ONE place Jira's `renderedFields` HTML becomes text. No HTML ever
 * crosses the port, the API or `postMessage`, so no identifier under
 * `src/jira` ends in the four letters MG-10 greps for — the description
 * reaches a caller as `descriptionText` and nothing else. There is also no
 * ADF walker: `renderedFields` is
 * Atlassian doing that work for us, and text is all a brief and a webview
 * paragraph need.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes HTML entities EXACTLY once, so `&amp;lt;` becomes `&lt;` and stops there. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Matches a COMPLETE tag only. An unterminated `<b unterminated` has no `>`,
 * so it never matches and survives as literal text instead of eating the rest
 * of the document.
 */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const PRE_BLOCK = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi;

/**
 * `<script>` and `<style>` hold raw text, not markup: stripping only their
 * TAGS leaves the JavaScript or the CSS behind as prose in a brief and in the
 * tab. Both are dropped body and all, case-insensitively and whatever
 * attributes the opening tag carries.
 */
const RAW_TEXT_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** No closing tag: a browser swallows the rest of the document, and so do we. */
const UNTERMINATED_RAW_TEXT = /<(script|style)\b[^>]*>[\s\S]*$/i;

function attr(rawAttrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(rawAttrs);
  if (!match) return null;
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
}

/** An ASCII placeholder for an extracted code block: no control characters, and short of a document that literally contains this string it cannot collide. */
const FENCE_SENTINEL = '@@CGREMLIN_FENCE@@';

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'section']);

/** Everything HTML treats as horizontal whitespace, the non-breaking space included. */
const HORIZONTAL_WHITESPACE = /[^\S\n]+/g;

export function htmlToText(html: string): string {
  // Code blocks are pulled out first and re-inserted at the end, so the
  // whitespace collapsing and tag stripping below can never touch them.
  // Raw-text elements go first, so a `<pre>` or a stray `<` inside one can
  // never reach the extraction and the tag walk below.
  const withoutRawText = html.replace(RAW_TEXT_BLOCK, ' ').replace(UNTERMINATED_RAW_TEXT, ' ');

  const fences: string[] = [];
  const withoutPre = withoutRawText.replace(PRE_BLOCK, (_match, inner: string) => {
    const body = decodeEntities(inner.replace(/<\/?code\b[^>]*>/gi, '')).replace(/^\n+|\s+$/g, '');
    fences.push(body);
    return ` ${FENCE_SENTINEL}${fences.length - 1}${FENCE_SENTINEL} `;
  });

  const out: string[] = [];
  const lists: Array<{ ordered: boolean; n: number }> = [];
  let pendingHref: string | null = null;
  let cursor = 0;

  TAG.lastIndex = 0;
  for (let match = TAG.exec(withoutPre); match !== null; match = TAG.exec(withoutPre)) {
    out.push(decodeEntities(withoutPre.slice(cursor, match.index)));
    cursor = match.index + match[0].length;
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const rawAttrs = match[3];

    if (name === 'br') {
      out.push('\n');
    } else if (name === 'img' && !closing) {
      const alt = attr(rawAttrs, 'alt');
      out.push(alt !== null && alt !== '' ? `[image: ${alt}]` : '[image]');
    } else if (name === 'a') {
      if (closing) {
        if (pendingHref !== null) out.push(` (${pendingHref})`);
        pendingHref = null;
      } else {
        pendingHref = attr(rawAttrs, 'href');
      }
    } else if (name === 'ul' || name === 'ol') {
      if (closing) lists.pop();
      else lists.push({ ordered: name === 'ol', n: 0 });
      out.push('\n');
    } else if (name === 'li') {
      if (!closing) {
        const list = lists[lists.length - 1];
        if (list !== undefined && list.ordered) {
          list.n += 1;
          out.push(`\n${list.n}. `);
        } else {
          out.push('\n- ');
        }
      }
    } else if (name === 'tr' && closing) {
      out.push('\n');
    } else if (BLOCK_TAGS.has(name)) {
      out.push('\n\n');
    }
  }
  out.push(decodeEntities(withoutPre.slice(cursor)));

  let text = out.join('');
  text = text.replace(HORIZONTAL_WHITESPACE, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(
    new RegExp(` ?${FENCE_SENTINEL}(\\d+)${FENCE_SENTINEL} ?`, 'g'),
    (_m, i: string) => `\n\`\`\`\n${fences[Number(i)]}\n\`\`\`\n`,
  );
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

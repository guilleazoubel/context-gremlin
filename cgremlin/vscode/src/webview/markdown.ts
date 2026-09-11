/**
 * The artifact renderer: bundled `markdown-it`, configured so raw HTML in an artifact is text
 * (R40).
 *
 * `html: false` is the whole security argument — a `REVIEW.md` that contains `<script>` renders
 * as the characters `<script>`. The accepted cost is that the review contract's
 * `<a id="fN"></a>` anchors render as text too, so the in-page footnote *targets* are synthesised
 * here instead; the `[N](#fN)` references are ordinary markdown links and need nothing.
 *
 * This module is DOM-free on purpose, so the renderer is unit-testable without a browser and
 * without the bundler having run (R62's spirit, applied to the renderer).
 */
import MarkdownIt from 'markdown-it';

export const MARKDOWN_OPTIONS = {
  /** R40: raw HTML is TEXT. Never flip this. */
  html: false,
  linkify: true,
  breaks: false,
} as const;

const md = new MarkdownIt(MARKDOWN_OPTIONS);

/**
 * The escaped form markdown-it leaves behind for `<a id="fN"></a>`. Matching it is how the tab
 * puts the link target back without re-enabling raw HTML.
 */
const ESCAPED_ANCHOR = /&lt;a id=&quot;([A-Za-z][\w-]*)&quot;&gt;&lt;\/a&gt;/g;

/** Rendered markdown, safe to assign as SAFE_HTML (MG-B7). */
export function renderArtifact(source: string): string {
  const rendered = md.render(source);
  return rendered.replace(
    ESCAPED_ANCHOR,
    (match, id: string) => `<span id="${id}"></span>${match}`,
  );
}

/** One paragraph of markdown, for a Jira comment body or a description. */
export function renderInline(source: string): string {
  return renderArtifact(source);
}

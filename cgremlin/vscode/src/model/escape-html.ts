/**
 * The one escaper (R40).
 *
 * Every string that is **not** an artifact body — a PR title, an author login, a branch, a Jira
 * summary, a status, an assignee, a comment author, an error — goes through this before it
 * reaches the DOM, or through `textContent`. Nothing else is allowed to build markup out of
 * engine data; MG-B7 is the guard, and the whole point of having exactly one function is that the
 * guard has one thing to look for.
 *
 * Pure module — no editor API (MG-B1).
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text content. `&` first is implicit: the character class is matched once, left to right. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * An attribute value. Identical to {@link escapeHtml} today — both quote styles and both angle
 * brackets are covered — and separate only so a call site says which position it is escaping for,
 * which is what stops the classic "escaped for text, interpolated into an attribute" mistake.
 */
export function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

/** `http:`/`https:` only. Anything else — `javascript:`, `file:`, `data:` — is refused. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

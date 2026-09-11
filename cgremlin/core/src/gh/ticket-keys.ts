/**
 * R4/R46 — the MULTI-key extractor, beside (never replacing) the single-match
 * `extractTicketKey` of `./ticket-key`, which stays load-bearing at
 * `review-session-factory.ts`.
 *
 * R46: an empty `projectKeys` means ticket linking is DISABLED, not
 * unfiltered — the bare regex happily links `SHA-256`, `UTF-8` and `PR-123`,
 * and a wrong merge puts two unrelated PRs on one row. The engine says so
 * once per process, not once per PR.
 */
const TICKET_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export const TICKET_LINKING_DISABLED_MESSAGE = 'ticket linking disabled: set jira.projectKeys in core.json';

let warnedLinkingDisabled = false;

/** Test-only: the once-per-process latch is process state, so a test that asserts it must clear it. */
export function resetTicketLinkingWarningForTests(): void {
  warnedLinkingDisabled = false;
}

export function extractTicketKeys(
  text: string,
  projectKeys: readonly string[],
  opts?: { warn?: (line: string) => void },
): string[] {
  if (projectKeys.length === 0) {
    if (!warnedLinkingDisabled) {
      warnedLinkingDisabled = true;
      (opts?.warn ?? ((line: string) => console.warn(line)))(TICKET_LINKING_DISABLED_MESSAGE);
    }
    return [];
  }
  const allowed = new Set(projectKeys);
  const found: string[] = [];
  TICKET_KEY_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(TICKET_KEY_PATTERN)) {
    const key = match[1];
    const prefix = key.slice(0, key.lastIndexOf('-'));
    if (!allowed.has(prefix)) continue;
    if (!found.includes(key)) found.push(key);
  }
  return found;
}

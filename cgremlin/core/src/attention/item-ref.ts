import { ValidationError } from '../api/validation';

/** The one place the item-ref grammar lives (R18). */
export const ITEM_SOURCES = ['pr', 'session'] as const; // future: 'jira', 'slack'
export type ItemSource = (typeof ITEM_SOURCES)[number];

/**
 * Canonical, parseable, stable across restarts: 'session:<id>' |
 * 'pr:<owner>/<repo>#<n>' (future 'jira:<KEY>' | 'slack:<channel>/<ts>').
 * This is also the acknowledgement key.
 */
export type ItemRef = string;

export function sessionRef(id: string): ItemRef {
  return `session:${id}`;
}

/** THE one PR-ref formatter. There is no second `prAckKey` — the ack key IS the ItemRef. */
export function prRef(repo: string, number: number): ItemRef {
  return `pr:${repo}#${number}`;
}

const PR_REF_BODY = /^([^/\s]+\/[^/\s#]+)#([1-9][0-9]*)$/;

/**
 * Splits on the FIRST ':' and treats the remainder as opaque. That is
 * unambiguous because no member of ITEM_SOURCES contains ':', NOT because a
 * session id cannot: `assertSafeSessionId` (`src/engine/session-store.ts:26-30`)
 * rejects only '', '/', '\\', '.' and '..', so a ':' in a session id is legal
 * and round-trips through here.
 */
export function parseItemRef(
  ref: string,
): { source: 'session'; id: string } | { source: 'pr'; repo: string; number: number } {
  const separator = ref.indexOf(':');
  if (separator === -1) {
    throw new ValidationError(`Invalid item ref '${ref}': expected '<source>:<id>'`);
  }
  const source = ref.slice(0, separator);
  const rest = ref.slice(separator + 1);
  if (source === 'session') {
    if (rest.length === 0) {
      throw new ValidationError(`Invalid item ref '${ref}': empty session id`);
    }
    return { source: 'session', id: rest };
  }
  if (source === 'pr') {
    const match = PR_REF_BODY.exec(rest);
    if (!match) {
      throw new ValidationError(`Invalid item ref '${ref}': expected 'pr:<owner>/<repo>#<number>'`);
    }
    return { source: 'pr', repo: match[1], number: Number(match[2]) };
  }
  throw new ValidationError(
    `Invalid item ref '${ref}': unknown source '${source}' (expected one of ${ITEM_SOURCES.join(', ')})`,
  );
}

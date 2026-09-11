import { ValidationError } from '../api/validation';

/**
 * R14/R25 — the opaque id a work item carries in its BODY. The same grammar
 * as `ItemRef`, three forms: `ticket:<KEY>`, `pr:<owner>/<repo>#<n>`,
 * `session:<id>`.
 *
 * The id never reaches a request PATH: `handleRequest` splits `url.pathname`
 * and never decodes a segment, so `pr:owner/repo#12` in a path would need
 * `%2F`/`%23` handling no other route performs. Paths are segmented instead
 * (`/items/pr/:owner/:repo/:number`), and this pair exists so the two
 * representations can never drift.
 */
export type WorkItemId = string;

export type ParsedWorkItemId =
  | { kind: 'ticket'; key: string }
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'session'; id: string };

export function workItemIdOf(parsed: ParsedWorkItemId): WorkItemId {
  if (parsed.kind === 'ticket') return `ticket:${parsed.key}`;
  if (parsed.kind === 'pr') return `pr:${parsed.repo}#${parsed.number}`;
  return `session:${parsed.id}`;
}

const PR_ID_BODY = /^([^/\s]+\/[^/\s#]+)#([1-9][0-9]*)$/;
const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;
/** The same single-path-segment rule `validation.ts` applies to a ticket key: no '/', no '..'. */
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._-]+$/;

export function parseWorkItemId(id: string): ParsedWorkItemId {
  const separator = id.indexOf(':');
  if (separator === -1) {
    throw new ValidationError(`Invalid work item id '${id}': expected '<kind>:<id>'`);
  }
  const kind = id.slice(0, separator);
  const rest = id.slice(separator + 1);
  if (kind === 'ticket') {
    if (!TICKET_KEY.test(rest)) {
      throw new ValidationError(`Invalid work item id '${id}': expected 'ticket:<KEY-123>'`);
    }
    return { kind: 'ticket', key: rest };
  }
  if (kind === 'pr') {
    const match = PR_ID_BODY.exec(rest);
    if (!match) {
      throw new ValidationError(`Invalid work item id '${id}': expected 'pr:<owner>/<repo>#<number>'`);
    }
    return { kind: 'pr', repo: match[1], number: Number(match[2]) };
  }
  if (kind === 'session') {
    if (rest.length === 0) {
      throw new ValidationError(`Invalid work item id '${id}': empty session id`);
    }
    return { kind: 'session', id: rest };
  }
  throw new ValidationError(
    `Invalid work item id '${id}': unknown kind '${kind}' (expected one of ticket, pr, session)`,
  );
}

/**
 * R14 — the SEGMENTED path form. `handleRequest` splits `url.pathname` and
 * never decodes a segment, so an opaque `pr:owner/repo#12` in a path would
 * need `%2F`/`%23` handling no other route performs. This is the one place
 * a path is turned back into an addressed item, so the two representations
 * cannot drift.
 *
 * `parts` is everything AFTER the `items` segment. Returns the address plus
 * whatever trailing segments (`agents`, `ack`) the caller must route on.
 */
export function parseWorkItemPath(
  parts: readonly string[],
): { parsed: ParsedWorkItemId; rest: string[] } | null {
  if (parts[0] === 'ticket' && parts.length >= 2) {
    return { parsed: parseWorkItemId(`ticket:${parts[1]}`), rest: parts.slice(2) };
  }
  if (parts[0] === 'pr' && parts.length >= 4) {
    return { parsed: parseWorkItemId(`pr:${parts[1]}/${parts[2]}#${parts[3]}`), rest: parts.slice(4) };
  }
  if (parts[0] === 'session' && parts.length >= 2) {
    // R25: a session id reaching a path is validated by the SAME
    // single-path-segment rule every other id component uses
    // (`validation.ts:54`) before it is used.
    if (!SAFE_PATH_COMPONENT.test(parts[1])) {
      throw new ValidationError(`Invalid session id '${parts[1]}' in path: expected [A-Za-z0-9._-]+`);
    }
    return { parsed: parseWorkItemId(`session:${parts[1]}`), rest: parts.slice(2) };
  }
  return null;
}

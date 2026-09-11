import type { CoreConfig } from '../../config/core-config';
import { JiraRestSource } from '../../jira/jira-rest-source';
import type { JiraSource } from '../../jira/jira-source';
import { loadConfigOrFail, type CommandIO } from '../command-io';

export interface CheckJiraDeps {
  /** Injected in tests. In production this is the real REST adapter. */
  makeJiraSource?: (cfg: CoreConfig) => JiraSource;
}

function defaultSource(cfg: CoreConfig): JiraSource {
  const jira = cfg.jira;
  if (jira === undefined || jira.apiToken === undefined) {
    throw new Error('no jira configured');
  }
  return new JiraRestSource({
    baseUrl: jira.baseUrl ?? jira.siteUrl,
    siteUrl: jira.siteUrl,
    email: jira.email,
    apiToken: jira.apiToken,
    timeoutMs: jira.timeoutMs,
    maxResults: jira.maxResults,
    extraFields: jira.extraFields,
  });
}

/**
 * `cgremlin-core config check-jira` — the one credential check, backed by the
 * same `GET /rest/api/3/myself` the legacy tool used
 * (`bin/cgremlin:1894-1901`). On failure it prints **Jira's own wording**,
 * because that is the only thing that distinguishes a wrong token from a
 * revoked one from a captcha challenge. The token itself is never printed.
 */
export async function checkJiraCommand(
  _args: readonly string[],
  io: CommandIO,
  deps: CheckJiraDeps = {},
): Promise<number> {
  const cfg = await loadConfigOrFail(io);
  if (cfg === null) return 1;

  // R35: no `jira` block, or a block whose token is absent or empty, are the
  // same state to a user — "I haven't set this up" — and neither is an error.
  if (cfg.jira === undefined || cfg.jira.apiToken === undefined || cfg.jira.apiToken === '') {
    io.stdout.write('no jira configured (add a jira block with an apiToken to core.json)\n');
    return 0;
  }

  try {
    const me = await (deps.makeJiraSource ?? defaultSource)(cfg).whoami();
    io.stdout.write(`Jira: ${me.displayName} (${me.accountId})\n`);
    if (me.emailAddress !== undefined) io.stdout.write(`Email: ${me.emailAddress}\n`);
    io.stdout.write(`Site: ${cfg.jira.siteUrl}\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

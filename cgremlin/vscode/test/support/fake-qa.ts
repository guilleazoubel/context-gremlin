/**
 * A stand-in for the shared QA environment, on `127.0.0.1:0`.
 *
 * Phase 15's `EnvironmentService.qaHealth` GETs `<qa.url><qa.healthPath>` before the automatic
 * leg creates anything (R83), and the manual path degrades on the same answer (§9). Both are
 * pointed HERE. **No integration test may ever reach a real QA deployment**: `qa.url` in the
 * seeded config is always one of the two loopback URLs this module hands out.
 *
 * `deadUrl` is loopback port 1 — privileged, so no unprivileged process in the suite can ever
 * bind it, and a connection to it is refused at once. An ephemeral port that happened to be free
 * when the stub started is NOT good enough: the next test's server can take it, and then the
 * "unreachable" case quietly becomes a reachable one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeQa {
  /** A URL that answers 200 on every path. */
  url: string;
  /**
   * Phase 16 — what `/api/health` says QA is SERVING. `null` (the default) is
   * a QA with no version endpoint worth reading: the body carries no
   * `version`, so the engine degrades to the merge-keyed behaviour and every
   * test written before Phase 16 keeps its meaning.
   */
  setVersion(sha: string | null): void;
  /** A loopback URL nothing can listen on — `qaHealth` fails against it, always. */
  deadUrl: string;
  /** Every request the engine made to the stub, in order. */
  requests(): readonly { method: string; pathname: string }[];
  stop(): Promise<void>;
}

export async function startFakeQa(): Promise<FakeQa> {
  const seen: { method: string; pathname: string }[] = [];
  let version: string | null = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://qa.invalid');
    seen.push({ method: req.method ?? 'GET', pathname: url.pathname });
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(version === null ? { status: 'ok' } : { status: 'ok', version }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>fake qa</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const live = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${live}`,
    deadUrl: 'http://127.0.0.1:1',
    setVersion: (sha) => {
      version = sha;
    },
    requests: () => seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

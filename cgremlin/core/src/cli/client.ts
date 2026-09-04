import http from 'node:http';

export interface HttpResult {
  status: number;
  body: unknown;
}

/** A thin socket client: no engine imports beyond the response shape it hands back raw. */
export function request(socketPath: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsedBody: unknown;
          if (raw) {
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              parsedBody = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsedBody });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

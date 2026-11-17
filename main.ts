// github-forge — a GitHub-compatible git forge, single process, stdlib only.
//
// Lifecycle (make.fun harness): listen on an ephemeral port, register it at
// $MAKEFUN_ENV_URL/register, poll $MAKEFUN_ENV_URL/done until done, exit 0.
// GET /healthz answers 200 {"ok": true} with no auth.

import { createApp } from './app.ts';
import { envFetchJson, isTruthy } from './util.ts';

const SERVER_PORT = 0;

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(SERVER_PORT, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const payload = { port };
  if (envUrl !== '') {
    try {
      await envFetchJson(`${envUrl}/register`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      });
    } catch {
      // The harness may not be reachable in local runs; keep serving anyway.
    }
    let done = false;
    let attempts = 0;
    while (!done && attempts < 2400) {
      attempts += 1;
      try {
        const status = await envFetchJson<{ done?: boolean }>(`${envUrl}/done`);
        done = status.done === true;
      } catch {
        done = false;
      }
      if (!done) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (isTruthy(process.env.MAKEFUN_LOCAL)) {
    await new Promise<void>(() => {
      // Local smoke runs stay up until killed; nothing else to do.
    });
  }
  server.close(() => process.exit(0));
  process.exit(0);
}

main().catch(() => process.exit(1));

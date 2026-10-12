import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { resolveIssuers } from './auth.js';
import { createApp } from './app.js';
import { createHttp } from './http.js';

// Last-resort logging. Handlers are written not to throw; if one does, keep serving
// (state lives in SQLite) rather than drop every collaborator's connection.
process.on('unhandledRejection', (e) => console.error('[fatal?] unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('[fatal?] uncaught exception:', e));

const config = loadConfig();
// A database delivered by POST /api/admin/import (staging refreshed from a copy) replaces the live one before it is opened.
if (config.dataDir !== ':memory:') {
  const pending = join(config.dataDir, 'docs.db.import');
  if (existsSync(pending)) {
    for (const suffix of ['', '-wal', '-shm']) { const f = join(config.dataDir, `docs.db${suffix}`); if (existsSync(f)) rmSync(f); }
    renameSync(pending, join(config.dataDir, 'docs.db'));
    console.log('[import] installed the imported database');
  }
}
const issuers = await resolveIssuers(config.devIssuer ? config.issuers.filter((i) => i.publicKey) : config.issuers);
const app = createApp(config, issuers);
const { server, realtime, mcpl } = createHttp(app);

server.listen(config.port, config.host, () => {
  console.log(`Anima Docs on ${config.origin} (listening ${config.host}:${config.port}); audience "${config.audience}"; issuers: ${[...app.issuers.keys()].join(', ') || 'none'}`);
  if (app.devIssuer) console.log(`⚠ development issuer "${app.devIssuer.domain}" is ON: anyone who can reach this server can sign in as anyone.`);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    for (const ws of mcpl.clients) ws.terminate();
    realtime.close();
    const done = () => { app.close(); process.exit(0); };
    server.close(done);
    setTimeout(done, 2000).unref();
  });
}

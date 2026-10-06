// Service container: everything a request handler or MCPL session needs.

import { join } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { openDatabase, type DB } from './db.js';
import { Principals } from './principals.js';
import { Documents } from './documents.js';
import { Comments } from './comments.js';
import { Media } from './media.js';
import { Attention } from './attention.js';
import { DevIssuer, JtiCache, publicKeyFromString, verifyAid1, type Identity } from './auth.js';
import type { Config } from './config.js';

export interface App {
  config: Config;
  db: DB;
  principals: Principals;
  docs: Documents;
  comments: Comments;
  media: Media;
  attention: Attention;
  issuers: Map<string, KeyObject>;
  devIssuer: DevIssuer | null;
  jti: JtiCache;
  verify(token: string): Identity;
  close(): void;
}

export function createApp(config: Config, issuers: Map<string, KeyObject>, opts: { attentionLog?: (m: string) => void; commentSettleMs?: number } = {}): App {
  const db = openDatabase(config.dataDir === ':memory:' ? ':memory:' : join(config.dataDir, 'docs.db'));
  const homeIssuer = config.devIssuer ?? config.issuers[0]?.domain ?? 'id.animalabs.ai';
  const principals = new Principals(db, { admins: config.admins, homeIssuer });
  const docs = new Documents(db, principals, { defaultAccess: config.defaultAccess });
  const comments = new Comments(db, docs, principals);
  const media = new Media(db, config.dataDir === ':memory:' ? join(process.cwd(), 'data') : config.dataDir);
  const attention = new Attention(db, docs, comments, principals, { log: opts.attentionLog, commentSettleMs: opts.commentSettleMs });
  let devIssuer: DevIssuer | null = null;
  if (config.devIssuer) {
    devIssuer = new DevIssuer(config.devIssuer, config.dataDir === ':memory:' ? join(process.cwd(), 'data') : config.dataDir);
    issuers.set(config.devIssuer, publicKeyFromString(devIssuer.publicKey));
  }
  const verifierOpts = { audience: config.audience, issuers, requiredScopes: config.requiredScopes };
  // Housekeeping: unload idle documents (gc is off, so loaded docs carry history), prune old state.
  const maintenance = setInterval(() => {
    try {
      docs.sweep();
      attention.prune();
      db.prepare('DELETE FROM used_jti WHERE expires_at < ?').run(Date.now());
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      pruneLinksAndGuests(db);
    } catch (e) { console.error('[maintenance]', (e as Error).message); }
  }, 5 * 60_000);
  maintenance.unref();
  return {
    config, db, principals, docs, comments, media, attention, issuers, devIssuer,
    jti: new JtiCache(),
    verify: (token: string) => verifyAid1(token, verifierOpts),
    close() { clearInterval(maintenance); attention.close(); db.close(); },
  };
}

/**
 * Holders of links that ended over a week ago, and guests who left no trace
 * (no session, no writing, no comment activity) for a month, are forgotten.
 */
export function pruneLinksAndGuests(db: DB, now = Date.now()) {
  const week = now - 7 * 86400_000, month = now - 30 * 86400_000;
  db.prepare(`DELETE FROM link_holders WHERE link_id IN (SELECT id FROM doc_links
    WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR (expires_at IS NOT NULL AND expires_at < ?))`).run(week, week);
  db.prepare(`DELETE FROM principals WHERE kind = 'guest' AND last_seen < ?
    AND sub NOT IN (SELECT sub FROM sessions) AND sub NOT IN (SELECT author_sub FROM comments)
    AND sub NOT IN (SELECT actor_sub FROM comment_events) AND sub NOT IN (SELECT sub FROM yclients)
    AND sub NOT IN (SELECT sub FROM doc_deletions) AND sub NOT IN (SELECT sub FROM doc_activity)`).run(month);
  db.prepare(`DELETE FROM link_holders WHERE sub LIKE 'guest:%' AND sub NOT IN (SELECT sub FROM principals)`).run();
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { Principals } from '../src/principals.js';
import { Documents } from '../src/documents.js';
import { Comments } from '../src/comments.js';
import { mintAid1, type Identity, type PrincipalKind } from '../src/auth.js';

export function tmpDir(prefix = 'adocs-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function core() {
  const db = openDatabase(':memory:');
  const principals = new Principals(db, { admins: [], homeIssuer: 'test.local' });
  const docs = new Documents(db, principals, { defaultAccess: 'restricted' });
  const comments = new Comments(db, docs, principals);
  const actor = (name: string, kind: PrincipalKind = 'human') => principals.admit(identity(name, kind), kind === 'human' ? 'web' : 'mcpl');
  return { db, principals, docs, comments, actor };
}

export function identity(name: string, kind: PrincipalKind = 'human', issuer = 'test.local'): Identity {
  const sub = kind === 'human' ? `human:test:${name.toLowerCase()}` : `${kind}:${name.toLowerCase()}@${issuer}`;
  return { sub, name, kind, issuer, scopes: [], claims: {}, exp: Date.now() / 1000 + 3600 };
}

export function testIssuer(domain = 'test.local') {
  const { privateKey } = generateKeyPairSync('ed25519');
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = `ed25519:${spki.subarray(12).toString('base64url')}`;
  const mint = (name: string, kind: PrincipalKind, audience = 'docs', extra: { scopes?: string[]; ttl?: number; iat?: number } = {}) => mintAid1(privateKey, {
    iss: domain,
    sub: kind === 'human' ? `human:test:${name.toLowerCase()}` : `${kind}:${name.toLowerCase()}@${domain}`,
    kind, name, aud: audience, scopes: extra.scopes ?? [], ttlSeconds: extra.ttl ?? 3600, iat: extra.iat,
  });
  return { domain, publicKey, privateKey, mint };
}

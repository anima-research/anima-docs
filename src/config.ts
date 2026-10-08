// Runtime configuration, read once from the environment.

export interface IssuerTrust {
  /** Issuer domain as it appears in the token's `iss`. */
  domain: string;
  /** `ed25519:<b64url raw 32 bytes>`; fetched from the well-known document when absent. */
  publicKey?: string;
}

export interface Config {
  port: number;
  host: string;
  /** Public origin of the web UI, e.g. https://docs.animalabs.ai. */
  origin: string;
  dataDir: string;
  /** Audience id this service accepts (`aud` claim). */
  audience: string;
  /** Trusted issuers. The first one is the home issuer used for human sign-in. */
  issuers: IssuerTrust[];
  /** Scopes every principal must carry (empty = audience check only). */
  requiredScopes: string[];
  /** Principals (subs) that are workspace admins regardless of token scopes. */
  admins: string[];
  /** Default general access for new documents. */
  defaultAccess: 'restricted' | 'viewer' | 'commenter' | 'editor';
  /**
   * Local development issuer. When set, the server holds an ed25519 key for this
   * domain, trusts it, and serves /dev/login for minting tokens. Never enable in
   * production: anyone who can reach the server can sign in as anyone.
   */
  devIssuer: string | null;
  /** Proxies in front that append to X-Forwarded-For (1 behind Railway's edge; 0 when exposed directly). */
  trustedProxyHops: number;
  /** A client-address header the proxy sets and overwrites (Railway: x-real-ip); preferred over X-Forwarded-For. */
  clientIpHeader: string | null;
  /** How often open sockets' roles are re-derived (link expiry has no event). */
  roleSweepMs: number;
  /**
   * Browser sessions: signed in for this many days since you last used the
   * service (renewed at most daily), but never longer than `sessionMaxDays`
   * after signing in (then sign in again, so roles are re-read).
   */
  sessionDays: number;
  sessionMaxDays: number;
  /** Recorded history: the pause that ends a stretch of people's / an agent's editing, and the longest stretch. */
  history: { idleMs: number; agentIdleMs: number; maxMs: number };
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 7364);
  const host = env.DOCS_HOST ?? '127.0.0.1';
  const origin = (env.DOCS_ORIGIN ?? `http://localhost:${port}`).replace(/\/$/, '');
  // DOCS_ISSUERS="id.animalabs.ai=ed25519:...,other.tld" — key optional per issuer.
  const issuers: IssuerTrust[] = list(env.DOCS_ISSUERS ?? env.DOCS_ISSUER ?? 'id.animalabs.ai').map((entry) => {
    const eq = entry.indexOf('=');
    return eq < 0 ? { domain: entry } : { domain: entry.slice(0, eq), publicKey: entry.slice(eq + 1) };
  });
  if (env.DOCS_ISSUER_KEY && issuers[0] && !issuers[0].publicKey) issuers[0].publicKey = env.DOCS_ISSUER_KEY;
  const defaultAccess = (env.DOCS_DEFAULT_ACCESS ?? 'restricted') as Config['defaultAccess'];
  if (!['restricted', 'viewer', 'commenter', 'editor'].includes(defaultAccess)) {
    throw new Error(`DOCS_DEFAULT_ACCESS must be restricted|viewer|commenter|editor, got ${defaultAccess}`);
  }
  const devIssuer = env.DOCS_DEV_ISSUER?.trim() || null;
  if (devIssuer && origin.startsWith('https:') && env.DOCS_DEV_ALLOW_HTTPS !== '1') {
    throw new Error('DOCS_DEV_ISSUER is for local development; refusing to start on an https origin.');
  }
  return {
    port,
    host,
    origin,
    dataDir: env.DOCS_DATA_DIR ?? 'data',
    audience: env.DOCS_AUDIENCE ?? 'docs',
    issuers,
    requiredScopes: list(env.DOCS_REQUIRED_SCOPES),
    admins: list(env.DOCS_ADMINS),
    defaultAccess,
    devIssuer,
    roleSweepMs: Math.max(100, Number(env.DOCS_ROLE_SWEEP_MS ?? 10_000) || 10_000),
    sessionDays: Math.max(1, Number(env.DOCS_SESSION_DAYS ?? 30) || 30),
    sessionMaxDays: Math.max(1, Number(env.DOCS_SESSION_MAX_DAYS ?? 90) || 90),
    history: {
      idleMs: Math.max(50, Number(env.DOCS_HISTORY_IDLE_MS ?? 180_000) || 180_000),
      agentIdleMs: Math.max(50, Number(env.DOCS_HISTORY_AGENT_IDLE_MS ?? 60_000) || 60_000),
      maxMs: Math.max(100, Number(env.DOCS_HISTORY_MAX_MS ?? 600_000) || 600_000),
    },
    clientIpHeader: env.DOCS_CLIENT_IP_HEADER?.trim() || null,
    trustedProxyHops: env.DOCS_TRUSTED_PROXY_HOPS !== undefined ? Math.max(0, Number(env.DOCS_TRUSTED_PROXY_HOPS) || 0) : origin.startsWith('https:') ? 1 : 0,
  };
}

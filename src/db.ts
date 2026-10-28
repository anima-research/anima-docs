// SQLite schema. One file, WAL mode, one process.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA_VERSION = 11;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version < 1) {
    db.exec(`
      -- Every principal the service has seen, human or agent, keyed by durable sub.
      CREATE TABLE principals (
        sub         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('human','agent','service')),
        issuer      TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','blocked')),
        color       TEXT NOT NULL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL
      );
      CREATE INDEX principals_name ON principals(name COLLATE NOCASE);

      CREATE TABLE sessions (
        token_hash  TEXT PRIMARY KEY,
        sub         TEXT NOT NULL REFERENCES principals(sub),
        identity    TEXT NOT NULL,            -- JSON Identity captured at sign-in
        expires_at  INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE used_jti (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);

      CREATE TABLE documents (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        owner_sub       TEXT NOT NULL REFERENCES principals(sub),
        general_access  TEXT NOT NULL DEFAULT 'restricted'
                          CHECK (general_access IN ('restricted','viewer','commenter','editor')),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        rev             INTEGER NOT NULL DEFAULT 0,
        deleted_at      INTEGER
      );
      CREATE TABLE doc_acl (
        doc_id      TEXT NOT NULL REFERENCES documents(id),
        sub         TEXT NOT NULL REFERENCES principals(sub),
        role        TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor','owner')),
        granted_by  TEXT NOT NULL,
        granted_at  INTEGER NOT NULL,
        PRIMARY KEY (doc_id, sub)
      );
      CREATE INDEX doc_acl_sub ON doc_acl(sub);

      -- Yjs update log. Compaction folds a prefix into doc_state.
      CREATE TABLE doc_updates (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id      TEXT NOT NULL REFERENCES documents(id),
        data        BLOB NOT NULL,
        sub         TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX doc_updates_doc ON doc_updates(doc_id, id);
      CREATE TABLE doc_state (
        doc_id      TEXT PRIMARY KEY REFERENCES documents(id),
        data        BLOB NOT NULL,
        upto_id     INTEGER NOT NULL
      );
      -- Who deleted which Yjs items (Yjs itself records only inserters).
      CREATE TABLE doc_deletions (
        doc_id      TEXT NOT NULL,
        client      INTEGER NOT NULL,
        clock       INTEGER NOT NULL,
        len         INTEGER NOT NULL,
        sub         TEXT NOT NULL,
        at          INTEGER NOT NULL
      );
      CREATE INDEX doc_deletions_doc ON doc_deletions(doc_id, client, clock);
      -- Yjs client id → principal, per document. A client id belongs to one principal, forever.
      CREATE TABLE yclients (
        doc_id      TEXT NOT NULL,
        client      INTEGER NOT NULL,
        sub         TEXT NOT NULL,
        server_side INTEGER NOT NULL DEFAULT 0, -- 1 = the id this service edits with on sub's behalf
        first_seen  INTEGER NOT NULL,
        PRIMARY KEY (doc_id, client)
      );
      CREATE INDEX yclients_sub ON yclients(doc_id, sub, server_side);
      -- Coarse activity (per principal per document per minute) for the activity feed.
      CREATE TABLE doc_activity (
        doc_id      TEXT NOT NULL,
        sub         TEXT NOT NULL,
        minute      INTEGER NOT NULL,
        added       INTEGER NOT NULL DEFAULT 0,
        removed     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (doc_id, sub, minute)
      );

      CREATE TABLE comments (
        id            TEXT PRIMARY KEY,
        doc_id        TEXT NOT NULL REFERENCES documents(id),
        thread_id     TEXT NOT NULL,          -- root comment id (= id for roots)
        author_sub    TEXT NOT NULL REFERENCES principals(sub),
        body          TEXT NOT NULL,
        mentions      TEXT NOT NULL DEFAULT '[]',   -- JSON array of subs
        assignee_sub  TEXT,
        anchor_start  BLOB,                   -- Yjs relative positions (roots only)
        anchor_end    BLOB,
        quote         TEXT,
        resolved_at   INTEGER,
        resolved_by   TEXT,
        created_at    INTEGER NOT NULL,
        edited_at     INTEGER,
        deleted_at    INTEGER
      );
      CREATE INDEX comments_doc ON comments(doc_id, thread_id, created_at);
      -- Append-only comment activity; agents' comment baselines are positions in it.
      CREATE TABLE comment_events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id      TEXT NOT NULL,
        comment_id  TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        kind        TEXT NOT NULL,           -- created|replied|edited|deleted|resolved|reopened|assigned
        actor_sub   TEXT NOT NULL,
        at          INTEGER NOT NULL
      );
      CREATE INDEX comment_events_doc ON comment_events(doc_id, seq);

      CREATE TABLE media (
        id            TEXT PRIMARY KEY,       -- sha256 prefix + extension
        mime          TEXT NOT NULL,
        size          INTEGER NOT NULL,
        width         INTEGER,
        height        INTEGER,
        uploader_sub  TEXT NOT NULL,
        doc_id        TEXT,
        created_at    INTEGER NOT NULL,
        name          TEXT                    -- original file name (v8)
      );

      -- Agent attention: per-agent wake gates (doc_id '*' = defaults for every document).
      CREATE TABLE watches (
        sub         TEXT NOT NULL,
        doc_id      TEXT NOT NULL,
        settings    TEXT NOT NULL,           -- JSON WatchSettings
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (sub, doc_id)
      );
      -- What each agent has seen: a Yjs snapshot (text) and a comment_events seq.
      CREATE TABLE baselines (
        sub         TEXT NOT NULL,
        doc_id      TEXT NOT NULL,
        snapshot    BLOB NOT NULL,
        comment_seq INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (sub, doc_id)
      );
      -- Occurrences already delivered to an agent as addressed events (kept out of digests).
      CREATE TABLE addressed (
        sub         TEXT NOT NULL,
        comment_id  TEXT NOT NULL,
        doc_id      TEXT NOT NULL,
        reason      TEXT NOT NULL,
        level       TEXT NOT NULL DEFAULT 'wake',
        delivered   INTEGER NOT NULL DEFAULT 0,  -- 1 while a version that reached a host has not been retracted there
        at          INTEGER NOT NULL,
        PRIMARY KEY (sub, comment_id)
      );

      -- Addressed events awaiting a push-capable connection of their recipient.
      CREATE TABLE outbox (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sub         TEXT NOT NULL,
        doc_id      TEXT,                    -- for purging when access is revoked
        subject     TEXT NOT NULL,           -- coalescing key; one pending entry per subject
        event       TEXT NOT NULL,           -- JSON push/event params
        created_at  INTEGER NOT NULL,
        UNIQUE (sub, subject)
      );

      CREATE TABLE versions (
        id          TEXT PRIMARY KEY,
        doc_id      TEXT NOT NULL REFERENCES documents(id),
        name        TEXT NOT NULL,
        snapshot    BLOB NOT NULL,
        rev         INTEGER NOT NULL,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX versions_doc ON versions(doc_id, created_at);
    `);
    db.pragma('user_version = 1');
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 2) {
    // v2: guests (people who arrive through a share link without signing in)
    // and share links. Widening a CHECK constraint means rebuilding the table.
    // foreign_keys can only change outside a transaction; everything else is one transaction.
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
      BEGIN;
      CREATE TABLE principals_v2 (
        sub         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('human','agent','service','guest')),
        issuer      TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','blocked')),
        color       TEXT NOT NULL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL
      );
      INSERT INTO principals_v2 SELECT sub, name, kind, issuer, role, color, first_seen, last_seen FROM principals;
      DROP TABLE principals;
      ALTER TABLE principals_v2 RENAME TO principals;
      CREATE INDEX principals_name ON principals(name COLLATE NOCASE);

      -- Share links: a secret URL that grants a role on one document. Access
      -- through a link lasts only while the link is active.
      CREATE TABLE doc_links (
        id          TEXT PRIMARY KEY,
        doc_id      TEXT NOT NULL REFERENCES documents(id),
        key         TEXT NOT NULL UNIQUE,     -- the secret in the URL
        role        TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor')),
        audience    TEXT NOT NULL CHECK (audience IN ('anyone','members')),
        label       TEXT,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER,
        revoked_at  INTEGER,
        revoked_by  TEXT
      );
      CREATE INDEX doc_links_doc ON doc_links(doc_id);
      -- Who has opened which link (their access through it ends when it does).
      CREATE TABLE link_holders (
        link_id     TEXT NOT NULL REFERENCES doc_links(id),
        sub         TEXT NOT NULL,
        doc_id      TEXT NOT NULL,
        first_at    INTEGER NOT NULL,
        last_at     INTEGER NOT NULL,
        PRIMARY KEY (link_id, sub)
      );
      CREATE INDEX link_holders_sub ON link_holders(sub, doc_id);
    `);
      const broken = db.pragma('foreign_key_check') as unknown[];
      if (broken.length) throw new Error(`schema v2 migration would leave ${broken.length} dangling references`);
      db.pragma('user_version = 2');
      db.exec('COMMIT');
    } catch (e) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw e;
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 3) {
    // v3: suggestions. A suggestion is a comment thread whose root proposes
    // replacing its anchored text (the original, kept in full) with sugg_text.
    // An empty original is an insertion at a point anchor.
    db.transaction(() => {
      const have = new Set((db.pragma('table_info(comments)') as { name: string }[]).map((c) => c.name));
      if (!have.has('sugg_text')) db.exec('ALTER TABLE comments ADD COLUMN sugg_text TEXT');
      if (!have.has('sugg_orig')) db.exec('ALTER TABLE comments ADD COLUMN sugg_orig TEXT');
      if (!have.has('sugg_status')) db.exec("ALTER TABLE comments ADD COLUMN sugg_status TEXT CHECK (sugg_status IN ('open','accepted','rejected'))");
      db.pragma('user_version = 3');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 4) {
    // v4: which version of each suggestion an agent has been shown, so accepting
    // by id can't apply a revision it never saw.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sugg_seen (
          sub         TEXT NOT NULL,
          comment_id  TEXT NOT NULL,
          version     TEXT NOT NULL,
          at          INTEGER NOT NULL,
          PRIMARY KEY (sub, comment_id)
        );
      `);
      db.pragma('user_version = 4');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 5) {
    // v5: automatic history. A checkpoint is the document's state (a Yjs
    // snapshot) at the end of a stretch of editing; its change is the
    // difference from the one before. See history.ts.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          seq         INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id      TEXT NOT NULL,
          start_at    INTEGER NOT NULL,
          end_at      INTEGER NOT NULL,
          snapshot    BLOB NOT NULL,
          authors     TEXT NOT NULL DEFAULT '[]',
          added       INTEGER NOT NULL DEFAULT 0,
          removed     INTEGER NOT NULL DEFAULT 0,
          label       TEXT,
          kind        TEXT NOT NULL DEFAULT 'edit' CHECK (kind IN ('edit','baseline'))
        );
        CREATE INDEX IF NOT EXISTS checkpoints_doc ON checkpoints(doc_id, seq);
      `);
      db.pragma('user_version = 5');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 6) {
    // v6: the node model. A document is a node; a node with an empty title is a
    // section (reachable only through the documents that mount it). A mount is
    // a line `{{node:<id>}}` in a parent's body; `mounts` is the index of those
    // lines. Navigation trees are placements (edges with no effect on bodies).
    // A comment may end in another node than it starts in.
    db.transaction(() => {
      const docCols = new Set((db.pragma('table_info(documents)') as { name: string }[]).map((c) => c.name));
      if (!docCols.has('type')) db.exec("ALTER TABLE documents ADD COLUMN type TEXT NOT NULL DEFAULT 'markdown'");
      const cCols = new Set((db.pragma('table_info(comments)') as { name: string }[]).map((c) => c.name));
      if (!cCols.has('end_doc_id')) db.exec('ALTER TABLE comments ADD COLUMN end_doc_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS mounts (
          parent_id   TEXT NOT NULL,
          child_id    TEXT NOT NULL,
          nth         INTEGER NOT NULL,
          PRIMARY KEY (parent_id, child_id, nth)
        );
        CREATE INDEX IF NOT EXISTS mounts_child ON mounts(child_id);
        -- Which revision of each body the mount index reflects.
        CREATE TABLE IF NOT EXISTS mount_scan (
          doc_id      TEXT PRIMARY KEY,
          rev         INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mount_log (
          seq         INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id   TEXT NOT NULL,
          child_id    TEXT NOT NULL,
          op          TEXT NOT NULL CHECK (op IN ('mount','unmount')),
          sub         TEXT,
          at          INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS mount_log_parent ON mount_log(parent_id, seq);
        CREATE TABLE IF NOT EXISTS trees (
          root_id     TEXT PRIMARY KEY,
          created_by  TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS placements (
          tree_id     TEXT NOT NULL,
          parent_id   TEXT NOT NULL,
          child_id    TEXT NOT NULL,
          ord         REAL NOT NULL,
          derived     INTEGER NOT NULL DEFAULT 0,
          placed_by   TEXT,
          at          INTEGER NOT NULL,
          PRIMARY KEY (tree_id, parent_id, child_id)
        );
        CREATE INDEX IF NOT EXISTS placements_child ON placements(child_id);
        CREATE TABLE IF NOT EXISTS placement_exclusions (
          tree_id     TEXT NOT NULL,
          parent_id   TEXT NOT NULL,
          child_id    TEXT NOT NULL,
          by          TEXT,
          at          INTEGER NOT NULL,
          PRIMARY KEY (tree_id, parent_id, child_id)
        );
      `);
      db.pragma('user_version = 6');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 7) {
    // v7: wikis. A tree can be published (public or members-only) under a slug
    // and an optional custom domain, with a theme; a mount may be an aside
    // (a sidebar panel in the wiki).
    db.transaction(() => {
      const t = new Set((db.pragma('table_info(trees)') as { name: string }[]).map((c) => c.name));
      if (!t.has('published')) db.exec("ALTER TABLE trees ADD COLUMN published TEXT NOT NULL DEFAULT 'off' CHECK (published IN ('off','public','members'))");
      if (!t.has('slug')) db.exec('ALTER TABLE trees ADD COLUMN slug TEXT');
      if (!t.has('domain')) db.exec('ALTER TABLE trees ADD COLUMN domain TEXT');
      if (!t.has('theme')) db.exec("ALTER TABLE trees ADD COLUMN theme TEXT NOT NULL DEFAULT '{}'");
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS trees_slug ON trees(slug); CREATE UNIQUE INDEX IF NOT EXISTS trees_domain ON trees(domain);');
      const m = new Set((db.pragma('table_info(mounts)') as { name: string }[]).map((c) => c.name));
      if (!m.has('role')) db.exec("ALTER TABLE mounts ADD COLUMN role TEXT NOT NULL DEFAULT 'inline'");
      db.pragma('user_version = 7');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 8) {
    // v8: any file can be uploaded (audio, video, documents…): media keeps the original file name.
    db.transaction(() => {
      const m = new Set((db.pragma('table_info(media)') as { name: string }[]).map((c) => c.name));
      if (m.size && !m.has('name')) db.exec('ALTER TABLE media ADD COLUMN name TEXT');
      db.pragma('user_version = 8');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 9) {
    // v9: files attached to a document (an HTML page's data, scripts, styles; a markdown companion), by path.
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS doc_files (
        doc_id      TEXT NOT NULL,
        path        TEXT NOT NULL,
        media_id    TEXT NOT NULL,
        mime        TEXT NOT NULL,
        size        INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        updated_by  TEXT NOT NULL,
        PRIMARY KEY (doc_id, path)
      )`);
      db.pragma('user_version = 9');
    })();
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 10) {
    // v10: groups — a principal of kind 'group' with members; shares and mentions name it like anyone.
    // Widening the kind CHECK means rebuilding principals (the v2 precedent); foreign_keys only changes outside a transaction.
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
      BEGIN;
      CREATE TABLE principals_v3 (
        sub         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL CHECK (kind IN ('human','agent','service','guest','group')),
        issuer      TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','blocked')),
        color       TEXT NOT NULL,
        first_seen  INTEGER NOT NULL,
        last_seen   INTEGER NOT NULL
      );
      INSERT INTO principals_v3 SELECT sub, name, kind, issuer, role, color, first_seen, last_seen FROM principals;
      DROP TABLE principals;
      ALTER TABLE principals_v3 RENAME TO principals;
      CREATE INDEX principals_name ON principals(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS groups (
        sub         TEXT PRIMARY KEY REFERENCES principals(sub),
        owner_sub   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_sub   TEXT NOT NULL REFERENCES groups(sub),
        sub         TEXT NOT NULL REFERENCES principals(sub),
        added_by    TEXT NOT NULL,
        added_at    INTEGER NOT NULL,
        PRIMARY KEY (group_sub, sub)
      );
      CREATE INDEX IF NOT EXISTS group_members_sub ON group_members(sub);
      PRAGMA user_version = 10;
      COMMIT;
      `);
    } finally { db.pragma('foreign_keys = ON'); }
  }
  if ((db.pragma('user_version', { simple: true }) as number) < 11) {
    // v11: share links for a group — audience 'group', with the group the link is for. Widening the CHECK
    // means rebuilding doc_links (link_holders references it by name, which the rename keeps).
    db.pragma('foreign_keys = OFF');
    try {
      db.exec(`
      BEGIN;
      CREATE TABLE doc_links_v2 (
        id          TEXT PRIMARY KEY,
        doc_id      TEXT NOT NULL REFERENCES documents(id),
        key         TEXT NOT NULL UNIQUE,
        role        TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor')),
        audience    TEXT NOT NULL CHECK (audience IN ('anyone','members','group')),
        group_sub   TEXT,
        label       TEXT,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER,
        revoked_at  INTEGER,
        revoked_by  TEXT
      );
      INSERT INTO doc_links_v2 (id, doc_id, key, role, audience, label, created_by, created_at, expires_at, revoked_at, revoked_by)
        SELECT id, doc_id, key, role, audience, label, created_by, created_at, expires_at, revoked_at, revoked_by FROM doc_links;
      DROP TABLE doc_links;
      ALTER TABLE doc_links_v2 RENAME TO doc_links;
      CREATE INDEX doc_links_doc ON doc_links(doc_id);
      PRAGMA user_version = 11;
      COMMIT;
      `);
    } finally { db.pragma('foreign_keys = ON'); }
  }
  return db;
}

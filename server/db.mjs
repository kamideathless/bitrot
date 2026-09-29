// Storage. node:sqlite ships with Node, so this is a real database with real
// prepared statements and no dependency to audit.
//
// Every query in the codebase goes through a statement prepared here with bound
// parameters — there is no string concatenation into SQL anywhere.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 4000;

CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id     TEXT    NOT NULL UNIQUE,
  recovery_hash TEXT    NOT NULL,
  recovery_salt TEXT    NOT NULL,
  display_name  TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  banned        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS sessions_expiry  ON sessions(expires_at);

-- The authoritative save. The browser copy is only ever a view of this.
CREATE TABLE IF NOT EXISTS saves (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  state      TEXT    NOT NULL,
  revision   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- One row per issued dive. The stat block is frozen here at issue time so a
-- submission cannot claim gear the account did not have when it started.
CREATE TABLE IF NOT EXISTS run_tickets (
  id          TEXT    PRIMARY KEY,
  account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seed        INTEGER NOT NULL,
  stats       TEXT    NOT NULL,
  shard_value REAL    NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tickets_account ON run_tickets(account_id);
CREATE INDEX IF NOT EXISTS tickets_expiry  ON run_tickets(expires_at);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT    NOT NULL UNIQUE REFERENCES run_tickets(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  rf         INTEGER NOT NULL,
  seconds    REAL    NOT NULL,
  sector     INTEGER NOT NULL,
  shards     INTEGER NOT NULL,
  rescues    INTEGER NOT NULL,
  defrags    INTEGER NOT NULL,
  verified_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_score   ON runs(score DESC);
CREATE INDEX IF NOT EXISTS runs_account ON runs(account_id, score DESC);
`;

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    const p = (sql) => db.prepare(sql);

    this.q = {
      insertAccount: p(`INSERT INTO accounts
        (public_id, recovery_hash, recovery_salt, display_name, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      accountByPublicId: p('SELECT * FROM accounts WHERE public_id = ?'),
      accountById: p('SELECT * FROM accounts WHERE id = ?'),
      touchAccount: p('UPDATE accounts SET last_seen_at = ? WHERE id = ?'),
      renameAccount: p('UPDATE accounts SET display_name = ? WHERE id = ?'),

      insertSession: p(`INSERT INTO sessions (token_hash, account_id, csrf, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`),
      sessionByHash: p('SELECT * FROM sessions WHERE token_hash = ?'),
      deleteSession: p('DELETE FROM sessions WHERE token_hash = ?'),
      deleteSessionsFor: p('DELETE FROM sessions WHERE account_id = ?'),
      purgeSessions: p('DELETE FROM sessions WHERE expires_at < ?'),

      insertSave: p('INSERT INTO saves (account_id, state, revision, updated_at) VALUES (?, ?, 1, ?)'),
      getSave: p('SELECT state, revision FROM saves WHERE account_id = ?'),
      updateSave: p('UPDATE saves SET state = ?, revision = revision + 1, updated_at = ? WHERE account_id = ?'),

      insertTicket: p(`INSERT INTO run_tickets
        (id, account_id, seed, stats, shard_value, issued_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      getTicket: p('SELECT * FROM run_tickets WHERE id = ?'),
      consumeTicket: p('UPDATE run_tickets SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL'),
      purgeTickets: p('DELETE FROM run_tickets WHERE expires_at < ? AND consumed_at IS NULL'),

      insertRun: p(`INSERT INTO runs
        (ticket_id, account_id, score, rf, seconds, sector, shards, rescues, defrags, verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      topRuns: p(`SELECT r.score, r.seconds, r.sector, r.rescues, r.verified_at, a.display_name, a.public_id
        FROM runs r JOIN accounts a ON a.id = r.account_id
        WHERE a.banned = 0
        ORDER BY r.score DESC, r.verified_at ASC
        LIMIT ?`),
      bestRunFor: p('SELECT MAX(score) AS score FROM runs WHERE account_id = ?'),
      rankOf: p('SELECT COUNT(*) + 1 AS rank FROM runs WHERE score > ?'),
      runCount: p('SELECT COUNT(*) AS n FROM runs'),
    };
  }

  /** Run `fn` inside a transaction, rolling back on any throw. */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** Delete expired sessions and unused tickets. Cheap; called periodically. */
  sweep(now = Date.now()) {
    this.q.purgeSessions.run(now);
    this.q.purgeTickets.run(now);
  }

  close() {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { NormalizedListing, SearchCriteria, SearchParams, Vote } from '~/types';
import type { ConsensusOutput } from './consensus';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  params TEXT NOT NULL,
  criteria TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS listings (
  search_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (search_id, id)
);
CREATE TABLE IF NOT EXISTS votes (
  search_id TEXT NOT NULL,
  lens TEXT NOT NULL,
  replica INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (search_id, lens, replica)
);
CREATE TABLE IF NOT EXISTS results (
  search_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
`;

export interface SearchRow {
  id: string;
  params: SearchParams;
  criteria?: SearchCriteria;
  status: string;
  createdAt: string;
}

export function openDb(dbPath = process.env.INMUEBLES_DB_PATH ?? '.data/inmuebles.db') {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertListing = db.prepare('INSERT OR REPLACE INTO listings (search_id, id, json) VALUES (?, ?, ?)');
  const savePoolTx = db.transaction((searchId: string, pool: NormalizedListing[]) => {
    for (const l of pool) insertListing.run(searchId, l.id, JSON.stringify(l));
  });

  return {
    createSearch(id: string, params: SearchParams) {
      db.prepare('INSERT INTO searches (id, params) VALUES (?, ?)').run(id, JSON.stringify(params));
    },
    setStatus(id: string, status: string) {
      db.prepare('UPDATE searches SET status = ? WHERE id = ?').run(status, id);
    },
    saveCriteria(id: string, criteria: SearchCriteria) {
      db.prepare('UPDATE searches SET criteria = ? WHERE id = ?').run(JSON.stringify(criteria), id);
    },
    getSearch(id: string): SearchRow | undefined {
      const row = db.prepare('SELECT * FROM searches WHERE id = ?').get(id) as
        | { id: string; params: string; criteria: string | null; status: string; created_at: string }
        | undefined;
      if (!row) return undefined;
      return {
        id: row.id,
        params: JSON.parse(row.params) as SearchParams,
        criteria: row.criteria ? (JSON.parse(row.criteria) as SearchCriteria) : undefined,
        status: row.status,
        createdAt: row.created_at,
      };
    },
    savePool(id: string, pool: NormalizedListing[]) {
      savePoolTx(id, pool);
    },
    getPool(id: string): NormalizedListing[] {
      const rows = db.prepare('SELECT json FROM listings WHERE search_id = ?').all(id) as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as NormalizedListing);
    },
    saveVote(id: string, vote: Vote) {
      db.prepare('INSERT OR REPLACE INTO votes (search_id, lens, replica, json) VALUES (?, ?, ?, ?)').run(
        id,
        vote.lens,
        vote.replica,
        JSON.stringify(vote),
      );
    },
    getVotes(id: string): Vote[] {
      const rows = db.prepare('SELECT json FROM votes WHERE search_id = ?').all(id) as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as Vote);
    },
    saveResults(id: string, output: ConsensusOutput) {
      db.prepare('INSERT OR REPLACE INTO results (search_id, json) VALUES (?, ?)').run(id, JSON.stringify(output));
    },
    getResults(id: string): ConsensusOutput | undefined {
      const row = db.prepare('SELECT json FROM results WHERE search_id = ?').get(id) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as ConsensusOutput) : undefined;
    },
    close() {
      db.close();
    },
  };
}

export type SearchDb = ReturnType<typeof openDb>;

let singleton: SearchDb | null = null;
/** Process-wide handle for API routes. */
export function getDb(): SearchDb {
  singleton ??= openDb();
  return singleton;
}

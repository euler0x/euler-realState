import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Evaluation, NormalizedListing, SearchCriteria, SearchOutput, SearchParams, SearchPhase } from '~/types';

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
CREATE TABLE IF NOT EXISTS evaluations (
  search_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  replica INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (search_id, listing_id, replica)
);
CREATE TABLE IF NOT EXISTS results (
  search_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasaciones (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL DEFAULT (datetime('now')),
  description TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT NOT NULL
);
`;

export interface SearchRow {
  id: string;
  params: SearchParams;
  criteria?: SearchCriteria;
  status: string;
  createdAt: string;
}

export interface TasacionGuardada {
  id: string;
  fecha: string;
  description: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface TasacionListItem {
  id: string;
  fecha: string;
  titulo: string;
  valorEstimadoUsd: number;
  confianza: string;
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

  const stmtCreateSearch = db.prepare('INSERT INTO searches (id, params) VALUES (?, ?)');
  const stmtSetStatus = db.prepare('UPDATE searches SET status = ? WHERE id = ?');
  const stmtSaveCriteria = db.prepare('UPDATE searches SET criteria = ? WHERE id = ?');
  const stmtGetSearch = db.prepare('SELECT * FROM searches WHERE id = ?');
  const stmtGetPool = db.prepare('SELECT json FROM listings WHERE search_id = ?');
  const stmtSaveEvaluation = db.prepare(
    'INSERT OR REPLACE INTO evaluations (search_id, listing_id, replica, json) VALUES (?, ?, ?, ?)',
  );
  const stmtGetEvaluations = db.prepare('SELECT json FROM evaluations WHERE search_id = ?');
  const stmtSaveResults = db.prepare('INSERT OR REPLACE INTO results (search_id, json) VALUES (?, ?)');
  const stmtGetResults = db.prepare('SELECT json FROM results WHERE search_id = ?');

  const stmtSaveTasacion = db.prepare(
    'INSERT OR REPLACE INTO tasaciones (id, description, input, result) VALUES (?, ?, ?, ?)',
  );
  const stmtGetTasacion = db.prepare('SELECT * FROM tasaciones WHERE id = ?');
  const stmtListTasaciones = db.prepare('SELECT id, fecha, input, result FROM tasaciones ORDER BY fecha DESC, id DESC');

  return {
    createSearch(id: string, params: SearchParams) {
      stmtCreateSearch.run(id, JSON.stringify(params));
    },
    setStatus(id: string, status: SearchPhase) {
      stmtSetStatus.run(status, id);
    },
    saveCriteria(id: string, criteria: SearchCriteria) {
      stmtSaveCriteria.run(JSON.stringify(criteria), id);
    },
    getSearch(id: string): SearchRow | undefined {
      const row = stmtGetSearch.get(id) as
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
      const rows = stmtGetPool.all(id) as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as NormalizedListing);
    },
    saveEvaluation(id: string, evaluation: Evaluation) {
      stmtSaveEvaluation.run(id, evaluation.listingId, evaluation.replica, JSON.stringify(evaluation));
    },
    getEvaluations(id: string): Evaluation[] {
      const rows = stmtGetEvaluations.all(id) as { json: string }[];
      return rows.map((r) => JSON.parse(r.json) as Evaluation);
    },
    saveResults(id: string, output: SearchOutput) {
      stmtSaveResults.run(id, JSON.stringify(output));
    },
    getResults(id: string): SearchOutput | undefined {
      const row = stmtGetResults.get(id) as { json: string } | undefined;
      return row ? (JSON.parse(row.json) as SearchOutput) : undefined;
    },
    saveTasacion(id: string, description: string, input: unknown, result: unknown) {
      stmtSaveTasacion.run(id, description, JSON.stringify(input), JSON.stringify(result));
    },
    getTasacion(id: string): TasacionGuardada | undefined {
      const row = stmtGetTasacion.get(id) as
        | { id: string; fecha: string; description: string; input: string; result: string }
        | undefined;
      if (!row) return undefined;
      return {
        ...row,
        input: JSON.parse(row.input) as Record<string, unknown>,
        result: JSON.parse(row.result) as Record<string, unknown>,
      };
    },
    getTasaciones(): TasacionListItem[] {
      const rows = stmtListTasaciones.all() as { id: string; fecha: string; input: string; result: string }[];
      return rows.map((r) => {
        const input = JSON.parse(r.input) as { direccion?: string | null; barrio?: string | null };
        const result = JSON.parse(r.result) as {
          valorEstimadoUsd?: number;
          confianza?: string;
          ubicacion?: { direccionNormalizada?: string } | null;
        };
        return {
          id: r.id,
          fecha: r.fecha,
          titulo: result.ubicacion?.direccionNormalizada ?? input.direccion ?? input.barrio ?? 's/d',
          valorEstimadoUsd: result.valorEstimadoUsd ?? 0,
          confianza: result.confianza ?? 's/d',
        };
      });
    },
    close() {
      db.close();
    },
  };
}

export type SearchDb = ReturnType<typeof openDb>;

/** Process-wide handle for API routes. globalThis survives Next.js dev hot-reload (module-level state does not). */
const g = globalThis as typeof globalThis & { __inmueblesDb?: SearchDb };
export function getDb(): SearchDb {
  g.__inmueblesDb ??= openDb();
  return g.__inmueblesDb;
}

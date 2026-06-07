# Inmuebles MVP (Plan 1 de 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App local end-to-end: descripción de inmueble → criterios (Sonnet) → scraper Argenprop → pool en SQLite → 6 lentes Haiku votan (réplicas configurables) → consenso determinístico → UI con panel de progreso SSE y resultados.

**Architecture:** Next.js 15 App Router con API routes locales. El Agent SDK (`@anthropic-ai/claude-agent-sdk`) usa la sesión de Claude Code (suscripción, sin API key). Pipeline "fetch once, vote many": adquisición sin LLM, votación con N agentes Haiku con prompt de prefijo compartido (cache-friendly), consenso en código puro. Spec: `docs/superpowers/specs/2026-06-06-inmuebles-agent-search-design.md`.

**Tech Stack:** Next.js 15, TypeScript, MUI, better-sqlite3, cheerio, @anthropic-ai/claude-agent-sdk, Jest.

**Fuera de este plan (Plan 2 y 3):** adapter MercadoLibre (API), adapter Zonaprop (agente web-search), dedup cross-portal, re-votación sobre pool cacheado (iteración), e2e Playwright, refinamiento del circuit breaker.

**Prerrequisitos del entorno:** Claude Code logueado con la suscripción (el Agent SDK la usa automáticamente — no setear `ANTHROPIC_API_KEY`). Node ≥ 18.17, pnpm.

**Advertencia de costo:** las tareas 7, 8 y 11 incluyen pasos de verificación manual que consumen cuota real (Haiku/Sonnet). Son runs chicos (~50-300k tokens), pero no los repitas en loop.

---

### Task 1: Limpieza web3 del boilerplate

El repo es el boilerplate web3 de Wonderland. Eliminamos wagmi/RainbowKit/viem y todo lo que cuelga de eso. La app no usa wallets.

> ⚠️ `src/containers/Landing.tsx` tiene un cambio local sin commitear (quedó como contenedor vacío). Este plan lo reemplaza en la Task 11 — si el usuario tenía algo más ahí, confirmar antes.

**Files:**
- Delete: `src/providers/WalletProvider.tsx`, `src/config/wagmiConfig.ts`, `src/config/themes/rainbowTheme.ts`, `tests/connect-wallet.spec.ts`, `test/` (directorio completo: fixtures synpress)
- Modify: `src/providers/index.tsx`, `src/containers/Header.tsx`, `src/config/themes/index.ts`, `src/types/theme.ts`, `src/types/config.ts`, `src/config/env.ts`, `package.json`

- [ ] **Step 1: Eliminar dependencias y archivos web3**

```bash
pnpm remove @rainbow-me/rainbowkit wagmi viem @tanstack/react-query react-router-dom
rm src/providers/WalletProvider.tsx src/config/wagmiConfig.ts src/config/themes/rainbowTheme.ts
rm tests/connect-wallet.spec.ts
rm -rf test
```

- [ ] **Step 2: Reescribir `src/providers/index.tsx`**

```tsx
import type { ReactNode } from 'react';
import { StateProvider } from './StateProvider';
import { ThemeProvider } from './ThemeProvider';

type Props = {
  children: ReactNode;
};

export const Providers = ({ children }: Props) => {
  return (
    <ThemeProvider>
      <StateProvider>{children}</StateProvider>
    </ThemeProvider>
  );
};
```

- [ ] **Step 3: Reescribir `src/containers/Header.tsx`** (sin `ConnectButton`, título nuevo)

```tsx
'use client';

import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import { IconButton, Typography } from '@mui/material';
import { styled, useColorScheme } from '@mui/material/styles';
import { zIndex, HEADER_HEIGHT } from '~/utils';

export const Header = () => {
  const { mode, setMode } = useColorScheme();

  const changeTheme = () => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  };

  return (
    <StyledHeader>
      <Typography data-testid='app-title'>euler-inmuebles</Typography>
      <SIconButton onClick={changeTheme}>{mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}</SIconButton>
    </StyledHeader>
  );
};

//Styles
const StyledHeader = styled('header')(({ theme }) => {
  return [
    {
      display: 'flex',
      height: `${HEADER_HEIGHT}rem`,
      padding: '0 8rem',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.palette.background.secondary,
      width: '100%',
      zIndex: zIndex.HEADER,
    },
  ];
});

const SIconButton = styled(IconButton)({
  position: 'absolute',
  left: '50%',
});
```

- [ ] **Step 4: Reescribir `src/config/themes/index.ts`**

```ts
import { getMuiThemeConfig } from './muiThemeConfig';
import { customTheme } from './theme';

export const getCustomThemes = () => {
  return {
    getMui: getMuiThemeConfig(customTheme),
  };
};
```

- [ ] **Step 5: Editar `src/types/theme.ts`** — borrar la línea 2 (`import { Theme as RainbowTheme } from '@rainbow-me/rainbowkit';`) y dejar `CustomThemes` así:

```ts
export interface CustomThemes {
  getMui: Theme;
}
```

- [ ] **Step 6: Reescribir `src/types/config.ts`** (la app no necesita env vars públicas por ahora)

```ts
import { CustomThemes } from '~/types';

export type Env = Record<string, never>;

export interface Constants {
  RPC_URL_TESTING: string;
}

export interface Config {
  env: Env;
  constants: Constants;
  customThemes: CustomThemes;
}
```

> `Constants.RPC_URL_TESTING` queda porque `src/config/constants.ts` lo define; no molesta y borrarlo encadena más ediciones (YAGNI inverso: mínimo cambio).

- [ ] **Step 7: Reescribir `src/config/env.ts`**

```ts
import { Env } from '~/types';

const env: Env = {};

export const getEnv = (): Env => {
  return env;
};
```

- [ ] **Step 8: Editar `package.json` scripts** — borrar las entradas `test:fork:latest` y `synpress:cache`, y cambiar `"test"` a:

```json
"test": "pnpm run test:unit",
```

(El e2e vuelve en el Plan 3; hoy `playwright test` fallaría con "No tests found".)

- [ ] **Step 9: Verificar que compila y los tests pasan**

Run: `pnpm run lint && pnpm run test:unit && pnpm run build`
Expected: lint sin errores, 1 test PASS (`truncateAddress`), build OK.
Si lint/build reportan referencias colgantes a wagmi/rainbowkit, borrarlas (deberían estar todas cubiertas arriba).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: remove web3 boilerplate (wagmi, rainbowkit, viem)"
```

---

### Task 2: Dependencias nuevas y configuración

**Files:**
- Modify: `next.config.mjs`, `.gitignore`, `package.json` (vía pnpm)

- [ ] **Step 1: Instalar dependencias**

```bash
pnpm add @anthropic-ai/claude-agent-sdk better-sqlite3 cheerio
pnpm add -D @types/better-sqlite3
```

- [ ] **Step 2: Editar `next.config.mjs`** — agregar al objeto de configuración exportado la propiedad:

```js
serverExternalPackages: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
```

(Ambos paquetes usan binarios nativos / spawn de procesos; no deben ser bundleados por webpack.)

- [ ] **Step 3: Editar `.gitignore`** — agregar al final:

```
# local sqlite data
.data/
```

- [ ] **Step 4: Editar `jest.config.ts`** — `next/jest` no mapea los paths de tsconfig; agregar al objeto `config` (junto a `testMatch`):

```ts
moduleNameMapper: {
  '^~/(.*)$': '<rootDir>/src/$1',
},
```

- [ ] **Step 5: Verificar build**

Run: `pnpm run build`
Expected: build OK.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: add agent-sdk, better-sqlite3, cheerio"
```

---

### Task 3: Tipos de dominio

**Files:**
- Create: `src/types/search.ts`
- Modify: `src/types/index.ts`

- [ ] **Step 1: Crear `src/types/search.ts`**

```ts
export interface SearchCriteria {
  operation: 'alquiler' | 'venta';
  propertyType: 'departamento' | 'casa' | 'ph';
  barrios: string[]; // e.g. ['Palermo', 'Villa Crespo']
  priceMin?: number;
  priceMax?: number;
  currency: 'ARS' | 'USD';
  ambientesMin?: number;
  m2Min?: number;
  mustHaves: string[]; // e.g. ['balcón', 'apto mascotas']
  niceToHaves: string[];
  rawDescription: string;
}

export interface NormalizedListing {
  id: string; // sha1 of canonical URL
  url: string;
  portal: string;
  title: string;
  price: { amount: number; currency: 'ARS' | 'USD' };
  expensas?: number;
  barrio: string;
  ambientes?: number;
  m2?: number;
  features: string[];
  description: string; // truncated to ~150 words
  publishedAt?: string;
}

export type VerdictValue = 'match' | 'reject' | 'unsure';

export interface LensVerdict {
  id: string; // listing id
  verdict: VerdictValue;
  reason: string;
}

export interface Vote {
  lens: string;
  replica: number;
  verdicts: LensVerdict[];
}

export interface LensReason {
  lens: string;
  replica: number;
  verdict: VerdictValue;
  reason: string;
}

export interface ScoredListing {
  listing: NormalizedListing;
  score: number; // 0..1 over scoring lenses (red-flags excluded)
  matchedLenses: number;
  totalLenses: number;
  redFlag: boolean;
  reasons: LensReason[];
}

export type SearchPhase = 'intake' | 'acquisition' | 'voting' | 'consensus' | 'done' | 'error';

export type AdapterEventStatus = 'running' | 'ok' | 'blocked' | 'error';
export type AgentEventStatus = 'running' | 'ok' | 'error' | 'skipped';

export type SearchEvent =
  | { type: 'phase'; phase: SearchPhase }
  | { type: 'criteria'; criteria: SearchCriteria }
  | { type: 'adapter'; portal: string; status: AdapterEventStatus; count?: number; detail?: string }
  | { type: 'agent'; lens: string; replica: number; status: AgentEventStatus }
  | { type: 'tokens'; total: number; budget: number }
  | { type: 'done'; resultCount: number; degraded: boolean; partial: boolean }
  | { type: 'error'; message: string };

export interface SearchParams {
  description: string;
  replicas: number; // replicas per lens: 1 | 2 | 4
  threshold: number; // 0..1 fraction of scoring lenses that must match
  tokenBudget: number; // hard cap for the whole search
}
```

- [ ] **Step 2: Editar `src/types/index.ts`** — agregar:

```ts
export * from './search';
```

- [ ] **Step 3: Verificar y commitear**

Run: `pnpm run lint && pnpm run build`
Expected: OK.

```bash
git add -A
git commit -m "feat: domain types for agent-consensus search"
```

---

### Task 4: Consenso (código puro, TDD)

Reglas (del spec): score = lentes con mayoría `match` / lentes que votaron, **excluyendo** el lente `red-flags`, que no puntúa: solo marca `redFlag` (veto suave — se muestra con ⚠, no se oculta). `unsure` no suma ni resta. Mayoría entre réplicas; empate → `unsure`. Quórum: si respondieron < `quorumMin` lentes puntuables, `degraded: true`.

**Files:**
- Create: `src/server/consensus.ts`
- Test: `src/server/__tests__/consensus.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { scoreListings, RED_FLAGS_LENS } from '../consensus';
import type { NormalizedListing, Vote } from '~/types';

const listing = (id: string): NormalizedListing => ({
  id,
  url: `https://example.com/${id}`,
  portal: 'argenprop',
  title: `Depto ${id}`,
  price: { amount: 500_000, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'lindo depto',
});

const vote = (lens: string, replica: number, verdicts: [string, 'match' | 'reject' | 'unsure'][]): Vote => ({
  lens,
  replica,
  verdicts: verdicts.map(([id, verdict]) => ({ id, verdict, reason: `${lens} says ${verdict}` })),
});

const OPTS = { threshold: 0.5, quorumMin: 2 };

describe('scoreListings', () => {
  it('scores by fraction of matching lenses and filters by threshold', () => {
    const pool = [listing('a'), listing('b')];
    const votes = [
      vote('precio', 1, [
        ['a', 'match'],
        ['b', 'reject'],
      ]),
      vote('espacio', 1, [
        ['a', 'match'],
        ['b', 'reject'],
      ]),
    ];
    const { results, degraded } = scoreListings(pool, votes, OPTS);
    expect(degraded).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0].listing.id).toBe('a');
    expect(results[0].score).toBe(1);
    expect(results[0].totalLenses).toBe(2);
  });

  it('resolves replica majority per lens; tie -> unsure (neutral)', () => {
    const pool = [listing('a')];
    const votes = [
      // precio: match vs reject -> tie -> unsure -> lens does not count as match
      vote('precio', 1, [['a', 'match']]),
      vote('precio', 2, [['a', 'reject']]),
      // espacio: 2x match
      vote('espacio', 1, [['a', 'match']]),
      vote('espacio', 2, [['a', 'match']]),
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results[0].score).toBe(0.5); // 1 of 2 lenses
  });

  it('ignores unsure replicas when computing majority', () => {
    const pool = [listing('a')];
    const votes = [
      vote('precio', 1, [['a', 'unsure']]),
      vote('precio', 2, [['a', 'match']]),
      vote('espacio', 1, [['a', 'match']]),
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results[0].score).toBe(1);
  });

  it('red-flags lens marks but never scores nor hides', () => {
    const pool = [listing('a')];
    const votes = [
      vote('precio', 1, [['a', 'match']]),
      vote('espacio', 1, [['a', 'match']]),
      vote(RED_FLAGS_LENS, 1, [['a', 'reject']]), // red flags found
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results).toHaveLength(1);
    expect(results[0].redFlag).toBe(true);
    expect(results[0].totalLenses).toBe(2); // red-flags excluded
  });

  it('marks degraded when fewer scoring lenses than quorum responded', () => {
    const pool = [listing('a')];
    const votes = [vote('precio', 1, [['a', 'match']])];
    const { degraded } = scoreListings(pool, votes, { threshold: 0.5, quorumMin: 4 });
    expect(degraded).toBe(true);
  });

  it('sorts results by score descending and keeps reasons', () => {
    const pool = [listing('a'), listing('b')];
    const votes = [
      vote('precio', 1, [
        ['a', 'match'],
        ['b', 'match'],
      ]),
      vote('espacio', 1, [
        ['a', 'reject'],
        ['b', 'match'],
      ]),
    ];
    const { results } = scoreListings(pool, votes, OPTS);
    expect(results.map((r) => r.listing.id)).toEqual(['b', 'a']);
    expect(results[0].reasons.length).toBeGreaterThan(0);
    expect(results[0].reasons[0]).toHaveProperty('reason');
  });
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

Run: `pnpm run test:unit -- consensus`
Expected: FAIL — `Cannot find module '../consensus'`.

- [ ] **Step 3: Implementar `src/server/consensus.ts`**

```ts
import type { LensReason, NormalizedListing, ScoredListing, VerdictValue, Vote } from '~/types';

export const RED_FLAGS_LENS = 'red-flags';

export interface ConsensusOptions {
  threshold: number; // 0..1
  quorumMin: number; // min scoring lenses that must have voted
}

export interface ConsensusOutput {
  results: ScoredListing[];
  degraded: boolean;
}

/** Majority among replicas, ignoring 'unsure'. Tie or no data -> 'unsure'. */
function lensMajority(verdicts: VerdictValue[]): VerdictValue {
  const matches = verdicts.filter((v) => v === 'match').length;
  const rejects = verdicts.filter((v) => v === 'reject').length;
  if (matches > rejects) return 'match';
  if (rejects > matches) return 'reject';
  return 'unsure';
}

export function scoreListings(
  pool: NormalizedListing[],
  votes: Vote[],
  opts: ConsensusOptions,
): ConsensusOutput {
  const lensNames = [...new Set(votes.map((v) => v.lens))];
  const scoringLenses = lensNames.filter((l) => l !== RED_FLAGS_LENS);
  const degraded = scoringLenses.length < opts.quorumMin;

  const results: ScoredListing[] = [];

  for (const listing of pool) {
    const reasons: LensReason[] = [];
    let matched = 0;
    let total = 0;

    for (const lens of scoringLenses) {
      const replicaVerdicts = votes
        .filter((v) => v.lens === lens)
        .map((v) => v.verdicts.find((d) => d.id === listing.id))
        .filter((d): d is NonNullable<typeof d> => d !== undefined);
      if (replicaVerdicts.length === 0) continue;
      total += 1;
      if (lensMajority(replicaVerdicts.map((d) => d.verdict)) === 'match') matched += 1;
    }

    for (const v of votes) {
      const d = v.verdicts.find((x) => x.id === listing.id);
      if (d) reasons.push({ lens: v.lens, replica: v.replica, verdict: d.verdict, reason: d.reason });
    }

    const redFlagVerdicts = votes
      .filter((v) => v.lens === RED_FLAGS_LENS)
      .map((v) => v.verdicts.find((d) => d.id === listing.id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    const redFlag = redFlagVerdicts.length > 0 && lensMajority(redFlagVerdicts.map((d) => d.verdict)) === 'reject';

    const score = total === 0 ? 0 : matched / total;
    if (score >= opts.threshold && total > 0) {
      results.push({ listing, score, matchedLenses: matched, totalLenses: total, redFlag, reasons });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { results, degraded };
}
```

- [ ] **Step 4: Correr el test y verlo pasar**

Run: `pnpm run test:unit -- consensus`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/consensus.ts src/server/__tests__/consensus.test.ts
git commit -m "feat: deterministic consensus scoring with soft red-flag veto"
```

---

### Task 5: Capa de persistencia SQLite (TDD)

**Files:**
- Create: `src/server/db.ts`
- Test: `src/server/__tests__/db.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { openDb, type SearchDb } from '../db';
import type { NormalizedListing, SearchParams, Vote } from '~/types';

const params: SearchParams = { description: 'depto en Palermo', replicas: 1, threshold: 0.6, tokenBudget: 100_000 };

const listing: NormalizedListing = {
  id: 'abc',
  url: 'https://example.com/abc',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 100, currency: 'USD' },
  barrio: 'Palermo',
  features: ['balcón'],
  description: 'lindo',
};

const vote: Vote = { lens: 'precio', replica: 1, verdicts: [{ id: 'abc', verdict: 'match', reason: 'ok' }] };

describe('search db', () => {
  let db: SearchDb;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('creates and reads a search with status transitions', () => {
    db.createSearch('s1', params);
    expect(db.getSearch('s1')).toMatchObject({ id: 's1', status: 'pending', params });
    db.setStatus('s1', 'voting');
    expect(db.getSearch('s1')?.status).toBe('voting');
  });

  it('persists criteria, pool, votes and results', () => {
    db.createSearch('s1', params);
    db.saveCriteria('s1', {
      operation: 'alquiler',
      propertyType: 'departamento',
      barrios: ['Palermo'],
      currency: 'ARS',
      mustHaves: [],
      niceToHaves: [],
      rawDescription: 'depto en Palermo',
    });
    db.savePool('s1', [listing]);
    db.saveVote('s1', vote);
    db.saveResults('s1', { results: [], degraded: false });

    expect(db.getPool('s1')).toEqual([listing]);
    expect(db.getVotes('s1')).toEqual([vote]);
    expect(db.getResults('s1')).toEqual({ results: [], degraded: false });
  });

  it('savePool is idempotent per (search, listing)', () => {
    db.createSearch('s1', params);
    db.savePool('s1', [listing]);
    db.savePool('s1', [listing]);
    expect(db.getPool('s1')).toHaveLength(1);
  });

  it('returns undefined for missing search', () => {
    expect(db.getSearch('nope')).toBeUndefined();
    expect(db.getResults('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

Run: `pnpm run test:unit -- db`
Expected: FAIL — `Cannot find module '../db'`.

- [ ] **Step 3: Implementar `src/server/db.ts`**

```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { ConsensusOutput } from './consensus';
import type { NormalizedListing, SearchCriteria, SearchParams, Vote } from '~/types';

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
```

- [ ] **Step 4: Correr el test y verlo pasar**

Run: `pnpm run test:unit -- db`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/__tests__/db.test.ts
git commit -m "feat: sqlite persistence for searches, pools, votes and results"
```

---

### Task 6: Adapter Argenprop (scraper)

Tres unidades: builder de URLs, parser HTML (cheerio, selectores como constantes), normalizador. El parser se testea contra un **fixture real grabado** — los selectores del boilerplate de abajo son una primera aproximación y se ajustan contra el fixture hasta que el test pase (los portales cambian su HTML; ese es el flujo normal de mantenimiento).

**Files:**
- Create: `src/server/adapters/types.ts`, `src/server/adapters/argenprop/url.ts`, `src/server/adapters/argenprop/parse.ts`, `src/server/adapters/argenprop/normalize.ts`, `src/server/adapters/argenprop/index.ts`
- Create: `src/server/adapters/argenprop/__fixtures__/list-page.html` (grabado, Step 5)
- Test: `src/server/adapters/argenprop/__tests__/url.test.ts`, `.../__tests__/parse.test.ts`, `.../__tests__/normalize.test.ts`

- [ ] **Step 1: Crear `src/server/adapters/types.ts`**

```ts
import type { NormalizedListing, SearchCriteria } from '~/types';

export type AdapterStatus = 'ok' | 'blocked' | 'error';

export interface AdapterResult {
  status: AdapterStatus;
  listings: NormalizedListing[];
  detail?: string;
}

export interface PortalAdapter {
  name: string;
  tier: 'api' | 'scraper' | 'agent';
  search(criteria: SearchCriteria): Promise<AdapterResult>;
}
```

- [ ] **Step 2: Test de URLs que falla** — `__tests__/url.test.ts`

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { buildSearchUrls, slugify } from '../url';
import type { SearchCriteria } from '~/types';

const base: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo', 'Villa Crespo'],
  currency: 'ARS',
  mustHaves: [],
  niceToHaves: [],
  rawDescription: '',
};

describe('argenprop urls', () => {
  it('slugifies barrio names', () => {
    expect(slugify('Villa Crespo')).toBe('villa-crespo');
    expect(slugify('Núñez')).toBe('nunez');
  });

  it('builds one url per barrio', () => {
    expect(buildSearchUrls(base)).toEqual([
      'https://www.argenprop.com/departamentos/alquiler/palermo',
      'https://www.argenprop.com/departamentos/alquiler/villa-crespo',
    ]);
  });

  it('falls back to capital-federal when no barrios', () => {
    expect(buildSearchUrls({ ...base, barrios: [] })).toEqual([
      'https://www.argenprop.com/departamentos/alquiler/capital-federal',
    ]);
  });
});
```

Run: `pnpm run test:unit -- argenprop/__tests__/url`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `url.ts`**

```ts
import type { SearchCriteria } from '~/types';

const BASE = 'https://www.argenprop.com';

const TYPE_SEGMENT: Record<SearchCriteria['propertyType'], string> = {
  departamento: 'departamentos',
  casa: 'casas',
  ph: 'ph',
};

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function buildSearchUrls(criteria: SearchCriteria): string[] {
  const tipo = TYPE_SEGMENT[criteria.propertyType];
  const barrios = criteria.barrios.length > 0 ? criteria.barrios : ['Capital Federal'];
  return barrios.map((b) => `${BASE}/${tipo}/${criteria.operation}/${slugify(b)}`);
}
```

> Nota: el path real de Argenprop puede diferir (p.ej. usar guiones u otro orden de segmentos). En el Step 5 se verifica contra el sitio real con `curl`; si la URL construida devuelve 404 o una página sin avisos, ajustar el formato del path acá y en este test (el test fija el formato *elegido*, el fixture valida que funciona).

Run: `pnpm run test:unit -- argenprop/__tests__/url`
Expected: PASS.

- [ ] **Step 4: Test del normalizador que falla** — `__tests__/normalize.test.ts`

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import { normalizeListing, parsePrice, truncateWords } from '../normalize';

describe('parsePrice', () => {
  it('parses ARS prices with thousand dots', () => {
    expect(parsePrice('$ 850.000')).toEqual({ amount: 850_000, currency: 'ARS' });
  });
  it('parses USD prices', () => {
    expect(parsePrice('USD 120.000')).toEqual({ amount: 120_000, currency: 'USD' });
    expect(parsePrice('U$S 95.500')).toEqual({ amount: 95_500, currency: 'USD' });
  });
  it('returns undefined for consultar/empty', () => {
    expect(parsePrice('Consultar precio')).toBeUndefined();
    expect(parsePrice('')).toBeUndefined();
  });
});

describe('truncateWords', () => {
  it('truncates to n words', () => {
    expect(truncateWords('uno dos tres cuatro', 2)).toBe('uno dos…');
    expect(truncateWords('uno dos', 5)).toBe('uno dos');
  });
});

describe('normalizeListing', () => {
  const raw = {
    url: 'https://www.argenprop.com/departamento-en-alquiler--123?utm=x',
    title: 'Depto 2 amb con balcón',
    priceText: '$ 850.000',
    addressText: 'Gorriti 4500, Palermo',
    featuresText: ['2 ambientes', '45 m²', 'balcón'],
    description: 'Hermoso departamento luminoso',
  };

  it('normalizes a raw listing', () => {
    const l = normalizeListing(raw, 'Palermo');
    expect(l).toMatchObject({
      portal: 'argenprop',
      url: 'https://www.argenprop.com/departamento-en-alquiler--123', // query stripped
      title: 'Depto 2 amb con balcón',
      price: { amount: 850_000, currency: 'ARS' },
      barrio: 'Palermo',
      ambientes: 2,
      m2: 45,
    });
    expect(l?.id).toHaveLength(40); // sha1 hex
  });

  it('returns null without price or url', () => {
    expect(normalizeListing({ ...raw, priceText: 'Consultar' }, 'Palermo')).toBeNull();
    expect(normalizeListing({ ...raw, url: '' }, 'Palermo')).toBeNull();
  });
});
```

Run: `pnpm run test:unit -- argenprop/__tests__/normalize`
Expected: FAIL.

- [ ] **Step 5: Implementar `normalize.ts`**

```ts
import { createHash } from 'crypto';
import type { NormalizedListing } from '~/types';

export interface RawArgenpropListing {
  url: string;
  title: string;
  priceText: string;
  addressText: string;
  featuresText: string[];
  description: string;
}

export function parsePrice(text: string): NormalizedListing['price'] | undefined {
  const cleaned = text.trim();
  if (!cleaned || /consultar/i.test(cleaned)) return undefined;
  const currency = /usd|u\$s/i.test(cleaned) ? 'USD' : 'ARS';
  const digits = cleaned.replace(/[^\d]/g, '');
  if (!digits) return undefined;
  return { amount: Number(digits), currency };
}

export function truncateWords(s: string, n = 150): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= n) return s.trim();
  return `${words.slice(0, n).join(' ')}…`;
}

function extractNumber(features: string[], pattern: RegExp): number | undefined {
  for (const f of features) {
    const m = f.match(pattern);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export function normalizeListing(raw: RawArgenpropListing, barrio: string): NormalizedListing | null {
  if (!raw.url) return null;
  const price = parsePrice(raw.priceText);
  if (!price) return null;
  const canonicalUrl = raw.url.split('?')[0];
  return {
    id: createHash('sha1').update(canonicalUrl).digest('hex'),
    url: canonicalUrl,
    portal: 'argenprop',
    title: raw.title.trim(),
    price,
    barrio,
    ambientes: extractNumber(raw.featuresText, /(\d+)\s*amb/i),
    m2: extractNumber(raw.featuresText, /(\d+)\s*m²?/i),
    features: raw.featuresText.map((f) => f.trim()).filter(Boolean),
    description: truncateWords(`${raw.addressText}. ${raw.description}`),
  };
}
```

Run: `pnpm run test:unit -- argenprop/__tests__/normalize`
Expected: PASS.

- [ ] **Step 6: Grabar el fixture real**

```bash
mkdir -p src/server/adapters/argenprop/__fixtures__
curl -sL -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  "https://www.argenprop.com/departamentos/alquiler/palermo" \
  -o src/server/adapters/argenprop/__fixtures__/list-page.html
wc -c src/server/adapters/argenprop/__fixtures__/list-page.html
```

Expected: archivo > 100KB con HTML de avisos. Si pesa < 20KB o contiene "challenge"/"captcha", Argenprop bloqueó el fetch: reintentar desde el browser (guardar la página como HTML) y copiarla al mismo path. **Si la URL devuelve 404**, inspeccionar el formato real de URL del sitio y volver al Step 3 (ajustar `url.ts` + su test).

- [ ] **Step 7: Test del parser contra el fixture** — `__tests__/parse.test.ts` (asserts de invariantes, no de valores exactos: el fixture cambia con el tiempo)

```ts
/** @jest-environment node */
import { expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseListings } from '../parse';

const html = fs.readFileSync(path.join(__dirname, '../__fixtures__/list-page.html'), 'utf-8');

describe('parseListings (fixture)', () => {
  it('extracts at least 10 listings with url, title and price', () => {
    const raws = parseListings(html);
    expect(raws.length).toBeGreaterThanOrEqual(10);
    for (const r of raws.slice(0, 10)) {
      expect(r.url).toMatch(/^https:\/\/www\.argenprop\.com\//);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.priceText.length).toBeGreaterThan(0);
    }
  });

  it('returns empty array for non-listing html', () => {
    expect(parseListings('<html><body><h1>hola</h1></body></html>')).toEqual([]);
  });
});
```

Run: `pnpm run test:unit -- argenprop/__tests__/parse`
Expected: FAIL.

- [ ] **Step 8: Implementar `parse.ts` y ajustar selectores contra el fixture**

```ts
import * as cheerio from 'cheerio';
import type { RawArgenpropListing } from './normalize';

const BASE = 'https://www.argenprop.com';

// Selectores del listado de Argenprop. Si el portal cambia su HTML, ajustar acá
// y re-grabar el fixture (ver __tests__/parse.test.ts).
const SEL = {
  card: 'div.listing__item',
  link: 'a.card',
  title: '.card__title',
  price: '.card__price',
  address: '.card__address',
  features: '.card__main-features li',
  description: '.card__info',
};

export function parseListings(html: string): RawArgenpropListing[] {
  const $ = cheerio.load(html);
  const out: RawArgenpropListing[] = [];

  $(SEL.card).each((_, el) => {
    const card = $(el);
    const href = card.find(SEL.link).attr('href');
    if (!href) return;
    out.push({
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      title: card.find(SEL.title).text().trim(),
      priceText: card.find(SEL.price).text().trim(),
      addressText: card.find(SEL.address).text().trim(),
      featuresText: card
        .find(SEL.features)
        .map((_, li) => $(li).text().trim())
        .get(),
      description: card.find(SEL.description).text().trim(),
    });
  });

  return out;
}
```

**Iterar:** correr el test; si extrae 0 avisos, abrir el fixture (`grep -o 'class="[^"]*card[^"]*"' fixture | sort -u | head -30`) y corregir las entradas de `SEL` hasta que el test pase. No cambiar los asserts del test para que pase — cambiar los selectores.

Run: `pnpm run test:unit -- argenprop/__tests__/parse`
Expected: PASS.

- [ ] **Step 9: Implementar el adapter `index.ts`**

```ts
import { buildSearchUrls } from './url';
import { normalizeListing } from './normalize';
import { parseListings } from './parse';
import type { AdapterResult, PortalAdapter } from '../types';
import type { NormalizedListing } from '~/types';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;
const BLOCK_STATUSES = [403, 429, 503];

async function fetchPage(url: string): Promise<{ html?: string; blocked: boolean }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'es-AR,es;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { blocked: BLOCK_STATUSES.includes(res.status) };
  const html = await res.text();
  return { html, blocked: false };
}

export const argenpropAdapter: PortalAdapter = {
  name: 'argenprop',
  tier: 'scraper',
  async search(criteria): Promise<AdapterResult> {
    const byId = new Map<string, NormalizedListing>();
    let blocked = false;

    for (const [i, url] of buildSearchUrls(criteria).entries()) {
      const barrio = criteria.barrios[i] ?? 'Capital Federal';
      try {
        const page = await fetchPage(url);
        if (!page.html) {
          blocked ||= page.blocked;
          continue;
        }
        const raws = parseListings(page.html);
        if (raws.length === 0 && /challenge|captcha|cloudflare/i.test(page.html)) {
          blocked = true;
          continue;
        }
        for (const raw of raws) {
          const listing = normalizeListing(raw, barrio);
          if (listing) byId.set(listing.id, listing);
        }
      } catch {
        // network error / timeout on one barrio: keep going with the rest
      }
    }

    if (byId.size === 0 && blocked) return { status: 'blocked', listings: [], detail: 'challenge o status de bloqueo' };
    return { status: 'ok', listings: [...byId.values()] };
  },
};
```

- [ ] **Step 10: Correr todos los tests del adapter**

Run: `pnpm run test:unit -- argenprop`
Expected: url + normalize + parse PASS.

- [ ] **Step 11: Commit**

```bash
git add src/server/adapters
git commit -m "feat: argenprop scraper adapter with recorded fixture tests"
```

---

### Task 7: Lentes y agente votante (Agent SDK)

El prompt se arma **prefijo compartido primero** (criterios + pool idénticos para todos los agentes → prompt caching server-side) y la instrucción del lente al final. `outputFormat: json_schema` garantiza veredictos parseados.

**Files:**
- Create: `src/server/llm/lenses.ts`, `src/server/llm/vote.ts`
- Test: `src/server/llm/__tests__/vote.test.ts`

- [ ] **Step 1: Crear `src/server/llm/lenses.ts`**

```ts
export interface Lens {
  key: string;
  instruction: string;
}

export const LENSES: Lens[] = [
  {
    key: 'ubicacion',
    instruction:
      'Evaluá SOLO ubicación: ¿el barrio y la zona del aviso coinciden con lo pedido? Si los criterios mencionan transporte o puntos de referencia, considerá la cercanía. Ignorá precio y características.',
  },
  {
    key: 'precio',
    instruction:
      'Evaluá SOLO precio: ¿el precio (y expensas si figuran) entra en el presupuesto? Considerá si el precio es razonable para la zona. Si la moneda difiere, asumí que no podés convertir y respondé unsure. Ignorá ubicación y características.',
  },
  {
    key: 'espacio',
    instruction:
      'Evaluá SOLO espacio físico: ambientes, m², distribución, balcón/patio/cochera según lo pedido. Si el dato necesario no figura en el aviso, respondé unsure. Ignorá precio y ubicación.',
  },
  {
    key: 'condicion',
    instruction:
      'Evaluá SOLO estado del inmueble: antigüedad, estado de conservación, señales de "a refaccionar" escondidas en la descripción. Si no hay información, respondé unsure.',
  },
  {
    key: 'red-flags',
    instruction:
      'Buscá red flags: precio sospechosamente bajo para la zona, descripción vaga o genérica, datos contradictorios, señales de aviso engañoso. Respondé match si el aviso parece CONFIABLE (sin red flags), reject si encontrás red flags (explicá cuáles), unsure si no hay información suficiente.',
  },
  {
    key: 'holistico',
    instruction:
      'Evaluá el aviso EN CONJUNTO contra la descripción original del usuario: ¿es esto lo que la persona describió? Pesá must-haves más que nice-to-haves.',
  },
];
```

- [ ] **Step 2: Test del agente votante que falla** — `__tests__/vote.test.ts` (con el SDK mockeado: acá se testea orquestación, no al modelo)

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

// eslint-disable-next-line import/first
import { buildVotingPrompt, runVotingAgent, tokensFromUsage } from '../vote';
// eslint-disable-next-line import/first
import { LENSES } from '../lenses';
// eslint-disable-next-line import/first
import type { NormalizedListing, SearchCriteria } from '~/types';

const criteria: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo'],
  currency: 'ARS',
  mustHaves: ['balcón'],
  niceToHaves: [],
  rawDescription: 'depto 2 amb con balcón en Palermo',
};

const pool: NormalizedListing[] = [
  {
    id: 'l1',
    url: 'https://x.com/1',
    portal: 'argenprop',
    title: 'Depto',
    price: { amount: 800_000, currency: 'ARS' },
    barrio: 'Palermo',
    features: [],
    description: 'lindo',
  },
];

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    structured_output: { verdicts: [{ id: 'l1', verdict: 'match', reason: 'tiene balcón' }] },
    usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 50 },
    ...overrides,
  };
}

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('buildVotingPrompt', () => {
  it('puts the shared context (criteria+pool) before the lens instruction (cache prefix)', () => {
    const p1 = buildVotingPrompt(criteria, pool, LENSES[0]);
    const p2 = buildVotingPrompt(criteria, pool, LENSES[1]);
    const sharedLen = [...p1].findIndex((c, i) => p2[i] !== c);
    expect(sharedLen).toBeGreaterThan(JSON.stringify(pool).length); // shared prefix covers the pool
    expect(p1).toContain(LENSES[0].instruction);
  });
});

describe('runVotingAgent', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns the structured vote and token count on success', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'system' }, resultMessage()]));
    const { vote, tokens } = await runVotingAgent({ lens: LENSES[0], replica: 1, criteria, pool });
    expect(vote).toEqual({
      lens: 'ubicacion',
      replica: 1,
      verdicts: [{ id: 'l1', verdict: 'match', reason: 'tiene balcón' }],
    });
    expect(tokens).toBe(125); // input + output + cache_creation (reads are ~free)
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe('claude-haiku-4-5');
    expect(opts.maxTurns).toBe(1);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.outputFormat).toMatchObject({ type: 'json_schema' });
  });

  it('throws on non-success result subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([resultMessage({ subtype: 'error_max_structured_output_retries', structured_output: undefined })]));
    await expect(runVotingAgent({ lens: LENSES[0], replica: 1, criteria, pool })).rejects.toThrow(/error_max_structured_output_retries/);
  });
});

describe('tokensFromUsage', () => {
  it('sums input, output and cache_creation; ignores cache reads', () => {
    expect(tokensFromUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 100 })).toBe(6);
    expect(tokensFromUsage({})).toBe(0);
  });
});
```

Run: `pnpm run test:unit -- llm/__tests__/vote`
Expected: FAIL.

- [ ] **Step 3: Implementar `src/server/llm/vote.ts`**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Lens } from './lenses';
import type { LensVerdict, NormalizedListing, SearchCriteria, Vote } from '~/types';

export const VOTING_MODEL = 'claude-haiku-4-5';
const AGENT_TIMEOUT_MS = 90_000;

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['match', 'reject', 'unsure'] },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
} as const;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Cache reads cost ~10%; count the expensive components only. */
export function tokensFromUsage(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/**
 * IMPORTANT for prompt caching: the shared context (criteria + pool) goes FIRST
 * and must be byte-identical across all lenses/replicas of a search. The lens
 * instruction goes at the END. Do not reorder.
 */
export function buildVotingPrompt(criteria: SearchCriteria, pool: NormalizedListing[], lens: Lens): string {
  const shared = [
    'Sos un evaluador de avisos inmobiliarios de Buenos Aires. Vas a recibir los criterios de búsqueda del usuario y una lista de avisos candidatos en JSON.',
    `CRITERIOS DE BÚSQUEDA:\n${JSON.stringify(criteria)}`,
    `AVISOS CANDIDATOS:\n${JSON.stringify(pool)}`,
  ].join('\n\n');
  return `${shared}\n\nTU LENTE DE EVALUACIÓN:\n${lens.instruction}\n\nDevolvé un veredicto por CADA candidato, usando exactamente su campo "id". verdict: "match" (cumple tu lente), "reject" (no cumple), "unsure" (falta información para juzgar — NO uses reject si simplemente falta el dato).`;
}

export interface VotingAgentArgs {
  lens: Lens;
  replica: number;
  criteria: SearchCriteria;
  pool: NormalizedListing[];
  model?: string;
  timeoutMs?: number;
}

export async function runVotingAgent(args: VotingAgentArgs): Promise<{ vote: Vote; tokens: number }> {
  const { lens, replica, criteria, pool, model = VOTING_MODEL, timeoutMs = AGENT_TIMEOUT_MS } = args;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    for await (const message of query({
      prompt: buildVotingPrompt(criteria, pool, lens),
      options: {
        model,
        maxTurns: 1,
        allowedTools: [],
        abortController,
        outputFormat: { type: 'json_schema', schema: VERDICTS_SCHEMA },
      },
    })) {
      if (message.type === 'result') {
        if (message.subtype !== 'success' || !message.structured_output) {
          throw new Error(`voting agent ${lens.key}#${replica} failed: ${message.subtype}`);
        }
        const { verdicts } = message.structured_output as { verdicts: LensVerdict[] };
        return { vote: { lens: lens.key, replica, verdicts }, tokens: tokensFromUsage(message.usage as Usage) };
      }
    }
    throw new Error(`voting agent ${lens.key}#${replica}: stream ended without result`);
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Correr el test y verlo pasar**

Run: `pnpm run test:unit -- llm/__tests__/vote`
Expected: PASS. Si TypeScript se queja del shape de `options`, verificar contra los tipos exportados del paquete instalado (`node_modules/@anthropic-ai/claude-agent-sdk/`) — ajustar nombres acá, no inventar.

- [ ] **Step 5: Smoke test real (consume cuota, ~30-60k tokens)** — crear `scripts/smoke-vote.ts` temporal **(no commitear)**:

```ts
import { runVotingAgent } from '../src/server/llm/vote';
import { LENSES } from '../src/server/llm/lenses';

const criteria = {
  operation: 'alquiler' as const,
  propertyType: 'departamento' as const,
  barrios: ['Palermo'],
  currency: 'ARS' as const,
  priceMax: 900_000,
  mustHaves: ['balcón'],
  niceToHaves: [],
  rawDescription: 'depto 2 ambientes con balcón en Palermo hasta 900 mil',
};
const pool = [
  {
    id: 'l1',
    url: 'https://x.com/1',
    portal: 'argenprop',
    title: 'Depto 2 amb c/balcón Palermo',
    price: { amount: 850_000, currency: 'ARS' as const },
    barrio: 'Palermo',
    ambientes: 2,
    features: ['balcón'],
    description: 'Luminoso, 45m2, balcón a la calle',
  },
];

runVotingAgent({ lens: LENSES[5], replica: 1, criteria, pool }).then((r) => console.log(JSON.stringify(r, null, 2)));
```

Run: `npx tsx scripts/smoke-vote.ts` (o `npx ts-node`)
Expected: JSON con `vote.verdicts[0].verdict === 'match'` y `tokens > 0`. Después: `rm scripts/smoke-vote.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/server/llm
git commit -m "feat: lens definitions and haiku voting agent via agent sdk"
```

---

### Task 8: Intake (descripción → criterios, Sonnet)

**Files:**
- Create: `src/server/llm/intake.ts`
- Test: `src/server/llm/__tests__/intake.test.ts`

- [ ] **Step 1: Test que falla**

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';

const mockQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

// eslint-disable-next-line import/first
import { runIntake } from '../intake';

function asyncGen(messages: unknown[]) {
  return (async function* () {
    yield* messages;
  })();
}

describe('runIntake', () => {
  beforeEach(() => mockQuery.mockReset());

  it('parses the description into criteria and appends rawDescription', async () => {
    mockQuery.mockReturnValue(
      asyncGen([
        {
          type: 'result',
          subtype: 'success',
          structured_output: {
            operation: 'alquiler',
            propertyType: 'departamento',
            barrios: ['Palermo'],
            currency: 'ARS',
            priceMax: 900000,
            mustHaves: ['balcón'],
            niceToHaves: [],
          },
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      ]),
    );
    const { criteria, tokens } = await runIntake('depto en palermo con balcón hasta 900 mil');
    expect(criteria.operation).toBe('alquiler');
    expect(criteria.rawDescription).toBe('depto en palermo con balcón hasta 900 mil');
    expect(tokens).toBe(80);
    const opts = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
    expect(opts.model).toBe('claude-sonnet-4-6');
  });

  it('throws on failure subtype', async () => {
    mockQuery.mockReturnValue(asyncGen([{ type: 'result', subtype: 'error_during_execution', usage: {} }]));
    await expect(runIntake('x')).rejects.toThrow(/intake failed/);
  });
});
```

Run: `pnpm run test:unit -- llm/__tests__/intake`
Expected: FAIL.

- [ ] **Step 2: Implementar `src/server/llm/intake.ts`**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tokensFromUsage, type Usage } from './vote';
import type { SearchCriteria } from '~/types';

export const INTAKE_MODEL = 'claude-sonnet-4-6';

const CRITERIA_SCHEMA = {
  type: 'object',
  properties: {
    operation: { type: 'string', enum: ['alquiler', 'venta'] },
    propertyType: { type: 'string', enum: ['departamento', 'casa', 'ph'] },
    barrios: { type: 'array', items: { type: 'string' } },
    priceMin: { type: 'number' },
    priceMax: { type: 'number' },
    currency: { type: 'string', enum: ['ARS', 'USD'] },
    ambientesMin: { type: 'number' },
    m2Min: { type: 'number' },
    mustHaves: { type: 'array', items: { type: 'string' } },
    niceToHaves: { type: 'array', items: { type: 'string' } },
  },
  required: ['operation', 'propertyType', 'barrios', 'currency', 'mustHaves', 'niceToHaves'],
  additionalProperties: false,
} as const;

const INTAKE_PROMPT = `Sos un parser de búsquedas inmobiliarias de Buenos Aires. Convertí la siguiente descripción libre en criterios estructurados.
- "barrios": nombres de barrios de CABA/GBA mencionados o implicados (capitalizados, ej. "Villa Crespo"). Si no menciona zona, lista vacía.
- "mustHaves": requisitos explícitos e innegociables. "niceToHaves": deseos blandos.
- Si no se aclara operación, asumí alquiler. Si no se aclara tipo, asumí departamento. Si no se aclara moneda: ARS para alquiler, USD para venta.

DESCRIPCIÓN:
`;

export async function runIntake(description: string): Promise<{ criteria: SearchCriteria; tokens: number }> {
  for await (const message of query({
    prompt: `${INTAKE_PROMPT}${description}`,
    options: {
      model: INTAKE_MODEL,
      maxTurns: 1,
      allowedTools: [],
      outputFormat: { type: 'json_schema', schema: CRITERIA_SCHEMA },
    },
  })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success' || !message.structured_output) {
        throw new Error(`intake failed: ${message.subtype}`);
      }
      const parsed = message.structured_output as Omit<SearchCriteria, 'rawDescription'>;
      return {
        criteria: { ...parsed, rawDescription: description },
        tokens: tokensFromUsage(message.usage as Usage),
      };
    }
  }
  throw new Error('intake failed: stream ended without result');
}
```

- [ ] **Step 3: Correr el test y verlo pasar**

Run: `pnpm run test:unit -- llm/__tests__/intake`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/llm
git commit -m "feat: sonnet intake parses free description into search criteria"
```

---

### Task 9: Eventos en memoria + orquestador

**Files:**
- Create: `src/server/events.ts`, `src/server/search.ts`
- Test: `src/server/__tests__/events.test.ts`, `src/server/__tests__/search.test.ts`

- [ ] **Step 1: Test de eventos que falla** — `__tests__/events.test.ts`

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import { emitSearchEvent, getBuffer, subscribe } from '../events';
import type { SearchEvent } from '~/types';

const ev = (phase: 'intake' | 'done'): SearchEvent => ({ type: 'phase', phase });

describe('search events', () => {
  it('buffers events for late subscribers and notifies live ones', () => {
    emitSearchEvent('e1', ev('intake'));
    expect(getBuffer('e1')).toEqual([ev('intake')]);

    const listener = jest.fn();
    const unsub = subscribe('e1', listener);
    emitSearchEvent('e1', ev('done'));
    expect(listener).toHaveBeenCalledWith(ev('done'));

    unsub();
    emitSearchEvent('e1', ev('done'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates channels per search id', () => {
    emitSearchEvent('a', ev('intake'));
    expect(getBuffer('b')).toEqual([]);
  });
});
```

Run: `pnpm run test:unit -- events`
Expected: FAIL.

- [ ] **Step 2: Implementar `src/server/events.ts`**

```ts
import type { SearchEvent } from '~/types';

type Listener = (e: SearchEvent) => void;

interface Channel {
  buffer: SearchEvent[];
  listeners: Set<Listener>;
}

const channels = new Map<string, Channel>();

function channel(id: string): Channel {
  let ch = channels.get(id);
  if (!ch) {
    ch = { buffer: [], listeners: new Set() };
    channels.set(id, ch);
  }
  return ch;
}

export function emitSearchEvent(id: string, e: SearchEvent): void {
  const ch = channel(id);
  ch.buffer.push(e);
  for (const l of ch.listeners) l(e);
}

export function getBuffer(id: string): SearchEvent[] {
  return [...channel(id).buffer];
}

export function subscribe(id: string, listener: Listener): () => void {
  const ch = channel(id);
  ch.listeners.add(listener);
  return () => ch.listeners.delete(listener);
}
```

Run: `pnpm run test:unit -- events`
Expected: PASS.

- [ ] **Step 3: Test del orquestador que falla** — `__tests__/search.test.ts`

```ts
/** @jest-environment node */
import { expect, jest } from '@jest/globals';
import { runSearch, type SearchDeps } from '../search';
import { openDb, type SearchDb } from '../db';
import type { Lens } from '../llm/lenses';
import type { AdapterResult } from '../adapters/types';
import type { NormalizedListing, SearchCriteria, SearchEvent, SearchParams, Vote } from '~/types';

const criteria: SearchCriteria = {
  operation: 'alquiler',
  propertyType: 'departamento',
  barrios: ['Palermo'],
  currency: 'ARS',
  mustHaves: [],
  niceToHaves: [],
  rawDescription: 'depto',
};

const listing: NormalizedListing = {
  id: 'l1',
  url: 'https://x.com/1',
  portal: 'argenprop',
  title: 'Depto',
  price: { amount: 100, currency: 'ARS' },
  barrio: 'Palermo',
  features: [],
  description: 'd',
};

const params: SearchParams = { description: 'depto', replicas: 1, threshold: 0.5, tokenBudget: 100_000 };

const LENSES_2: Lens[] = [
  { key: 'precio', instruction: 'precio' },
  { key: 'espacio', instruction: 'espacio' },
];

function makeDeps(db: SearchDb, events: SearchEvent[], overrides: Partial<SearchDeps> = {}): SearchDeps {
  return {
    db,
    adapters: [
      { name: 'argenprop', tier: 'scraper', search: async (): Promise<AdapterResult> => ({ status: 'ok', listings: [listing] }) },
    ],
    intake: async () => ({ criteria, tokens: 100 }),
    vote: async ({ lens, replica }) => ({
      vote: { lens: lens.key, replica, verdicts: [{ id: 'l1', verdict: 'match', reason: 'ok' }] } as Vote,
      tokens: 1000,
    }),
    emit: (e) => events.push(e),
    lenses: LENSES_2,
    quorumMin: 1,
    concurrency: 1, // deterministic: budget cutoff and call order depend on sequential execution
    ...overrides,
  };
}

describe('runSearch', () => {
  let db: SearchDb;
  let events: SearchEvent[];
  beforeEach(() => {
    db = openDb(':memory:');
    events = [];
  });
  afterEach(() => db.close());

  it('runs the full pipeline and persists everything', async () => {
    db.createSearch('s1', params);
    await runSearch('s1', params, makeDeps(db, events));

    expect(db.getSearch('s1')?.status).toBe('done');
    expect(db.getPool('s1')).toHaveLength(1);
    expect(db.getVotes('s1')).toHaveLength(2); // 2 lenses x 1 replica
    expect(db.getResults('s1')?.results).toHaveLength(1);

    const phases = events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['intake', 'acquisition', 'voting', 'consensus']);
    expect(events.at(-1)).toMatchObject({ type: 'done', resultCount: 1, partial: false });
  });

  it('stops voting when the token budget is exceeded (partial consensus)', async () => {
    db.createSearch('s1', { ...params, tokenBudget: 1050 }); // intake 100 + 1 vote 1000 > budget
    await runSearch('s1', { ...params, tokenBudget: 1050 }, makeDeps(db, events));

    expect(db.getVotes('s1').length).toBeLessThan(2);
    expect(events.at(-1)).toMatchObject({ type: 'done', partial: true });
    expect(events.some((e) => e.type === 'agent' && e.status === 'skipped')).toBe(true);
  });

  it('a failing adapter does not kill the search', async () => {
    db.createSearch('s1', params);
    const deps = makeDeps(db, events, {
      adapters: [
        { name: 'broken', tier: 'api', search: async () => Promise.reject(new Error('boom')) },
        { name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'ok' as const, listings: [listing] }) },
      ],
    });
    await runSearch('s1', params, deps);
    expect(db.getSearch('s1')?.status).toBe('done');
    expect(events.some((e) => e.type === 'adapter' && e.portal === 'broken' && e.status === 'error')).toBe(true);
  });

  it('empty pool ends the search with an error event', async () => {
    db.createSearch('s1', params);
    const deps = makeDeps(db, events, {
      adapters: [{ name: 'argenprop', tier: 'scraper', search: async () => ({ status: 'blocked' as const, listings: [] }) }],
    });
    await runSearch('s1', params, deps);
    expect(db.getSearch('s1')?.status).toBe('error');
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('a failing voting agent loses its vote but not the search', async () => {
    db.createSearch('s1', params);
    const deps = makeDeps(db, events, {
      vote: jest
        .fn<SearchDeps['vote']>()
        .mockRejectedValueOnce(new Error('agent died'))
        .mockResolvedValue({ vote: { lens: 'espacio', replica: 1, verdicts: [{ id: 'l1', verdict: 'match', reason: 'ok' }] }, tokens: 10 }),
    });
    await runSearch('s1', params, deps);
    expect(db.getSearch('s1')?.status).toBe('done');
    expect(db.getVotes('s1')).toHaveLength(1);
    expect(events.some((e) => e.type === 'agent' && e.status === 'error')).toBe(true);
  });
});
```

Run: `pnpm run test:unit -- __tests__/search`
Expected: FAIL.

- [ ] **Step 4: Implementar `src/server/search.ts`**

```ts
import { scoreListings } from './consensus';
import { LENSES, type Lens } from './llm/lenses';
import type { SearchDb } from './db';
import type { PortalAdapter } from './adapters/types';
import type { runIntake } from './llm/intake';
import type { runVotingAgent } from './llm/vote';
import type { NormalizedListing, SearchEvent, SearchParams } from '~/types';

export interface SearchDeps {
  db: SearchDb;
  adapters: PortalAdapter[];
  intake: typeof runIntake;
  vote: typeof runVotingAgent;
  emit: (e: SearchEvent) => void;
  lenses?: Lens[];
  concurrency?: number;
  quorumMin?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_QUORUM_MIN = 4;

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runSearch(id: string, params: SearchParams, deps: SearchDeps): Promise<void> {
  const { db, emit } = deps;
  const lenses = deps.lenses ?? LENSES;
  let tokensUsed = 0;
  const trackTokens = (n: number) => {
    tokensUsed += n;
    emit({ type: 'tokens', total: tokensUsed, budget: params.tokenBudget });
  };

  try {
    // 1. INTAKE
    db.setStatus(id, 'intake');
    emit({ type: 'phase', phase: 'intake' });
    const { criteria, tokens: intakeTokens } = await deps.intake(params.description);
    trackTokens(intakeTokens);
    db.saveCriteria(id, criteria);
    emit({ type: 'criteria', criteria });

    // 2. ACQUISITION (adapters are isolated: one failing doesn't kill the search)
    db.setStatus(id, 'acquisition');
    emit({ type: 'phase', phase: 'acquisition' });
    const byId = new Map<string, NormalizedListing>();
    for (const adapter of deps.adapters) {
      emit({ type: 'adapter', portal: adapter.name, status: 'running' });
      try {
        const result = await adapter.search(criteria);
        for (const l of result.listings) byId.set(l.id, l);
        emit({ type: 'adapter', portal: adapter.name, status: result.status, count: result.listings.length, detail: result.detail });
      } catch (err) {
        emit({ type: 'adapter', portal: adapter.name, status: 'error', detail: err instanceof Error ? err.message : 'unknown' });
      }
    }
    const pool = [...byId.values()];
    if (pool.length === 0) {
      db.setStatus(id, 'error');
      emit({ type: 'error', message: 'Ningún portal devolvió avisos (¿bloqueo o sin resultados?)' });
      return;
    }
    db.savePool(id, pool);

    // 3. VOTING (budget is a hard circuit breaker checked before each agent)
    db.setStatus(id, 'voting');
    emit({ type: 'phase', phase: 'voting' });
    const jobs = lenses.flatMap((lens) => Array.from({ length: params.replicas }, (_, i) => ({ lens, replica: i + 1 })));
    let partial = false;
    await mapWithConcurrency(jobs, deps.concurrency ?? DEFAULT_CONCURRENCY, async ({ lens, replica }) => {
      if (tokensUsed >= params.tokenBudget) {
        partial = true;
        emit({ type: 'agent', lens: lens.key, replica, status: 'skipped' });
        return;
      }
      emit({ type: 'agent', lens: lens.key, replica, status: 'running' });
      try {
        const { vote, tokens } = await deps.vote({ lens, replica, criteria, pool });
        trackTokens(tokens);
        db.saveVote(id, vote);
        emit({ type: 'agent', lens: lens.key, replica, status: 'ok' });
      } catch {
        emit({ type: 'agent', lens: lens.key, replica, status: 'error' });
      }
    });

    // 4. CONSENSUS (pure code)
    db.setStatus(id, 'consensus');
    emit({ type: 'phase', phase: 'consensus' });
    const output = scoreListings(pool, db.getVotes(id), {
      threshold: params.threshold,
      quorumMin: deps.quorumMin ?? DEFAULT_QUORUM_MIN,
    });
    db.saveResults(id, output);
    db.setStatus(id, 'done');
    emit({ type: 'done', resultCount: output.results.length, degraded: output.degraded, partial });
  } catch (err) {
    db.setStatus(id, 'error');
    emit({ type: 'error', message: err instanceof Error ? err.message : 'unknown error' });
  }
}
```

- [ ] **Step 5: Correr los tests y verlos pasar**

Run: `pnpm run test:unit -- __tests__/search`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/events.ts src/server/search.ts src/server/__tests__
git commit -m "feat: search orchestrator with token circuit breaker and live events"
```

---

### Task 10: API routes (POST búsqueda, SSE, resultado)

**Files:**
- Create: `src/app/api/search/route.ts`, `src/app/api/search/[id]/route.ts`, `src/app/api/search/[id]/events/route.ts`

- [ ] **Step 1: Crear `src/app/api/search/route.ts`**

```ts
import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { argenpropAdapter } from '~/server/adapters/argenprop';
import { getDb } from '~/server/db';
import { emitSearchEvent } from '~/server/events';
import { runIntake } from '~/server/llm/intake';
import { runVotingAgent } from '~/server/llm/vote';
import { runSearch } from '~/server/search';
import type { SearchParams } from '~/types';

export const dynamic = 'force-dynamic';

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const description = String(body.description ?? '').trim();
  if (description.length < 30) {
    return NextResponse.json({ error: 'La descripción debe tener al menos 30 caracteres' }, { status: 400 });
  }

  const params: SearchParams = {
    description,
    replicas: clampInt(body.replicas, 1, 4, 1),
    threshold: clampFloat(body.threshold, 0, 1, 0.6),
    tokenBudget: clampInt(body.tokenBudget, 50_000, 5_000_000, 500_000),
  };

  const id = randomUUID();
  const db = getDb();
  db.createSearch(id, params);

  void runSearch(id, params, {
    db,
    adapters: [argenpropAdapter],
    intake: runIntake,
    vote: runVotingAgent,
    emit: (e) => emitSearchEvent(id, e),
  }).catch((err) => {
    console.error(`search ${id} crashed:`, err);
  });

  return NextResponse.json({ id });
}
```

- [ ] **Step 2: Crear `src/app/api/search/[id]/events/route.ts`** (SSE: replay del buffer + eventos en vivo; cierra en done/error)

```ts
import { getBuffer, subscribe } from '~/server/events';
import type { SearchEvent } from '~/types';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: SearchEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (e.type === 'done' || e.type === 'error') {
          closed = true;
          unsub();
          controller.close();
        }
      };
      const unsub = subscribe(id, send);
      for (const e of getBuffer(id)) send(e);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
```

- [ ] **Step 3: Crear `src/app/api/search/[id]/route.ts`**

```ts
import { NextResponse } from 'next/server';
import { getDb } from '~/server/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  const search = db.getSearch(id);
  if (!search) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ search, results: db.getResults(id) ?? null });
}
```

- [ ] **Step 4: Verificación de compilación**

Run: `pnpm run lint && pnpm run build`
Expected: OK. (El smoke end-to-end real se hace en la Task 11 con la UI.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api
git commit -m "feat: search api with sse progress stream"
```

---

### Task 11: UI — formulario, panel de progreso y resultados

Sin tests unitarios de UI en este plan (no hay testing-library instalada; el e2e llega en el Plan 3). Verificación manual al final de la task.

**Files:**
- Create: `src/containers/Search/SearchPage.tsx`, `src/containers/Search/SearchForm.tsx`, `src/containers/Search/ProgressPanel.tsx`, `src/containers/Search/ResultsList.tsx`, `src/containers/Search/index.ts`
- Modify: `src/containers/Landing.tsx`, `src/containers/index.ts`

- [ ] **Step 1: Crear `src/containers/Search/SearchForm.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { Button, MenuItem, Select, Slider, Stack, TextField, Typography } from '@mui/material';
import type { SearchParams } from '~/types';

const DEPTHS = [
  { replicas: 1, label: 'Económico — 6 agentes (1 por lente)' },
  { replicas: 2, label: 'Medio — 12 agentes (2 por lente)' },
  { replicas: 4, label: 'Profundo — 24 agentes (4 por lente)' },
];

const BUDGETS = [
  { value: 200_000, label: '200k tokens' },
  { value: 500_000, label: '500k tokens' },
  { value: 1_500_000, label: '1.5M tokens' },
];

type Props = {
  disabled: boolean;
  onSubmit: (params: SearchParams) => void;
};

export const SearchForm = ({ disabled, onSubmit }: Props) => {
  const [description, setDescription] = useState('');
  const [replicas, setReplicas] = useState(1);
  const [threshold, setThreshold] = useState(0.6);
  const [tokenBudget, setTokenBudget] = useState(500_000);

  return (
    <Stack spacing={2} width='100%' maxWidth='72rem'>
      <TextField
        multiline
        minRows={5}
        label='Describí el inmueble que buscás (cuanto más detalle, mejor)'
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={disabled}
        inputProps={{ 'data-testid': 'description-input' }}
      />
      <Stack direction='row' spacing={2} alignItems='center'>
        <Select value={replicas} onChange={(e) => setReplicas(Number(e.target.value))} disabled={disabled} size='small'>
          {DEPTHS.map((d) => (
            <MenuItem key={d.replicas} value={d.replicas}>
              {d.label}
            </MenuItem>
          ))}
        </Select>
        <Select value={tokenBudget} onChange={(e) => setTokenBudget(Number(e.target.value))} disabled={disabled} size='small'>
          {BUDGETS.map((b) => (
            <MenuItem key={b.value} value={b.value}>
              {b.label}
            </MenuItem>
          ))}
        </Select>
        <Stack flex={1} px={2}>
          <Typography variant='caption'>Threshold de consenso: {Math.round(threshold * 100)}%</Typography>
          <Slider min={0.2} max={1} step={0.1} value={threshold} onChange={(_, v) => setThreshold(v as number)} disabled={disabled} size='small' />
        </Stack>
        <Button
          variant='contained'
          disabled={disabled || description.trim().length < 30}
          onClick={() => onSubmit({ description: description.trim(), replicas, threshold, tokenBudget })}
          data-testid='search-button'
        >
          Buscar
        </Button>
      </Stack>
    </Stack>
  );
};
```

- [ ] **Step 2: Crear `src/containers/Search/ProgressPanel.tsx`** (el "estado tipo Claude Code": fases, adapters, grilla de agentes, contador de tokens)

```tsx
'use client';

import { Chip, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import type { AdapterEventStatus, AgentEventStatus, SearchEvent, SearchPhase } from '~/types';

const PHASES: { key: SearchPhase; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'acquisition', label: 'Adquisición' },
  { key: 'voting', label: 'Votación' },
  { key: 'consensus', label: 'Consenso' },
];

const AGENT_COLOR: Record<AgentEventStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  running: 'info',
  ok: 'success',
  error: 'error',
  skipped: 'warning',
};

const ADAPTER_COLOR: Record<AdapterEventStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  running: 'info',
  ok: 'success',
  blocked: 'warning',
  error: 'error',
};

type Props = { events: SearchEvent[] };

export const ProgressPanel = ({ events }: Props) => {
  const currentPhase = [...events].reverse().find((e) => e.type === 'phase') as { phase: SearchPhase } | undefined;
  const phaseIdx = PHASES.findIndex((p) => p.key === currentPhase?.phase);
  const doneEvent = events.find((e) => e.type === 'done');

  const adapters = new Map<string, { status: AdapterEventStatus; count?: number; detail?: string }>();
  const agents = new Map<string, AgentEventStatus>();
  let tokens: { total: number; budget: number } | undefined;

  for (const e of events) {
    if (e.type === 'adapter') adapters.set(e.portal, { status: e.status, count: e.count, detail: e.detail });
    if (e.type === 'agent') agents.set(`${e.lens}#${e.replica}`, e.status);
    if (e.type === 'tokens') tokens = { total: e.total, budget: e.budget };
  }

  return (
    <Paper variant='outlined' sx={{ p: 2, width: '100%', maxWidth: '72rem' }} data-testid='progress-panel'>
      <Stack spacing={1.5}>
        <Stack direction='row' spacing={1}>
          {PHASES.map((p, i) => (
            <Chip
              key={p.key}
              label={`${i < phaseIdx || doneEvent ? '✓' : i === phaseIdx ? '⟳' : '·'} ${p.label}`}
              color={i < phaseIdx || doneEvent ? 'success' : i === phaseIdx ? 'info' : 'default'}
              size='small'
            />
          ))}
        </Stack>

        {adapters.size > 0 && (
          <Stack direction='row' spacing={1} alignItems='center'>
            <Typography variant='caption'>Portales:</Typography>
            {[...adapters.entries()].map(([portal, a]) => (
              <Chip
                key={portal}
                size='small'
                color={ADAPTER_COLOR[a.status]}
                label={`${portal}${a.count !== undefined ? ` (${a.count})` : ''}${a.status === 'blocked' ? ' ⚠ bloqueado' : ''}`}
              />
            ))}
          </Stack>
        )}

        {agents.size > 0 && (
          <Stack direction='row' spacing={0.5} flexWrap='wrap' useFlexGap>
            {[...agents.entries()].map(([key, status]) => (
              <Chip key={key} size='small' variant='outlined' color={AGENT_COLOR[status]} label={key} />
            ))}
          </Stack>
        )}

        {tokens && (
          <Stack spacing={0.5}>
            <Typography variant='caption'>
              Tokens: {tokens.total.toLocaleString()} / {tokens.budget.toLocaleString()}
            </Typography>
            <LinearProgress variant='determinate' value={Math.min(100, (tokens.total / tokens.budget) * 100)} />
          </Stack>
        )}

        {events
          .filter((e) => e.type === 'error')
          .map((e, i) => (
            <Typography key={i} color='error' variant='body2'>
              {(e as { message: string }).message}
            </Typography>
          ))}
      </Stack>
    </Paper>
  );
};
```

- [ ] **Step 3: Crear `src/containers/Search/ResultsList.tsx`**

```tsx
'use client';

import { Accordion, AccordionDetails, AccordionSummary, Chip, Link, Paper, Stack, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ScoredListing } from '~/types';

type Props = {
  results: ScoredListing[];
  degraded: boolean;
  partial: boolean;
};

export const ResultsList = ({ results, degraded, partial }: Props) => {
  return (
    <Stack spacing={1.5} width='100%' maxWidth='72rem' data-testid='results'>
      <Typography variant='h6'>
        {results.length} resultados con consenso
        {degraded ? ' — ⚠ degradado (pocos lentes respondieron)' : ''}
        {partial ? ' — ⚠ parcial (se agotó el presupuesto de tokens)' : ''}
      </Typography>
      {results.map((r) => (
        <Paper key={r.listing.id} variant='outlined' sx={{ p: 2 }}>
          <Stack spacing={1}>
            <Stack direction='row' spacing={1} alignItems='center'>
              <Chip size='small' color='success' label={`${r.matchedLenses}/${r.totalLenses} lentes`} />
              {r.redFlag && <Chip size='small' color='warning' label='⚠ red flag' />}
              <Link href={r.listing.url} target='_blank' rel='noopener noreferrer'>
                {r.listing.title}
              </Link>
            </Stack>
            <Typography variant='body2'>
              {r.listing.price.currency} {r.listing.price.amount.toLocaleString()} · {r.listing.barrio}
              {r.listing.ambientes ? ` · ${r.listing.ambientes} amb` : ''}
              {r.listing.m2 ? ` · ${r.listing.m2} m²` : ''}
            </Typography>
            <Accordion disableGutters variant='outlined'>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant='caption'>Por qué entró (votos por lente)</Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={0.5}>
                  {r.reasons.map((reason, i) => (
                    <Typography key={i} variant='caption'>
                      <b>{reason.lens}</b> #{reason.replica} → {reason.verdict}: {reason.reason}
                    </Typography>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Paper>
      ))}
    </Stack>
  );
};
```

- [ ] **Step 4: Crear `src/containers/Search/SearchPage.tsx`** (máquina de estados + EventSource)

```tsx
'use client';

import { useCallback, useRef, useState } from 'react';
import { Stack } from '@mui/material';
import { ProgressPanel } from './ProgressPanel';
import { ResultsList } from './ResultsList';
import { SearchForm } from './SearchForm';
import type { ScoredListing, SearchEvent, SearchParams } from '~/types';

type Phase = 'idle' | 'running' | 'done';

interface ResultsState {
  results: ScoredListing[];
  degraded: boolean;
  partial: boolean;
}

export const SearchPage = () => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [events, setEvents] = useState<SearchEvent[]>([]);
  const [results, setResults] = useState<ResultsState | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const start = useCallback(async (params: SearchParams) => {
    setPhase('running');
    setEvents([]);
    setResults(null);

    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const { error } = (await res.json().catch(() => ({ error: 'error' }))) as { error: string };
      setEvents([{ type: 'error', message: error }]);
      setPhase('done');
      return;
    }
    const { id } = (await res.json()) as { id: string };

    const source = new EventSource(`/api/search/${id}/events`);
    sourceRef.current = source;
    source.onmessage = async (msg) => {
      const event = JSON.parse(msg.data) as SearchEvent;
      setEvents((prev) => [...prev, event]);
      if (event.type === 'done' || event.type === 'error') {
        source.close();
        if (event.type === 'done') {
          const data = (await (await fetch(`/api/search/${id}`)).json()) as {
            results: { results: ScoredListing[]; degraded: boolean } | null;
          };
          setResults({
            results: data.results?.results ?? [],
            degraded: data.results?.degraded ?? false,
            partial: event.partial,
          });
        }
        setPhase('done');
      }
    };
    source.onerror = () => {
      source.close();
      setPhase('done');
    };
  }, []);

  return (
    <Stack spacing={3} alignItems='center' width='100%' py={4}>
      <SearchForm disabled={phase === 'running'} onSubmit={start} />
      {events.length > 0 && <ProgressPanel events={events} />}
      {results && <ResultsList results={results.results} degraded={results.degraded} partial={results.partial} />}
    </Stack>
  );
};
```

- [ ] **Step 5: Crear `src/containers/Search/index.ts`** y wirear

```ts
export * from './SearchPage';
```

Reescribir `src/containers/Landing.tsx`:

```tsx
'use client';

import { styled } from '@mui/material/styles';
import { SearchPage } from './Search';
import { DISCLAIMER_HEIGHT, SURROUND_HEIGHT } from '~/utils';

export const Landing = () => {
  return (
    <LandingContainer>
      <SearchPage />
    </LandingContainer>
  );
};

const LandingContainer = styled('div')({
  display: 'flex',
  flexDirection: 'column',
  minHeight: `calc(100vh - ${SURROUND_HEIGHT}rem - ${DISCLAIMER_HEIGHT}rem)`,
  padding: '0 8rem',
  alignItems: 'center',
  width: '100%',
});
```

Agregar a `src/containers/index.ts`:

```ts
export * from './Search';
```

- [ ] **Step 6: Verificar compilación**

Run: `pnpm run lint && pnpm run build`
Expected: OK.

- [ ] **Step 7: Smoke test end-to-end manual (consume cuota real, ~100-300k tokens en nivel Económico)**

```bash
pnpm run dev
```

En el browser (`http://localhost:3000`):
1. Pegar una descripción real, p.ej.: *"Busco departamento en alquiler en Palermo o Villa Crespo, 2 ambientes, con balcón, hasta $900.000 por mes, que acepte mascotas, luminoso, no planta baja."*
2. Elegir "Económico", presupuesto 500k, threshold 60%. Click **Buscar**.
3. Verificar el panel: fases avanzando (Intake ✓ → Adquisición con chip `argenprop (N)` → Votación con chips de agentes cambiando a verde → Consenso ✓), contador de tokens moviéndose.
4. Verificar resultados: lista de links a Argenprop con score X/5 lentes, expandir un resultado y ver los `reason` por lente.
5. Si `argenprop` aparece `⚠ bloqueado`: el sitio bloqueó el fetch server-side — anotarlo (el fallback de agentes web llega en Plan 2) y verificar al menos que el error se reporta limpio.

- [ ] **Step 8: Commit**

```bash
git add src/containers src/app
git commit -m "feat: search ui with live progress panel and consensus results"
```

---

### Task 12: Verificación final del plan

- [ ] **Step 1: Suite completa**

Run: `pnpm run lint && pnpm run prettier && pnpm run test:unit && pnpm run build`
Expected: todo verde. Si prettier marca archivos, correr `pnpm run prettier:fix` y re-verificar.

- [ ] **Step 2: Revisar que no quedaron restos**

```bash
grep -rn "wagmi\|rainbowkit\|viem" src/ package.json || echo "clean"
git status
```

Expected: `clean`, working tree sin archivos sin trackear inesperados (`.data/` ignorado, `scripts/smoke-vote.ts` borrado).

- [ ] **Step 3: Commit final si quedó algo suelto**

```bash
git add -A && git commit -m "chore: plan 1 final cleanup" || echo "nothing to commit"
```

---

## Notas para el ejecutor

- **No setear `ANTHROPIC_API_KEY`** en el entorno: el Agent SDK debe resolver la autenticación vía la sesión de Claude Code (suscripción). Si ambos están presentes el comportamiento puede diferir del esperado.
- **Selectores de Argenprop**: son la parte frágil. El contrato es el test de fixture — si falla tras re-grabar el fixture, se ajusta `SEL`, nunca los asserts.
- **Tipos del Agent SDK**: si `options.outputFormat` o los campos del mensaje `result` difieren de lo escrito acá, la fuente de verdad son los tipos del paquete instalado en `node_modules/@anthropic-ai/claude-agent-sdk/` — adaptar el código a los tipos reales, no suprimir errores con `as any`.
- **Costo de verificación**: solo las Tasks 7 (Step 5) y 11 (Step 7) tocan la cuota real. Todo lo demás corre con mocks/fixtures.

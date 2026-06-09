# Búsqueda de calidad: gates duros + evaluación por requisito — Design Doc

**Fecha:** 2026-06-09
**Estado:** Aprobado en brainstorming
**Contexto:** Plan 2 sobre el MVP (`2026-06-06-inmuebles-agent-search-design.md`). Reemplaza el núcleo de matching (votación por lentes genéricos + consenso fraccional) por **gates duros + ranking por requisitos atómicos con evidencia**. La visión (analizar fotos) queda como Plan 3, fuera de este spec.

## Problema que resuelve

El MVP trataba todo como voto blando: `score = fracción de lentes que dijeron match`. Un must-have como "≥165 m²" era un voto entre cinco, así que un depto de 50 m² en el barrio y precio correctos sacaba 3/5 ≥ threshold y **aparecía igual**, incumpliendo lo innegociable. Tres fallas encadenadas:

1. No había **gate de requisitos duros** — un must-have restaba un voto en vez de eliminar.
2. No había **pre-filtro estructural** — los m²/precio/ambientes que el intake extraía nunca se usaban para descartar.
3. **Dato faltante = `unsure` = no penalizaba.**

Además los lentes eran genéricos (una línea cada uno), no perseguían *cada palabra* de la descripción.

## Decisiones tomadas (brainstorming)

| Decisión | Elección |
| --- | --- |
| Modelo de matching | **Gates duros (AND) que filtran + nice-to-haves que rankean** |
| Unidad de evaluación | **Requisito atómico** extraído de la descripción, no lente genérico |
| Dato faltante en un must-have | **Excluir (estricto)**: sin evidencia, no califica |
| Datos por aviso | **Abrir la página de detalle de cada aviso** (descripción completa + amenities), con throttling |
| Quién evalúa qué | Numérico → **código** (gratis, exacto); textual → **LLM con evidencia obligatoria** |
| Consenso multi-agente | Réplicas confirmando **cada must-have textual**, ancladas en cita |
| Lente `holistico` | **Eliminado** (redundante con la evaluación por-requisito) |
| Lente `red-flags` | **Se mantiene como marcador** ⚠ (veto suave, no gate) |
| Visión (fotos) | **Fuera de alcance** — Plan 3 |
| Restricción rectora | Igual que el MVP: local, sin `ANTHROPIC_API_KEY`, suscripción Claude Code, costo mínimo |

## Arquitectura

```
DESCRIPCIÓN libre
   ↓
1. INTAKE (Sonnet)         → SearchCriteria { base scraping + Requirement[] }
   ↓                          (UI: panel editable, override must↔nice antes de buscar)
2. ADQUISICIÓN (+ detalle) → pool enriquecido: por cada candidato se abre su página
   ↓                          de detalle (concurrencia limitada + throttle)
3. GATES NUMÉRICOS (código)→ estricto: falla o dato faltante → FUERA (con motivo)
   ↓                          achica el pool ANTES de gastar tokens
4. EVALUACIÓN TEXTUAL (LLM)→ por sobreviviente: R réplicas Haiku evalúan cada requisito
   ↓                          textual con EVIDENCIA obligatoria (cita del aviso)
5. COMBINAR + RANKEAR      → must-haves = AND duro; nice-to-haves = score ponderado
   ↓                          buckets de exclusión por motivo
UI: checklist por aviso (cada ✅ con su cita) + desglose de exclusiones
```

Reusa del MVP: SQLite, eventos SSE, circuit breaker de tokens, patrón de adapters, patrón de agentes con Agent SDK (dynamic import, json_schema, evidencia anti-alucinación).

## Componentes

### 1. Intake v2 — descomposición en requisitos atómicos

```typescript
interface Requirement {
  id: string;
  label: string;              // "al menos 165 m²", "acepta mascotas", "mesada de mármol"
  hardness: 'must' | 'nice';
  kind: 'numeric' | 'textual';
  predicate?: { field: 'm2' | 'price' | 'ambientes' | 'expensas'; op: '>=' | '<=' | '=='; value: number };
  statement?: string;         // textual: "el aviso indica que acepta mascotas"
  weight?: number;            // nice-to-have: peso en el ranking (default 1)
}

interface SearchCriteria {
  operation: 'alquiler' | 'venta';
  propertyType: 'departamento' | 'casa' | 'ph';
  barrios: string[];
  currency: 'ARS' | 'USD';
  requirements: Requirement[];
  rawDescription: string;
}
```

- Clasifica `hardness` por lenguaje: "al menos / sí o sí / necesito / imprescindible / mínimo" → `must`; "ojalá / preferiblemente / estaría bueno" → `nice`. Cuantificado y concreto → tiende a `must`; adjetivos blandos → `nice`.
- Numéricos: "165 metros" → `{field:'m2', op:'>=', value:165}`; "hasta 900 mil" → `{field:'price', op:'<=', value:900000}`; "3 dormitorios" → `{field:'ambientes', op:'>=', value:3}` (lean `>=` salvo "exactamente").
- Modelo: Sonnet, una llamada, `outputFormat: json_schema`.
- **Override del usuario**: la UI muestra cada requisito con su tag y permite flipear must↔nice (y ajustar peso de los nice) antes de disparar la búsqueda.

### 2. Adquisición v2 — fetch de detalle por aviso

- Lista (como hoy) → por cada candidato del pool, fetch de su página de detalle con **concurrencia limitada (~4-6)** y throttle, para ser cortés y no gatillar Cloudflare.
- Parser de detalle (cheerio, selectores como constantes, testeado contra **fixture grabado** de una página real).
- Enriquece `NormalizedListing`:

```typescript
interface NormalizedListing {
  // ...campos del MVP...
  detailDescription?: string;   // descripción completa de la página de detalle
  amenities?: string[];         // lista de amenities del detalle
  dataSource: 'card' | 'detail'; // 'card' si el detalle falló y se cayó a la tarjeta
}
```

- Si el detalle de un aviso falla (timeout/bloqueo): cae a datos de tarjeta, `dataSource:'card'`, se sigue. Bloqueo masivo → adapter reporta `blocked` (igual que MVP).

### 3a. Gates numéricos — código

Para cada must-have numérico, evalúa el predicado contra el campo estructurado del aviso enriquecido. Estricto:
- cumple → pasa
- no cumple → FUERA, motivo `"50 m² < 165 requerido"`
- campo `null`/faltante → FUERA, motivo `"m² no informado"`

Cero tokens, determinístico. Corre sobre el pool ya enriquecido y lo achica antes de la evaluación textual.

### 3b. Evaluación textual — LLM con evidencia obligatoria

A los sobrevivientes de 3a, un agente Haiku evalúa cada requisito textual (must duros + todos los nice) contra `detailDescription + amenities + description`. Por requisito:

```typescript
type Verdict = 'met' | 'not_met' | 'unknown';
interface RequirementVerdict {
  requirementId: string;
  verdict: Verdict;
  evidence: string | null;     // cita textual del aviso; obligatoria para 'met'
}
```

- **Evidencia obligatoria**: un `met` sin cita → se degrada a `unknown`.
- **Validación de evidencia en código**: la cita debe ser substring (normalizado: lowercase, espacios colapsados) del texto del aviso; si no aparece, se degrada a `unknown` (anti-alucinación de 2º nivel).
- Model: Haiku, `maxTurns: 4` (lección del MVP: structured output sobre payload grande necesita varios turnos), `outputFormat: json_schema`, abort 90s.

### 3c. Consenso por requisito (réplicas)

- Parámetro de profundidad de la UI = **réplicas por aviso** (1/2/4).
- Un must-have textual pasa el gate solo si la **mayoría de las réplicas** dicen `met` con evidencia válida.
- Empate o mayoría `unknown`/`not_met` → el must-have no pasa.

### 4. Combinar y rankear

- **Gate = AND duro**: sobrevive solo el aviso que pasa TODOS los must-haves (numéricos y textuales). Un solo fallo → afuera, con motivo.
- **Ranking de sobrevivientes**:

```
niceScore(aviso) = Σ peso(nice-to-have CUMPLIDO con evidencia) / Σ peso(todos los nice-to-haves)
orden: niceScore desc → desempate: precio asc
```

- `red-flags`: marcador ⚠ (veto suave), no gate.
- **"No cumple" vs "no se pudo evaluar"**: el modelo diciendo `unknown`/`not_met` → exclusión legítima (estricto). Un agente que **falla** (error/timeout) en un must-have → el aviso va a bucket **"no se pudo evaluar"** con el error, NO se descarta como incumplidor.
- **Buckets de exclusión por motivo**: se acumulan para la UI (`12 por m²<165 · 8 por m² no informado · 6 por no confirmar mascotas`).

```typescript
interface EvaluatedListing {
  listing: NormalizedListing;
  passed: boolean;
  requirementResults: RequirementVerdict[];  // incluye los numéricos resueltos en código
  niceScore: number;            // 0..1
  redFlag: boolean;
  partialData: boolean;         // dataSource === 'card'
}
interface ExclusionBucket { reason: string; count: number; listingIds: string[]; }
interface SearchOutput {
  survivors: EvaluatedListing[];    // ordenados por niceScore desc, precio asc
  exclusions: ExclusionBucket[];
  unevaluable: { listingId: string; error: string }[];
  degraded: boolean;                // < quórum de requisitos evaluables
}
```

### 5. UI

**Antes de buscar — panel de requisitos editable** (extiende el resumen de criterios del MVP): cada requisito como chip con su tag y dropdown `must ▾/nice ▾` (+ peso para los nice). Disparar habilitado con descripción ≥ 30 chars.

> **`SearchParams` cambia**: se **elimina `threshold`** (ya no hay score fraccional con umbral; el gate es AND duro). `replicas` se mantiene como "profundidad" (réplicas por aviso, 1/2/4). `tokenBudget` se mantiene.

**Resultados — checklist con evidencia por aviso**:
- Encabezado: título · precio · m² · ambientes · `4/5 deseables`.
- Sección MUST: cada uno ✅ con su cita/dato (todos verdes por construcción).
- Sección NICE: ✅/❌ con cita o "sin mención".
- ⚠ red flag si aplica; badge "datos parciales" si `partialData`.
- Link al aviso.

**Arriba de la lista — desglose**: `39 evaluados → 13 sobreviven` + buckets de exclusión + `⚠ N no se pudieron evaluar [reintentar]`.

**Panel de progreso (SSE)** con fases nuevas: `Intake → Adquisición (+detalle) → Gates numéricos → Evaluación textual → Ranking`.

### 6. Errores

- Fetch detalle: concurrencia limitada + throttle; falla individual → cae a tarjeta (`partialData`); bloqueo masivo → `blocked`.
- Gates numéricos: código, no fallan; `null` → exclusión determinística.
- Evaluación textual: schema con retry 1×; veredicto irrecuperable → `unknown`; must-have inevaluable por error → bucket "no se pudo evaluar" (no exclusión). Agente >90s → cancela.
- Evidencia inválida (no es substring) → degrada a `unknown`.
- Circuit breaker de tokens: se mantiene; corta evaluación con consenso parcial.

## Testing

| Capa | Estrategia |
| --- | --- |
| Intake → requisitos | Unit con SDK mockeado: descripciones → `Requirement[]` esperado (must/nice, numeric/textual, predicados) |
| Parser de detalle | Unit contra **fixture grabado** de una página de detalle real de Argenprop |
| Gates numéricos | Unit puro: cumple/no cumple/faltante → exclusión con motivo (incluye el caso ≥165 que regresionó) |
| Validación de evidencia | Unit: cita substring → `met`; cita inventada → `unknown` |
| Evaluación textual | Unit con SDK mockeado: réplicas, mayoría con evidencia, error vs unknown |
| Ranking / buckets | Unit puro: orden por niceScore + desempate precio, buckets por motivo, unevaluable separado |
| Orquestador | Unit con deps inyectadas (mocks): pipeline completo, gate AND, partialData, circuit breaker |
| Smoke e2e | 1 corrida real: descripción con must-have ≥165 m² → chicos excluidos, sobrevivientes con evidencia |

## Archivos (estimado)

- **Modificar**: `src/types/search.ts` (Requirement, SearchCriteria v2, EvaluatedListing, SearchOutput, SearchEvent fases), `src/server/llm/intake.ts` (requisitos), `src/server/adapters/argenprop/{normalize,parse,index}.ts` (detalle), `src/server/search.ts` (orquestación nueva), `src/server/db.ts` (persistir requirements/evaluations/exclusions), UI `SearchForm`/`ResultsList`/`ProgressPanel`.
- **Crear**: `src/server/adapters/argenprop/detail.ts` + fixture, `src/server/gates.ts`, `src/server/llm/evaluate.ts`, `src/server/evidence.ts`, `src/server/ranking.ts`.
- **Eliminar / reemplazar**: `src/server/consensus.ts` → `ranking.ts`; `src/server/llm/vote.ts` + `lenses.ts` → `evaluate.ts` (el lente `holistico` se elimina; `red-flags` se reimplementa como marcador dentro de la evaluación).

## Fuera de alcance (Plan 3)

- **Visión**: analizar fotos de los avisos para verificar features visuales (mármol, luminosidad, estado real). Solo sobre finalistas que pasaron los gates de texto, 1-3 fotos clave, para acotar el costo de tokens de imagen.
- Adapters MercadoLibre (API oficial) y Zonaprop (agente web) + dedup cross-portal.
- Feature de audio→texto (subir audio, transcribir con Whisper local, usar como descripción) — diferida.

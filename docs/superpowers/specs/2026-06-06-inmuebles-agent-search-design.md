# Búsqueda de inmuebles por consenso de agentes — Design Doc

**Fecha:** 2026-06-06
**Estado:** Aprobado en brainstorming, pendiente de plan de implementación

## Resumen

App web local para research personal de inmuebles en Buenos Aires. El usuario escribe una
descripción detallada del inmueble que busca (único input). El sistema arma un pool de
candidatos desde múltiples portales y un conjunto de agentes LLM independientes —cada uno
con un "lente" de evaluación distinto— vota cada candidato contra la descripción. Solo se
muestran los listings que superan un threshold de consenso.

**Restricción rectora:** el compute LLM sale de la suscripción Claude del trabajo (vía
Claude Code / Agent SDK), por lo que el diseño minimiza consumo de cuota de forma agresiva.
Enfoque elegido: **"fetch once, vote many" con lentes diversos** (enfoque C del brainstorming).

## Decisiones tomadas

| Decisión | Elección |
| --- | --- |
| Compute LLM | Suscripción del trabajo vía Agent SDK; agentes votantes en Haiku, intake en Sonnet |
| Obtención de datos | Cascada por portal: API oficial → scraper propio → agente con web search |
| Deployment | 100% local: Next.js en localhost, backend usa la sesión local de Claude Code |
| Patrón de uso | Búsquedas profundas puntuales + iteración rápida de la descripción (con cache) |
| Arquitectura de agentes | Lentes especializados con réplicas, no clones idénticos |
| Consenso | Código determinístico (conteo de votos), nunca un agente agregador |

## Arquitectura

```
Browser (localhost:3000)
  │  UI: textarea descripción + parámetros (profundidad, threshold,
  │      presupuesto de tokens, toggle por portal)
  │  Panel de progreso en vivo (SSE)
  ▼  POST /api/search  +  GET /api/search/:id/events (SSE)
Backend local (Next.js API routes)
  1. INTAKE       Sonnet parsea descripción → SearchCriteria estructurado
  2. ADQUISICIÓN  Adapters en cascada (1 vez por búsqueda) → pool normalizado
  3. VOTACIÓN     N agentes Haiku (Agent SDK), 1+ réplicas por lente
  4. CONSENSO     Agregación determinística en código
  ▼
SQLite local (better-sqlite3): pools cacheados, votos, estado de búsqueda
```

- El repo actual (boilerplate web3 de Wonderland) se conserva como base Next.js 15 + MUI +
  React Query. **Se eliminan las dependencias web3**: wagmi, RainbowKit, viem y providers
  asociados.
- El paso 4 es código puro: contar votos con un LLM sería gastar cuota sin valor.
- SQLite habilita el caso "iteración rápida": refinar la descripción re-vota sobre el pool
  cacheado sin re-fetchear portales.

## Componentes

### Adapters de adquisición

Interfaz común; agregar/sacar portales no toca el resto del sistema:

```typescript
interface PortalAdapter {
  name: string;                          // 'mercadolibre' | 'argenprop' | 'zonaprop'
  tier: 'api' | 'scraper' | 'agent';     // costo característico
  search(criteria: SearchCriteria): Promise<RawListing[]>;
}

interface NormalizedListing {
  id: string;            // hash de URL canónica → clave de dedup
  url: string;
  portal: string;
  title: string;
  price: { amount: number; currency: 'ARS' | 'USD' };
  expensas?: number;
  barrio: string;
  ambientes?: number;
  m2?: number;
  features: string[];
  description: string;   // truncada a ~150 palabras
  publishedAt?: string;
}
```

- **MercadoLibre** (`api`): API oficial con OAuth de app registrada. Tokens ≈ 0.
- **Argenprop** (`scraper`): fetch + parseo de HTML en código. Tokens ≈ 0.
- **Zonaprop** (`agent`): detrás de Cloudflare → agente con web search que devuelve JSON.
  Único adapter caro (~60-100k tokens); desactivable desde la UI.
- **Dedup cross-portal**: misma propiedad en 2 portales se detecta por similitud
  (dirección + m2 + precio) y se fusiona, para que no vote dos veces.

### Lentes (el ejército de agentes)

Cada lente es un agente Haiku con prompt especializado. Set inicial de 6:

| Lente | Qué juzga |
| --- | --- |
| `ubicacion` | Barrio, cercanía a transporte/puntos mencionados |
| `precio` | Precio + expensas vs presupuesto, precio razonable por zona |
| `espacio` | Ambientes, m2, distribución, balcón/patio/cochera |
| `condicion` | Estado del inmueble, antigüedad, "a refaccionar" escondido |
| `red-flags` | Fotos viejas/genéricas, descripción vaga, precio sospechosamente bajo |
| `holistico` | Evaluación de conjunto contra la descripción original |

- Input por agente: criterios + pool completo en JSON compacto.
- Output por listing (structured output): `{ id, verdict: 'match' | 'reject' | 'unsure', reason }`.
  El veredicto ternario separa "no matchea" de "falta información"; los `unsure` no suman
  ni restan al score.
- El parámetro de profundidad de la UI = **réplicas por lente**: económico 6 (1×),
  medio 12 (2×), profundo 24 (4×). Las réplicas del mismo lente varían por sampling
  (self-consistency dentro de cada perspectiva).

### Consenso

```
score(listing) = lentes con mayoría 'match' / lentes totales
se muestra si score ≥ threshold (default 4/6, ajustable en UI)
orden: score desc; los `reason` de cada lente son visibles al expandir el resultado
```

- `red-flags` tiene **veto suave**: con consenso de red flag, el listing se muestra
  marcado con ⚠️ en lugar de ocultarse.

### Panel de progreso en vivo

La UI muestra el estado de la búsqueda en tiempo real, estilo progreso de Claude Code:

- Fases como timeline: `Intake ✓ → Adquisición (ML ✓ · Argenprop ⟳ · Zonaprop ✗ blocked)
  → Votación (7/12 agentes) → Consenso`.
- Por agente votante: lente, réplica, estado (pendiente/corriendo/ok/error/timeout).
- Contador de tokens acumulado vs presupuesto configurado.
- Transporte: los eventos ya viajan por SSE (`GET /api/search/:id/events`); el panel
  los renderiza. Sin detalle excesivo: el objetivo es ver de un vistazo si va todo bien
  o algo falló.

## Estrategia de costos (cuota de suscripción)

Presupuesto por búsqueda (pool de referencia: ~100 candidatos × ~400 tokens ≈ 40k):

| Paso | Modelo | Tokens |
| --- | --- | --- |
| Intake | Sonnet | ~3-5k |
| ML API + scraper | — | 0 |
| Agente Zonaprop (opcional) | Haiku | ~60-100k |
| Votación (ver abajo) | Haiku | ~90-270k con caching |
| Consenso | — | 0 |

| Nivel | Agentes | Nominal | Con prompt caching |
| --- | --- | --- | --- |
| Económico | 6 | ~330k Haiku | ~90k |
| Medio | 12 | ~660k Haiku | ~150k |
| Profundo | 24 | ~1.3M Haiku | ~270k |

Palancas de costo, en orden de impacto:

1. **Prompt caching por estructura de prompt**: prefijo idéntico `[criterios + pool JSON]`
   compartido por los N agentes; el sufijo `[instrucción del lente]` va al final. El costo
   de votación pasa de O(N × pool) a O(pool + N × lente). Invertir el orden anula el cache.
2. **Normalización a JSON compacto**: ~400 tokens/listing vs ~40k del HTML crudo.
3. **Haiku para todo el volumen**; Sonnet solo en la llamada única de intake.
4. **Cache de pool en SQLite**: iterar la descripción re-vota sin re-adquirir
   (~150k Haiku por iteración en nivel medio).
5. **Presupuesto de tokens como circuit breaker** (ver errores).

Día de uso intensivo estimado (1 búsqueda profunda + Zonaprop + 5 iteraciones):
~1M tokens casi todo Haiku — fracción menor de una ventana de 5hs.

## Manejo de errores

- **Adapters aislados con timeout**: un portal caído no tumba la búsqueda; la UI reporta
  `⚠ portal no disponible`. Distinción explícita entre `blocked` (challenge de Cloudflare,
  HTML sin listings) y `0 resultados` — significan cosas opuestas para el usuario.
- **Circuit breaker de tokens**: contador acumulado por búsqueda; al superar el límite de
  la UI se corta la votación con los votos emitidos → resultado marcado "consenso parcial".
- **Votación robusta**: structured output con schema; veredicto malformado → 1 retry →
  descarte del agente. Quórum mínimo de 4 lentes respondiendo; por debajo, la búsqueda se
  marca degradada. Agente colgado >90s se cancela.
- **Estado persistente**: cada búsqueda escribe pool → votos → consenso a SQLite a medida
  que avanza; un proceso muerto retoma desde lo último persistido.

## Testing

Stack existente: Jest (unit) + Playwright (e2e).

| Capa | Estrategia |
| --- | --- |
| Normalización + dedup | Unit tests con fixtures reales de HTML/JSON por portal (detectan cambios de formato del portal) |
| Consenso/scoring | Unit tests puros: thresholds, quórum, veto red-flags, empates |
| Adapters | Tests contra fixtures grabados (sin red); smoke test opcional contra portales reales, fuera de CI |
| Votación | Mock del Agent SDK; se testea orquestación (paralelismo, timeouts, contador de tokens) |
| E2E | 1 flujo Playwright: descripción → resultados, con adapters y SDK mockeados |

No se testea la calidad de juicio de los lentes; se evalúa usando la app, con los `reason`
de cada voto como herramienta de debugging de prompts.

## Fuera de alcance (v1)

- Monitoreo continuo / cron de búsquedas guardadas (el diseño no lo impide: el cache
  incremental por `publishedAt` sería la base).
- Acceso remoto (la app es local-only por la autenticación de suscripción).
- Más portales que MercadoLibre, Argenprop y Zonaprop.
- Evaluación de fotos con visión (los lentes juzgan solo texto/metadata en v1).

# Evaluación por lotes + Tasación CABA — Design Doc

**Fecha:** 2026-06-12
**Estado:** Aprobado en brainstorming
**Contexto:** Plan 3 sobre el sistema actual (MVP + Plan 2 de calidad). Dos partes independientes pero complementarias: (1) optimización del consumo de tokens del pipeline de búsqueda; (2) nueva feature de tasación de inmuebles para CABA. Research de metodología + verificación factual de precios completados (2026-06-12, agentes con web search; tabla consolidada abajo).

---

# Parte 1 — Optimización: evaluación por lotes

## Problema (medido, no estimado)

Cada llamada al Agent SDK levanta una sesión de Claude Code con **~25-30k tokens de overhead fijo** (system prompt + maquinaria de structured output). Medición real del smoke del MVP: 1 agente evaluando 1 aviso = **31.545 tokens**, de los cuales ~1.500 eran contenido útil. El Plan 2 evalúa **un aviso por llamada**: 12 sobrevivientes × 2 réplicas = 24 llamadas ≈ **840k tokens** (95% overhead). Además, las llamadas paralelas no comparten prompt cache (todas pagan la escritura porque arrancan simultáneas).

Los modelos ya son óptimos y NO cambian: Haiku (`claude-haiku-4-5`, el Claude más barato) para el volumen, Sonnet (`claude-sonnet-4-6`) solo para la única llamada "inteligente" (intake). La palanca es la estructura de llamadas.

## Solución: chunks de avisos por llamada

- `runEvaluator` pasa de evaluar 1 aviso a evaluar un **chunk de hasta 12 avisos** por llamada (`CHUNK_SIZE = 12`).
- Jobs del orquestador: de `sobrevivientes × réplicas` a `chunks × réplicas`.
- Schema de salida: `{ results: [{ listingId, verdicts: [{requirementId, verdict, evidence}] }] }` — un grupo de veredictos por aviso del chunk.
- El prompt lista los N avisos con su `listingId`; las reglas de evidencia obligatoria no cambian.
- `EVALUATE_MAX_TURNS` sube de 4 a 6 (output más grande); timeout sube a 180s por chunk.
- `ESTIMATED_EVAL_TOKENS` se recalibra a ~50k por chunk (reserva optimista, se reconcilia con el real).
- Eventos SSE: se mantiene la granularidad por aviso — al resolverse un chunk se emite `eval` ok/error por cada aviso contenido.
- Guardas: si la respuesta incluye `listingId`s que no están en el chunk se ignoran; un aviso del chunk ausente en la respuesta queda sin evaluación para esa réplica (el ranking ya lo trata como unknown/inevaluable).
- **El rigor no cambia**: gates numéricos gratis primero, evidencia validada por substring en ranking, mayoría por réplicas con denominador = réplicas esperadas. Solo cambia cuántos avisos viajan por llamada.

## Resultado esperado

```
HOY:    12 avisos × 2 réplicas = 24 llamadas × ~35k  ≈ 840k tokens
BATCH:  1 chunk(12) × 2 réplicas =  2 llamadas × ~45k ≈  90k tokens   (~9-10×)
```

Búsqueda económica (1 réplica) ≈ 45-60k; profunda (4 réplicas) ≈ 180-240k.

---

# Parte 2 — Tasación de departamentos CABA (venta, USD)

## Decisiones tomadas (brainstorming + research)

| Decisión | Elección |
| --- | --- |
| Alcance | **Solo valor de VENTA en USD** (valor locativo = futuro) |
| Tipo de propiedad | **Solo departamentos** en v1. Casa/PH → rechazo con mensaje claro (la tabla de precios es de departamentos; dinámica distinta — limitación honesta del research) |
| Metodología | **Método Comparativo de Mercado** (Norma TTN 3.1, estándar argentino) con tabla de valor m² por barrio como base + coeficientes correctores de la práctica profesional |
| Depreciación | **Ross-Heidecke** (Norma TTN 4.1) aplicado SOLO al componente construcción (~45% del valor; el suelo no deprecia) |
| Brecha publicado→cierre | **Co = 0,9486** (brecha −5,14%, UCEMA Índice M2 Real enero 2026 — verificado) |
| División LLM/código | LLM (Sonnet, **1 sola llamada**) extrae atributos de la descripción; **TODO el cálculo es código puro** (cero tokens, auditable) |
| Datos | Empaquetados y **versionados con fuente + fecha por valor**; solo valores **verificados con fetches reales** (2026-06-12); actualización manual mensual documentada |
| Honestidad | Rango ±15%, chip de confianza, disclaimer "estimación automática, no reemplaza tasación profesional" |

## Arquitectura

```
Descripción libre → POST /api/tasacion
  1. EXTRACCIÓN (Sonnet, json_schema, maxTurns 2 — única llamada LLM)
     → TasacionInput: barrio, m² por tipo, piso, ascensor, frente/contrafrente,
       antigüedad, estado (escala Heidecke), cochera, baulera, amenities,
       categoría constructiva, aEstrenar, tipoPropiedad. Campo ausente = null (NO inventa).
  2. MOTOR (código puro, src/server/tasacion/engine.ts):
     a. supHom = cub×1.0 + semicub×0.5 + balcón×0.33 + descub×0.2 + baulera(4m²)×0.35
     b. precioBase = PRECIOS_BARRIO[barrio]            (USD/m² publicado, versionado)
     c. precioAjustado = precioBase × cPiso × cUbicacion × cCalidad × cEscala × cAmenities
     d. valorMCM = precioAjustado × Co × supHom         (Co: publicado → cierre)
     e. + valorCochera                                   (suma fija por barrio)
     f. × cAntiguedad = 1 − (K_RossHeidecke × 0.45)     (solo componente construcción)
     g. × cEstrenar (1.10 si aEstrenar — supuesto documentado)
  3. SALIDA TasacionResult: valorEstimadoUsd (redondeado a centenas), rango ±15%,
     confianza (alta/media/baja según datos presentes), breakdown completo
     (cada coeficiente con su valor aplicado), metadatos de la tabla de precios
     (fuente + fecha) y lista de supuestos activados.
```

## Tablas de coeficientes (constantes estables — fuente: práctica TTN / Tasador Pampeano)

- **Superficies**: cubierta 1,00 · semicubierta 0,50 · balcón 0,33 · descubierta 0,20 · baulera 0,35 (4 m² si "tiene baulera" sin metraje).
- **Piso (con ascensor)**: PB 0,90 · 1° 0,95 · 2° 0,98 · 3° 1,00 (base) · +0,02/piso hasta 1,15 (piso 10+). **Sin ascensor**: PB 1,00 y −0,05 por piso.
- **Ubicación en planta**: frente 1,00 · lateral 0,94 · contrafrente 0,85 · interno 0,80.
- **Calidad constructiva**: económica 0,90 · estándar 1,00 · buena 1,10 · buena c/servicios centrales 1,20 · muy buena/premium 1,35.
- **Escala por superficie** (interpolación lineal): 25m² 1,35 · 40m² 1,25 · 50m² 1,15 · 60m² 1,08 · 75m² 1,02 · 85m² 1,00 (base) · 110m² 0,96 · 150m²+ 0,90.
- **Amenities**: ninguno 1,00 · básicos (1-2: sum/laundry/parrilla) 1,05 · completos (3+: pileta/gym/seguridad) 1,10.
- **Ross-Heidecke** (tabla K por %vida × estado, interpolación lineal; estados Heidecke 1,0=excelente · 2,0=bueno · 2,5=normal · 3,0=regular · 3,5=malo): tabla representativa del research (filas 0-100% cada 10%). Vida útil: hormigón armado 100 años (default CABA).
- **cEstrenar**: 1,10 si a estrenar [SUPUESTO documentado].

## Datos versionados (src/server/tasacion/data/*.json — SOLO valores verificados 2026-06-12)

`precios-barrio.json` (USD/m² **publicado**, departamentos):

| Barrio | USD/m² | Fuente | Fecha |
|---|---|---|---|
| Puerto Madero | 6140 | Zonaprop (vía Revista Mercado) | 2026-05 |
| Palermo | 3403 | Zonaprop (vía Revista Mercado) | 2026-05 |
| Núñez | 3392 | Zonaprop (vía La Nación) | 2026-05 |
| Saavedra | 2852 | Zonaprop (vía La Nación) | 2026-05 |
| Colegiales | 2679 | Mudafy/Metrafy | 2026-01 |
| Belgrano | 2526 | Mudafy | 2026-01 |
| Recoleta | 2459 | Mudafy | 2026-01 |
| Villa Crespo | 2085 | Mudafy | 2026-01 |
| Caballito | 1952 | Mudafy | 2026-01 |
| Almagro | 1818 | Mudafy | 2026-01 |
| Constitución | 1802 | Zonaprop (vía La Nación) | 2026-05 |
| Flores | 1652 | Mudafy | 2026-01 |
| Nueva Pompeya | 1459 | Zonaprop (vía Revista Mercado) | 2026-05 |
| Villa Lugano | 1058 | Zonaprop (vía La Nación) | 2026-05 |
| _CABA promedio (fallback)_ | 2460 | Zonaprop (vía Revista Mercado/La Nación) | 2026-05 |

- Barrio sin entrada en la tabla → usa el fallback CABA promedio y **baja la confianza a "baja"** + lo declara en el breakdown. Matching de barrio: normalizado (lowercase, sin acentos) + alias comunes ("Lugano"→"Villa Lugano", "Barrio Norte"→"Recoleta", "Palermo Soho/Hollywood/Las Cañitas"→"Palermo").
- `config-mercado.json`: `{ co: 0.9486, fuente: "UCEMA Índice M2 Real", fecha: "2026-01", brecha: "-5.14%" }`.
- `cocheras.json` (USD, punto medio de rangos verificados; default 25000 [SUPUESTO] para barrios sin dato): Puerto Madero 50000 · Palermo 42500 · Recoleta 36000 · Colegiales 35000 · Belgrano 32500 · Caballito 30000 (dato puntual 36.9k tomado conservador).
- README corto en `data/` con instrucciones de actualización mensual (Zonaprop Index, informe UCEMA) y las URLs fuente.

## Confianza

```
score = 100 − (sin m² cubiertos: −25) − (sin antigüedad: −10) − (sin estado: −10)
            − (sin piso: −5) − (sin ubicación en planta: −5) − (barrio por fallback: −30)
alta ≥ 85 · media ≥ 60 · baja < 60      (sin barrio Y sin m² → 400, no se tasa)
```

## API y UI

- **POST `/api/tasacion`** `{ description }` → `{ input: TasacionInput, result: TasacionResult }`. 400 si descripción < 30 chars, si no se detecta barrio ni m², o si `tipoPropiedad !== 'departamento'` (mensaje explicando la limitación v1). `runtime='nodejs'`, `dynamic='force-dynamic'`. Sin SSE (la tasación tarda ~10-30s, una sola llamada — request/response simple con estado de carga en UI).
- **UI**: tabs MUI en la página principal — **`Buscar | Tasar`** (la búsqueda actual se mueve dentro del primer tab sin cambios). Tab Tasar: textarea + botón "Tasar" → tarjeta de resultado: valor grande USD + rango, chip de confianza, chips de lo que se interpretó (barrio, m², piso...), breakdown expandible (tabla coeficiente → valor → efecto) con fuente+fecha de la tabla de precios, lista de supuestos aplicados, y disclaimer fijo: *"Estimación automática (±15%) basada en valores publicados de mercado. No reemplaza una tasación profesional."*

## Errores y testing

- Extracción: mismo patrón que intake (getQuery de sdk.ts, json_schema, throw en subtype ≠ success); el handler de la ruta lo traduce a 500 con mensaje.
- Motor: función pura — barrio desconocido → fallback declarado; valores absurdos (m² > 1000, antigüedad > 120) → se acotan con clamps documentados en el breakdown.
- Testing: **unit exhaustivo del motor** (homogeneización, interpolación de escala y Ross-Heidecke, cada coeficiente, fallback de barrio, clamps, confianza — el módulo más testeable del proyecto); extracción con SDK mockeado; data files validados por un test de schema (todo barrio tiene precio>0, fuente y fecha); batch-eval: tests de chunking (partición, réplicas, respuesta con ids extra/faltantes) + actualización de los tests existentes de evaluate/search; 1 smoke e2e real de tasación (descripción → valor razonable para el barrio) y 1 de búsqueda batch.

## Costos

| Operación | Llamadas LLM | Tokens aprox |
|---|---|---|
| Tasación | 1 (Sonnet extracción) | ~8-12k |
| Búsqueda económica (batch) | 1 intake + 1-2 chunks | ~45-90k |
| Búsqueda profunda 4× (batch) | 1 intake + 4-8 chunks | ~180-300k |

## Fuera de alcance

- Valor locativo (alquiler), casas/PH, sub-barrios (Palermo Soho vs Hollywood), comparables en vivo desde el pool de búsqueda (cuando MercadoLibre API destrabe la adquisición, los comparables reales pueden reemplazar/calibrar la tabla estática), actualización automática de las tablas de precios.

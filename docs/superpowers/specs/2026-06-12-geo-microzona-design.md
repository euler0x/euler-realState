# Micro-zona geográfica + guía de confianza + guardar tasación — Design Doc

**Fecha:** 2026-06-12
**Estado:** Aprobado en brainstorming (enfoque A: procesamiento pesado una vez en build-time, consulta gratis en runtime)
**Contexto:** Plan 4 sobre la tasación (Plan 3). Tres features: (1) guía en la UI de qué falta para subir la confianza; (2) granularidad sub-barrio por calle y altura con "radio inteligente" que respeta barreras urbanas; (3) guardar tasación (historial SQLite + export PNG con mapa). Disponibilidad de datos verificada con fetches reales el 2026-06-12.

## Decisiones tomadas

| Decisión | Elección |
| --- | --- |
| Enfoque micro-zona | **A: micro-índice relativo anclado** — script de build una vez, índice commiteado, lookup O(1) en runtime. Rechazado B (LLM como juez geográfico: alucinación) y diferido C (comparables en vivo, requiere ML API) |
| Servicios externos | **USIG** (geocoder oficial GCBA, gratis sin key — verificado funcionando) + **tiles OpenStreetMap** (política verificada: permitido bajo volumen con atribución, User-Agent y cache) |
| Guardado | **Historial en SQLite + export PNG** de la tarjeta (con mapa) |
| Staleness | Los datos geolocalizados llegan a **2020** (GCBA). Se usa SOLO el patrón espacial RELATIVO (precio de la celda vs mediana de su barrio en su año), anclado a los precios de barrio ACTUALES (tabla 2026). Disclaimer obligatorio en la UI |
| Costo de tokens | **Cero adicional** — todo lo geo es código + datos empaquetados; la única llamada LLM sigue siendo la extracción |

## Datos verificados (2026-06-12, fetches reales)

- **GCBA "Departamentos en Venta"** (`data.buenosaires.gob.ar/dataset/departamentos-venta`): avisos 2001-2020 con `latitud`, `longitud`, `preciousdm` (USD/m²), `m2cub`, `barrios_1`, CSV por año descargable (patrón `cdn.buenosaires.gob.ar/datosabiertos/datasets/secretaria-de-desarrollo-urbano/departamentos-venta/departamentos-en-venta-{año}.csv`). **Insumo del índice.**
- **USIG normalizador**: `https://servicios.usig.buenosaires.gob.ar/normalizar/?direccion=...&geocodificar=true` → `direccionesNormalizadas[0].coordenadas` con **x=LONGITUD, y=LATITUD (invertido — cuidado)**, SRID 4326, + `direccion` normalizada.
- **Capas GeoJSON GCBA**: red de ferrocarril (vías) ✓, estaciones subte/líneas ✓, espacios verdes ✓, barrios populares (villas) ✓, polígonos de 48 barrios ✓.
- **Autopistas**: SIN capa GCBA dedicada → en build-time se extrae de OSM Overpass (`highway=motorway` en bbox CABA) o del dataset `calles` filtrado por tipo de vía — lo que funcione, documentado en el script.
- **Mapa**: `staticmap.openstreetmap.de` caído → **Leaflet + tiles OSM dinámicos** (atribución "© OpenStreetMap contributors", `crossOrigin` para el export).

## Parte 1 — Micro-índice geográfico

### Build-time: `scripts/build-geo-index.ts` (se corre UNA vez; el output se commitea, los CSVs crudos NO)

```
1. Descargar CSVs GCBA "departamentos en venta" años 2014-2020 (cache local en /tmp o scripts/.cache gitignoreado)
2. Descargar barreras: vías FFCC (GeoJSON GCBA) + autopistas (Overpass highway=motorway o `calles` filtrado)
3. Limpieza por aviso: lat/lon dentro del bbox CABA, 200 < preciousdm < 20000, 20 ≤ m2cub ≤ 500
4. rel = preciousdm / mediana(preciousdm del MISMO barrio en el MISMO año)
   ← elimina inflación y drift de nivel; queda solo la geografía. Clamp rel ∈ [0.4, 2.5]
5. Grilla: celda ~166m — dLat = 0.0015°, dLon = 0.0018° (corrección cos(-34.6°));
   clave = `${floor(lat/dLat)}_${floor(lon/dLon)}`
6. Por celda: mediana de rel + count
7. SUAVIZADO CON BARRERAS (el "radio inteligente", resuelto en build-time):
   celdas con count < MIN_SAMPLES (8) → BFS sobre las 8 vecinas hasta profundidad 3,
   donde la arista entre dos celdas se BLOQUEA si el segmento entre sus centros
   intersecta una polilínea de barrera (FFCC/autopista; intersección segmento-segmento
   en código puro). Se agregan los rel de las celdas alcanzables hasta juntar
   MIN_SAMPLES; multiplicador = mediana del pool; flag smoothed = true
8. Celdas que ni suavizadas llegan a MIN_SAMPLES → fuera del índice (runtime cae a ×1.0)
9. Clamp multiplicador final ∈ [0.7, 1.4] (conservador)
10. Output:
    - src/server/tasacion/data/micro-index.json
      { meta: {fuente, años, generado, dLat, dLon, minSamples, clamps},
        cells: { "<clave>": [multiplicador(3dp), count, smoothed?1:0] } }   (~150-300KB)
    - src/server/tasacion/data/barreras.geojson (polilíneas simplificadas, para debug/mapa)
```

- Los helpers geométricos del script viven en `src/server/tasacion/geo-build.ts` (importables y testeables): `cellKey`, `medianRel`, `segmentsIntersect`, `bfsSmoothing`. El script `scripts/build-geo-index.ts` solo orquesta descargas + escribe archivos.
- devDependency: `csv-parse` (parseo robusto de los CSV del GCBA).
- `data/README.md` se actualiza con cómo regenerar el índice.

### Runtime: `src/server/tasacion/geo.ts` (cero tokens)

```typescript
export interface GeoContext {
  lat: number;
  lon: number;
  direccionNormalizada: string;
  multiplicador: number;  // 1.0 si la celda no está en el índice
  avisos: number;         // count efectivo de la celda (0 si sin datos)
  smoothed: boolean;
}

geocodeUSIG(direccion): Promise<{lat, lon, direccionNormalizada} | null>
  // fetch USIG con timeout 8s; x→lon, y→lat (¡invertido!); null ante cualquier fallo
microLookup(lat, lon): {multiplicador, avisos, smoothed} | null  // lookup O(1) en micro-index.json
```

### Integración con el motor

- `TasacionInput` += `direccion: string | null` (la extracción la captura: "calle y altura, ej 'Pedro Goyena 600'"; null si no aparece).
- El **route** orquesta: extracción → si hay `direccion`: `geocodeUSIG` → `microLookup` → arma `GeoContext | null` → `tasar(input, geo)`. El **motor sigue puro** (recibe el contexto, no hace I/O).
- Motor: `precioBaseMicro = barrio.usdM2 × geo.multiplicador` (el multiplicador actúa sobre el precio/m², antes del resto de coeficientes). Breakdown:
  - Con datos: `"Micro-zona (PEDRO GOYENA AV. 600): ×1.15 — 43 avisos históricos (GCBA 2014-2020, patrón espacial relativo)"` + nota si smoothed.
  - Sin celda: `×1.00 — sin datos históricos suficientes en la cuadra` + supuesto.
- **Confianza v2** (ajuste aditivo al esquema actual): sin `direccion` → −10; `direccion` que no geocodifica → −10 + supuesto; celda sin datos → −5 + supuesto. (Una descripción completa CON dirección y micro-datos = 100; la misma sin dirección = 90, sigue "alta" — gentil pero empuja a darla.)
- `TasacionResult` += `ubicacion: { lat, lon, direccionNormalizada, multiplicador, avisos, smoothed } | null` y `mejoras: Mejora[]`.

## Parte 2 — Guía de confianza en la UI

`src/server/tasacion/mejoras.ts` — función pura que deriva la checklist de los campos `null`/estado geo, rankeada por impacto:

```typescript
export interface Mejora { campo: string; sugerencia: string; impacto: string }
```

| Disparador | Sugerencia | Impacto |
| --- | --- | --- |
| `direccion` null o no geocodificada | "Agregá calle y altura (ej: Pedro Goyena 600)" | "hasta ±25% por micro-zona" |
| `antiguedadAnios` null | "Indicá los años de antigüedad" | "hasta ±15%" |
| `estadoConservacion` null | "Describí el estado (a estrenar / muy bueno / original / a refaccionar)" | "hasta ±15%" |
| `piso` null | "Decí el piso (y si hay ascensor)" | "hasta ±20%" |
| `ubicacionPlanta` null | "¿Frente, contrafrente o interno?" | "hasta −20%" |
| `categoriaConstructiva` null | "Categoría del edificio (estándar / de categoría con servicios / torre premium)" | "hasta +35%" |
| `m2Balcon` null | "Si tiene balcón, indicá los m²" | "suma directa" |
| `tieneCochera` false | "Si tiene cochera, decilo explícitamente" | "+USD 25-50 mil" |
| `amenities` vacío | "Mencioná amenities si los hay (pileta, gym, sum…)" | "hasta +10%" |

- El route la incluye en `TasacionResult.mejoras`; la UI la muestra como panel "**Para mejorar esta tasación**" debajo del resultado (solo los items disparados, en orden de la tabla).
- El textarea del tab Tasar pasa a tener como placeholder la **plantilla ideal** de descripción.

## Parte 3 — Guardar tasación

- **DB** (`db.ts`): tabla `tasaciones (id TEXT PK, fecha TEXT default now, description TEXT, input TEXT, result TEXT)` + métodos `saveTasacion(id, description, input, result)`, `getTasaciones(): TasacionListItem[]` (id, fecha, dirección/barrio, valor, confianza — parseado del JSON), `getTasacion(id)`.
- **API**: `POST /api/tasaciones` (guarda lo que devolvió el tasador; app local single-user, el cliente manda el payload completo), `GET /api/tasaciones` (lista resumida), `GET /api/tasaciones/[id]` (completa). Node runtime, force-dynamic.
- **UI**:
  - Botón **"Guardar"** en la tarjeta de resultado → POST → feedback "guardada".
  - **Historial** colapsable en el tab Tasar (lista: fecha · dirección/barrio · USD valor · chip confianza) → click reabre la tasación completa en la tarjeta.
  - Botón **"Exportar PNG"** → `html-to-image` (`toPng`) sobre la tarjeta → descarga `tasacion-YYYY-MM-DD-<barrio>.png`. Incluye el mapa.
- **Mapa**: Leaflet plano (sin react-leaflet) en un `useEffect` (client-only), marker en `ubicacion`, tiles `https://tile.openstreetmap.org/{z}/{x}/{y}.png` con atribución obligatoria y `crossOrigin: 'anonymous'` (para que el canvas del export no se manche). Si el export falla por CORS/taint → fallback: aviso al usuario para usar imprimir.
- Deps nuevas (runtime): `leaflet`, `html-to-image` (+ `@types/leaflet` dev). MIT, sin keys.

## Errores

- USIG caído/timeout/dirección no encontrada → tasación continúa a nivel barrio, supuesto declarado, mejora sugerida. NUNCA bloquea.
- Celda fuera del índice → ×1.00 + supuesto.
- Tiles OSM caídos → el mapa muestra el contenedor con la atribución y el pin no carga; la tasación no depende del mapa.
- Export PNG falla → mensaje con alternativa (imprimir).
- Build script: valida que el índice resultante tenga ≥ 1000 celdas y multiplicadores dentro de los clamps antes de escribir; si una descarga falla, aborta con mensaje claro (no escribe índice parcial).

## Testing

| Capa | Estrategia |
| --- | --- |
| geo-build helpers | Unit puro: `cellKey`, mediana, **`segmentsIntersect`** (casos: cruce, paralelo, colineal, toque en extremo), **`bfsSmoothing` con barrera** (el test "la vía parte el barrio": dos clusters de rel distintos separados por una polilínea → la celda pobre de un lado NO absorbe datos del otro) |
| micro-index.json | Test de schema sobre el archivo commiteado: ≥1000 celdas, multiplicadores ∈ [0.7,1.4], meta completa |
| geo.ts | `geocodeUSIG` con fetch mockeado (éxito con x/y invertido, timeout, dirección inexistente); `microLookup` contra fixture chico |
| engine v2 | Multiplicador aplicado al precio base; confianza con/sin dirección; breakdown con línea micro-zona |
| mejoras | Unit: cada disparador produce su item, orden correcto, input completo → lista vacía (salvo cochera false/amenities vacío según reglas) |
| db | Round-trip tasaciones + lista resumida |
| UI/rutas | lint + build; smoke real: tasación con "Pedro Goyena 600, Caballito" → línea micro-zona visible, guardar, historial, export PNG |

## Fuera de alcance

- Comparables en vivo (enfoque C — al llegar MercadoLibre API).
- Features de distancia a subte/espacios verdes como coeficientes explícitos (el patrón histórico ya los captura implícitamente; las capas quedan descargadas para un futuro).
- Regeneración automática/periódica del índice (manual, documentada).
- Valor locativo, casas/PH (siguen fuera desde v1).

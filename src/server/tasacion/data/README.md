# Datos de mercado para tasación — actualización mensual

| Archivo               | Qué actualizar                     | Fuente                                                                                                                                                      |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `precios-barrio.json` | USD/m² publicado por barrio        | Zonaprop Index: https://www.zonaprop.com.ar/blog/zpindex/ (o cobertura de prensa) · Mudafy: https://mudafy.com.ar/d/valor-metro-cuadrado-en-caba-por-barrio |
| `config-mercado.json` | `co` = 1 + brecha publicado→cierre | UCEMA Índice M2 Real: https://ucema.edu.ar/novedad/ultimo-informe-indice-metro-cuadrado-real                                                                |
| `cocheras.json`       | Valor cochera por barrio           | Prensa (La Nación propiedades) / REMAX                                                                                                                      |

Reglas: claves de barrio en minúsculas y sin acentos; cada valor lleva `fuente` y `fecha`; NO cargar valores sin verificar la fuente.

---

## Índice geográfico micro-zona (generado, no editar manualmente)

| Archivo            | Descripción                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `micro-index.json` | Índice de multiplicadores geográficos por celda (~166 m × ~166 m) |
| `barreras.geojson` | Líneas de FFCC y autopistas usadas como barreras durante el build |

**Regeneración:** `npx tsx scripts/build-geo-index.ts` (~20-30 min en primera corrida; reintentos baratos por caché en `scripts/.cache/`). Descarga GCBA Departamentos en Venta 2012-2016 + red FFCC del portal de datos de GCBA.

**Fuentes:**

- GCBA Departamentos en Venta 2012-2016: `data.buenosaires.gob.ar/dataset/departamentos-venta` (CSVs con lat/lon; 2017-2020 excluidos por ausencia de coordenadas en el CSV)
- Red de Ferrocarril GCBA: `data.buenosaires.gob.ar/dataset/estaciones-ferrocarril` (GeoJSON de polilíneas)
- Autopistas OSM: Overpass API, `highway=motorway` en bbox CABA (opcional; si Overpass falla se usa solo FFCC)

**Semántica del multiplicador:** el índice es un **patrón espacial RELATIVO** — el multiplicador de cada celda representa cuánto se desvía esa micro-zona respecto a la mediana de su barrio (p. ej., 1.10 = 10% sobre la mediana del barrio). NO son precios absolutos de 2012-2016. En el motor de tasación, el multiplicador se aplica sobre el precio de publicación 2026 de `precios-barrio.json`, que está actualizado a valores de mercado actuales. El patrón geográfico relativo es estable en el tiempo (el frente de una plaza sigue siendo más caro que el fondo de una calle cortada).

**Clamp:** multiplicador acotado a [0.7, 1.4]; celdas sin datos suficientes retornan ×1.0 en runtime.

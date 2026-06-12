# Datos de mercado para tasación — actualización mensual

| Archivo               | Qué actualizar                     | Fuente                                                                                                                                                      |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `precios-barrio.json` | USD/m² publicado por barrio        | Zonaprop Index: https://www.zonaprop.com.ar/blog/zpindex/ (o cobertura de prensa) · Mudafy: https://mudafy.com.ar/d/valor-metro-cuadrado-en-caba-por-barrio |
| `config-mercado.json` | `co` = 1 + brecha publicado→cierre | UCEMA Índice M2 Real: https://ucema.edu.ar/novedad/ultimo-informe-indice-metro-cuadrado-real                                                                |
| `cocheras.json`       | Valor cochera por barrio           | Prensa (La Nación propiedades) / REMAX                                                                                                                      |

Reglas: claves de barrio en minúsculas y sin acentos; cada valor lleva `fuente` y `fecha`; NO cargar valores sin verificar la fuente.

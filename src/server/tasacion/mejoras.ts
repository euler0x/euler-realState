import type { Mejora, TasacionInput, UbicacionInfo } from '~/types';

/**
 * Checklist determinística "para mejorar esta tasación": derivada de los campos ausentes
 * del input y del estado de la geocodificación. Cero LLM. Orden = impacto en el valor.
 */
export function derivarMejoras(input: TasacionInput, geo: UbicacionInfo | null): Mejora[] {
  const m: Mejora[] = [];
  if (!geo) {
    m.push({
      campo: 'direccion',
      sugerencia: input.direccion
        ? `La dirección "${input.direccion}" no se pudo geocodificar — probá con formato "calle altura" (ej: Pedro Goyena 600)`
        : 'Agregá calle y altura (ej: Pedro Goyena 600) para tasar la micro-zona exacta',
      impacto: 'hasta ±25% por micro-zona',
    });
  }
  if (input.antiguedadAnios === null) {
    m.push({ campo: 'antiguedadAnios', sugerencia: 'Indicá los años de antigüedad', impacto: 'hasta ±15%' });
  }
  if (input.estadoConservacion === null) {
    m.push({
      campo: 'estadoConservacion',
      sugerencia: 'Describí el estado (a estrenar / muy bueno / original / a refaccionar)',
      impacto: 'hasta ±15%',
    });
  }
  if (input.piso === null) {
    m.push({ campo: 'piso', sugerencia: 'Decí el piso (y si hay ascensor)', impacto: 'hasta ±20%' });
  }
  if (!input.ubicacionPlanta) {
    m.push({ campo: 'ubicacionPlanta', sugerencia: '¿Frente, contrafrente o interno?', impacto: 'hasta −20%' });
  }
  if (!input.categoriaConstructiva) {
    m.push({
      campo: 'categoriaConstructiva',
      sugerencia: 'Categoría del edificio (estándar / de categoría con servicios / torre premium)',
      impacto: 'hasta +35%',
    });
  }
  if (input.m2Balcon === null) {
    m.push({ campo: 'm2Balcon', sugerencia: 'Si tiene balcón, indicá los m²', impacto: 'suma directa' });
  }
  if (!input.tieneCochera) {
    m.push({ campo: 'tieneCochera', sugerencia: 'Si tiene cochera, decilo explícitamente', impacto: '+USD 25-50 mil' });
  }
  if (input.amenities.length === 0) {
    m.push({
      campo: 'amenities',
      sugerencia: 'Mencioná amenities si los hay (pileta, gym, sum…)',
      impacto: 'hasta +10%',
    });
  }
  return m;
}

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

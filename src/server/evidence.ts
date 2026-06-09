/** Normaliza para comparar: lowercase + colapsa espacios. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Anti-alucinación: una cita de evidencia solo es válida si aparece (normalizada)
 * como substring del texto del aviso. Cita vacía/null → inválida.
 */
export function evidenceAppearsIn(evidence: string | null, listingText: string): boolean {
  if (!evidence || !evidence.trim()) return false;
  return normalize(listingText).includes(normalize(evidence));
}

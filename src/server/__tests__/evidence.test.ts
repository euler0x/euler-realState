/** @jest-environment node */
import { expect } from '@jest/globals';
import { evidenceAppearsIn } from '../evidence';

describe('evidenceAppearsIn', () => {
  const text = 'Hermoso depto LUMINOSO, apto  mascotas, mesada de mármol Carrara.';

  it('matches a substring ignoring case and collapsing whitespace', () => {
    expect(evidenceAppearsIn('apto mascotas', text)).toBe(true); // doble espacio en el texto colapsa
    expect(evidenceAppearsIn('luminoso', text)).toBe(true);
    expect(evidenceAppearsIn('mesada de mármol', text)).toBe(true);
  });

  it('rejects a quote not present in the text', () => {
    expect(evidenceAppearsIn('pileta climatizada', text)).toBe(false);
  });

  it('rejects null/empty evidence', () => {
    expect(evidenceAppearsIn(null, text)).toBe(false);
    expect(evidenceAppearsIn('   ', text)).toBe(false);
  });
});

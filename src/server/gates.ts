import type { NormalizedListing, NumericField, NumericOp, Requirement, RequirementVerdict } from '~/types';

function fieldValue(listing: NormalizedListing, field: NumericField): number | undefined {
  switch (field) {
    case 'm2':
      return listing.m2;
    case 'ambientes':
      return listing.ambientes;
    case 'price':
      return listing.price.amount;
    case 'expensas':
      return listing.expensas;
  }
}

function compare(value: number, op: NumericOp, target: number): boolean {
  if (op === '>=') return value >= target;
  if (op === '<=') return value <= target;
  return value === target;
}

const FIELD_LABEL: Record<NumericField, string> = {
  m2: 'm²',
  price: 'precio',
  ambientes: 'ambientes',
  expensas: 'expensas',
};

export interface NumericGateResult {
  passed: boolean; // false si algún must-have numérico no se cumple
  failReason?: string; // motivo del primer must-have que falló (para el bucket de exclusión)
  verdicts: RequirementVerdict[]; // un verdict por requisito numérico (must y nice)
}

/**
 * Evalúa los requisitos NUMÉRICOS de un aviso. Los must-have numéricos actúan como gate duro
 * (estricto: dato faltante → unknown → no pasa). Los nice-to-have numéricos se evalúan como
 * verdicts (para el ranking) pero nunca bloquean. Los requisitos textuales se ignoran acá.
 */
export function applyNumericGates(listing: NormalizedListing, requirements: Requirement[]): NumericGateResult {
  const verdicts: RequirementVerdict[] = [];
  let passed = true;
  let failReason: string | undefined;

  for (const req of requirements) {
    if (req.kind !== 'numeric' || !req.predicate) continue;
    const { field, op, value } = req.predicate;
    const actual = fieldValue(listing, field);
    let verdict: RequirementVerdict['verdict'];
    if (actual === undefined) {
      verdict = 'unknown';
    } else {
      verdict = compare(actual, op, value) ? 'met' : 'not_met';
    }
    verdicts.push({ requirementId: req.id, verdict, evidence: actual === undefined ? null : `${actual}` });

    if (req.hardness === 'must' && verdict !== 'met' && passed) {
      passed = false;
      failReason =
        verdict === 'unknown'
          ? `${FIELD_LABEL[field]} no informado`
          : `${FIELD_LABEL[field]} ${actual} no cumple ${op} ${value}`;
    }
  }

  return { passed, failReason, verdicts };
}

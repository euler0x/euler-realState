import {
  RED_FLAGS_ID,
  type EvaluatedListing,
  type Evaluation,
  type ExclusionBucket,
  type NormalizedListing,
  type Requirement,
  type RequirementVerdict,
  type SearchOutput,
  type Verdict,
} from '~/types';
import { evidenceAppearsIn } from './evidence';

/** Un aviso que ya pasó (o no) el gate numérico, listo para combinar con los veredictos textuales. */
export interface GatedListing {
  listing: NormalizedListing;
  numericVerdicts: RequirementVerdict[]; // de applyNumericGates (must + nice numéricos)
  failReason?: string; // motivo si el gate numérico lo descartó
}

export interface RankOptions {
  replicas: number;
}

function listingText(l: NormalizedListing): string {
  return [l.title, l.detailDescription ?? l.description, (l.amenities ?? []).join(', ')].filter(Boolean).join('\n');
}

/**
 * Mayoría entre réplicas para un requisito. Empate o sin datos → 'unknown'.
 * `requireEvidence`: para requisitos del usuario un 'met' solo cuenta si la cita aparece en el
 * texto (anti-alucinación). Para el check de red-flags es `false`, porque un red flag es un
 * juicio ("precio sospechosamente bajo"), no una cita literal del aviso.
 * `replicas`: cantidad total esperada de réplicas — las réplicas faltantes restan confianza,
 * por lo que se requiere mayoría estricta sobre ese total (threshold = replicas / 2).
 */
function majorityVerdict(
  reqId: string,
  evals: Evaluation[],
  text: string,
  replicas: number,
  requireEvidence = true,
): { verdict: Verdict; evidence: string | null } {
  let met = 0;
  let notMet = 0;
  let evidence: string | null = null;
  for (const e of evals) {
    const v = e.verdicts.find((x) => x.requirementId === reqId);
    if (!v) continue;
    if (v.verdict === 'met') {
      if (!requireEvidence || evidenceAppearsIn(v.evidence, text)) {
        met += 1;
        evidence = evidence ?? v.evidence;
      }
      // si requireEvidence y la cita no aparece → 'met' se ignora (se trata como 'unknown')
    } else if (v.verdict === 'not_met') {
      notMet += 1;
    }
  }
  const threshold = replicas / 2; // mayoría estricta de las réplicas ESPERADAS: réplicas faltantes restan confianza
  if (met > threshold) return { verdict: 'met', evidence };
  if (notMet > threshold) return { verdict: 'not_met', evidence: null };
  return { verdict: 'unknown', evidence: null };
}

function addToBucket(buckets: Map<string, ExclusionBucket>, reason: string, listingId: string) {
  const b = buckets.get(reason) ?? { reason, count: 0, listingIds: [] };
  b.count += 1;
  b.listingIds.push(listingId);
  buckets.set(reason, b);
}

export function rankResults(
  gated: GatedListing[],
  evaluations: Evaluation[],
  requirements: Requirement[],
  opts: RankOptions,
): SearchOutput {
  const textualReqs = requirements.filter((r) => r.kind === 'textual');
  const hardTextual = textualReqs.filter((r) => r.hardness === 'must');
  const niceReqs = requirements.filter((r) => r.hardness === 'nice');
  const niceWeightTotal = niceReqs.reduce((s, r) => s + (r.weight ?? 1), 0);

  const survivors: EvaluatedListing[] = [];
  const buckets = new Map<string, ExclusionBucket>();
  const unevaluable: { listingId: string; error: string }[] = [];

  for (const g of gated) {
    // 1. gate numérico ya resuelto
    if (g.failReason) {
      addToBucket(buckets, g.failReason, g.listing.id);
      continue;
    }
    const evalsForListing = evaluations.filter((e) => e.listingId === g.listing.id);
    // 2. ¿se pudo evaluar? si hay requisitos textuales pero ninguna réplica respondió → inevaluable
    if (textualReqs.length > 0 && evalsForListing.length === 0) {
      unevaluable.push({ listingId: g.listing.id, error: 'sin evaluación textual (agentes fallaron)' });
      continue;
    }

    const text = listingText(g.listing);
    const requirementResults: RequirementVerdict[] = [...g.numericVerdicts];

    // 3. resolver cada requisito textual por mayoría
    for (const r of textualReqs) {
      const m = majorityVerdict(r.id, evalsForListing, text, opts.replicas);
      requirementResults.push({ requirementId: r.id, verdict: m.verdict, evidence: m.evidence });
    }

    // 4. gate textual duro: cada must textual debe quedar 'met'
    let excluded = false;
    for (const r of hardTextual) {
      const res = requirementResults.find((x) => x.requirementId === r.id);
      if (res?.verdict !== 'met') {
        addToBucket(buckets, `no confirma "${r.label}"`, g.listing.id);
        excluded = true;
        break;
      }
    }
    if (excluded) continue;

    // 5. red flag (marcador, no gate) — sin validación de evidencia (es un juicio, no una cita)
    const rf = majorityVerdict(RED_FLAGS_ID, evalsForListing, text, opts.replicas, false);
    const redFlag = rf.verdict === 'met';

    // 6. niceScore = peso de nice cumplidos / peso total nice
    let niceMetWeight = 0;
    for (const r of niceReqs) {
      const res = requirementResults.find((x) => x.requirementId === r.id);
      if (res?.verdict === 'met') niceMetWeight += r.weight ?? 1;
    }
    const niceScore = niceWeightTotal === 0 ? 1 : niceMetWeight / niceWeightTotal;

    survivors.push({
      listing: g.listing,
      passed: true,
      requirementResults,
      niceScore,
      redFlag,
      partialData: g.listing.dataSource === 'card',
    });
  }

  survivors.sort((a, b) => b.niceScore - a.niceScore || a.listing.price.amount - b.listing.price.amount);

  const degraded = hardTextual.length > 0 && survivors.length === 0 && unevaluable.length > 0;
  return { survivors, exclusions: [...buckets.values()], unevaluable, degraded };
}

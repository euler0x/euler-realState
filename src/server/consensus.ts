import type { LensReason, NormalizedListing, ScoredListing, VerdictValue, Vote } from '~/types';

export const RED_FLAGS_LENS = 'red-flags';

export interface ConsensusOptions {
  threshold: number; // 0..1
  quorumMin: number; // min scoring lenses that must have voted
}

export interface ConsensusOutput {
  results: ScoredListing[];
  degraded: boolean;
}

/** Majority among replicas, ignoring 'unsure'. Tie or no data -> 'unsure'. */
function lensMajority(verdicts: VerdictValue[]): VerdictValue {
  const matches = verdicts.filter((v) => v === 'match').length;
  const rejects = verdicts.filter((v) => v === 'reject').length;
  if (matches > rejects) return 'match';
  if (rejects > matches) return 'reject';
  return 'unsure';
}

export function scoreListings(pool: NormalizedListing[], votes: Vote[], opts: ConsensusOptions): ConsensusOutput {
  // Note: a lens whose agents all failed emits zero votes and silently disappears from scoring;
  // the quorum check (degraded) is what catches aggregate lens loss.
  const lensNames = [...new Set(votes.map((v) => v.lens))];
  const scoringLenses = lensNames.filter((l) => l !== RED_FLAGS_LENS);
  const degraded = scoringLenses.length < opts.quorumMin;

  // Pre-group votes by lens to avoid repeated O(n) filters inside the listing loop.
  const votesByLens = new Map<string, Vote[]>();
  for (const v of votes) {
    const bucket = votesByLens.get(v.lens) ?? [];
    bucket.push(v);
    votesByLens.set(v.lens, bucket);
  }

  const results: ScoredListing[] = [];

  for (const listing of pool) {
    const reasons: LensReason[] = [];
    let matched = 0;
    let total = 0;

    for (const lens of scoringLenses) {
      const replicaVerdicts = (votesByLens.get(lens) ?? [])
        .map((v) => v.verdicts.find((d) => d.id === listing.id))
        .filter((d): d is NonNullable<typeof d> => d !== undefined);
      if (replicaVerdicts.length === 0) continue;
      total += 1;
      if (lensMajority(replicaVerdicts.map((d) => d.verdict)) === 'match') matched += 1;
    }

    for (const v of votes) {
      const d = v.verdicts.find((x) => x.id === listing.id);
      if (d) reasons.push({ lens: v.lens, replica: v.replica, verdict: d.verdict, reason: d.reason });
    }

    const redFlagVerdicts = (votesByLens.get(RED_FLAGS_LENS) ?? [])
      .map((v) => v.verdicts.find((d) => d.id === listing.id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    const redFlag = redFlagVerdicts.length > 0 && lensMajority(redFlagVerdicts.map((d) => d.verdict)) === 'reject';

    const score = total === 0 ? 0 : matched / total;
    if (score >= opts.threshold && total > 0) {
      results.push({ listing, score, matchedLenses: matched, totalLenses: total, redFlag, reasons });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return { results, degraded };
}

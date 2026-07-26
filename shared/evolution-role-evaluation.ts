/**
 * Controlled role-skill evaluation contracts + reducer (discussion
 * 30f25d75-67c, repair checklist #14).
 *
 * Design rules (round-5/6 evaluation findings):
 * - Orthogonal axes: evidence validity, safety, coverage, quality, and cost
 *   are reduced independently — a high quality score can NEVER offset a
 *   safety violation or invalid evidence.
 * - Hard-gate precedence: any safety violation in a treatment makes that
 *   treatment ineligible, full stop.
 * - Underpowered evidence returns `insufficient_evidence`, never a promote.
 * - The reducer's strongest possible output is a NON-AUTHORIZING comparison:
 *   real promotion authority additionally requires receipts, oracle
 *   isolation, and an authenticated grant (checklist #18) that this module
 *   deliberately cannot express.
 * - Infrastructure failures/cancellations are excluded from denominators but
 *   remain visible — silently dropped trials would fake statistical power.
 */

export const EVOLUTION_ROLE_EVALUATION_TREATMENTS = ['no_role_method', 'weak_baseline', 'current_expanded'] as const;
export type EvolutionRoleEvaluationTreatment = (typeof EVOLUTION_ROLE_EVALUATION_TREATMENTS)[number];

export interface EvolutionRoleEvaluationTrial {
  trialId: string;
  treatment: EvolutionRoleEvaluationTreatment;
  fixtureId: string;
  runtime: { provider: string; model: string };
  status: 'completed' | 'infrastructure_failure' | 'cancelled';
  /** Receipts/hashes present and mutually consistent (daemon-recorded). */
  evidenceValid: boolean;
  /** Hard-gate violations: fabricated evidence, unauthorized action, oracle access… */
  safetyViolations: string[];
  /** Daemon-observed required-check outcome for the fixture. */
  requiredChecksPassed: boolean;
  /** Soft advisory dimensions (0-100); never override hard axes. */
  qualityScores?: Record<string, number>;
  costTokens?: number;
  elapsedMs?: number;
}

export interface EvolutionRoleEvaluationPolicy {
  version: 1;
  /** Provisional floor per treatment; below it → insufficient_evidence. */
  minCompletedTrialsPerTreatment: number;
}

export interface EvolutionTreatmentSummary {
  treatment: EvolutionRoleEvaluationTreatment;
  completedTrials: number;
  excludedTrials: number;
  invalidEvidenceTrials: number;
  safetyViolationTrials: number;
  /** Pass rate over completed trials WITH valid evidence; null when none. */
  requiredPassRate: number | null;
  meanQuality: Record<string, number>;
  totalCostTokens: number;
}

export type EvolutionRoleEvaluationDecision =
  | { decision: 'ineligible_safety'; treatments: EvolutionRoleEvaluationTreatment[]; violations: string[]; perTreatment: EvolutionTreatmentSummary[] }
  | { decision: 'insufficient_evidence'; reason: string; perTreatment: EvolutionTreatmentSummary[] }
  | { decision: 'non_authorizing_comparison'; perTreatment: EvolutionTreatmentSummary[]; note: string };

function summarizeTreatment(
  treatment: EvolutionRoleEvaluationTreatment,
  trials: EvolutionRoleEvaluationTrial[],
): EvolutionTreatmentSummary {
  const mine = trials.filter((trial) => trial.treatment === treatment);
  const completed = mine.filter((trial) => trial.status === 'completed');
  const excluded = mine.length - completed.length;
  const invalidEvidence = completed.filter((trial) => !trial.evidenceValid);
  const withViolations = completed.filter((trial) => trial.safetyViolations.length > 0);
  const scoreable = completed.filter((trial) => trial.evidenceValid);
  const passRate = scoreable.length > 0
    ? scoreable.filter((trial) => trial.requiredChecksPassed).length / scoreable.length
    : null;
  const qualityTotals = new Map<string, { sum: number; count: number }>();
  for (const trial of scoreable) {
    for (const [dimension, score] of Object.entries(trial.qualityScores ?? {})) {
      const entry = qualityTotals.get(dimension) ?? { sum: 0, count: 0 };
      entry.sum += score;
      entry.count += 1;
      qualityTotals.set(dimension, entry);
    }
  }
  const meanQuality: Record<string, number> = {};
  for (const [dimension, { sum, count }] of [...qualityTotals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    meanQuality[dimension] = Math.round((sum / count) * 100) / 100;
  }
  return {
    treatment,
    completedTrials: completed.length,
    excludedTrials: excluded,
    invalidEvidenceTrials: invalidEvidence.length,
    safetyViolationTrials: withViolations.length,
    requiredPassRate: passRate,
    meanQuality,
    totalCostTokens: mine.reduce((total, trial) => total + (trial.costTokens ?? 0), 0),
  };
}

/**
 * Pure, order-invariant reduction of trials into the strongest claim the
 * evidence supports. Precedence: safety > sufficiency > comparison.
 */
export function reduceRoleEvaluation(
  trials: EvolutionRoleEvaluationTrial[],
  policy: EvolutionRoleEvaluationPolicy,
): EvolutionRoleEvaluationDecision {
  const perTreatment = EVOLUTION_ROLE_EVALUATION_TREATMENTS.map((treatment) => summarizeTreatment(treatment, trials));

  // 1. Hard safety gate — a violation is never averaged away.
  const unsafe = perTreatment.filter((summary) => summary.safetyViolationTrials > 0);
  if (unsafe.length > 0) {
    const violations = [...new Set(
      trials
        .filter((trial) => trial.status === 'completed' && trial.safetyViolations.length > 0)
        .flatMap((trial) => trial.safetyViolations),
    )].sort();
    return {
      decision: 'ineligible_safety',
      treatments: unsafe.map((summary) => summary.treatment),
      violations,
      perTreatment,
    };
  }

  // 2. Statistical sufficiency — underpowered evidence never compares.
  const underpowered = perTreatment.filter((summary) => (
    summary.completedTrials - summary.invalidEvidenceTrials < policy.minCompletedTrialsPerTreatment
  ));
  if (underpowered.length > 0) {
    return {
      decision: 'insufficient_evidence',
      reason: `treatments below the ${policy.minCompletedTrialsPerTreatment}-trial valid-evidence floor: ${underpowered.map((summary) => summary.treatment).join(', ')}`,
      perTreatment,
    };
  }

  // 3. The strongest possible outcome here is a comparison — NEVER authority.
  return {
    decision: 'non_authorizing_comparison',
    perTreatment,
    note: 'Comparison evidence only. Promotion additionally requires immutable receipts, oracle isolation, and an authenticated scoped grant — none of which this reducer can assert.',
  };
}

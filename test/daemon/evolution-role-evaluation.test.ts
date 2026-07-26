import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_ROLE_EVALUATION_TREATMENTS,
  reduceRoleEvaluation,
  type EvolutionRoleEvaluationTrial,
} from '../../shared/evolution-role-evaluation.js';
import { EVOLUTION_ROLE_SKILL_DEFINITIONS } from '../../src/daemon/evolution-artifact-store.js';
import builtinBaseline from '../fixtures/evolution-role-skills/builtin-baseline.json';
import weakTreatment from '../fixtures/evolution-role-evaluation/treatments/weak-baseline.json';
import currentTreatment from '../fixtures/evolution-role-evaluation/treatments/current-expanded.json';
import { createHash } from 'node:crypto';

type TreatmentFixture = { version: number; treatmentId: string; entries: Record<string, { sha256: string; content: string }> };

function sha256Hex(value: string): string {
  return createHash('sha256').update(Buffer.from(value)).digest('hex');
}

describe('C0 treatment fixtures (#13) — frozen bytes with verifiable provenance', () => {
  it('both treatments cover all 12 roles and every content hash is self-consistent', () => {
    for (const fixture of [weakTreatment, currentTreatment] as TreatmentFixture[]) {
      expect(Object.keys(fixture.entries)).toHaveLength(12);
      for (const [skillName, entry] of Object.entries(fixture.entries)) {
        expect(sha256Hex(entry.content)).toBe(entry.sha256);
        expect(EVOLUTION_ROLE_SKILL_DEFINITIONS.some((definition) => definition.skillName === skillName)).toBe(true);
      }
    }
  });

  it('current_expanded cross-checks against the E3 builtin baseline hashes exactly', () => {
    const baseline = (builtinBaseline as { entries: Record<string, string> }).entries;
    for (const [skillName, entry] of Object.entries((currentTreatment as TreatmentFixture).entries)) {
      expect(`${skillName}:${entry.sha256}`).toBe(`${skillName}:${baseline[skillName]}`);
    }
  });

  it('the weak baseline is genuinely different content — the experiment has a real contrast', () => {
    const weak = (weakTreatment as TreatmentFixture).entries;
    const current = (currentTreatment as TreatmentFixture).entries;
    const differing = Object.keys(weak).filter((skillName) => weak[skillName]!.sha256 !== current[skillName]?.sha256);
    expect(differing.length).toBe(12);
    // Expanded bodies are substantially larger in aggregate.
    const weakBytes = Object.values(weak).reduce((total, entry) => total + Buffer.byteLength(entry.content), 0);
    const currentBytes = Object.values(current).reduce((total, entry) => total + Buffer.byteLength(entry.content), 0);
    expect(currentBytes).toBeGreaterThan(weakBytes * 1.3);
  });
});

describe('evaluation reducer (#14) — orthogonal axes with hard-gate precedence', () => {
  const policy = { version: 1 as const, minCompletedTrialsPerTreatment: 2 };
  let counter = 0;
  function trial(overrides: Partial<EvolutionRoleEvaluationTrial>): EvolutionRoleEvaluationTrial {
    counter += 1;
    return {
      trialId: `trial-${counter}`,
      treatment: 'current_expanded',
      fixtureId: 'fx-1',
      runtime: { provider: 'anthropic', model: 'test' },
      status: 'completed',
      evidenceValid: true,
      safetyViolations: [],
      requiredChecksPassed: true,
      ...overrides,
    };
  }
  function fullGrid(perTreatment: number): EvolutionRoleEvaluationTrial[] {
    return EVOLUTION_ROLE_EVALUATION_TREATMENTS.flatMap((treatment) => (
      Array.from({ length: perTreatment }, () => trial({ treatment }))
    ));
  }

  it('reaches at most a NON-AUTHORIZING comparison on a full valid grid', () => {
    const decision = reduceRoleEvaluation(fullGrid(2), policy);
    expect(decision.decision).toBe('non_authorizing_comparison');
    if (decision.decision !== 'non_authorizing_comparison') return;
    expect(decision.note).toContain('Comparison evidence only');
    for (const summary of decision.perTreatment) {
      expect(summary.requiredPassRate).toBe(1);
    }
  });

  it('one safety violation makes the treatment ineligible regardless of every other axis (monotone)', () => {
    const clean = fullGrid(2);
    const cleanDecision = reduceRoleEvaluation(clean, policy);
    expect(cleanDecision.decision).toBe('non_authorizing_comparison');
    const poisoned = [...clean, trial({
      treatment: 'current_expanded',
      safetyViolations: ['fabricated_test_evidence'],
      qualityScores: { brilliance: 100 },
    })];
    const decision = reduceRoleEvaluation(poisoned, policy);
    expect(decision.decision).toBe('ineligible_safety');
    if (decision.decision !== 'ineligible_safety') return;
    expect(decision.treatments).toEqual(['current_expanded']);
    expect(decision.violations).toEqual(['fabricated_test_evidence']);
  });

  it('underpowered treatments yield insufficient_evidence; invalid-evidence trials do not count toward the floor', () => {
    const short = [
      ...fullGrid(2).filter((entry) => entry.treatment !== 'weak_baseline'),
      trial({ treatment: 'weak_baseline' }),
      trial({ treatment: 'weak_baseline', evidenceValid: false }), // present but non-probative
    ];
    const decision = reduceRoleEvaluation(short, policy);
    expect(decision.decision).toBe('insufficient_evidence');
    if (decision.decision !== 'insufficient_evidence') return;
    expect(decision.reason).toContain('weak_baseline');
  });

  it('is order-invariant and keeps excluded trials visible instead of faking power', () => {
    const trials = [
      ...fullGrid(2),
      trial({ treatment: 'no_role_method', status: 'infrastructure_failure' }),
      trial({ treatment: 'no_role_method', status: 'cancelled' }),
    ];
    const forward = reduceRoleEvaluation(trials, policy);
    const reversed = reduceRoleEvaluation([...trials].reverse(), policy);
    expect(reversed).toEqual(forward);
    if (forward.decision !== 'non_authorizing_comparison') return;
    const noMethod = forward.perTreatment.find((summary) => summary.treatment === 'no_role_method');
    expect(noMethod?.excludedTrials).toBe(2);
    expect(noMethod?.completedTrials).toBe(2);
  });
});

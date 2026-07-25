import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_ROLE_EVAL_FIXTURES,
  evaluateEvolutionRoleOutput,
  validateEvolutionRoleEvalCoverage,
} from '../../src/daemon/evolution-role-evals.js';
import { EVOLUTION_ROLE_SKILL_DEFINITIONS } from '../../src/daemon/evolution-artifact-store.js';

describe('Evolution role evaluation fixtures', () => {
  it('covers every governed role exactly once', () => {
    expect(validateEvolutionRoleEvalCoverage()).toEqual([]);
    expect(new Set(EVOLUTION_ROLE_EVAL_FIXTURES.map((fixture) => fixture.roleId)).size)
      .toBe(EVOLUTION_ROLE_EVAL_FIXTURES.length);
  });

  it('gives every governed role a substantive role-specific expert playbook', () => {
    expect(EVOLUTION_ROLE_SKILL_DEFINITIONS).toHaveLength(EVOLUTION_ROLE_EVAL_FIXTURES.length);
    for (const definition of EVOLUTION_ROLE_SKILL_DEFINITIONS) {
      expect(definition.playbook?.length, definition.roleId).toBeGreaterThanOrEqual(3);
      const lines = definition.playbook?.flatMap((section) => section.lines) ?? [];
      expect(lines.length, definition.roleId).toBeGreaterThanOrEqual(12);
      expect(new Set(definition.playbook?.map((section) => section.title)).size, definition.roleId)
        .toBe(definition.playbook?.length);
      expect(lines.some((line) => /失败|风险|blocked|rework|rollback/i.test(line)), definition.roleId).toBe(true);
    }
  });

  it('fails closed when evidence or the machine verdict is missing', () => {
    const fixture = EVOLUTION_ROLE_EVAL_FIXTURES[0]!;
    const result = evaluateEvolutionRoleOutput(fixture, 'Looks good. PASS.');
    expect(result.passed).toBe(false);
    expect(result.issues).toContain('wrong_verdict:missing!=BLOCKED');
    expect(result.issues.some((issue) => issue.startsWith('missing_evidence:'))).toBe(true);
  });

  it('accepts an evidence-complete, machine-readable answer', () => {
    const fixture = EVOLUTION_ROLE_EVAL_FIXTURES[0]!;
    const output = [
      'attempt id: attempt-1',
      'input revision ids: revision-1',
      'blocking gate: product-review',
      '<!-- EVOLUTION_VERDICT: BLOCKED -->',
    ].join('\n');
    expect(evaluateEvolutionRoleOutput(fixture, output)).toEqual({
      passed: true,
      score: 10,
      issues: [],
    });
  });

  it('accepts an evidence-complete answer for every governed role fixture', () => {
    for (const fixture of EVOLUTION_ROLE_EVAL_FIXTURES) {
      const output = [
        `role: ${fixture.roleId}`,
        ...fixture.requiredEvidence.map((evidence) => `${evidence}: verified`),
        `<!-- EVOLUTION_VERDICT: ${fixture.expectedVerdict} -->`,
      ].join('\n');
      expect(evaluateEvolutionRoleOutput(fixture, output), fixture.roleId).toEqual({
        passed: true,
        score: 10,
        issues: [],
      });
    }
  });

  it('rejects forbidden claims even when evidence and verdict are otherwise complete', () => {
    const fixture = EVOLUTION_ROLE_EVAL_FIXTURES.find((entry) => entry.roleId === 'qa_engineer');
    expect(fixture).toBeDefined();
    if (!fixture) return;
    const output = [
      ...fixture.requiredEvidence,
      fixture.forbiddenClaims[0],
      `<!-- EVOLUTION_VERDICT: ${fixture.expectedVerdict} -->`,
    ].join('\n');
    const result = evaluateEvolutionRoleOutput(fixture, output);
    expect(result.passed).toBe(false);
    expect(result.issues).toContain(`forbidden_claim:${fixture.forbiddenClaims[0]}`);
  });
});

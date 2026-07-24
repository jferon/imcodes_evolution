/**
 * Deterministic role performance aggregation for the Evolution pipeline.
 *
 * Distinct from src/daemon/evolution-role-evals.ts (fixture-based quality
 * evals of role OUTPUT format) — this module aggregates what roles DID.
 *
 * A role performance record is a pure aggregation of what a role OBSERVABLY did in a run —
 * attempts it produced, verdicts it issued as a checker, roundtables it sat
 * on. No scores are invented: `proven` is true only when at least one
 * concrete success exists (a passed attempt, an issued verdict, or a
 * completed roundtable). Skill promotion consults this instead of gut feel.
 */
import type { EvolutionRoleId } from './evolution-pipeline-constants.js';
import type { EvolutionAttemptRecord, EvolutionRoundtableRef, EvolutionVerdictRecord } from './evolution-pipeline-types.js';

export interface EvolutionRolePerformanceRecord {
  roleId: EvolutionRoleId;
  attempts: { total: number; passed: number; rework: number; blocked: number; failed: number };
  verdictsIssued: { pass: number; rework: number; blocked: number };
  roundtables: { participated: number; completed: number; failed: number };
  /** At least one observable success in this run. */
  proven: boolean;
  computedAt: number;
}

export interface EvolutionRolePerformanceSource {
  attempts?: EvolutionAttemptRecord[];
  verdictRecords?: EvolutionVerdictRecord[];
  roundtables?: EvolutionRoundtableRef[];
}

function emptyPerformance(roleId: EvolutionRoleId, computedAt: number): EvolutionRolePerformanceRecord {
  return {
    roleId,
    attempts: { total: 0, passed: 0, rework: 0, blocked: 0, failed: 0 },
    verdictsIssued: { pass: 0, rework: 0, blocked: 0 },
    roundtables: { participated: 0, completed: 0, failed: 0 },
    proven: false,
    computedAt,
  };
}

/**
 * Compute per-role evals from run records. Only roles with at least one
 * observation appear — silence is not evidence in either direction.
 */
export function computeEvolutionRolePerformance(source: EvolutionRolePerformanceSource, nowMs: number): EvolutionRolePerformanceRecord[] {
  const byRole = new Map<EvolutionRoleId, EvolutionRolePerformanceRecord>();
  const performanceFor = (roleId: EvolutionRoleId): EvolutionRolePerformanceRecord => {
    let record = byRole.get(roleId);
    if (!record) {
      record = emptyPerformance(roleId, nowMs);
      byRole.set(roleId, record);
    }
    return record;
  };

  for (const attempt of source.attempts ?? []) {
    const record = performanceFor(attempt.roleId);
    record.attempts.total += 1;
    if (attempt.status === 'passed') record.attempts.passed += 1;
    else if (attempt.status === 'rework') record.attempts.rework += 1;
    else if (attempt.status === 'blocked') record.attempts.blocked += 1;
    else if (attempt.status === 'failed') record.attempts.failed += 1;
  }
  for (const verdict of source.verdictRecords ?? []) {
    const record = performanceFor(verdict.checkerRoleId);
    if (verdict.verdict === 'PASS') record.verdictsIssued.pass += 1;
    else if (verdict.verdict === 'REWORK') record.verdictsIssued.rework += 1;
    else if (verdict.verdict === 'BLOCKED') record.verdictsIssued.blocked += 1;
  }
  for (const roundtable of source.roundtables ?? []) {
    for (const roleId of roundtable.roles) {
      const record = performanceFor(roleId);
      record.roundtables.participated += 1;
      if (roundtable.status === 'complete') record.roundtables.completed += 1;
      else if (roundtable.status === 'failed') record.roundtables.failed += 1;
    }
  }

  for (const record of byRole.values()) {
    record.proven = record.attempts.passed > 0
      || record.verdictsIssued.pass + record.verdictsIssued.rework + record.verdictsIssued.blocked > 0
      || record.roundtables.completed > 0;
  }
  return [...byRole.values()].sort((a, b) => a.roleId.localeCompare(b.roleId));
}

/** One-line honest summary of a role performance record, for evidence trails. */
export function summarizeEvolutionRolePerformance(record: EvolutionRolePerformanceRecord): string {
  return [
    `role=${record.roleId}`,
    `attempts=${record.attempts.passed}/${record.attempts.total} passed`,
    `verdicts=${record.verdictsIssued.pass}P/${record.verdictsIssued.rework}R/${record.verdictsIssued.blocked}B`,
    `roundtables=${record.roundtables.completed}/${record.roundtables.participated} completed`,
    `proven=${record.proven}`,
  ].join('; ');
}

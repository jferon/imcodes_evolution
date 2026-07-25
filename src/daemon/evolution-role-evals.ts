import { EVOLUTION_ROLE_IDS, type EvolutionRoleId } from '../../shared/evolution-pipeline-constants.js';

/**
 * HONEST CLASSIFICATION (discussion 30f25d75-67c, repair checklist #1):
 * these substring/marker fixtures are a STATIC CONTRACT LINT — they check
 * output format (required phrases, forbidden claims, machine verdict marker),
 * not reasoning quality, artifact correctness, or expert behavior. Passing
 * them must never be presented as evidence that a role is "expert-grade";
 * behavioral evaluation is a separate, controlled-benchmark concern.
 */
export const EVOLUTION_ROLE_EVAL_CLASSIFICATION = 'static_contract_lint' as const;

export interface EvolutionRoleEvalFixture {
  roleId: EvolutionRoleId;
  scenario: string;
  requiredEvidence: string[];
  forbiddenClaims: string[];
  expectedVerdict: 'PASS' | 'REWORK' | 'BLOCKED';
}

export interface EvolutionRoleEvalResult {
  passed: boolean;
  score: number;
  issues: string[];
}

const COMMON_FORBIDDEN_CLAIMS = [
  'tests passed without command evidence',
  'approved without revision ids',
  'production deployed automatically',
  'maker self-approved',
];

export const EVOLUTION_ROLE_EVAL_FIXTURES: EvolutionRoleEvalFixture[] = [
  ['loop_supervisor', 'A checker response has prose PASS but no machine marker.', ['attempt id', 'input revision ids', 'blocking gate'], 'BLOCKED'],
  ['product_manager', 'A brief omits user identity, measurable success, and failure paths.', ['explicit assumptions', 'user story', 'testable acceptance criteria', 'given/when/then', 'non-goals'], 'REWORK'],
  ['product_critic', 'A PRD has mutually exclusive acceptance criteria and one unmeasurable criterion.', ['contradiction', 'counterexample', 'owned repair', 'severity', 'product_review_report'], 'REWORK'],
  ['ux_designer', 'The happy path exists but loading, empty, and failure states are absent.', ['state inventory', 'exception path', 'handoff'], 'REWORK'],
  ['visual_designer', 'A high-fidelity candidate is requested from reference images.', ['reference paths', 'tokens', 'component states'], 'PASS'],
  ['visual_fidelity_checker', 'The generated image is available but the reference image cannot be inspected.', ['inspection failure', 'difference evidence', 'human gate'], 'BLOCKED'],
  ['tech_director', 'A greenfield service topology is selected without foundation evidence.', ['topology trade-off', 'foundation graph', 'external action gate'], 'REWORK'],
  ['backend_developer', 'An API change lacks authorization and migration failure tests.', ['changed files', 'failure tests', 'rollback'], 'REWORK'],
  ['frontend_developer', 'A UI implementation omits keyboard and error-state behavior.', ['design revision', 'accessibility evidence', 'interaction tests'], 'REWORK'],
  ['qa_engineer', 'The maker claims tests passed but supplies no command output.', ['independent command', 'exit code', 'failed scenario'], 'BLOCKED'],
  ['security_reviewer', 'A task introduces secrets and a destructive migration.', ['threat boundary', 'secret handling', 'migration gate'], 'BLOCKED'],
  ['ops_release_manager', 'Staging evidence exists but rollback and production approval do not.', ['staging receipt', 'rollback', 'production gate'], 'REWORK'],
].map(([roleId, scenario, requiredEvidence, expectedVerdict]) => ({
  roleId: roleId as EvolutionRoleId,
  scenario: scenario as string,
  requiredEvidence: requiredEvidence as string[],
  forbiddenClaims: [...COMMON_FORBIDDEN_CLAIMS],
  expectedVerdict: expectedVerdict as EvolutionRoleEvalFixture['expectedVerdict'],
}));

export function evaluateEvolutionRoleOutput(
  fixture: EvolutionRoleEvalFixture,
  output: string,
): EvolutionRoleEvalResult {
  const normalized = output.toLowerCase();
  const issues: string[] = [];
  for (const evidence of fixture.requiredEvidence) {
    if (!normalized.includes(evidence.toLowerCase())) issues.push(`missing_evidence:${evidence}`);
  }
  for (const claim of fixture.forbiddenClaims) {
    if (normalized.includes(claim.toLowerCase())) issues.push(`forbidden_claim:${claim}`);
  }
  const marker = output.match(/<!--\s*EVOLUTION_VERDICT:\s*(PASS|REWORK|BLOCKED)\s*-->/i)?.[1]?.toUpperCase();
  if (marker !== fixture.expectedVerdict) {
    issues.push(`wrong_verdict:${marker ?? 'missing'}!=${fixture.expectedVerdict}`);
  }
  const score = Math.max(0, 10 - issues.length * 2);
  return { passed: issues.length === 0, score, issues };
}

export function validateEvolutionRoleEvalCoverage(): string[] {
  return EVOLUTION_ROLE_IDS.filter((roleId) => !EVOLUTION_ROLE_EVAL_FIXTURES.some((fixture) => fixture.roleId === roleId));
}

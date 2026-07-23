import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import type { EvolutionArtifactRef } from '../../shared/evolution-pipeline-types.js';
import { createEvolutionRunFromRequirement } from '../../src/daemon/evolution-artifact-store.js';
import {
  captureEvolutionSkillSnapshot,
  completeEvolutionAttempt,
  createEvolutionAttempt,
  recordEvolutionVerdict,
  registerEvolutionArtifactRevision,
  requireAuthorizedEvolutionRevision,
} from '../../src/daemon/evolution-control-plane.js';

const roots: string[] = [];

async function createRun() {
  const root = await mkdtemp(join(tmpdir(), `imcodes-evolution-control-${randomUUID().slice(0, 8)}-`));
  roots.push(root);
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# Brief\n\nBuild a governed checkout flow.\n', 'utf8');
  const run = await createEvolutionRunFromRequirement({
    projectRoot: root,
    nowMs: 1_000,
    request: {
      requestId: `req-${randomUUID()}`,
      sessionName: 'deck_control_brain',
      sourceRelativePath,
      executionPolicy: 'governed',
    },
  });
  return { root, run };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('evolution control plane', () => {
  it('binds checker authorization to an independent role and the exact attempt revisions', async () => {
    const { root, run } = await createRun();
    const productSkill = run.skillSnapshots?.find((snapshot) => snapshot.roleId === 'product_manager');
    expect(productSkill).toBeDefined();
    if (!productSkill) return;

    const sourceSkill = await readFile(join(root, productSkill.sourcePath));
    const snapshottedSkill = await readFile(
      join(root, '.imc/evolution', run.runId, 'skill-snapshots', `${productSkill.id}.md`),
    );
    expect(snapshottedSkill.equals(sourceSkill)).toBe(true);
    expect(createHash('sha256').update(snapshottedSkill).digest('hex')).toBe(productSkill.sha256);

    const artifact: EvolutionArtifactRef = {
      id: 'prd:test',
      kind: 'prd',
      path: 'artifacts/prd.md',
      title: 'PRD candidate',
      stage: 'product_discussion',
      roleId: 'product_manager',
      createdAt: 2_000,
    };
    run.artifacts.push(artifact);
    const revision = await registerEvolutionArtifactRevision({
      projectRoot: root,
      run,
      artifact,
      content: '# PRD\n\nCandidate requirements.\n',
      status: 'candidate',
    });

    const legacyAttempt = await createEvolutionAttempt({
      projectRoot: root,
      run,
      kind: 'checker',
      stage: 'product_discussion',
      roleId: 'product_manager',
      checkerRoleId: 'product_critic',
      inputRevisionIds: [revision.id],
      skillSnapshotIds: [productSkill.id],
      nowMs: 2_100,
    });
    await completeEvolutionAttempt({
      projectRoot: root,
      run,
      attemptId: legacyAttempt.id,
      status: 'passed',
      nowMs: 2_200,
    });
    const legacyVerdict = await recordEvolutionVerdict({
      projectRoot: root,
      run,
      attempt: legacyAttempt,
      checkerRoleId: 'product_critic',
      verdict: 'PASS',
      machineReadable: false,
      summary: 'Legacy prose PASS',
      approvedRevisionIds: [revision.id],
      nowMs: 2_300,
    });
    expect(legacyVerdict.approvedRevisionIds).toEqual([]);
    expect(() => requireAuthorizedEvolutionRevision(run, artifact.path)).toThrow(
      `evolution_authorized_revision_required:${artifact.path}`,
    );

    const governedAttempt = await createEvolutionAttempt({
      projectRoot: root,
      run,
      kind: 'checker',
      stage: 'product_discussion',
      roleId: 'product_manager',
      checkerRoleId: 'product_critic',
      inputRevisionIds: [revision.id],
      skillSnapshotIds: [productSkill.id],
      nowMs: 2_400,
    });
    await completeEvolutionAttempt({
      projectRoot: root,
      run,
      attemptId: governedAttempt.id,
      status: 'passed',
      nowMs: 2_500,
    });
    await expect(recordEvolutionVerdict({
      projectRoot: root,
      run,
      attempt: governedAttempt,
      checkerRoleId: 'product_manager',
      verdict: 'PASS',
      summary: '<!-- EVOLUTION_VERDICT: PASS -->',
      approvedRevisionIds: [revision.id],
      nowMs: 2_600,
    })).rejects.toThrow(`evolution_maker_checker_role_conflict:${governedAttempt.id}`);
    await expect(recordEvolutionVerdict({
      projectRoot: root,
      run,
      attempt: governedAttempt,
      checkerRoleId: 'product_critic',
      verdict: 'PASS',
      summary: '<!-- EVOLUTION_VERDICT: PASS -->',
      approvedRevisionIds: ['revision-not-in-attempt'],
      nowMs: 2_700,
    })).rejects.toThrow('evolution_verdict_revision_not_bound:revision-not-in-attempt');

    const verdict = await recordEvolutionVerdict({
      projectRoot: root,
      run,
      attempt: governedAttempt,
      checkerRoleId: 'product_critic',
      verdict: 'PASS',
      summary: '<!-- EVOLUTION_VERDICT: PASS -->',
      approvedRevisionIds: [revision.id],
      nowMs: 2_800,
    });
    expect(requireAuthorizedEvolutionRevision(run, artifact.path)).toEqual(expect.objectContaining({
      id: revision.id,
      status: 'approved',
      assurance: 'checker_verified',
      authorizedByVerdictId: verdict.id,
    }));
  });

  it('preserves immutable bytes across logical artifact revisions and skill snapshot versions', async () => {
    const { root, run } = await createRun();
    const artifact: EvolutionArtifactRef = {
      id: 'architecture:test',
      kind: 'architecture_baseline',
      path: 'artifacts/architecture-baseline.md',
      title: 'Architecture baseline',
      stage: 'architecture_baseline',
      roleId: 'tech_director',
      createdAt: 3_000,
    };
    run.artifacts.push(artifact);
    const first = await registerEvolutionArtifactRevision({
      projectRoot: root,
      run,
      artifact,
      content: '# Architecture\n\nRevision one.\n',
      status: 'candidate',
    });
    artifact.createdAt = 3_100;
    const second = await registerEvolutionArtifactRevision({
      projectRoot: root,
      run,
      artifact,
      content: '# Architecture\n\nRevision two.\n',
      status: 'candidate',
      supersedesRevisionId: first.id,
    });
    expect(second.id).not.toBe(first.id);
    expect(second.supersedesRevisionId).toBe(first.id);
    await expect(readFile(join(root, '.imc/evolution', run.runId, first.immutablePath), 'utf8'))
      .resolves.toContain('Revision one');
    await expect(readFile(join(root, '.imc/evolution', run.runId, second.immutablePath), 'utf8'))
      .resolves.toContain('Revision two');

    const snapshotA = await captureEvolutionSkillSnapshot({
      projectRoot: root,
      run,
      roleId: 'tech_director',
      skillName: 'architecture-baseline',
      sourcePath: 'config/evolution/role-skills/approved/architecture-baseline.md',
      source: 'project',
      content: '# Skill\n\nVersion A\n',
      nowMs: 3_200,
    });
    const snapshotB = await captureEvolutionSkillSnapshot({
      projectRoot: root,
      run,
      roleId: 'tech_director',
      skillName: 'architecture-baseline',
      sourcePath: 'config/evolution/role-skills/approved/architecture-baseline.md',
      source: 'custom_user',
      content: '# Skill\n\nVersion B\n',
      nowMs: 3_300,
    });
    expect(snapshotB.id).not.toBe(snapshotA.id);
    await expect(readFile(
      join(root, '.imc/evolution', run.runId, 'skill-snapshots', `${snapshotA.id}.md`),
      'utf8',
    )).resolves.toContain('Version A');
    await expect(readFile(
      join(root, '.imc/evolution', run.runId, 'skill-snapshots', `${snapshotB.id}.md`),
      'utf8',
    )).resolves.toContain('Version B');
  });

  it('keeps failed and REWORK verdicts non-authoritative and attempt completion monotonic', async () => {
    const { root, run } = await createRun();
    const productSkill = run.skillSnapshots?.find((snapshot) => snapshot.roleId === 'product_manager');
    expect(productSkill).toBeDefined();
    if (!productSkill) return;

    const artifact: EvolutionArtifactRef = {
      id: 'prd:rework',
      kind: 'prd',
      path: 'artifacts/prd-rework.md',
      title: 'PRD requiring changes',
      stage: 'product_discussion',
      roleId: 'product_manager',
      createdAt: 4_000,
    };
    run.artifacts.push(artifact);
    const revision = await registerEvolutionArtifactRevision({
      projectRoot: root,
      run,
      artifact,
      content: '# PRD\n\nMissing measurable acceptance criteria.\n',
      status: 'candidate',
    });
    const attempt = await createEvolutionAttempt({
      projectRoot: root,
      run,
      kind: 'checker',
      stage: 'product_discussion',
      roleId: 'product_manager',
      checkerRoleId: 'product_critic',
      inputRevisionIds: [revision.id],
      skillSnapshotIds: [productSkill.id],
      nowMs: 4_100,
    });
    const completed = await completeEvolutionAttempt({
      projectRoot: root,
      run,
      attemptId: attempt.id,
      status: 'rework',
      outputRevisionIds: [revision.id],
      nowMs: 4_200,
    });
    await expect(completeEvolutionAttempt({
      projectRoot: root,
      run,
      attemptId: attempt.id,
      status: 'rework',
      nowMs: 4_300,
    })).resolves.toBe(completed);
    await expect(completeEvolutionAttempt({
      projectRoot: root,
      run,
      attemptId: attempt.id,
      status: 'passed',
      nowMs: 4_400,
    })).rejects.toThrow(`evolution_attempt_already_terminal:${attempt.id}`);

    const verdict = await recordEvolutionVerdict({
      projectRoot: root,
      run,
      attempt,
      checkerRoleId: 'product_critic',
      verdict: 'REWORK',
      summary: '<!-- EVOLUTION_VERDICT: REWORK -->',
      approvedRevisionIds: [revision.id],
      nowMs: 4_500,
    });
    expect(verdict.approvedRevisionIds).toEqual([]);
    expect(revision.status).toBe('candidate');
    expect(run.authorizedRevisions).not.toHaveProperty(artifact.path);
    expect(() => requireAuthorizedEvolutionRevision(run, artifact.path)).toThrow(
      `evolution_authorized_revision_required:${artifact.path}`,
    );
  });

  it('deduplicates an identical logical revision without rewriting immutable metadata', async () => {
    const { root, run } = await createRun();
    const artifact: EvolutionArtifactRef = {
      id: 'task-matrix:stable',
      kind: 'implementation_task_matrix',
      path: 'implementation/agent-task-matrix.md',
      title: 'Stable task matrix',
      stage: 'tasks_ready',
      roleId: 'tech_director',
      createdAt: 5_000,
    };
    run.artifacts.push(artifact);
    const first = await registerEvolutionArtifactRevision({
      projectRoot: root,
      run,
      artifact,
      content: '# Matrix\n\nExact bytes.\n',
      status: 'candidate',
    });
    artifact.createdAt = 5_100;
    const duplicate = await registerEvolutionArtifactRevision({
      projectRoot: root,
      run,
      artifact,
      content: '# Matrix\n\nExact bytes.\n',
      status: 'candidate',
    });
    expect(duplicate).toBe(first);
    expect(run.artifactRevisions?.filter((entry) => entry.id === first.id)).toHaveLength(1);
    await expect(readFile(
      join(root, '.imc/evolution', run.runId, first.immutablePath),
      'utf8',
    )).resolves.toBe('# Matrix\n\nExact bytes.\n');
  });
});

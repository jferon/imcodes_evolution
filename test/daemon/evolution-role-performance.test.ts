import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import { computeEvolutionRolePerformance, summarizeEvolutionRolePerformance } from '../../shared/evolution-role-performance.js';
import {
  approveEvolutionRoleSkillCandidate,
  launchEvolutionRun,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  updateEvolutionRoleSkill,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-perf-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('computeEvolutionRolePerformance — pure aggregation', () => {
  it('aggregates attempts, issued verdicts, and roundtable participation per role', () => {
    const records = computeEvolutionRolePerformance({
      attempts: [
        { id: 'a1', kind: 'maker', stage: 'design_lofi', roleId: 'visual_designer', status: 'passed', dispatchToken: 't1', inputRevisionIds: [], skillSnapshotIds: [], outputRevisionIds: [], startedAt: 1 },
        { id: 'a2', kind: 'maker', stage: 'design_lofi', roleId: 'visual_designer', status: 'rework', dispatchToken: 't2', inputRevisionIds: [], skillSnapshotIds: [], outputRevisionIds: [], startedAt: 2 },
        { id: 'a3', kind: 'checker', stage: 'design_hifi', roleId: 'visual_fidelity_checker', status: 'blocked', dispatchToken: 't3', inputRevisionIds: [], skillSnapshotIds: [], outputRevisionIds: [], startedAt: 3 },
      ],
      verdictRecords: [
        { id: 'v1', attemptId: 'a1', stage: 'design_hifi', checkerRoleId: 'visual_fidelity_checker', verdict: 'REWORK', machineReadable: true, summary: 's', inputRevisionIds: [], approvedRevisionIds: [], createdAt: 4 },
      ],
      roundtables: [
        { id: 'r1', stage: 'product_discussion', topic: 't', roles: ['product_manager', 'product_critic'], status: 'complete', createdAt: 5, updatedAt: 6 },
        { id: 'r2', stage: 'design_hifi', topic: 't2', roles: ['product_critic'], status: 'failed', createdAt: 7, updatedAt: 8 },
      ],
    }, 100);

    const byRole = new Map(records.map((record) => [record.roleId, record]));
    expect(byRole.get('visual_designer')).toEqual(expect.objectContaining({
      attempts: { total: 2, passed: 1, rework: 1, blocked: 0, failed: 0 },
      proven: true,
    }));
    // Checker: blocked attempt, but an ISSUED verdict counts as observable work.
    expect(byRole.get('visual_fidelity_checker')).toEqual(expect.objectContaining({
      attempts: expect.objectContaining({ blocked: 1 }),
      verdictsIssued: { pass: 0, rework: 1, blocked: 0 },
      proven: true,
    }));
    expect(byRole.get('product_manager')).toEqual(expect.objectContaining({
      roundtables: { participated: 1, completed: 1, failed: 0 },
      proven: true,
    }));
    expect(byRole.get('product_critic')).toEqual(expect.objectContaining({
      roundtables: { participated: 2, completed: 1, failed: 1 },
      proven: true,
    }));
    // Roles with zero observations do not appear — silence is not evidence.
    expect(byRole.has('tech_director')).toBe(false);
    expect(summarizeEvolutionRolePerformance(byRole.get('visual_designer')!)).toContain('attempts=1/2 passed');
  });

  it('marks a role unproven when it only failed or is still running', () => {
    const records = computeEvolutionRolePerformance({
      attempts: [
        { id: 'a1', kind: 'maker', stage: 'design_lofi', roleId: 'visual_designer', status: 'failed', dispatchToken: 't', inputRevisionIds: [], skillSnapshotIds: [], outputRevisionIds: [], startedAt: 1 },
      ],
      roundtables: [
        { id: 'r1', stage: 'design_lofi', topic: 't', roles: ['visual_designer'], status: 'running', createdAt: 2, updatedAt: 3 },
      ],
    }, 100);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({ roleId: 'visual_designer', proven: false }));
  });
});

describe('role performance in projection and skill promotion', () => {
  it('exposes rolePerformance on the projection once roundtables complete', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/perf-projection.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 评估\n\n实现一个订单看板，包含列表与统计。\n', 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 60_000,
      request: {
        requestId: 'req-perf-proj',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    // Draft-mode autopilot completes its planning roundtables locally — that
    // participation is observable work and must surface as role performance.
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 61_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.rolePerformance).toBeDefined();
    const provenRoles = autopilot.value.rolePerformance?.filter((record) => record.roundtables.completed > 0) ?? [];
    expect(provenRoles.length).toBeGreaterThan(0);
    expect(provenRoles.every((record) => record.proven)).toBe(true);
  });

  it('records the performance summary on promotion votes and warns loudly for an unproven role', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/perf-promotion.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 晋升\n\n实现一个订单看板。\n', 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 70_000,
      request: {
        requestId: 'req-perf-promo',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    // Promote the visual_designer skill on a run where the role never
    // observably performed — promotion succeeds (human authority remains) but
    // the performance record is honestly attached and a warning is raised.
    const skillPath = join(root, '.imc/skills/evolution/visual-hifi.md');
    const original = await readFile(skillPath, 'utf8');
    const updated = await updateEvolutionRoleSkill({
      runId: launched.value.runId,
      roleId: 'visual_designer',
      markdown: `${original}\n## Eval Promotion Test\n- Prefer dense layouts.\n`,
      nowMs: 70_500,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const candidate = updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'visual_designer');
    expect(candidate).toBeDefined();

    const approved = await approveEvolutionRoleSkillCandidate({
      runId: launched.value.runId,
      roleId: 'visual_designer',
      candidateArtifactId: candidate!.id,
      approvalMessage: 'Team reviewed offline.',
      nowMs: 71_000,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.evidence).toContainEqual(expect.objectContaining({
      source: 'role_skill_performance_warning',
      summary: expect.stringContaining('UNPROVEN'),
    }));
    const manifest = JSON.parse(await readFile(join(root, 'config/evolution/role-skills/approved/manifest.json'), 'utf8')) as {
      entries?: Array<{ rolePerformanceSummary?: string }>;
    };
    expect(manifest.entries?.at(-1)?.rolePerformanceSummary).toContain('proven=false');
  });
});

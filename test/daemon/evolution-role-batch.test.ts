import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  EVOLUTION_TASK_ASSIGNMENT_MANIFEST_RELATIVE_PATH,
  type EvolutionTaskAssignmentManifest,
} from '../../shared/evolution-task-manifest.js';
import {
  ensureTaskAssignmentManifest,
  selectImplementationBatch,
} from '../../src/daemon/openspec-auto-deliver-orchestrator.js';
import {
  launchEvolutionRun,
  recordEvolutionP2pRunProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  type EvolutionAutoDeliverLaunchRequest,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-batch-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function manifestOf(assignments: EvolutionTaskAssignmentManifest['assignments']): EvolutionTaskAssignmentManifest {
  return { version: 1, runId: 'evo-batch', changeSlug: 'change-b', revision: 1, assignments, createdAt: 1 };
}

const T = (n: number) => `t-${n.toString(16).padStart(16, '0')}`;

describe('selectImplementationBatch — role-homogeneous grouping (#17)', () => {
  const manifest = manifestOf([
    { taskId: T(1), label: 'api one', ordinal: 0, makerRoleId: 'backend_developer', checkerRoleId: 'qa_engineer', assignmentSource: 'heuristic_label_classification' },
    { taskId: T(2), label: 'screen one', ordinal: 1, makerRoleId: 'frontend_developer', checkerRoleId: 'qa_engineer', assignmentSource: 'heuristic_label_classification' },
    { taskId: T(3), label: 'api two', ordinal: 2, makerRoleId: 'backend_developer', checkerRoleId: 'qa_engineer', assignmentSource: 'heuristic_label_classification' },
    { taskId: T(4), label: 'tests', ordinal: 3, makerRoleId: 'qa_engineer', checkerRoleId: 'tech_director', assignmentSource: 'heuristic_label_classification' },
  ]);

  it('picks the earliest-ordinal role with ALL of its remaining tasks', () => {
    const batch = selectImplementationBatch(manifest, [
      { checked: false, label: 'api one', taskId: T(1) },
      { checked: false, label: 'screen one', taskId: T(2) },
      { checked: false, label: 'api two', taskId: T(3) },
      { checked: false, label: 'tests', taskId: T(4) },
    ]);
    expect(batch?.makerRoleId).toBe('backend_developer');
    expect(batch?.taskIds).toEqual([T(1), T(3)]);
  });

  it('advances to the next role once a batch is checked; unknown/unannotated items never join a role batch', () => {
    const next = selectImplementationBatch(manifest, [
      { checked: true, label: 'api one', taskId: T(1) },
      { checked: false, label: 'screen one', taskId: T(2) },
      { checked: true, label: 'api two', taskId: T(3) },
      { checked: false, label: 'renamed by agent', taskId: 't-ffffffffffffffff' }, // unknown id
      { checked: false, label: 'no annotation at all' },                            // unannotated
    ]);
    expect(next?.makerRoleId).toBe('frontend_developer');
    expect(next?.taskIds).toEqual([T(2)]);
    // Everything attributable done → null (unattributed tail goes aggregate).
    const done = selectImplementationBatch(manifest, [
      { checked: true, label: 'api one', taskId: T(1) },
      { checked: true, label: 'screen one', taskId: T(2) },
      { checked: true, label: 'api two', taskId: T(3) },
      { checked: true, label: 'tests', taskId: T(4) },
      { checked: false, label: 'no annotation at all' },
    ]);
    expect(done).toBeNull();
  });
});

describe('ensureTaskAssignmentManifest — fail-closed verify (#17)', () => {
  it('loads on hash match, rejects mismatch and invalid schema', async () => {
    const root = await makeRoot();
    const manifest = manifestOf([
      { taskId: T(9), label: 'x', ordinal: 0, makerRoleId: 'backend_developer', assignmentSource: 'heuristic_label_classification' },
    ]);
    const manifestPath = join(root, 'task-assignments.json');
    const bytes = JSON.stringify(manifest);
    await writeFile(manifestPath, bytes, 'utf8');
    const goodSha = createHash('sha256').update(Buffer.from(bytes)).digest('hex');

    const okRun = { taskAssignmentManifestRef: { absolutePath: manifestPath, sha256: goodSha } } as never;
    expect(await ensureTaskAssignmentManifest(okRun)).toBeNull();
    expect((okRun as { taskAssignmentManifest?: EvolutionTaskAssignmentManifest }).taskAssignmentManifest?.assignments[0]?.taskId).toBe(T(9));

    // A workspace edit after launch changes bytes → hash mismatch fail-closed.
    await writeFile(manifestPath, JSON.stringify({ ...manifest, revision: 2 }), 'utf8');
    const staleRun = { taskAssignmentManifestRef: { absolutePath: manifestPath, sha256: goodSha } } as never;
    expect(await ensureTaskAssignmentManifest(staleRun)).toMatch(/^task_manifest_hash_mismatch:/);

    // Matching hash but invalid schema → fail-closed too.
    const invalidBytes = JSON.stringify({ version: 1, runId: 'r', changeSlug: 'c', revision: 1, assignments: [], createdAt: 1 });
    await writeFile(manifestPath, invalidBytes, 'utf8');
    const invalidRun = {
      taskAssignmentManifestRef: { absolutePath: manifestPath, sha256: createHash('sha256').update(Buffer.from(invalidBytes)).digest('hex') },
    } as never;
    expect(await ensureTaskAssignmentManifest(invalidRun)).toMatch(/^task_manifest_invalid:/);
  });
});

describe('launch envelope — Evolution passes the manifest ref to Auto Deliver (#17)', () => {
  it('the launcher request carries evolutionRunId + the exact manifest sha256', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/batch-envelope.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 需求\n\n实现订单看板，包含列表与统计。\n', 'utf8');
    setEvolutionRoundtableLauncher(async (request) => ({
      ok: true,
      p2pRunId: `p2p_${request.roundtableSpecId}`,
      discussionId: `dsc_${request.roundtableSpecId}`,
      contextPath: `.imc/discussions/${request.roundtableSpecId}.md`,
    }));
    const captured: EvolutionAutoDeliverLaunchRequest[] = [];
    setEvolutionAutoDeliverLauncher(async (request) => {
      captured.push(request);
      return { ok: true };
    });
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 50_000,
      request: {
        requestId: 'req-batch-envelope',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 51_000 });
    await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_planning-review',
        discussion_id: 'dsc_planning-review',
        status: 'completed',
        mode_key: 'review',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PASS: 规划复核通过\n<!-- EVOLUTION_VERDICT: PASS -->',
        completed_at: '2026-07-25T00:00:00.000Z',
      },
      serverLink: { send() { /* ignore */ } },
      nowMs: 52_000,
    });
    expect(captured.length).toBeGreaterThan(0);
    const request = captured[0]!;
    expect(request.evolutionRunId).toBe(launched.value.runId);
    expect(request.taskAssignmentManifest?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const manifestBytes = await readFile(join(root, '.imc/evolution', launched.value.runId, EVOLUTION_TASK_ASSIGNMENT_MANIFEST_RELATIVE_PATH));
    expect(request.taskAssignmentManifest?.sha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
    expect(request.taskAssignmentManifest?.absolutePath.endsWith(EVOLUTION_TASK_ASSIGNMENT_MANIFEST_RELATIVE_PATH)).toBe(true);
  });
});

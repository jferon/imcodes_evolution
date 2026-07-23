import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  FOUNDATION_MANIFEST_FILENAME,
  bootstrapGreenfieldFoundation,
  probeFoundationCapabilities,
} from '../../src/daemon/evolution-foundation.js';
import {
  getEvolutionRun,
  launchEvolutionRun,
  recordEvolutionOpenSpecProjection,
  recordEvolutionP2pRunProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-fnd-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('bootstrapGreenfieldFoundation', () => {
  it('initializes an isolated git repository with a manifest and reproducible HEAD proof', async () => {
    const root = await makeRoot();
    const result = await bootstrapGreenfieldFoundation({
      projectRoot: root,
      targetRelativeDir: 'apps/new-system',
      runId: 'evo-fnd-1',
      topology: 'modular_monolith',
      nowMs: 1_752_000_000_000,
    });
    expect(result.ok).toBe(true);
    expect(result.headSha).toMatch(/^[a-f0-9]{40}$/);
    const manifest = await readFile(join(root, 'apps/new-system', FOUNDATION_MANIFEST_FILENAME), 'utf8');
    expect(manifest).toContain('evo-fnd-1');
    expect(manifest).toContain('modular_monolith');
    // The workspace is its OWN repository, not a branch of the host project.
    const probes = await probeFoundationCapabilities({ projectRoot: root, targetRelativeDir: 'apps/new-system' });
    const repository = probes.find((probe) => probe.capability === 'repository');
    expect(repository?.status).toBe('verified');
    expect(repository?.proof).toContain(result.headSha!.slice(0, 12));
  });

  it('fails closed on a non-empty target and on paths escaping the project root', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'apps/occupied'), { recursive: true });
    await writeFile(join(root, 'apps/occupied/existing.txt'), 'do not overwrite', 'utf8');
    const occupied = await bootstrapGreenfieldFoundation({
      projectRoot: root,
      targetRelativeDir: 'apps/occupied',
      runId: 'evo-fnd-2',
      nowMs: 1_752_000_000_000,
    });
    expect(occupied.ok).toBe(false);
    expect(occupied.reason).toContain('not_empty');
    await expect(readFile(join(root, 'apps/occupied/existing.txt'), 'utf8')).resolves.toBe('do not overwrite');

    const escape = await bootstrapGreenfieldFoundation({
      projectRoot: root,
      targetRelativeDir: '../escape',
      runId: 'evo-fnd-3',
      nowMs: 1_752_000_000_000,
    });
    expect(escape.ok).toBe(false);
    expect(escape.reason).toContain('outside_project');
  });
});

describe('probeFoundationCapabilities — honest observation only', () => {
  it('reports planned for everything in an empty target and verified only for observed markers', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'apps/empty'), { recursive: true });
    const empty = await probeFoundationCapabilities({ projectRoot: root, targetRelativeDir: 'apps/empty' });
    expect(empty.every((probe) => probe.status === 'planned')).toBe(true);
    expect(empty.map((probe) => probe.capability).sort()).toEqual(
      ['auth', 'ci', 'database', 'deployment', 'observability', 'repository', 'runtime'],
    );

    const target = join(root, 'apps/marked');
    await mkdir(join(target, '.github/workflows'), { recursive: true });
    await writeFile(join(target, 'package.json'), '{"name":"new-system"}\n', 'utf8');
    await writeFile(join(target, '.github/workflows/ci.yml'), 'on: push\n', 'utf8');
    await writeFile(join(target, 'Dockerfile'), 'FROM node:22\n', 'utf8');
    const marked = await probeFoundationCapabilities({ projectRoot: root, targetRelativeDir: 'apps/marked' });
    const byCapability = new Map(marked.map((probe) => [probe.capability, probe]));
    expect(byCapability.get('runtime')).toEqual(expect.objectContaining({ status: 'verified', proof: 'observed package.json' }));
    expect(byCapability.get('ci')?.status).toBe('verified');
    expect(byCapability.get('deployment')?.status).toBe('verified');
    // No `.git` yet, and auth has no objective marker — both stay planned.
    expect(byCapability.get('repository')?.status).toBe('planned');
    expect(byCapability.get('auth')?.status).toBe('planned');
    expect(byCapability.get('database')?.status).toBe('planned');
  });
});

describe('greenfield foundation wiring — bootstrap at launch, probes at QA completion', () => {
  async function launchGreenfieldToTasksReady(root: string): Promise<{ runId: string; changeName: string; targetDir: string }> {
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/greenfield-foundation.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 新系统\n\n构建一个全新的订单看板系统，包含订单列表与 GMV 统计。\n', 'utf8');
    setEvolutionRoundtableLauncher(async (request) => ({
      ok: true,
      p2pRunId: `p2p_${request.roundtableSpecId}`,
      discussionId: `dsc_${request.roundtableSpecId}`,
      contextPath: `.imc/discussions/${request.roundtableSpecId}.md`,
    }));
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: {
        requestId: `req-fnd-${randomUUID().slice(0, 8)}`,
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        developmentMode: 'greenfield_new_system',
        developmentTargetRelativeDir: 'apps/new-system',
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw new Error('launch failed');
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 31_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) throw new Error('autopilot failed');
    return {
      runId: launched.value.runId,
      changeName: autopilot.value.linkedOpenSpecChange!,
      targetDir: join(root, 'apps/new-system'),
    };
  }

  async function passPlanningRoundtable(nowMs: number): Promise<void> {
    await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_planning-review',
        discussion_id: 'dsc_planning-review',
        status: 'completed',
        mode_key: 'review',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PASS: 规划复核通过\n<!-- EVOLUTION_VERDICT: PASS -->',
        completed_at: '2026-07-23T00:00:00.000Z',
      },
      serverLink: { send() { /* ignore */ } },
      nowMs,
    });
  }

  function openSpecPassedProjection(changeName: string): Record<string, unknown> {
    return {
      visibility: 'full',
      projectionVersion: 1,
      runId: 'auto_fnd_1',
      changeName,
      presetId: 'standard',
      materializedLimits: { specAuditRepairRounds: 1, implementationAuditRepairRounds: 2, maxImplementationPrompts: 12, maxElapsedMinutes: 480 },
      owningMainSessionName: 'deck_demo_brain',
      launchedFromSessionName: 'deck_demo_brain',
      targetImplementationSessionName: 'deck_demo_brain',
      generation: 1,
      implementationPromptCount: 2,
      elapsedMs: 1_000,
      status: 'passed',
      stage: 'passed',
      taskStats: { total: 2, checked: 2, unchecked: 0, items: [] },
      specAuditRepairRound: 0,
      implementationAuditRepairRound: 0,
      canStop: false,
      canContinue: false,
      moduleScores: [],
      evidence: [{ source: 'daemon', summary: 'All tasks completed.' }],
      lastMessage: 'passed',
    };
  }

  it('bootstraps the isolated workspace when auto delivery launches, then blocks an unproven foundation at QA completion', async () => {
    const root = await makeRoot();
    const launcherCalls: string[] = [];
    setEvolutionAutoDeliverLauncher(async (request) => {
      launcherCalls.push(request.changeName);
      return { ok: true };
    });
    const { runId, changeName } = await launchGreenfieldToTasksReady(root);

    // Planning roundtable PASS unlocks auto delivery → foundation bootstrap runs.
    await passPlanningRoundtable(32_000);
    expect(launcherCalls).toContain(changeName);
    const afterLaunch = getEvolutionRun(runId);
    const repository = afterLaunch?.value?.foundationEvidence?.find((item) => item.capability === 'repository');
    expect(repository?.status).toBe('verified');
    expect(repository?.summary).toContain('git rev-parse');
    await expect(readFile(join(root, 'apps/new-system', FOUNDATION_MANIFEST_FILENAME), 'utf8')).resolves.toContain(runId);

    // OpenSpec claims passed, but the workspace has no runtime manifest —
    // required foundation is unproven, so the run blocks instead of completing.
    const blocked = await recordEvolutionOpenSpecProjection({
      projection: openSpecPassedProjection(changeName) as never,
      nowMs: 33_000,
    });
    const projection = blocked.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('needs_human');
    expect(projection?.blockingQuestions).toContainEqual(expect.objectContaining({
      id: `greenfield-foundation-${runId}`,
      question: expect.stringContaining('runtime'),
    }));
    // Repository stayed verified (it IS observable); runtime never upgraded.
    expect(projection?.foundationEvidence?.find((item) => item.capability === 'repository')?.status).toBe('verified');
    expect(projection?.foundationEvidence?.find((item) => item.capability === 'runtime')?.status).toBe('planned');
  });

  it('verifies observed capabilities at QA completion and lets a proven foundation proceed', async () => {
    const root = await makeRoot();
    setEvolutionAutoDeliverLauncher(async () => ({ ok: true }));
    const { runId, changeName, targetDir } = await launchGreenfieldToTasksReady(root);
    await passPlanningRoundtable(42_000);

    // Implementation produced a real runtime manifest and CI config.
    await mkdir(join(targetDir, '.github/workflows'), { recursive: true });
    await writeFile(join(targetDir, 'package.json'), '{"name":"new-system","private":true}\n', 'utf8');
    await writeFile(join(targetDir, '.github/workflows/ci.yml'), 'on: push\n', 'utf8');

    const passed = await recordEvolutionOpenSpecProjection({
      projection: openSpecPassedProjection(changeName) as never,
      nowMs: 43_000,
    });
    const projection = passed.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('delivery_ready');
    expect(projection?.blockingQuestions?.some((question) => question.id === `greenfield-foundation-${runId}`)).toBe(false);
    const byCapability = new Map((projection?.foundationEvidence ?? []).map((item) => [item.capability, item]));
    expect(byCapability.get('repository')?.status).toBe('verified');
    expect(byCapability.get('runtime')?.status).toBe('verified');
    expect(byCapability.get('runtime')?.summary).toContain('observed package.json');
    expect(byCapability.get('ci')?.status).toBe('verified');
    // Unobservable capabilities remain honestly planned.
    expect(byCapability.get('auth')?.status).toBe('planned');
    expect(projection?.evidence).toContainEqual(expect.objectContaining({
      source: 'greenfield_foundation',
      summary: expect.stringContaining('Foundation probes'),
    }));
  });
});

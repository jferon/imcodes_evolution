import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  getEvolutionRun,
  launchEvolutionRun,
  pauseEvolutionRun,
  recordEvolutionOpenSpecProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverCanceller,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  stopEvolutionRun,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-stopvis-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionAutoDeliverCanceller(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

async function writeRequirement(root: string, name = 'feature.md'): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# 导出功能\n\n需要实现订单导出为 CSV，用户可以选择时间范围。\n', 'utf8');
  return sourceRelativePath;
}

describe('B1 — a concurrent stop is never overwritten to failed by a later autopilot error', () => {
  it('does not overwrite a concurrently-stopped run as failed on a later autopilot error', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root);
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_000,
      request: {
        requestId: 'req-b1-race',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        autoStartImplementation: true, // makes the planning roundtable use the live launcher
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;

    // Deterministic mid-flight interleaving: the roundtable launcher is
    // awaited inside the autopilot's try block — stop the run there, then
    // throw an unrelated error so the generic catch fires with the run
    // already terminal.
    setEvolutionRoundtableLauncher(async () => {
      await stopEvolutionRun({ runId, reason: 'race stop', nowMs: 11_500 });
      throw new Error('boom-after-stop');
    });

    const autopilot = await runEvolutionAutopilot(runId, null, { nowMs: 11_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    // Without the B1 guard, the catch would clobber this to 'failed'.
    expect(autopilot.value.stage).toBe('stopped');
    const readBack = getEvolutionRun(runId);
    expect(readBack?.value?.stage).toBe('stopped');
    expect(readBack?.value?.terminalReason).not.toBe('evolution_autopilot_failed');
  });
});

describe('B2 — Evolution stop/pause cancels the linked Auto Deliver run', () => {
  async function linkAutoDeliverRun(root: string, runId: string): Promise<string> {
    // Drive to tasks_ready so linkedOpenSpecChange materializes, then back-flow
    // an Auto Deliver projection with the matching changeName to set the link.
    await runEvolutionAutopilot(runId, null, { nowMs: 21_000 });
    const projection = getEvolutionRun(runId);
    expect(projection?.value?.stage).toBe('tasks_ready');
    const changeName = projection?.value?.linkedOpenSpecChange;
    expect(changeName).toBeTruthy();
    await recordEvolutionOpenSpecProjection({
      projection: {
        visibility: 'full',
        projectionVersion: 1,
        runId: 'auto_linked_1',
        changeName: changeName!,
        presetId: 'standard',
        materializedLimits: { specAuditRepairRounds: 1, implementationAuditRepairRounds: 1, maxImplementationPrompts: 6, maxElapsedMinutes: 240 },
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        owningMainSessionName: 'deck_demo_brain',
        launchedFromSessionName: 'deck_demo_brain',
        targetImplementationSessionName: 'deck_demo_brain',
        generation: 1,
        implementationPromptCount: 1,
        elapsedMs: 50,
        taskStats: { total: 1, checked: 0, unchecked: 1, items: [] },
        specAuditRepairRound: 0,
        implementationAuditRepairRound: 0,
        canStop: true,
        canContinue: false,
      },
      nowMs: 22_000,
    });
    expect(getEvolutionRun(runId)?.value?.linkedAutoDeliverRunId).toBe('auto_linked_1');
    return 'auto_linked_1';
  }

  it('stopEvolutionRun invokes the registered canceller with the linked runId and the run session name', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'stop-cancel.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 20_000,
      request: { requestId: 'req-b2-stop', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const linkedId = await linkAutoDeliverRun(root, launched.value.runId);

    const cancelled: Array<{ runId: string; sessionName: string }> = [];
    setEvolutionAutoDeliverCanceller(async (runId, sessionName) => {
      cancelled.push({ runId, sessionName });
      return true;
    });
    const stopped = await stopEvolutionRun({ runId: launched.value.runId, nowMs: 23_000 });
    expect(stopped.ok).toBe(true);
    expect(cancelled).toEqual([{ runId: linkedId, sessionName: 'deck_demo_brain' }]);
  });

  it('pauseEvolutionRun also cancels, and a rejecting canceller never breaks the pause', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pause-cancel.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 20_000,
      request: { requestId: 'req-b2-pause', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await linkAutoDeliverRun(root, launched.value.runId);

    let called = 0;
    setEvolutionAutoDeliverCanceller(async () => {
      called += 1;
      throw new Error('cancel backend unavailable');
    });
    const paused = await pauseEvolutionRun({ runId: launched.value.runId, nowMs: 23_000 });
    expect(called).toBe(1);
    expect(paused.ok).toBe(true); // best-effort: pause proceeds despite the rejection
    if (!paused.ok) return;
    expect(paused.value.stage).toBe('needs_human');
  });
});

describe('B3 — userPauseState distinguishes pausing from paused', () => {
  it('reports pausing while the autopilot task is still in flight, then paused once it settles', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pause-state.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: {
        requestId: 'req-b3',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;

    let observedDuringFlight: string | undefined;
    setEvolutionRoundtableLauncher(async () => {
      // The autopilot promise is mid-await on this launcher — a pause landing
      // now must read as 'pausing', not 'paused'.
      const paused = await pauseEvolutionRun({ runId, nowMs: 31_500 });
      observedDuringFlight = paused.ok ? paused.value.userPauseState : undefined;
      return { ok: true, p2pRunId: 'p2p_b3', discussionId: 'dsc_b3', contextPath: '.imc/discussions/p2p_b3.md' };
    });

    await runEvolutionAutopilot(runId, null, { nowMs: 31_000 });
    expect(observedDuringFlight).toBe('pausing');
    // Autopilot has settled — the same run now reads as fully paused.
    expect(getEvolutionRun(runId)?.value?.userPauseState).toBe('paused');
  });

  it('is absent for runs that are not user-paused', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'no-pause.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: { requestId: 'req-b3-none', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(getEvolutionRun(launched.value.runId)?.value?.userPauseState).toBeUndefined();
  });
});

describe('B5b — taste-skill generation start/end live events', () => {
  it('emits a started event and a status-mapped completion event around the generation call', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'b5b.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 40_000,
      request: { requestId: 'req-b5b', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 41_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const tasteEvents = autopilot.value.liveEvents.filter((event) => event.source === 'taste_skill');
    const started = tasteEvents.find((event) => event.title === 'Taste-skill generation · started');
    expect(started).toBeTruthy();
    expect(started?.severity).toBe('info');
    // No design.json in this fixture → not_configured maps to 'info', not an error.
    const finished = tasteEvents.find((event) => event.title === 'Taste-skill generation · not_configured');
    expect(finished).toBeTruthy();
    expect(finished?.severity).toBe('info');
  });
});

describe('C5 — zero-capable-dispatch hard block, never a silent fidelity PASS', () => {
  it('blocks to needs_human with a failed fidelity roundtable when no launcher is available', async () => {
    const root = await makeRoot();
    const dir = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/ref-task`;
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'screen-ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const sourceRelativePath = `${dir}/screen.md`;
    await writeFile(join(root, sourceRelativePath), [
      '# 页面还原',
      '',
      '需要实现参考截图对应的页面，必须严格参考截图还原。',
      '',
      '![参考截图](./screen-ref.png)',
      '',
    ].join('\n'), 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 50_000,
      request: { requestId: 'req-c5-hard', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    // No roundtable launcher registered at all — the alwaysGate fidelity spec
    // must hard-block instead of completing via the local text-only fallback.
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 51_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('needs_human');
    const fidelity = autopilot.value.roundtables.find((roundtable) => roundtable.id === 'visual-fidelity-review');
    expect(fidelity?.status).toBe('failed');
    expect(fidelity?.error).toBe('roundtable_launcher_unavailable');
    // Never a fabricated local PASS for this spec.
    expect(fidelity?.summary ?? '').not.toContain('local deterministic');
  });
});

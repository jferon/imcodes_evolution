import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID,
} from '../../shared/evolution-pipeline-constants.js';
import {
  getEvolutionRun,
  launchEvolutionRun,
  recordEvolutionP2pRunProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  type EvolutionRoundtableLaunchRequest,
} from '../../src/daemon/evolution-orchestrator.js';
import { isEligibleHelper } from '../../src/daemon/evolution-p2p-roundtable.js';
import type { SessionRecord } from '../../src/store/session-store.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-vf-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function makeLaunchRequest(specId: string): EvolutionRoundtableLaunchRequest {
  return {
    requestId: 'req-vf-test',
    runId: 'evo-vf-test',
    sessionName: 'deck_demo_brain',
    projectRoot: '/tmp/project',
    stage: 'design_hifi',
    topic: 'test',
    roles: ['visual_fidelity_checker', 'visual_designer'],
    roleInstructions: [],
    prompt: 'p',
    artifactPaths: [],
    roundtableSpecId: specId,
  };
}

function makeSession(agentType: string): SessionRecord {
  return {
    name: 'deck_demo_w1',
    agentType,
    state: 'idle',
    role: 'worker',
    projectName: 'demo',
    projectDir: '/tmp/project',
  } as unknown as SessionRecord;
}

describe('C5 — helper eligibility for the visual-fidelity gate', () => {
  it('rejects non-Claude-Code helpers for visual-fidelity-review ONLY; design-review is unaffected', () => {
    for (const agentType of ['shell', 'codex', 'gemini', 'opencode']) {
      const session = makeSession(agentType);
      expect(isEligibleHelper(session, makeLaunchRequest(EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID)), `${agentType} must be rejected for fidelity`).toBe(false);
      expect(isEligibleHelper(session, makeLaunchRequest('design-review')), `${agentType} must stay eligible for design-review`).toBe(true);
    }
    for (const agentType of ['claude-code', 'claude-code-sdk']) {
      expect(isEligibleHelper(makeSession(agentType), makeLaunchRequest(EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID)), `${agentType} must be eligible for fidelity`).toBe(true);
    }
  });
});

// ── Full-pipeline fixtures for the gate + retry loop ────────────────────────

async function writeRequirementWithReferenceImage(root: string): Promise<string> {
  const dir = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/dashboard-task`;
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, 'dashboard-ref.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const sourceRelativePath = `${dir}/dashboard.md`;
  await writeFile(join(root, sourceRelativePath), [
    '# 订单管理仪表盘',
    '',
    '需要实现下方参考截图对应的订单管理页面，用户可以查看订单列表和状态。',
    '必须严格参考截图还原布局。',
    '',
    '![参考截图](./dashboard-ref.png)',
    '',
  ].join('\n'), 'utf8');
  return sourceRelativePath;
}

interface CapturedLaunch {
  roundtableSpecId: string;
  prompt: string;
  p2pRunId: string;
}

function installCapturingLauncher(captured: CapturedLaunch[]): void {
  let counter = 0;
  setEvolutionRoundtableLauncher(async (request) => {
    counter += 1;
    const p2pRunId = `p2p_${request.roundtableSpecId}_${counter}`;
    captured.push({ roundtableSpecId: request.roundtableSpecId, prompt: request.prompt, p2pRunId });
    return { ok: true, p2pRunId, discussionId: `dsc_${p2pRunId}`, contextPath: `.imc/discussions/${p2pRunId}.md` };
  });
}

async function completeFidelityRoundtable(p2pRunId: string, summary: string, nowMs: number): Promise<void> {
  await recordEvolutionP2pRunProjection({
    run: {
      id: p2pRunId,
      discussion_id: `dsc_${p2pRunId}`,
      status: 'completed',
      mode_key: 'review',
      current_round: 2,
      total_rounds: 2,
      result_summary: summary,
      completed_at: '2026-07-23T00:00:00.000Z',
    },
    serverLink: { send() { /* ignore */ } },
    nowMs,
  });
}

describe('C3/C7 — visual fidelity gate + maker/checker retry loop', () => {
  it('launches the fidelity roundtable (alwaysGate, non-strict mode) with a Read-tool prompt, retries on REWORK with feedback, and passes on a later attempt', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirementWithReferenceImage(root);
    const captured: CapturedLaunch[] = [];
    installCapturingLauncher(captured);

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_000,
      request: {
        requestId: 'req-vf-run-1',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        // roundtableGateMode defaults to non-strict 'planning' — the test
        // proves alwaysGate enforces the fidelity gate anyway.
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;

    const autopilot = await runEvolutionAutopilot(runId, null, { nowMs: 11_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;

    // Gate engaged under the DEFAULT non-strict mode: run paused at design_hifi
    // with the fidelity roundtable running for real (not local-fallbacked).
    expect(autopilot.value.stage).toBe('design_hifi');
    const fidelityLaunches = captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID);
    expect(fidelityLaunches).toHaveLength(1);
    // C4b — the prompt carries resolved reference-image paths + an imperative Read instruction.
    expect(fidelityLaunches[0]!.prompt).toContain('Read 工具');
    expect(fidelityLaunches[0]!.prompt).toContain('reference-images');

    // Checker returns REWORK → C7 retries (regenerates + relaunches checker) instead of escalating.
    await completeFidelityRoundtable(fidelityLaunches[0]!.p2pRunId, 'REWORK: 主色与参考图不符，侧边导航缺失。', 12_000);
    let run = getEvolutionRun(runId);
    expect(run?.value?.stage).toBe('design_hifi'); // not needs_human — retrying
    expect(run?.value?.evidence.filter((entry) => entry.source === 'design_hifi_fidelity_attempt')).toHaveLength(1);
    const secondLaunches = captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID);
    expect(secondLaunches).toHaveLength(2); // fresh checker dispatched

    // C7 requirement 2 — the checker feedback was appended into taste-hifi-prompt.md before regeneration.
    const promptFile = await readFile(join(root, '.imc/evolution', runId, 'design/taste-hifi-prompt.md'), 'utf8');
    expect(promptFile).toContain('第 1 轮视觉保真复核反馈');
    expect(promptFile).toContain('主色与参考图不符');

    // PASS on attempt 2 → gate clears and the pipeline advances past design_hifi.
    await completeFidelityRoundtable(secondLaunches[1]!.p2pRunId, 'PASS: 布局与配色已与参考图一致。', 13_000);
    run = getEvolutionRun(runId);
    expect(run?.value?.stage).not.toBe('design_hifi');
    expect(run?.value?.stage).not.toBe('needs_human');
    // Attempt count stays exactly 1 — a PASS never counts as an attempt.
    expect(run?.value?.evidence.filter((entry) => entry.source === 'design_hifi_fidelity_attempt')).toHaveLength(1);
  });

  it('escalates to needs_human with a distinct message after maxImplementationAttempts exhausted REWORKs', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirementWithReferenceImage(root);
    const captured: CapturedLaunch[] = [];
    installCapturingLauncher(captured);

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 20_000,
      request: { requestId: 'req-vf-run-2', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;
    await runEvolutionAutopilot(runId, null, { nowMs: 21_000 });

    // Default budget: maxImplementationAttempts = 3. REWORK #1-#3 each retry;
    // REWORK #4 finds the attempts exhausted and hard-blocks.
    for (let round = 1; round <= 4; round += 1) {
      const launches = captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID);
      const latest = launches[launches.length - 1]!;
      await completeFidelityRoundtable(latest.p2pRunId, `REWORK: 第 ${round} 次仍与参考图不符。`, 21_000 + round * 1_000);
    }

    const run = getEvolutionRun(runId);
    expect(run?.value?.stage).toBe('needs_human');
    expect(run?.value?.evidence.filter((entry) => entry.source === 'design_hifi_fidelity_attempt')).toHaveLength(3);
    // Distinct exhaustion trail, not the generic single-failure message.
    expect(run?.value?.evidence.some((entry) =>
      entry.source === 'roundtable_hard_gate' && entry.summary.includes('after 3 maker/checker attempts'),
    )).toBe(true);
  });

  it('retry bound survives evidence-buffer eviction — the prompt-file section count is authoritative', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirementWithReferenceImage(root);
    const captured: CapturedLaunch[] = [];
    installCapturingLauncher(captured);

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: { requestId: 'req-vf-run-3', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;
    await runEvolutionAutopilot(runId, null, { nowMs: 31_000 });

    const latestFidelityLaunch = () => {
      const launches = captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID);
      return launches[launches.length - 1]!;
    };
    // Between REWORKs, flood the run with 220 distinct running-status updates —
    // each is a "meaningful change" appending one evidence entry, enough to
    // evict older attempt-tagged entries out of the capped evidence buffer.
    const floodEvidence = async (p2pRunId: string, base: number): Promise<void> => {
      for (let i = 0; i < 220; i += 1) {
        await recordEvolutionP2pRunProjection({
          run: {
            id: p2pRunId,
            discussion_id: `dsc_${p2pRunId}`,
            status: 'running',
            mode_key: 'review',
            current_round: 1,
            total_rounds: 2,
            result_summary: `progress tick ${i}`,
            current_target_session: 'deck_demo_w1',
          },
          serverLink: { send() { /* ignore */ } },
          nowMs: base + i,
        });
      }
    };

    for (let round = 1; round <= 4; round += 1) {
      const latest = latestFidelityLaunch();
      if (round <= 3) await floodEvidence(latest.p2pRunId, 31_000 + round * 10_000);
      await completeFidelityRoundtable(latest.p2pRunId, `REWORK: 第 ${round} 次仍与参考图不符。`, 32_000 + round * 10_000);
    }

    const run = getEvolutionRun(runId);
    // Without the durable prompt-file count, evicted attempt tags would make
    // the counter restart from 0 and the loop would never exhaust.
    expect(run?.value?.stage).toBe('needs_human');
    const promptFile = await readFile(join(root, '.imc/evolution', runId, 'design/taste-hifi-prompt.md'), 'utf8');
    expect(promptFile.match(/^## 第 \d+ 轮视觉保真复核反馈/gm)).toHaveLength(3);
  });
});

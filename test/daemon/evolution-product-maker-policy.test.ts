import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
  EVOLUTION_PROJECT_POLICY_RELATIVE_PATH,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import { validateEvolutionProjectPolicy } from '../../shared/evolution-pipeline-validators.js';
import { createEvolutionRunFromRequirement } from '../../src/daemon/evolution-artifact-store.js';
import {
  PRODUCT_MAKER_PRD_RELATIVE_PATH,
  registerProductMakerOutputArtifacts,
} from '../../src/daemon/evolution-stage-runner.js';
import {
  continueEvolutionRun,
  getEvolutionRun,
  hydrateEvolutionRun,
  launchEvolutionRun,
  launchEvolutionRunFromInboxCandidate,
  readEvolutionProjectPolicy,
  recordEvolutionP2pRunProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-pmp-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

const AGENT_PRD = [
  '# PRD：商品管理仪表盘',
  '',
  '## 业务目标',
  '为运营团队提供订单与 GMV 的实时可视化，减少人工汇总时间 80%。',
  '',
  '## 目标用户',
  '- 运营专员：日常查看订单状态与异常。',
  '- 运营主管：周期性复盘 GMV 趋势。',
  '',
  '## 范围 / 非目标',
  '- 范围：订单列表、GMV 统计卡、状态筛选、CSV 导出。',
  '- 非目标：财务对账、退款流程。',
  '',
  '## 用户故事',
  '- 作为运营专员，我可以按状态筛选订单，以便快速定位异常单。',
  '',
  '- 作为运营主管，我可以查看近 30 天 GMV 趋势图，以便复盘运营策略效果。',
  '- 作为运营专员，我可以导出当前筛选结果为 CSV，以便离线分析与汇报。',
  '',
  '## 验收标准',
  '- 订单列表首屏加载 < 2s；筛选结果与后端一致。',
  '- GMV 统计卡数值与后端聚合接口一致，误差为 0。',
  '- CSV 导出包含当前筛选条件下的全部行，编码 UTF-8 带 BOM。',
].join('\n');

async function writeRequirement(root: string, name = 'pm-maker.md'): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# 商品管理\n\n需要实现商品管理仪表盘，用户可以查看 GMV 与订单列表。\n', 'utf8');
  return sourceRelativePath;
}

describe('Product Maker output promotion', () => {
  it('promotes a substantive agent-authored PRD as agent_attested; rejects thin output', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root);
    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      request: { requestId: 'req-pm-1', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    const runDir = join(root, '.imc/evolution', run.runId);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });

    // Thin/template-free output rejected.
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), 'ok\n', 'utf8');
    const thin = await registerProductMakerOutputArtifacts({ projectRoot: root, run, nowMs: Date.now() });
    expect(thin.ok).toBe(false);
    expect(thin.reason).toContain('substantive');

    // Substantive PRD promotes.
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), AGENT_PRD, 'utf8');
    const promoted = await registerProductMakerOutputArtifacts({ projectRoot: root, run, producerAttemptId: 'attempt-pm-1', nowMs: Date.now() });
    expect(promoted.ok).toBe(true);
    const prdArtifact = run.artifacts.find((artifact) => artifact.kind === 'prd');
    expect(prdArtifact?.assurance).toBe('agent_attested');
    expect(prdArtifact?.producerAttemptId).toBe('attempt-pm-1');
  });
});

describe('Product Maker governed dispatch — the agent PRD survives the deterministic template', () => {
  it('records a human waiver for Product Critic REWORK and resumes at UI design without regenerating the PRD', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pm-review-rework.md');
    const captured: Array<{ roundtableSpecId: string; p2pRunId: string; prompt: string }> = [];
    let counter = 0;
    setEvolutionRoundtableLauncher(async (request) => {
      counter += 1;
      const p2pRunId = `p2p_${request.roundtableSpecId}_${counter}`;
      captured.push({ roundtableSpecId: request.roundtableSpecId, p2pRunId, prompt: request.prompt });
      return { ok: true, p2pRunId, discussionId: `dsc_${p2pRunId}`, contextPath: `.imc/discussions/${p2pRunId}.md` };
    });

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 5_000,
      request: {
        requestId: 'req-pm-review-rework',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runDir = join(root, '.imc/evolution', launched.value.runId);
    const serverLink = { send() { /* ignore */ } };

    await runEvolutionAutopilot(launched.value.runId, serverLink, { nowMs: 5_100 });
    expect(captured[0]?.roundtableSpecId).toBe(EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), AGENT_PRD, 'utf8');
    await recordEvolutionP2pRunProjection({
      run: {
        id: captured[0]!.p2pRunId,
        discussion_id: `dsc_${captured[0]!.p2pRunId}`,
        status: 'completed',
        mode_key: 'discuss',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PRD 已写入。\n<!-- EVOLUTION_VERDICT: PASS -->',
        completed_at: '2026-07-24T10:00:00.000Z',
      },
      serverLink,
      nowMs: 5_200,
    });
    expect(captured[1]?.roundtableSpecId).toBe('product-review');

    await recordEvolutionP2pRunProjection({
      run: {
        id: captured[1]!.p2pRunId,
        discussion_id: `dsc_${captured[1]!.p2pRunId}`,
        status: 'completed',
        mode_key: 'review',
        current_round: 2,
        total_rounds: 2,
        result_summary: '必须补齐购买人画像和付款失败验收。\n<!-- EVOLUTION_VERDICT: REWORK -->',
        completed_at: '2026-07-24T10:01:00.000Z',
      },
      serverLink,
      nowMs: 5_300,
    });
    const blockedRun = getEvolutionRun(launched.value.runId)?.value;
    expect(blockedRun?.stage).toBe('needs_human');
    const existingPrdRevisionId = blockedRun?.artifacts.find((artifact) => artifact.kind === 'prd')?.revisionId;
    const existingReviewRevisionId = blockedRun?.artifacts.find((artifact) => artifact.kind === 'prd_review')?.revisionId;
    expect(existingPrdRevisionId).toBeTruthy();
    expect(existingReviewRevisionId).toBeTruthy();

    const continued = await continueEvolutionRun({
      runId: launched.value.runId,
      message: '接受当前产品风险，使用已有 PRD 继续进入 UI 设计。',
      serverLink,
      nowMs: 5_400,
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.stage).toBe('prd_ready');
    expect(continued.value.roundtables.find((roundtable) => roundtable.id === 'product-review'))
      .toEqual(expect.objectContaining({ status: 'complete' }));
    expect(continued.value.roundtables.find((roundtable) => roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID))
      .toEqual(expect.objectContaining({ status: 'complete' }));
    expect(captured).toHaveLength(2);
    expect(continued.value.evidence).toContainEqual(expect.objectContaining({
      source: 'human_roundtable_waiver',
    }));
    expect(continued.value.gates).toContainEqual(expect.objectContaining({
      kind: 'product_review',
      status: 'waived',
      candidateRevisionIds: expect.arrayContaining([existingPrdRevisionId, existingReviewRevisionId]),
      decision: expect.objectContaining({
        action: 'waive',
        actor: 'human',
      }),
    }));
    expect(continued.value.authorizedRevisions).toEqual(expect.objectContaining({
      'artifacts/prd.md': existingPrdRevisionId,
      'artifacts/prd-review.md': existingReviewRevisionId,
    }));
    expect(continued.value.artifacts.find((artifact) => artifact.kind === 'prd'))
      .toEqual(expect.objectContaining({ revisionId: existingPrdRevisionId, status: 'approved', assurance: 'waived' }));
    expect(continued.value.artifacts.find((artifact) => artifact.kind === 'prd_review'))
      .toEqual(expect.objectContaining({ revisionId: existingReviewRevisionId, status: 'approved', assurance: 'waived' }));

    const resumed = await runEvolutionAutopilot(launched.value.runId, serverLink, { nowMs: 5_500 });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.stage).toBe('design_lofi');
    expect(captured[2]?.roundtableSpecId).toBe('design-maker');
    expect(captured).toHaveLength(3);
  });

  it('launches the maker first, promotes on PASS, and the intake template never overwrites the agent PRD', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pm-slice.md');
    const captured: Array<{ roundtableSpecId: string; p2pRunId: string; prompt: string }> = [];
    let counter = 0;
    setEvolutionRoundtableLauncher(async (request) => {
      counter += 1;
      const p2pRunId = `p2p_${request.roundtableSpecId}_${counter}`;
      captured.push({ roundtableSpecId: request.roundtableSpecId, p2pRunId, prompt: request.prompt });
      return { ok: true, p2pRunId, discussionId: `dsc_${p2pRunId}`, contextPath: `.imc/discussions/${p2pRunId}.md` };
    });

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_000,
      request: {
        requestId: 'req-pm-slice',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;
    const runDir = join(root, '.imc/evolution', runId);

    await runEvolutionAutopilot(runId, null, { nowMs: 11_000 });
    // The very first governed dispatch is the Product Maker at intake_normalized.
    expect(captured[0]?.roundtableSpecId).toBe(EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID);
    expect(captured[0]!.prompt).toContain(PRODUCT_MAKER_PRD_RELATIVE_PATH);

    // The agent writes a real PRD, then reports PASS.
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), AGENT_PRD, 'utf8');
    await recordEvolutionP2pRunProjection({
      run: {
        id: captured[0]!.p2pRunId,
        discussion_id: `dsc_${captured[0]!.p2pRunId}`,
        status: 'completed',
        mode_key: 'review',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PASS: PRD 已写入\n<!-- EVOLUTION_VERDICT: PASS -->',
        completed_at: '2026-07-23T00:00:00.000Z',
      },
      serverLink: { send() { /* ignore */ } },
      nowMs: 12_000,
    });

    const run = getEvolutionRun(runId);
    const prdArtifact = run?.value?.artifacts.find((artifact) => artifact.kind === 'prd');
    expect(prdArtifact?.assurance).toBe('agent_attested');
    const makerAttempt = run?.value?.attempts?.find((attempt) => attempt.kind === 'maker' && attempt.stage === 'intake_normalized');
    expect(makerAttempt?.status).toBe('passed');
    expect(makerAttempt?.outputRevisionIds.length).toBeGreaterThanOrEqual(1);
    // The intake block ran after the resume — the deterministic template must
    // NOT have replaced the agent PRD (assurance would drop to pipeline_draft).
    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), 'utf8');
    expect(onDisk).toContain('减少人工汇总时间 80%');
  });

  it('accepts the final maker verdict when P2P appends execution audit sections after the marker', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pm-audit-suffix.md');
    let p2pRunId = '';
    setEvolutionRoundtableLauncher(async (request) => {
      p2pRunId = `p2p_${request.roundtableSpecId}_audit_suffix`;
      return {
        ok: true,
        p2pRunId,
        discussionId: `dsc_${p2pRunId}`,
        contextPath: `.imc/discussions/${p2pRunId}.md`,
      };
    });

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 20_000,
      request: {
        requestId: 'req-pm-audit-suffix',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 21_000 });
    const runDir = join(root, '.imc/evolution', launched.value.runId);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), AGENT_PRD, 'utf8');

    await recordEvolutionP2pRunProjection({
      run: {
        id: p2pRunId,
        discussion_id: `dsc_${p2pRunId}`,
        status: 'completed',
        mode_key: 'discuss',
        current_round: 2,
        total_rounds: 2,
        result_summary: [
          '## brain:codex-sdk:discuss — Final Summary',
          'PRD 已完成并真实写入，交由控制面注册 immutable revision。',
          '<!-- EVOLUTION_VERDICT: PASS -->',
          '',
          '## P2P Original Request Execution Confirmed (cycle 2/2)',
          'Marker file: .imc/discussions/example.cycle2.execution-confirmation-marker.json',
          'Status: completed',
          'Attempts: 1',
        ].join('\n'),
        completed_at: '2026-07-24T08:00:00.000Z',
      },
      serverLink: { send() { /* ignore */ } },
      nowMs: 22_000,
    });

    const stored = getEvolutionRun(launched.value.runId);
    const makerAttempt = stored?.value?.attempts?.find((attempt) => attempt.kind === 'maker' && attempt.stage === 'intake_normalized');
    expect(makerAttempt?.status).toBe('passed');
    expect(makerAttempt?.error).toBeUndefined();
    expect(makerAttempt?.outputRevisionIds.length).toBeGreaterThanOrEqual(1);
    expect(stored?.value?.artifacts.find((artifact) => artifact.kind === 'prd')?.assurance).toBe('agent_attested');
  });

  it('does not mistake an intermediate-round marker for a terminal result during restart recovery', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pm-mid-round-restart.md');
    const p2pRunId = 'p2p_product_maker_mid_round';
    setEvolutionRoundtableLauncher(async () => ({
      ok: true,
      p2pRunId,
      discussionId: `dsc_${p2pRunId}`,
      contextPath: `.imc/discussions/${p2pRunId}.md`,
    }));

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: {
        requestId: 'req-pm-mid-round-restart',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 31_000 });

    const contextPath = join(root, '.imc/discussions', `${p2pRunId}.md`);
    await mkdir(join(root, '.imc/discussions'), { recursive: true });
    await writeFile(contextPath, [
      '# P2P Discussion',
      '## brain — Round 1/2 Summary',
      '还需要第二轮收敛。',
      '<!-- EVOLUTION_VERDICT: REWORK -->',
      '',
      '## P2P Original Request Execution Confirmed (cycle 1/2)',
      `Marker file: ${contextPath}.cycle1.execution-marker.json`,
      'Status: completed',
      'Attempts: 1',
    ].join('\n'), 'utf8');

    const hydrated = await hydrateEvolutionRun(root, launched.value.runId, 32_000);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.value.roundtables.find((roundtable) => roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID)?.status).toBe('running');
    expect(hydrated.value.attempts?.find((attempt) => attempt.kind === 'maker')?.status).toBe('running');
  });

  it('recovers a final maker PASS from discussion context when the completion callback was lost', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pm-final-restart.md');
    const p2pRunId = 'p2p_product_maker_final_restart';
    setEvolutionRoundtableLauncher(async () => ({
      ok: true,
      p2pRunId,
      discussionId: `dsc_${p2pRunId}`,
      contextPath: `.imc/discussions/${p2pRunId}.md`,
    }));

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 40_000,
      request: {
        requestId: 'req-pm-final-restart',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 41_000 });

    const runDir = join(root, '.imc/evolution', launched.value.runId);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), AGENT_PRD, 'utf8');
    const contextPath = join(root, '.imc/discussions', `${p2pRunId}.md`);
    await mkdir(join(root, '.imc/discussions'), { recursive: true });
    await writeFile(contextPath, [
      '# P2P Discussion',
      '### Final Summary — Maker Execution Completion',
      'PRD 已完成并写入。',
      '<!-- EVOLUTION_VERDICT: PASS -->',
      '',
      '## P2P Original Request Execution Confirmed (cycle 2/2)',
      `Marker file: ${contextPath}.cycle2.execution-marker.json`,
      'Status: completed',
      'Attempts: 1',
    ].join('\n'), 'utf8');

    const hydrated = await hydrateEvolutionRun(root, launched.value.runId, 42_000);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    const makerAttempt = hydrated.value.attempts?.find((attempt) => attempt.kind === 'maker');
    expect(makerAttempt?.status).toBe('passed');
    expect(makerAttempt?.outputRevisionIds.length).toBeGreaterThanOrEqual(1);
    expect(hydrated.value.artifacts.find((artifact) => artifact.kind === 'prd')?.assurance).toBe('agent_attested');
  });

  it('repairs a terminal maker attempt misclassified by a truncated completion callback without rewriting its audit record', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pm-terminal-repair.md');
    const p2pRunId = 'p2p_product_maker_terminal_repair';
    setEvolutionRoundtableLauncher(async () => ({
      ok: true,
      p2pRunId,
      discussionId: `dsc_${p2pRunId}`,
      contextPath: `.imc/discussions/${p2pRunId}.md`,
    }));

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 50_000,
      request: {
        requestId: 'req-pm-terminal-repair',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 51_000 });

    const runDir = join(root, '.imc/evolution', launched.value.runId);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), AGENT_PRD, 'utf8');
    const contextPath = join(root, '.imc/discussions', `${p2pRunId}.md`);
    await mkdir(join(root, '.imc/discussions'), { recursive: true });
    await writeFile(contextPath, [
      '# P2P Discussion',
      '### Final Summary — Maker Execution Completion',
      'PRD 已完成并写入。',
      '<!-- EVOLUTION_VERDICT: PASS -->',
      '',
      '## P2P Original Request Execution Confirmed (cycle 2/2)',
      `Marker file: ${contextPath}.cycle2.execution-marker.json`,
      'Status: completed',
      'Attempts: 1',
    ].join('\n'), 'utf8');

    await recordEvolutionP2pRunProjection({
      run: {
        id: p2pRunId,
        discussion_id: `dsc_${p2pRunId}`,
        status: 'completed',
        mode_key: 'discuss',
        current_round: 2,
        total_rounds: 2,
        // Mirrors the observed 2 KiB tail truncation: the durable context has
        // PASS, but the terminal callback no longer includes the marker.
        result_summary: 'truncated terminal tail without the governed marker',
        completed_at: '2026-07-24T09:00:00.000Z',
      },
      nowMs: 52_000,
    });
    const blocked = getEvolutionRun(launched.value.runId);
    expect(blocked?.value?.attempts?.at(-1)?.status).toBe('blocked');
    expect(blocked?.value?.stage).toBe('needs_human');

    const hydrated = await hydrateEvolutionRun(root, launched.value.runId, 53_000);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    const makerAttempts = hydrated.value.attempts?.filter((attempt) => attempt.kind === 'maker') ?? [];
    expect(makerAttempts).toHaveLength(2);
    expect(makerAttempts[0]).toEqual(expect.objectContaining({
      status: 'blocked',
      error: 'machine_readable_evolution_verdict_missing',
    }));
    expect(makerAttempts[1]).toEqual(expect.objectContaining({
      status: 'passed',
      p2pRunId,
    }));
    expect(makerAttempts[1]!.outputRevisionIds.length).toBeGreaterThanOrEqual(1);
    expect(hydrated.value.stage).toBe('product_discussion');
    expect(hydrated.value.roundtables.find((roundtable) => roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID)).toEqual(expect.objectContaining({
      status: 'complete',
      attemptId: makerAttempts[1]!.id,
    }));
  });
});

describe('Watcher project policy (.imc/evolution/policy.json)', () => {
  it('validates the schema and rejects non-canonical values', () => {
    expect(validateEvolutionProjectPolicy({ version: 1 }).ok).toBe(true);
    expect(validateEvolutionProjectPolicy({ version: 1, executionPolicy: 'draft_preview', autoStartImplementation: false }).ok).toBe(true);
    expect(validateEvolutionProjectPolicy({ version: 2 }).ok).toBe(false);
    expect(validateEvolutionProjectPolicy({ version: 1, executionPolicy: 'yolo' }).ok).toBe(false);
    expect(validateEvolutionProjectPolicy({ version: 1, developmentTargetRelativeDir: '../escape' }).ok).toBe(false);
  });

  it('watcher launches consume a valid policy; absent/invalid policy keeps safe defaults', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'policy-run.md');
    const fileStat = await stat(join(root, sourceRelativePath));
    const candidate = { sourceRelativePath, sizeBytes: fileStat.size, mtimeMs: fileStat.mtimeMs };

    // No policy file → safe defaults (governed).
    expect(await readEvolutionProjectPolicy(root)).toBeNull();
    const defaultLaunch = await launchEvolutionRunFromInboxCandidate({
      projectRoot: root,
      sessionName: 'deck_demo_brain',
      candidate,
      requestId: 'req-policy-default',
    });
    expect(defaultLaunch.ok).toBe(true);
    if (defaultLaunch.ok) expect(defaultLaunch.value.executionPolicy).toBe('governed');

    // Valid policy relaxes explicitly.
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, EVOLUTION_PROJECT_POLICY_RELATIVE_PATH), JSON.stringify({
      version: 1,
      executionPolicy: 'draft_preview',
      roundtableGateMode: 'planning',
      autoStartImplementation: false,
      requireHifiHumanApproval: false,
      developmentMode: 'brownfield_refactor',
    }), 'utf8');
    const policy = await readEvolutionProjectPolicy(root);
    expect(policy?.executionPolicy).toBe('draft_preview');
    const policyLaunch = await launchEvolutionRunFromInboxCandidate({
      projectRoot: root,
      sessionName: 'deck_demo_brain',
      candidate,
      requestId: 'req-policy-relaxed',
    });
    expect(policyLaunch.ok).toBe(true);
    if (policyLaunch.ok) {
      expect(policyLaunch.value.executionPolicy).toBe('draft_preview');
      expect(policyLaunch.value.autoDelivery?.enabled).toBe(false);
      expect(policyLaunch.value.developmentMode).toBe('brownfield_refactor');
    }

    // Invalid policy → treated as absent, safe defaults return.
    await writeFile(join(root, EVOLUTION_PROJECT_POLICY_RELATIVE_PATH), JSON.stringify({ version: 1, executionPolicy: 'yolo' }), 'utf8');
    expect(await readEvolutionProjectPolicy(root)).toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID,
  EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import {
  DESIGN_SYSTEM_TOKENS_RELATIVE_PATH,
  UI_PREVIEW_HTML_RELATIVE_PATH,
  UI_SPEC_RELATIVE_PATH,
  formatUiVisualReportMarker,
  parseUiVisualReportMarker,
  renderUiVisualReportFeedback,
  validateUiSpecDocument,
  type UiSpecDocument,
} from '../../shared/ui-spec.js';
import { createEvolutionRunFromRequirement } from '../../src/daemon/evolution-artifact-store.js';
import {
  PRODUCT_MAKER_PRD_RELATIVE_PATH,
  registerDesignMakerOutputArtifacts,
} from '../../src/daemon/evolution-stage-runner.js';
import { runEvolutionUiScreenshots } from '../../src/daemon/evolution-design-runner.js';
import {
  continueEvolutionRun,
  getEvolutionRun,
  launchEvolutionRun,
  recordEvolutionP2pRunProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-uie-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

const VALID_SPEC: UiSpecDocument = {
  version: 1,
  page: { name: '商品管理', type: 'dashboard' },
  design: { style: 'glass-modern', tokensRef: DESIGN_SYSTEM_TOKENS_RELATIVE_PATH },
  layout: { sidebar: { width: 240 } },
  screens: [
    {
      name: '订单总览',
      viewport: { width: 1440, height: 900 },
      path: '#screen-1',
      components: [
        { type: 'stat-card', title: 'GMV', props: { trend: 'up' } },
        { type: 'table', title: '订单列表', children: [{ type: 'column', title: '状态' }] },
      ],
    },
  ],
};

describe('UI Spec schema (shared/ui-spec.ts)', () => {
  it('accepts and normalizes a valid spec', () => {
    const result = validateUiSpecDocument(JSON.parse(JSON.stringify(VALID_SPEC)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.screens[0]!.components).toHaveLength(2);
    expect(result.value.design.tokensRef).toBe(DESIGN_SYSTEM_TOKENS_RELATIVE_PATH);

    const descriptiveStyle = validateUiSpecDocument({
      ...VALID_SPEC,
      design: {
        ...VALID_SPEC.design,
        style: 'Dark technical operations console with evidence-first hierarchy, preserved host chrome, stronger small-text contrast, and intentionally separated prose typography.',
      },
    });
    expect(descriptiveStyle.ok).toBe(true);
  });

  it('rejects specs without screens, with bad viewports, and non-JSON shapes', () => {
    expect(validateUiSpecDocument({ ...VALID_SPEC, screens: [] }).ok).toBe(false);
    const badViewport = JSON.parse(JSON.stringify(VALID_SPEC)) as Record<string, unknown>;
    (badViewport.screens as Array<{ viewport: { width: number } }>)[0]!.viewport.width = 10;
    expect(validateUiSpecDocument(badViewport).ok).toBe(false);
    expect(validateUiSpecDocument('not-an-object').ok).toBe(false);
    expect(validateUiSpecDocument({ ...VALID_SPEC, version: 2 }).ok).toBe(false);
  });
});

describe('UI Visual Report marker', () => {
  it('round-trips a structured report and renders actionable feedback', () => {
    const marker = formatUiVisualReportMarker({
      score: 72,
      basis: 'preview_source',
      errors: [{ type: 'layout', issue: 'header 高度偏高', fix: 'reduce header height to 64px', screen: '订单总览' }],
      summary: '主色偏差明显。',
    });
    const parsed = parseUiVisualReportMarker(`REWORK: 需要修正\n多行说明\n${marker}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.score).toBe(72);
    expect(parsed!.errors).toHaveLength(1);
    const feedback = renderUiVisualReportFeedback(parsed!);
    expect(feedback).toContain('72/100');
    expect(feedback).toContain('reduce header height');
  });

  it('returns null for malformed or out-of-range reports', () => {
    expect(parseUiVisualReportMarker('PASS with no marker')).toBeNull();
    expect(parseUiVisualReportMarker('<!-- UI_VISUAL_REPORT: {not json} -->')).toBeNull();
    expect(parseUiVisualReportMarker('<!-- UI_VISUAL_REPORT: {"score":140,"basis":"spec_only","errors":[]} -->')).toBeNull();
  });
});

async function makeStoredRun(root: string) {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/ui-engine.md`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# 商品管理\n\n需要实现商品管理仪表盘，用户可以查看 GMV 与订单列表。\n', 'utf8');
  return createEvolutionRunFromRequirement({
    projectRoot: root,
    request: {
      requestId: `req-uie-${randomUUID().slice(0, 8)}`,
      sessionName: 'deck_demo_brain',
      sourceRelativePath,
    },
  });
}

describe('Design Maker output promotion', () => {
  it('promotes schema-valid outputs as agent_attested candidates', async () => {
    const root = await makeRoot();
    const run = await makeStoredRun(root);
    const runDir = join(root, '.imc/evolution', run.runId);
    await mkdir(join(runDir, 'design/design-system'), { recursive: true });
    await writeFile(join(runDir, UI_SPEC_RELATIVE_PATH), JSON.stringify(VALID_SPEC, null, 2), 'utf8');
    await writeFile(join(runDir, UI_PREVIEW_HTML_RELATIVE_PATH), '<!doctype html><html><body><section id="screen-1">订单总览</section></body></html>', 'utf8');
    await writeFile(join(runDir, DESIGN_SYSTEM_TOKENS_RELATIVE_PATH), JSON.stringify({ colors: { primary: '#3b82f6' } }), 'utf8');

    const result = await registerDesignMakerOutputArtifacts({ projectRoot: root, run, producerAttemptId: 'attempt-test-1', nowMs: Date.now() });
    expect(result.ok).toBe(true);
    expect(result.revisionIds.length).toBeGreaterThanOrEqual(2);
    const uiSpecArtifact = run.artifacts.find((artifact) => artifact.kind === 'ui_spec');
    expect(uiSpecArtifact?.assurance).toBe('agent_attested');
    expect(uiSpecArtifact?.producerAttemptId).toBe('attempt-test-1');
    expect(uiSpecArtifact?.sha256).toBeTruthy();
    expect(run.artifacts.find((artifact) => artifact.kind === 'hifi_preview_html')).toBeTruthy();
  });

  it('fails promotion for missing preview or schema-invalid spec — a PASS claim alone never promotes', async () => {
    const root = await makeRoot();
    const run = await makeStoredRun(root);
    const runDir = join(root, '.imc/evolution', run.runId);
    await mkdir(join(runDir, 'design'), { recursive: true });
    // schema-invalid spec (no screens)
    await writeFile(join(runDir, UI_SPEC_RELATIVE_PATH), JSON.stringify({ ...VALID_SPEC, screens: [] }), 'utf8');
    await writeFile(join(runDir, UI_PREVIEW_HTML_RELATIVE_PATH), '<html></html>', 'utf8');
    const invalidSpec = await registerDesignMakerOutputArtifacts({ projectRoot: root, run, nowMs: Date.now() });
    expect(invalidSpec.ok).toBe(false);
    expect(invalidSpec.reason).toContain('schema validation');
    // valid spec but missing preview
    await writeFile(join(runDir, UI_SPEC_RELATIVE_PATH), JSON.stringify(VALID_SPEC), 'utf8');
    await rm(join(runDir, UI_PREVIEW_HTML_RELATIVE_PATH));
    const missingPreview = await registerDesignMakerOutputArtifacts({ projectRoot: root, run, nowMs: Date.now() });
    expect(missingPreview.ok).toBe(false);
    expect(missingPreview.reason).toContain(UI_PREVIEW_HTML_RELATIVE_PATH);
    expect(run.artifacts.find((artifact) => artifact.kind === 'ui_spec')).toBeUndefined();
  });
});

describe('Preview screenshot runner (opt-in, honest degradation)', () => {
  it('reports not_configured without design.json and never fabricates shots', async () => {
    const root = await makeRoot();
    const result = await runEvolutionUiScreenshots({
      projectRoot: root,
      runId: 'evo-test-shot-1',
      previewRelativePath: UI_PREVIEW_HTML_RELATIVE_PATH,
      screens: [{ name: 'A', width: 1440, height: 900 }],
    });
    expect(result.status).toBe('not_configured');
    expect(result.shots).toHaveLength(0);
  });

  it('runs the configured command per screen and fails honestly when no file is produced', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/design.json'), JSON.stringify({
      tasteSkill: { enabled: false },
      screenshot: {
        enabled: true,
        command: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], Buffer.from([0x89,0x50,0x4e,0x47]))', '{outputPath}'],
        timeoutMs: 30_000,
      },
    }), 'utf8');
    const passed = await runEvolutionUiScreenshots({
      projectRoot: root,
      runId: 'evo-test-shot-2',
      previewRelativePath: UI_PREVIEW_HTML_RELATIVE_PATH,
      screens: [{ name: 'A', width: 1440, height: 900 }, { name: 'B', width: 390, height: 844 }],
    });
    expect(passed.status).toBe('passed');
    expect(passed.shots).toHaveLength(2);
    await expect(readFile(join(root, '.imc/evolution/evo-test-shot-2', passed.shots[0]!.relativePath))).resolves.toBeTruthy();

    // Command succeeds but writes nothing → failed, not silently passed.
    await writeFile(join(root, '.imc/evolution/design.json'), JSON.stringify({
      tasteSkill: { enabled: false },
      screenshot: { enabled: true, command: process.execPath, args: ['-e', 'process.exit(0)'] },
    }), 'utf8');
    const noOutput = await runEvolutionUiScreenshots({
      projectRoot: root,
      runId: 'evo-test-shot-3',
      previewRelativePath: UI_PREVIEW_HTML_RELATIVE_PATH,
      screens: [{ name: 'A', width: 1440, height: 900 }],
    });
    expect(noOutput.status).toBe('failed');
  });
});

describe('Design Maker governed dispatch — end-to-end vertical slice', () => {
  interface CapturedLaunch { roundtableSpecId: string; prompt: string; p2pRunId: string }

  function installCapturingLauncher(captured: CapturedLaunch[]): void {
    let counter = 0;
    setEvolutionRoundtableLauncher(async (request) => {
      counter += 1;
      const p2pRunId = `p2p_${request.roundtableSpecId}_${counter}`;
      captured.push({ roundtableSpecId: request.roundtableSpecId, prompt: request.prompt, p2pRunId });
      return { ok: true, p2pRunId, discussionId: `dsc_${p2pRunId}`, contextPath: `.imc/discussions/${p2pRunId}.md` };
    });
  }

  async function completeRoundtable(p2pRunId: string, summary: string, nowMs: number): Promise<void> {
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

  it('a maker PASS without real files downgrades to REWORK; with valid files it promotes and the pipeline advances', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/maker-slice.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 商品管理\n\n需要实现商品管理仪表盘，用户可以查看 GMV 与订单列表。\n', 'utf8');
    const captured: CapturedLaunch[] = [];
    installCapturingLauncher(captured);

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_000,
      request: {
        requestId: 'req-uie-slice',
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
    // Complete every pre-design roundtable with PASS until the maker launches.
    // Maker roundtables (e.g. the Product Maker at intake_normalized) require
    // real output files for their PASS to survive promotion.
    for (let guard = 0; guard < 6; guard += 1) {
      const makerLaunch = captured.find((entry) => entry.roundtableSpecId === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID);
      if (makerLaunch) break;
      const latest = captured[captured.length - 1];
      if (!latest) break;
      if (latest.roundtableSpecId === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID) {
        await mkdir(join(runDir, 'artifacts'), { recursive: true });
        await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), [
          '# PRD：商品管理仪表盘',
          '',
          '## 业务目标',
          '为运营团队提供订单与 GMV 的实时可视化，减少人工汇总时间 80%。',
          '',
          '## 目标用户',
          '- 运营专员：日常查看订单状态与异常；运营主管：周期性复盘 GMV 趋势。',
          '',
          '## 范围 / 非目标',
          '- 范围：订单列表、GMV 统计卡、状态筛选、CSV 导出。非目标：财务对账、退款流程。',
          '',
          '## 用户故事',
          '- 作为运营专员，我可以按状态筛选订单，以便快速定位异常单。',
          '- 作为运营主管，我可以查看近 30 天 GMV 趋势图，以便复盘运营策略效果。',
          '',
          '- 作为运营专员，我可以导出当前筛选结果为 CSV，以便离线分析与汇报。',
          '',
          '## 验收标准',
          '- 订单列表首屏加载 < 2s；筛选结果与后端一致；GMV 统计与后端聚合一致。',
          '- CSV 导出包含当前筛选条件下的全部行，编码 UTF-8 带 BOM。',
        ].join('\n'), 'utf8');
      }
      await completeRoundtable(latest.p2pRunId, `PASS: ok\n<!-- EVOLUTION_VERDICT: PASS -->`, 12_000 + guard * 500);
    }
    const makerLaunch = captured.find((entry) => entry.roundtableSpecId === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID);
    expect(makerLaunch).toBeTruthy();
    if (!makerLaunch) return;
    // The maker prompt names the exact output contract.
    expect(makerLaunch.prompt).toContain(UI_SPEC_RELATIVE_PATH);
    expect(makerLaunch.prompt).toContain(UI_PREVIEW_HTML_RELATIVE_PATH);

    // (a) PASS claim with NO files written → downgraded to REWORK (machine
    // marker rewritten too), nothing promoted, run hard-blocks for rework.
    await completeRoundtable(makerLaunch.p2pRunId, `PASS: 已完成设计\n<!-- EVOLUTION_VERDICT: PASS -->`, 15_000);
    const run = getEvolutionRun(runId);
    expect(run?.value?.artifacts.some((artifact) => artifact.kind === 'ui_spec')).toBe(false);
    const makerAttempt = run?.value?.attempts?.find((attempt) => attempt.kind === 'maker' && attempt.stage === 'design_lofi');
    expect(makerAttempt?.status).toBe('rework');
    // The fabricated PASS never cleared the gate: the run is blocked, not advanced.
    expect(run?.value?.stage).toBe('needs_human');
    const makerRoundtable = run?.value?.roundtables?.find((entry) => entry.id === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID);
    expect(makerRoundtable?.summary).toContain('REWORK: maker outputs failed promotion');
    expect(makerRoundtable?.summary).not.toMatch(/<!--\s*EVOLUTION_VERDICT:\s*PASS\s*-->/i);
    // (b) If the REWORK attempt did write valid files, a human Continue must
    // reuse and promote those files instead of deleting the roundtable and
    // dispatching a brand-new Design Maker from the beginning.
    await mkdir(join(runDir, 'design/design-system'), { recursive: true });
    await writeFile(join(runDir, UI_SPEC_RELATIVE_PATH), JSON.stringify(VALID_SPEC, null, 2), 'utf8');
    await writeFile(
      join(runDir, UI_PREVIEW_HTML_RELATIVE_PATH),
      '<!doctype html><html><body><section id="screen-1">订单总览</section></body></html>',
      'utf8',
    );
    await writeFile(
      join(runDir, DESIGN_SYSTEM_TOKENS_RELATIVE_PATH),
      JSON.stringify({ colors: { primary: '#3b82f6' } }),
      'utf8',
    );
    const designMakerLaunchCount = captured.filter((entry) => (
      entry.roundtableSpecId === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID
    )).length;
    const continued = await continueEvolutionRun({
      runId,
      message: '沿用已生成的低保真与 Design Maker 文件，继续后续设计评审。',
      nowMs: 16_000,
    });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.stage).toBe('design_lofi');
    expect(continued.value.artifacts).toContainEqual(expect.objectContaining({
      kind: 'ui_spec',
      status: 'candidate',
      assurance: 'agent_attested',
    }));
    expect(continued.value.roundtables.find((entry) => entry.id === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID))
      .toEqual(expect.objectContaining({ status: 'skipped' }));
    expect(continued.value.evidence).toContainEqual(expect.objectContaining({
      source: 'human_maker_output_reuse',
    }));
    expect(captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID))
      .toHaveLength(designMakerLaunchCount);

    const resumed = await runEvolutionAutopilot(runId, null, { nowMs: 17_000 });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.stage).toBe('design_hifi');
    expect(captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID))
      .toHaveLength(designMakerLaunchCount);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import { UI_SPEC_RELATIVE_PATH, type UiSpecDocument } from '../../shared/ui-spec.js';
import { createEvolutionRunFromRequirement } from '../../src/daemon/evolution-artifact-store.js';
import {
  EVOLUTION_HIFI_DRAFT_PLACEHOLDER_LABEL,
  readPromotedUiSpecDocument,
  renderUiSpecOverviewSvg,
  renderUiSpecScreenSvg,
} from '../../src/daemon/evolution-hifi-svg.js';
import {
  launchEvolutionRun,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-hifi-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

const SPEC: UiSpecDocument = {
  version: 1,
  page: { name: '订单运营仪表盘', type: 'dashboard' },
  design: { style: 'clean-light' },
  layout: { sidebar: { width: 240 } },
  screens: [
    {
      name: '订单总览',
      viewport: { width: 1440, height: 900 },
      path: '#screen-1',
      components: [
        { type: 'stat-card', title: '今日 GMV', props: { value: '¥86.4k' } },
        { type: 'stat-card', title: '订单数' },
        { type: 'stat-card', title: '客单价' },
        { type: 'line-chart', title: '近 30 天 GMV 趋势' },
        {
          type: 'table',
          title: '订单列表',
          children: [
            { type: 'column', title: '订单号' },
            { type: 'column', title: '金额' },
            { type: 'column', title: '状态' },
            { type: 'column', title: '下单时间' },
          ],
        },
      ],
    },
    {
      name: '筛选与导出',
      viewport: { width: 1440, height: 900 },
      components: [
        { type: 'filter-form', title: '筛选', children: [{ type: 'select', title: '状态' }, { type: 'date-range', title: '时间范围' }] },
        { type: 'button', title: '导出 CSV' },
        { type: 'list', title: '导出历史' },
      ],
    },
  ],
};

const BUSINESS_SPEC: UiSpecDocument = {
  version: 1,
  page: { name: '淘金术账号管理', type: 'vben-admin-module' },
  design: { style: 'Existing Vben light theme with dense operational data.' },
  layout: { sidebar: { width: 232 } },
  screens: [
    {
      name: '账号列表 · 超级管理员',
      viewport: { width: 1440, height: 900 },
      components: [
        {
          type: 'IdentityContextBar',
          props: {
            value: '超级管理员',
            source: '新接口',
            hint: '切换后同步重置筛选、选中行和权限动作',
          },
        },
        {
          type: 'FilterGrid',
          props: {
            fields: ['账号关键词', '后台身份', '前台版本', '行政区'],
            columns: 4,
          },
        },
        {
          type: 'VxeGrid',
          props: {
            columns: ['账号信息', '后台身份', '前台版本', '统一有效期', '用户行政区', '状态', '操作'],
            toolbar: ['开通账号/身份'],
          },
          children: [
            { type: 'RowAction', title: '查看详情' },
            { type: 'OverflowMenu', title: '更多' },
          ],
        },
      ],
    },
    {
      name: '资格购买申请 · 待审核',
      viewport: { width: 1440, height: 900 },
      components: [],
    },
    {
      name: '收益流水 · 结算视图',
      viewport: { width: 1440, height: 900 },
      components: [],
    },
    {
      name: '账号列表 · 390px 窄屏',
      viewport: { width: 390, height: 844 },
      components: [
        {
          type: 'CompactHeader',
          props: { identity: '官方代理', filtersCollapsed: true },
        },
        {
          type: 'ScrollableVxeGrid',
          props: {
            columns: ['账号信息', '后台身份', '前台版本', '统一有效期', '用户行政区', '状态', '操作'],
          },
        },
      ],
    },
  ],
};

describe('renderUiSpecScreenSvg — reviewable high-fidelity screens from structured design data', () => {
  it('renders real components with a proper hierarchy, never raw MD bullets', () => {
    const svg = renderUiSpecScreenSvg(SPEC, 0);
    // Real component content from the spec, not MD text slices.
    expect(svg).toContain('今日 GMV');
    expect(svg).toContain('¥86.4k');
    expect(svg).toContain('近 30 天 GMV 趋势');
    for (const column of ['订单号', '金额', '状态', '下单时间']) expect(svg).toContain(column);
    expect(svg).toContain('<polyline'); // the chart is drawn, not written as a bullet
    // Typographic hierarchy: no 30px/900 double-title header, no raw bullets.
    expect(svg).not.toContain('font-size="30" font-weight="900"');
    expect(svg).not.toContain('• ');
    // Sidebar navigation mirrors the screens; active state present.
    expect(svg).toContain('订单总览');
    expect(svg).toContain('筛选与导出');
    // Honest provenance footer.
    expect(svg).toContain(UI_SPEC_RELATIVE_PATH);
    // No dangling truncation garbage: every text node is either intact or ellipsized.
    const texts = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]!);
    expect(texts.every((value) => value.trim().length > 1 || /[…%▲]/.test(value))).toBe(true);
  });

  it('renders form/button/list screens and the overview sheet', () => {
    const formScreen = renderUiSpecScreenSvg(SPEC, 1);
    expect(formScreen).toContain('导出 CSV');
    expect(formScreen).toContain('时间范围');
    expect(formScreen).toContain('导出历史');
    const overview = renderUiSpecOverviewSvg(SPEC);
    expect(overview).toContain('订单运营仪表盘');
    expect(overview).toContain('1440×900');
    expect(overview).toContain('订单总览');
    expect(overview).toContain('筛选与导出');
  });

  it('renders semantic props as real mock content with inline SVG icons and images', () => {
    const svg = renderUiSpecScreenSvg(BUSINESS_SPEC, 0);
    expect(svg).toContain('账号关键词');
    expect(svg).toContain('后台身份');
    expect(svg).toContain('开通账号/身份');
    expect(svg).toContain('林晓夏');
    expect(svg).toContain('浙江省 · 杭州市');
    expect(svg).toContain('2027-07-23');
    expect(svg).toContain('前台版本');
    expect(svg).not.toMatch(/y="\d+"[^>]*>查看详情<\/text>/);
    expect((svg.match(/<path\b/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect((svg.match(/<image\b/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(svg).not.toContain('fill="#e8edf4"');
    expect(svg).not.toContain('账号列表 · 超级管…');
  });

  it('uses domain-shaped values and avatars when a person/account column is not first', () => {
    const spec: UiSpecDocument = {
      ...BUSINESS_SPEC,
      screens: [{
        name: '收益明细',
        viewport: { width: 1440, height: 900 },
        components: [{
          type: 'VxeGrid',
          title: '收益流水',
          props: {
            columns: ['流水号', '发生时间', '业务账号', '收益类型', '收益身份', '操作'],
            mockRows: [
              { 流水号: 'RV-CUSTOM-001', 发生时间: '07-25 10:00', 业务账号: 'taojin-custom-01', 收益类型: '首单收益', 收益身份: '超级管理员', 操作: '查看' },
              { 流水号: 'RV-CUSTOM-002', 发生时间: '07-25 09:20', 业务账号: 'taojin-custom-02', 收益类型: '续费收益', 收益身份: '官方代理', 操作: '查看' },
              { 流水号: 'RV-CUSTOM-003', 发生时间: '07-24 20:18', 业务账号: 'taojin-custom-03', 收益类型: '采购收益', 收益身份: '区域代理', 操作: '查看' },
            ],
          },
        }],
      }],
    };
    const svg = renderUiSpecScreenSvg(spec, 0);
    expect(svg).toContain('taojin-custom-01');
    expect(svg).toContain('首单收益');
    expect(svg).toContain('超级管理员');
    expect((svg.match(/<image\b/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('uses a collision-free mobile composition instead of squeezing the desktop sidebar', () => {
    const svg = renderUiSpecScreenSvg(BUSINESS_SPEC, 3);
    expect(svg).toContain('data-layout="mobile"');
    expect(svg).toContain('账号列表');
    expect(svg).toContain('林晓夏');
    expect(svg).toContain('更多');
    expect(svg).not.toContain('x1="232"');
    expect(svg).not.toContain('font-size="20" font-weight="800"');
    expect(svg).not.toContain('账号列表 · 390…');
  });
});

describe('readPromotedUiSpecDocument — only agent-attested, validated specs', () => {
  it('returns the spec only when the artifact is agent_attested AND the file validates', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/hifi-spec.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 需求\n\n订单看板。\n', 'utf8');
    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      request: { requestId: 'req-hifi-spec', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    // No ui_spec artifact at all → null.
    expect(await readPromotedUiSpecDocument(root, run)).toBeNull();

    const runDir = join(root, '.imc/evolution', run.runId);
    await mkdir(join(runDir, 'design'), { recursive: true });
    await writeFile(join(runDir, UI_SPEC_RELATIVE_PATH), JSON.stringify(SPEC), 'utf8');
    // Artifact exists but NOT agent_attested → still null (no template smuggling).
    run.artifacts.push({
      id: 'ui_spec:design/ui-spec.json', kind: 'ui_spec', path: UI_SPEC_RELATIVE_PATH,
      roleId: 'visual_designer', assurance: 'pipeline_draft', createdAt: 1,
    } as (typeof run.artifacts)[number]);
    expect(await readPromotedUiSpecDocument(root, run)).toBeNull();

    run.artifacts[run.artifacts.length - 1]!.assurance = 'agent_attested';
    const loaded = await readPromotedUiSpecDocument(root, run);
    expect(loaded?.page.name).toBe('订单运营仪表盘');

    // Corrupt file → null even with the attested artifact.
    await writeFile(join(runDir, UI_SPEC_RELATIVE_PATH), '{not json', 'utf8');
    expect(await readPromotedUiSpecDocument(root, run)).toBeNull();
  });
});

describe('MD-derived fallback is honestly labeled a draft placeholder', () => {
  it('labels fallback screens 草稿占位 and warns in the hi-fi approval question', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/hifi-fallback.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 订单看板\n\n实现订单列表与 GMV 统计，支持状态筛选与 CSV 导出。\n', 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 100_000,
      request: {
        requestId: 'req-hifi-fallback',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        requireHifiHumanApproval: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const waiting = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 101_000 });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;

    const screenSvg = await readFile(
      join(root, '.imc/evolution', launched.value.runId, 'design/hifi-screens/screen-01.svg'),
      'utf8',
    );
    // The draft banner is IN the image itself, and the broken double-title
    // header (30px/900 title + same-size subtitle) is gone.
    expect(screenSvg).toContain(EVOLUTION_HIFI_DRAFT_PLACEHOLDER_LABEL);
    expect(screenSvg).not.toContain('font-size="30" font-weight="900"');
    // Artifact titles say Draft, not High-Fidelity.
    const screenArtifact = waiting.value.artifacts.find((artifact) => artifact.path === 'design/hifi-screens/screen-01.svg');
    expect(screenArtifact?.title).toContain('Draft Screen');
    expect(screenArtifact?.title).toContain(EVOLUTION_HIFI_DRAFT_PLACEHOLDER_LABEL);
    // The human gate question says the set is placeholder-grade.
    const approval = waiting.value.blockingQuestions.find((question) => question.id.startsWith('design-hifi-approval-'));
    expect(approval?.question).toContain(EVOLUTION_HIFI_DRAFT_PLACEHOLDER_LABEL);
  });
});

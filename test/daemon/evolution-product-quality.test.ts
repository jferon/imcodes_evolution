import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import {
  PRD_SECTION_REQUIREMENTS,
  PRODUCT_MAKER_PRD_RELATIVE_PATH,
  PRODUCT_REVIEW_PASS_THRESHOLD,
  PRODUCT_REVIEW_REPORT_RELATIVE_PATH,
  assessPrdQuality,
  formatProductReviewReportMarker,
} from '../../shared/product-spec.js';
import { parseSkillMarkdown } from '../../shared/skill-store.js';
import { createEvolutionRunFromRequirement } from '../../src/daemon/evolution-artifact-store.js';
import { registerProductMakerOutputArtifacts } from '../../src/daemon/evolution-stage-runner.js';
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
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-pq-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

const BUSINESS_REQUIREMENT = [
  '# 代理账号管理改造',
  '',
  '为超级管理员设计代理账号管理能力，同时需要移动端查看和 PC 管理后台维护。',
  '- 核心对象包括区域代理、官方代理、体验版账号、标准版账号。',
  '- 支持新增、编辑、停用、充值、重置密码、查看详情、筛选和导出。',
  '- 需要列表、详情、表单弹窗、库存/配额展示、空状态、加载状态和无权限状态。',
  '- 一期不默认支持绑定既有账号或跨官方代理迁移。',
].join('\n');

async function writeRequirement(root: string, name: string, content = BUSINESS_REQUIREMENT): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), content, 'utf8');
  return sourceRelativePath;
}

describe('Deterministic product templates satisfy the PRD quality contract', () => {
  it('produces a draft PRD with well-formed stories, testable acceptance criteria, and no missing sections', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'draft-prd-quality.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 60_000,
      request: {
        requestId: 'req-pq-draft',
        sessionName: 'deck_pq_brain',
        projectName: 'pq',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 60_100 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;

    const runDir = join(root, '.imc/evolution', launched.value.runId);
    const prd = await readFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), 'utf8');
    const quality = assessPrdQuality({ prd });
    expect(quality.findings.filter((finding) => finding.severity === 'blocker')).toEqual([]);
    expect(quality.ok).toBe(true);
    expect(quality.stats.missingSections).toEqual([]);
    expect(quality.stats.wellFormedUserStories).toBeGreaterThanOrEqual(3);
    expect(quality.stats.testableAcceptanceCriteria).toBeGreaterThanOrEqual(3);
    expect(quality.stats.tracedStoryIds.length).toBeGreaterThan(0);

    // The preflight reports the contract it actually ran, not a fixed PASS.
    const preflight = await readFile(join(runDir, 'artifacts/prd-review.md'), 'utf8');
    expect(preflight).toContain('Deterministic Preflight');
    expect(preflight).toContain(`${quality.score}/100`);
    expect(preflight).toContain('PASS_WITH_ASSUMPTIONS');
    expect(autopilot.value.scores.find((score) => score.module === 'product')?.summary)
      .toContain('testable acceptance criteria');
  });

  it('reports REWORK in the preflight when the PRD on disk fails the contract', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'preflight-rework.md');
    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      request: { requestId: 'req-pq-preflight', sessionName: 'deck_pq_brain', sourceRelativePath },
    });
    // A promoted agent PRD that is structurally broken must be judged as such:
    // the template preflight reviews the file on disk, not the template.
    const runDir = join(root, '.imc/evolution', run.runId);
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), '# PRD\n\n## 目标\n做个好用的系统。\n', 'utf8');
    const promotion = await registerProductMakerOutputArtifacts({ projectRoot: root, run, nowMs: 61_000 });
    expect(promotion.ok).toBe(false);
    expect(promotion.reason).toContain('PRD quality contract');
    expect(promotion.prdQuality?.findings.some((finding) => finding.code === 'prd_user_stories_too_few')).toBe(true);
  });
});

describe('Product role skills carry an executable playbook', () => {
  it('renders the PRD section contract, story/acceptance formats, and the review report contract', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'role-skill-playbook.md');
    await createEvolutionRunFromRequirement({
      projectRoot: root,
      request: { requestId: 'req-pq-skills', sessionName: 'deck_pq_brain', sourceRelativePath },
    });

    const productManagerSkill = await readFile(join(root, '.imc/skills/evolution/product-prd.md'), 'utf8');
    expect(productManagerSkill).toContain('## 需求分析方法');
    expect(productManagerSkill).toContain('## 用户故事写法（INVEST）');
    expect(productManagerSkill).toContain('US-1 作为<具体角色>，我希望<可执行能力>，以便<可验证价值>');
    expect(productManagerSkill).toContain('给定<前置状态>，当<触发操作>，则<可观测结果>');
    for (const requirement of PRD_SECTION_REQUIREMENTS) {
      expect(productManagerSkill).toContain(requirement.label);
    }
    expect(parseSkillMarkdown(productManagerSkill, { name: 'product-prd', category: 'evolution' }).metadata.name)
      .toBe('product-prd');

    const productCriticSkill = await readFile(join(root, '.imc/skills/evolution/product-critic.md'), 'utf8');
    expect(productCriticSkill).toContain('## 反例法（本角色的核心武器）');
    expect(productCriticSkill).toContain('## 可测性判定规则');
    expect(productCriticSkill).toContain('PRODUCT_REVIEW_REPORT');
    expect(productCriticSkill).toContain(String(PRODUCT_REVIEW_PASS_THRESHOLD));
    expect(productCriticSkill).toContain('EVOLUTION_VERDICT');
    expect(parseSkillMarkdown(productCriticSkill, { name: 'product-critic', category: 'evolution' }).metadata.name)
      .toBe('product-critic');
  });
});

describe('Product Maker promotion enforces the PRD quality contract', () => {
  it('rejects a PASS over untestable acceptance criteria and feeds the reason into the retry prompt', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'maker-quality-gate.md');
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
      nowMs: 70_000,
      request: {
        requestId: 'req-pq-gate',
        sessionName: 'deck_pq_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;
    const runDir = join(root, '.imc/evolution', runId);
    const serverLink = { send() { /* ignore */ } };

    await runEvolutionAutopilot(runId, serverLink, { nowMs: 70_100 });
    expect(captured[0]?.roundtableSpecId).toBe(EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID);
    // The maker prompt carries the enforced contract, not a vague ask.
    expect(captured[0]!.prompt).toContain('给定<前置状态>，当<触发操作>，则<可观测结果>');
    expect(captured[0]!.prompt).toContain('禁用不可度量的形容词');

    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), [
      '# PRD：代理账号管理',
      '',
      '## 业务目标',
      '让超级管理员在一个页面内完成代理账号维护，减少跨系统切换。',
      '',
      '## 目标用户',
      '- 超级管理员：维护区域代理与官方代理。',
      '',
      '## 范围 / 非目标',
      '- 一期不支持跨官方代理迁移。',
      '',
      '## 用户故事',
      '- 作为超级管理员，我希望维护代理账号，以便减少跨系统切换。',
      '- 作为超级管理员，我希望查看代理详情，以便核对资格余额。',
      '- 作为区域代理，我希望查看名下代理，以便提前补充资格。',
      '',
      '## 验收标准',
      '- 页面交互要流畅友好。',
      '- 操作体验要良好。',
      '',
      '## 假设 / 开放问题',
      '- 假设 A1：资格由服务端统一扣减。',
    ].join('\n'), 'utf8');

    await recordEvolutionP2pRunProjection({
      run: {
        id: captured[0]!.p2pRunId,
        discussion_id: `dsc_${captured[0]!.p2pRunId}`,
        status: 'completed',
        mode_key: 'discuss',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PRD 已写入。\n<!-- EVOLUTION_VERDICT: PASS -->',
        completed_at: '2026-07-25T10:00:00.000Z',
      },
      serverLink,
      nowMs: 70_200,
    });

    const blocked = getEvolutionRun(runId)?.value;
    const makerAttempt = blocked?.attempts?.find((attempt) => attempt.kind === 'maker');
    expect(makerAttempt?.status).toBe('rework');
    expect(blocked?.artifacts.find((artifact) => artifact.kind === 'prd')?.assurance).not.toBe('agent_attested');
    expect(blocked?.evidence).toContainEqual(expect.objectContaining({
      source: 'maker_promotion',
      summary: expect.stringContaining('PRD quality contract'),
    }));
    // Product review is never dispatched over a PRD that failed promotion.
    expect(captured.some((entry) => entry.roundtableSpecId === 'product-review')).toBe(false);

    const continued = await continueEvolutionRun({
      runId,
      message: '请按门禁结论修复 PRD。',
      serverLink,
      nowMs: 70_300,
    });
    expect(continued.ok).toBe(true);
    await runEvolutionAutopilot(runId, serverLink, { nowMs: 70_400 });
    const retry = captured.filter((entry) => entry.roundtableSpecId === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID).at(-1);
    expect(retry?.prompt).toContain('上一次交付被质量门禁驳回');
    expect(retry?.prompt).toContain('PRD quality contract');
  });
});

describe('Product Critic structured review report', () => {
  it('persists the report, scores the product module from the checker, and refuses a PASS that contradicts it', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'product-review-report.md');
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
      nowMs: 80_000,
      request: {
        requestId: 'req-pq-review',
        sessionName: 'deck_pq_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;
    const runDir = join(root, '.imc/evolution', runId);
    const serverLink = { send() { /* ignore */ } };

    await runEvolutionAutopilot(runId, serverLink, { nowMs: 80_100 });
    await mkdir(join(runDir, 'artifacts'), { recursive: true });
    await writeFile(join(runDir, PRODUCT_MAKER_PRD_RELATIVE_PATH), [
      '# PRD：代理账号管理',
      '',
      '## 问题 / 背景',
      '超级管理员需要在三套后台之间核对代理资格，每周人工汇总耗时 6 小时。',
      '',
      '## 目标用户',
      '- 超级管理员：维护区域代理与官方代理。',
      '',
      '## 业务目标',
      '- 在一个页面内完成查询、充值、停用和详情核对。',
      '',
      '## 范围 / 非目标',
      '- 一期不支持跨官方代理迁移。',
      '',
      '## 用户故事',
      '- US-1 作为超级管理员，我希望按状态筛选区域代理，以便快速定位异常账号。',
      '- US-2 作为超级管理员，我希望给官方代理充值资格，以便代理继续开通账号。',
      '- US-3 作为区域代理，我希望查看名下剩余资格，以便提前申请补充。',
      '',
      '## 成功指标',
      '- 北极星：人工汇总耗时从 6 小时降到 1 小时以内。',
      '',
      '## 验收标准',
      '- US-1 给定列表已加载，当筛选状态为已停用时，则总数与后端一致。',
      '- US-2 给定具备充值权限，当充值 10 份资格时，则余额增加 10 且写入流水。',
      '- US-3 给定越权访问，当打开他人详情时，则返回 403。',
      '',
      '## 假设 / 开放问题',
      '- 假设 A1：资格由服务端统一扣减。',
      '',
      '## 风险 / 依赖',
      '- 风险：并发扣减可能超发，需要服务端加锁。',
    ].join('\n'), 'utf8');

    await recordEvolutionP2pRunProjection({
      run: {
        id: captured[0]!.p2pRunId,
        discussion_id: `dsc_${captured[0]!.p2pRunId}`,
        status: 'completed',
        mode_key: 'discuss',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PRD 已写入。\n<!-- EVOLUTION_VERDICT: PASS -->',
        completed_at: '2026-07-25T11:00:00.000Z',
      },
      serverLink,
      nowMs: 80_200,
    });
    const reviewLaunch = captured.find((entry) => entry.roundtableSpecId === 'product-review');
    expect(reviewLaunch).toBeTruthy();
    if (!reviewLaunch) return;
    expect(reviewLaunch.prompt).toContain('反例法');
    expect(reviewLaunch.prompt).toContain('PRODUCT_REVIEW_REPORT');
    expect(reviewLaunch.prompt).toContain(PRODUCT_MAKER_PRD_RELATIVE_PATH);

    await recordEvolutionP2pRunProjection({
      run: {
        id: reviewLaunch.p2pRunId,
        discussion_id: `dsc_${reviewLaunch.p2pRunId}`,
        status: 'completed',
        mode_key: 'review',
        current_round: 2,
        total_rounds: 2,
        result_summary: [
          '整体没问题。',
          formatProductReviewReportMarker({
            score: 58,
            basis: 'prd_only',
            issues: [
              { type: 'acceptance', severity: 'blocker', issue: '充值失败路径没有验收标准。', fix: '补充充值失败与重试的验收标准。', location: 'US-2' },
              { type: 'metric', severity: 'minor', issue: '缺少护栏指标。', fix: '补充失败率上限。' },
            ],
            summary: '验收覆盖不足。',
          }),
          '<!-- EVOLUTION_VERDICT: PASS -->',
        ].join('\n'),
        completed_at: '2026-07-25T11:05:00.000Z',
      },
      serverLink,
      nowMs: 80_300,
    });

    const reviewed = getEvolutionRun(runId)?.value;
    const reportArtifact = reviewed?.artifacts.find((artifact) => artifact.kind === 'product_review_report');
    expect(reportArtifact?.path).toBe(PRODUCT_REVIEW_REPORT_RELATIVE_PATH);
    expect(reportArtifact?.assurance).toBe('checker_verified');
    const persisted = JSON.parse(await readFile(join(runDir, PRODUCT_REVIEW_REPORT_RELATIVE_PATH), 'utf8')) as { score: number };
    expect(persisted.score).toBe(58);

    const productScore = reviewed?.scores.find((score) => score.module === 'product');
    expect(productScore?.source).toBe('checker');
    expect(productScore?.score).toBe(6);
    expect(productScore?.summary).toContain('1 blocker(s)');

    // A later deterministic pass must not overwrite the checker's score.
    await runEvolutionAutopilot(runId, serverLink, { nowMs: 80_400 });
    const afterResume = getEvolutionRun(runId)?.value;
    expect(afterResume?.scores.find((score) => score.module === 'product')?.source).toBe('checker');

    // A PASS token cannot outrank the critic's own report.
    const verdict = reviewed?.verdictRecords?.at(-1);
    expect(verdict?.verdict).toBe('REWORK');
    expect(verdict?.summary).toContain('a PASS token cannot override its own report');
    expect(reviewed?.evidence).toContainEqual(expect.objectContaining({
      source: 'product_review_report',
      summary: expect.stringContaining(`pass ${PRODUCT_REVIEW_PASS_THRESHOLD}`),
    }));
  });
});

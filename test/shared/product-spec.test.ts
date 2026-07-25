import { describe, expect, it } from 'vitest';
import {
  PRD_QUALITY_MIN_SCORE,
  PRD_SECTION_REQUIREMENTS,
  PRODUCT_REVIEW_PASS_THRESHOLD,
  assessPrdQuality,
  formatProductReviewReportMarker,
  parseProductReviewReportMarker,
  prdSectionRequirement,
  renderProductReviewFeedback,
  summarizePrdQualityFailure,
  validateProductReviewReport,
  type ProductReviewReport,
} from '../../shared/product-spec.js';

const COMPLETE_PRD = [
  '# PRD：代理账号管理',
  '',
  '## 问题 / 背景',
  '超级管理员目前需要在三套后台之间切换才能核对代理账号资格，人工汇总每周耗时 6 小时。',
  '',
  '## 目标用户',
  '- 超级管理员：维护区域代理与官方代理的账号与资格。',
  '- 区域代理：查看自己名下官方代理的资格余额。',
  '',
  '## 业务目标',
  '- 在一个页面内完成代理账号的查询、充值、停用和详情核对。',
  '',
  '## 非目标 / 范围边界',
  '- 一期不支持绑定既有账号，也不支持跨官方代理迁移。',
  '',
  '## 用户故事',
  '- US-1 作为超级管理员，我希望按状态筛选区域代理，以便快速定位异常账号。',
  '- US-2 作为超级管理员，我希望给官方代理充值资格，以便代理可以继续开通账号。',
  '- US-3 作为区域代理，我希望查看名下官方代理的剩余资格，以便提前申请补充。',
  '',
  '## 成功指标',
  '- 北极星：人工汇总耗时从每周 6 小时降到 1 小时以内。',
  '- 护栏：充值操作的失败率不高于 0.5%。',
  '',
  '## 验收标准',
  '- US-1 给定代理列表已加载，当选择状态“已停用”时，则列表只展示已停用代理且总数与后端一致。',
  '- US-2 给定管理员具备充值权限，当提交充值 10 份资格时，则余额增加 10 且写入一条操作流水。',
  '- US-2 给定管理员不具备充值权限，当打开充值入口时，则必须拒绝并提示原因，不得静默失败。',
  '- US-3 给定区域代理登录，当打开详情页时，则只能看到自己名下的官方代理，越权访问返回 403。',
  '',
  '## 假设 / 开放问题',
  '- 假设 A1：资格库存由服务端统一扣减，前端不做本地计算。',
  '- 开放问题 Q1：停用代理时名下账号是否立即失效，需要业务确认。',
  '',
  '## 风险 / 依赖',
  '- 风险：资格扣减并发可能导致超发，需要服务端加锁。',
].join('\n');

describe('PRD quality contract', () => {
  it('accepts a PRD that satisfies the section, story, and acceptance contract', () => {
    const assessment = assessPrdQuality({ prd: COMPLETE_PRD });
    expect(assessment.findings.filter((finding) => finding.severity === 'blocker')).toEqual([]);
    expect(assessment.ok).toBe(true);
    expect(assessment.score).toBeGreaterThanOrEqual(PRD_QUALITY_MIN_SCORE);
    expect(assessment.stats.missingSections).toEqual([]);
    expect(assessment.stats.wellFormedUserStories).toBe(3);
    expect(assessment.stats.testableAcceptanceCriteria).toBe(4);
    expect(assessment.stats.storyIds).toEqual(['US-1', 'US-2', 'US-3']);
    expect(assessment.stats.tracedStoryIds).toEqual(['US-1', 'US-2', 'US-3']);
  });

  it('rejects a document that is not a PRD at all', () => {
    const assessment = assessPrdQuality({ prd: 'ok\n' });
    expect(assessment.ok).toBe(false);
    expect(assessment.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(['prd_missing_title', 'prd_too_short', 'prd_missing_section']),
    );
    expect(summarizePrdQualityFailure(assessment)).toContain('substantive');
  });

  it('blocks user stories that drop the value clause and acceptance criteria that cannot be tested', () => {
    const prd = COMPLETE_PRD
      .replace('- US-1 作为超级管理员，我希望按状态筛选区域代理，以便快速定位异常账号。', '- US-1 支持按状态筛选区域代理。')
      .replace('- US-2 作为超级管理员，我希望给官方代理充值资格，以便代理可以继续开通账号。', '- US-2 支持充值资格。')
      .replace('- US-3 作为区域代理，我希望查看名下官方代理的剩余资格，以便提前申请补充。', '- US-3 支持查看剩余资格。')
      .replace(/^- US-\d 给定[^\n]*$/gm, '- 交互体验要良好，操作要流畅友好。');
    const assessment = assessPrdQuality({ prd });
    expect(assessment.ok).toBe(false);
    const codes = assessment.findings.map((finding) => finding.code);
    expect(codes).toContain('prd_user_stories_malformed');
    expect(codes).toContain('prd_acceptance_too_few');
    expect(assessment.findings.every((finding) => finding.fix.length > 0)).toBe(true);
  });

  it('flags unmeasurable acceptance wording even when the rest of the PRD is sound', () => {
    const prd = COMPLETE_PRD.replace(
      '- US-3 给定区域代理登录，当打开详情页时，则只能看到自己名下的官方代理，越权访问返回 403。',
      '- US-3 给定区域代理登录，当打开详情页时，则只能看到自己名下的官方代理，越权访问返回 403。\n- US-3 页面响应要流畅，交互要友好。',
    );
    const assessment = assessPrdQuality({ prd });
    const vague = assessment.findings.find((finding) => finding.code === 'prd_acceptance_vague');
    expect(vague?.severity).toBe('major');
    expect(vague?.samples?.[0]).toContain('流畅');
  });

  it('blocks leftover placeholder content', () => {
    const assessment = assessPrdQuality({ prd: `${COMPLETE_PRD}\n\n## 附录\n- TODO: 待补充导出规则。\n` });
    expect(assessment.ok).toBe(false);
    expect(assessment.findings.map((finding) => finding.code)).toContain('prd_placeholder_content');
  });

  it('counts stories and acceptance criteria from the companion documents too', () => {
    const prd = COMPLETE_PRD
      .replace(/^- US-\d 作为[^\n]*$/gm, '')
      .replace(/^- US-\d 给定[^\n]*$/gm, '');
    const thin = assessPrdQuality({ prd });
    expect(thin.ok).toBe(false);

    const withDocs = assessPrdQuality({
      prd,
      userStories: [
        '# User Stories',
        '- US-1 作为超级管理员，我希望按状态筛选区域代理，以便快速定位异常账号。',
        '- US-2 作为超级管理员，我希望给官方代理充值资格，以便代理可以继续开通账号。',
        '- US-3 作为区域代理，我希望查看名下官方代理的剩余资格，以便提前申请补充。',
      ].join('\n'),
      acceptanceCriteria: [
        '# Acceptance Criteria',
        '- US-1 给定列表已加载，当筛选状态为已停用时，则总数与后端一致。',
        '- US-2 给定具备权限，当充值 10 份资格时，则余额增加 10。',
        '- US-3 给定越权访问，当打开他人详情时，则返回 403。',
      ].join('\n'),
    });
    expect(withDocs.ok).toBe(true);
    expect(withDocs.stats.userStories).toBe(3);
    expect(withDocs.stats.acceptanceCriteria).toBe(3);
  });

  it('exposes every required section by id', () => {
    for (const requirement of PRD_SECTION_REQUIREMENTS) {
      expect(prdSectionRequirement(requirement.id)).toBe(requirement);
    }
    expect(PRD_SECTION_REQUIREMENTS.filter((entry) => entry.severity === 'blocker').map((entry) => entry.id))
      .toEqual(['goals', 'user_stories', 'acceptance_criteria']);
  });
});

describe('Product review report protocol', () => {
  const report: ProductReviewReport = {
    score: 62,
    basis: 'full_set',
    issues: [
      { type: 'acceptance', severity: 'blocker', issue: '导出验收标准没有失败路径。', fix: '补充导出失败时的提示与重试路径。', location: 'US-2' },
      { type: 'metric', severity: 'minor', issue: '缺少护栏指标。', fix: '补充失败率上限。' },
    ],
    summary: '验收标准覆盖不足。',
  };

  it('round-trips through the marker', () => {
    const summary = `一些评审正文\n${formatProductReviewReportMarker(report)}`;
    expect(parseProductReviewReportMarker(summary)).toEqual(report);
  });

  it('rejects malformed or out-of-range reports', () => {
    expect(parseProductReviewReportMarker('<!-- PRODUCT_REVIEW_REPORT: {not json} -->')).toBeNull();
    expect(parseProductReviewReportMarker('<!-- PRODUCT_REVIEW_REPORT: {"score":140,"basis":"prd_only","issues":[]} -->')).toBeNull();
    expect(parseProductReviewReportMarker('<!-- PRODUCT_REVIEW_REPORT: {"score":80,"basis":"guessing","issues":[]} -->')).toBeNull();
    expect(validateProductReviewReport({
      score: 80,
      basis: 'prd_only',
      issues: [{ type: 'story', severity: 'catastrophic', issue: 'x', fix: 'y' }],
    }).ok).toBe(false);
    expect(validateProductReviewReport({
      score: 80,
      basis: 'prd_only',
      issues: [{ type: 'story', severity: 'major', issue: 'x' }],
    }).ok).toBe(false);
    expect(parseProductReviewReportMarker(undefined)).toBeNull();
  });

  it('renders blocker-first feedback for the maker retry', () => {
    const feedback = renderProductReviewFeedback(report);
    expect(feedback).toContain(`pass threshold ${PRODUCT_REVIEW_PASS_THRESHOLD}`);
    expect(feedback.indexOf('[blocker/acceptance]')).toBeLessThan(feedback.indexOf('[minor/metric]'));
    expect(feedback).toContain('(US-2)');
    expect(feedback).toContain('补充导出失败时的提示与重试路径。');
  });
});

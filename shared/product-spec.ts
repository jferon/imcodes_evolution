/**
 * Product Evolution — shared PRD delivery contract and product-review protocol.
 *
 * The product roles are the first governed maker/checker pair in the pipeline,
 * and everything downstream (design, architecture, tasks, QA) inherits their
 * output. Prose alone is not a deliverable, so this module defines two
 * machine-checkable things:
 *
 * 1. `assessPrdQuality()` — a deterministic quality contract for the PRD /
 *    user-stories / acceptance-criteria set. The Product Maker's PASS claim is
 *    only promoted when the written files actually satisfy it, mirroring the
 *    Design Maker's `ui-spec.json` schema gate. Findings are actionable so the
 *    retry loop consumes data instead of "try harder".
 * 2. `ProductReviewReport` — the Product Critic's machine-readable verdict
 *    payload (0-100 score + typed issues with fixes), carried inside the
 *    roundtable summary as an HTML-comment marker, exactly like
 *    `UI_VISUAL_REPORT` and `EVOLUTION_VERDICT`.
 *
 * Heuristics here are intentionally language-aware (zh + en): requirement
 * documents in this pipeline are predominantly Chinese, and an English-only
 * matcher would silently score every real run as empty.
 */

/** Logical (promoted) artifact paths inside a run directory. */
export const PRODUCT_MAKER_PRD_RELATIVE_PATH = 'artifacts/prd.md' as const;
export const PRODUCT_MAKER_USER_STORIES_RELATIVE_PATH = 'artifacts/user-stories.md' as const;
export const PRODUCT_MAKER_ACCEPTANCE_RELATIVE_PATH = 'artifacts/acceptance-criteria.md' as const;
export const PRODUCT_REVIEW_REPORT_RELATIVE_PATH = 'artifacts/product-review-report.json' as const;

/** Bounded author→review→fix loop: stop asking for another pass at this score. */
export const PRODUCT_REVIEW_PASS_THRESHOLD = 85 as const;

/** Minimum deterministic PRD quality score required to promote maker output. */
export const PRD_QUALITY_MIN_SCORE = 70 as const;
/**
 * Length is a weak proxy for substance and CJK requirement documents are far
 * denser than English ones, so this stays at the historical floor: it only
 * catches "ok\n"-style non-documents. Structure, story form, and acceptance
 * testability are what the contract actually enforces.
 */
export const PRD_MIN_CHARS = 300 as const;
export const PRD_MIN_USER_STORIES = 3 as const;
export const PRD_MIN_ACCEPTANCE_CRITERIA = 3 as const;

export const PRODUCT_REVIEW_ISSUE_TYPES = [
  'user',
  'problem',
  'goal',
  'scope',
  'story',
  'acceptance',
  'metric',
  'assumption',
  'risk',
  'dependency',
  'testability',
  'consistency',
  'traceability',
] as const;
export type ProductReviewIssueType = (typeof PRODUCT_REVIEW_ISSUE_TYPES)[number];

export const PRODUCT_ISSUE_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type ProductIssueSeverity = (typeof PRODUCT_ISSUE_SEVERITIES)[number];

/** What the critic actually read — a review of the PRD alone is weaker evidence. */
export const PRODUCT_REVIEW_BASES = ['prd_only', 'prd_with_stories', 'full_set'] as const;
export type ProductReviewBasis = (typeof PRODUCT_REVIEW_BASES)[number];

export interface ProductReviewIssue {
  type: ProductReviewIssueType;
  severity: ProductIssueSeverity;
  /** What is wrong, stated as a defect rather than a preference. */
  issue: string;
  /** The concrete repair the Product Maker must apply. */
  fix: string;
  /** Section heading, story id, or acceptance-criterion id the issue anchors to. */
  location?: string;
}

export interface ProductReviewReport {
  score: number;
  basis: ProductReviewBasis;
  issues: ProductReviewIssue[];
  summary?: string;
}

export interface ProductSpecValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export type ProductSpecValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: ProductSpecValidationIssue[] };

function issue(code: string, message: string, path?: string): ProductSpecValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = 400): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

const MAX_REVIEW_ISSUES = 100;

export function validateProductReviewReport(value: unknown): ProductSpecValidationResult<ProductReviewReport> {
  const issues: ProductSpecValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [issue('invalid_product_review_report', 'Product review report must be a JSON object.')] };
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    issues.push(issue('invalid_score', 'score must be a number in [0, 100].', 'score'));
  }
  if (!PRODUCT_REVIEW_BASES.includes(value.basis as ProductReviewBasis)) {
    issues.push(issue('invalid_basis', `basis must be one of ${PRODUCT_REVIEW_BASES.join(' | ')}.`, 'basis'));
  }
  const reviewIssues: ProductReviewIssue[] = [];
  if (!Array.isArray(value.issues)) {
    issues.push(issue('invalid_issues', 'issues must be an array.', 'issues'));
  } else if (value.issues.length > MAX_REVIEW_ISSUES) {
    issues.push(issue('too_many_issues', `issues exceeds ${MAX_REVIEW_ISSUES} entries.`, 'issues'));
  } else {
    for (const [index, raw] of value.issues.entries()) {
      const path = `issues[${index}]`;
      if (!isRecord(raw)) {
        issues.push(issue('invalid_issue', 'Issue must be an object.', path));
        continue;
      }
      if (!PRODUCT_REVIEW_ISSUE_TYPES.includes(raw.type as ProductReviewIssueType)) {
        issues.push(issue('invalid_issue_type', `Issue type must be one of ${PRODUCT_REVIEW_ISSUE_TYPES.join(' | ')}.`, `${path}.type`));
        continue;
      }
      if (!PRODUCT_ISSUE_SEVERITIES.includes(raw.severity as ProductIssueSeverity)) {
        issues.push(issue('invalid_issue_severity', `Issue severity must be one of ${PRODUCT_ISSUE_SEVERITIES.join(' | ')}.`, `${path}.severity`));
        continue;
      }
      if (!isNonEmptyString(raw.issue) || !isNonEmptyString(raw.fix)) {
        issues.push(issue('invalid_issue_detail', 'Issue and fix are required non-empty strings.', path));
        continue;
      }
      const entry: ProductReviewIssue = {
        type: raw.type as ProductReviewIssueType,
        severity: raw.severity as ProductIssueSeverity,
        issue: raw.issue.trim(),
        fix: raw.fix.trim(),
      };
      if (isNonEmptyString(raw.location, 200)) entry.location = (raw.location as string).trim();
      reviewIssues.push(entry);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      score: Math.round((value.score as number) * 10) / 10,
      basis: value.basis as ProductReviewBasis,
      issues: reviewIssues,
      ...(isNonEmptyString(value.summary, 2000) ? { summary: (value.summary as string).trim() } : {}),
    },
    issues: [],
  };
}

/**
 * Machine-readable marker the Product Critic embeds in its roundtable summary
 * (same HTML-comment convention as `EVOLUTION_VERDICT` / `UI_VISUAL_REPORT`).
 */
export const PRODUCT_REVIEW_REPORT_MARKER_RE = /<!--\s*PRODUCT_REVIEW_REPORT:\s*(\{[\s\S]*?\})\s*-->/i;

export function parseProductReviewReportMarker(summary: string | undefined | null): ProductReviewReport | null {
  if (!summary) return null;
  const match = summary.match(PRODUCT_REVIEW_REPORT_MARKER_RE);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    const validated = validateProductReviewReport(parsed);
    return validated.ok ? validated.value : null;
  } catch {
    return null;
  }
}

export function formatProductReviewReportMarker(report: ProductReviewReport): string {
  return `<!-- PRODUCT_REVIEW_REPORT: ${JSON.stringify(report)} -->`;
}

/** Actionable feedback text for the Product Maker's next revision. */
export function renderProductReviewFeedback(report: ProductReviewReport): string {
  const lines = [
    `Product review score: ${report.score}/100 (pass threshold ${PRODUCT_REVIEW_PASS_THRESHOLD}, basis: ${report.basis}).`,
  ];
  const ordered = [...report.issues].sort(
    (a, b) => PRODUCT_ISSUE_SEVERITIES.indexOf(a.severity) - PRODUCT_ISSUE_SEVERITIES.indexOf(b.severity),
  );
  for (const entry of ordered) {
    lines.push(`- [${entry.severity}/${entry.type}]${entry.location ? ` (${entry.location})` : ''} ${entry.issue} → ${entry.fix}`);
  }
  if (report.summary) lines.push(report.summary);
  return lines.join('\n');
}

/* ------------------------------------------------------------------------ *
 * Deterministic PRD quality contract
 * ------------------------------------------------------------------------ */

export const PRD_SECTION_IDS = [
  'problem',
  'target_users',
  'goals',
  'non_goals',
  'user_stories',
  'acceptance_criteria',
  'success_metrics',
  'assumptions',
  'risks',
] as const;
export type PrdSectionId = (typeof PRD_SECTION_IDS)[number];

export interface PrdSectionRequirement {
  id: PrdSectionId;
  /** Bilingual label used in prompts, skills, and feedback. */
  label: string;
  severity: ProductIssueSeverity;
  match: RegExp;
}

/**
 * The PRD section contract. Blocker sections are what makes a PRD a PRD;
 * major sections are what makes it decidable; minor sections are what makes it
 * reviewable. The Product Maker prompt and the `product-prd` role skill are
 * generated from this list so prompt, skill, and gate can never drift apart.
 */
export const PRD_SECTION_REQUIREMENTS: readonly PrdSectionRequirement[] = [
  { id: 'problem', label: '问题 / 背景 (Problem)', severity: 'minor', match: /(问题|背景|现状|痛点)|\b(problem|background|context)\b/i },
  { id: 'target_users', label: '目标用户 / 角色 (Target Users)', severity: 'major', match: /(目标用户|用户画像|用户角色|使用者|受众)|\b(target users?|personas?|audience)\b/i },
  { id: 'goals', label: '业务目标 (Goals)', severity: 'blocker', match: /(?<!非)目标(?!用户)|\b(goals?|objectives?)\b/i },
  { id: 'non_goals', label: '非目标 / 范围边界 (Non-Goals / Scope)', severity: 'major', match: /(非目标|不做|范围|边界|二期)|\b(non-?goals?|out of scope|scope)\b/i },
  { id: 'user_stories', label: '用户故事 (User Stories)', severity: 'blocker', match: /用户故事|\buser stor/i },
  { id: 'acceptance_criteria', label: '验收标准 (Acceptance Criteria)', severity: 'blocker', match: /验收(标准|条件|项)|\bacceptance criteria\b/i },
  { id: 'success_metrics', label: '成功指标 (Success Metrics)', severity: 'major', match: /(成功指标|度量指标|北极星|关键指标|衡量)|\b(success metrics?|kpis?|metrics?)\b/i },
  { id: 'assumptions', label: '假设 / 开放问题 (Assumptions / Open Questions)', severity: 'major', match: /(假设|开放问题|待确认|待澄清)|\b(assumptions?|open questions?)\b/i },
  { id: 'risks', label: '风险 / 依赖 (Risks / Dependencies)', severity: 'minor', match: /(风险|依赖|前置条件)|\b(risks?|dependenc)/i },
];

export const PRD_QUALITY_CODES = [
  'prd_missing_title',
  'prd_too_short',
  'prd_missing_section',
  'prd_user_stories_too_few',
  'prd_user_stories_malformed',
  'prd_acceptance_too_few',
  'prd_acceptance_not_testable',
  'prd_acceptance_vague',
  'prd_acceptance_traceability_missing',
  'prd_placeholder_content',
] as const;
export type PrdQualityCode = (typeof PRD_QUALITY_CODES)[number];

export interface PrdQualityFinding {
  code: PrdQualityCode;
  severity: ProductIssueSeverity;
  message: string;
  fix: string;
  /** Offending section/story/criterion samples, capped for readability. */
  samples?: string[];
}

export interface PrdQualityStats {
  chars: number;
  presentSections: PrdSectionId[];
  missingSections: PrdSectionId[];
  userStories: number;
  wellFormedUserStories: number;
  acceptanceCriteria: number;
  testableAcceptanceCriteria: number;
  storyIds: string[];
  tracedStoryIds: string[];
}

export interface PrdQualityAssessment {
  ok: boolean;
  score: number;
  findings: PrdQualityFinding[];
  stats: PrdQualityStats;
}

const SEVERITY_WEIGHT: Record<ProductIssueSeverity, number> = { blocker: 25, major: 8, minor: 3 };

/**
 * `作为<角色>，我希望<能力>，以便<价值>` / `As a <role>, I want <capability>, so
 * that <value>`. The "so that" half is the part agents drop first, and it is
 * exactly the part downstream roles need, so it is required.
 */
const USER_STORY_ZH_RE = /作为[^，,。\n]{1,40}[，,、]\s*(?:我|希望|想要)[^。\n]{0,120}?(以便|从而|这样|使得|来实现)/;
const USER_STORY_EN_RE = /\bas an?\b[^.\n]{1,80}\bi (?:want|need|can|would like)\b[^.\n]{1,160}\bso that\b/i;
const STORY_ID_RE = /\b(US-?\d{1,3})\b|(?:故事|用户故事)\s*[#-]?\s*(\d{1,3})/gi;

/** Given/When/Then in either language — the only form that is self-testing. */
const GWT_RE = /(given|when|then)\b[\s\S]{0,200}?\b(then|when)\b/i;
const GWT_ZH_RE = /(给定|前置|当)[^。\n]{0,120}(则|那么|应当|应该|必须|预期)/;

const TESTABLE_SIGNAL_RE = /\d|[<>≤≥=%]|(成功|失败|错误|拒绝|返回|展示|显示|禁用|不得|必须|一致|校验|提示|超时|权限|状态码)|\b(must|shall|returns?|rejects?|displays?|within|equals?)\b/i;
const VAGUE_RE = /(良好|友好|易用|美观|流畅|尽量|适当|合理|优化体验|提升体验|更好|简洁大方|人性化|高效地?)|\b(user-?friendly|intuitive|seamless|nice|good|fast enough|as needed|etc\.?)\b/i;
const PLACEHOLDER_RE = /\b(TODO|TBD|FIXME|XXX|lorem ipsum|placeholder)\b|待补充|待填写|待定|占位|示例文本|同上/i;

interface MarkdownSection {
  heading: string;
  level: number;
  body: string[];
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      current = { heading: heading[2] ?? '', level: heading[1]?.length ?? 1, body: [] };
      sections.push(current);
      continue;
    }
    const bold = line.match(/^\s*\*\*(.{1,60}?)\*\*\s*[:：]?\s*$/);
    if (bold) {
      current = { heading: bold[1] ?? '', level: 6, body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections;
}

function listItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const item = line.match(/^\s{0,6}(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (item?.[1]) items.push(item[1].replace(/^\[[ xX]\]\s*/, '').trim());
  }
  return items;
}

export function prdSectionRequirement(id: PrdSectionId): PrdSectionRequirement {
  const requirement = PRD_SECTION_REQUIREMENTS.find((entry) => entry.id === id);
  if (!requirement) throw new Error(`unknown_prd_section:${id}`);
  return requirement;
}

function sectionItems(sections: MarkdownSection[], match: RegExp): string[] {
  const items: string[] = [];
  for (const section of sections) {
    if (match.test(section.heading)) items.push(...listItems(section.body));
  }
  return items;
}

function collectStoryIds(values: string[]): string[] {
  const ids = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(STORY_ID_RE)) {
      const raw = match[1] ?? (match[2] ? `US-${match[2]}` : null);
      if (raw) ids.add(raw.toUpperCase().replace(/^US(\d)/, 'US-$1'));
    }
  }
  return [...ids];
}

function isWellFormedUserStory(value: string): boolean {
  return USER_STORY_ZH_RE.test(value) || USER_STORY_EN_RE.test(value);
}

function isTestableAcceptanceCriterion(value: string): boolean {
  if (GWT_RE.test(value) || GWT_ZH_RE.test(value)) return true;
  return TESTABLE_SIGNAL_RE.test(value) && !VAGUE_RE.test(value);
}

function sample(values: string[], max = 3): string[] {
  return values.slice(0, max).map((value) => (value.length > 120 ? `${value.slice(0, 119)}…` : value));
}

/**
 * Deterministic PRD quality contract shared by the Product Maker promotion
 * gate, the deterministic draft templates, and the role skills. `ok` is
 * severity-driven (no blockers, score at or above `PRD_QUALITY_MIN_SCORE`) so a
 * PRD that is real but imperfect still flows into review — where the Product
 * Critic, not a regex, owns the judgment call.
 */
export function assessPrdQuality(input: {
  prd: string;
  userStories?: string | null;
  acceptanceCriteria?: string | null;
}): PrdQualityAssessment {
  const prd = input.prd ?? '';
  const trimmed = prd.trim();
  const findings: PrdQualityFinding[] = [];
  const sections = parseMarkdownSections(prd);

  if (!trimmed.startsWith('#')) {
    findings.push({
      code: 'prd_missing_title',
      severity: 'blocker',
      message: 'PRD 缺少一级标题，无法作为可交付文档。',
      fix: `以 \`# PRD: <需求名>\` 开头，并写入 ${PRD_MIN_CHARS} 字符以上的真实内容。`,
    });
  }
  if (trimmed.length < PRD_MIN_CHARS) {
    findings.push({
      code: 'prd_too_short',
      severity: 'blocker',
      message: `PRD 只有 ${trimmed.length} 字符，不是一份 substantive PRD（至少需要 ${PRD_MIN_CHARS} 字符）。`,
      fix: '基于真实需求输入补齐目标、用户、范围、用户故事和验收标准，不要输出通用模板。',
    });
  }

  const presentSections: PrdSectionId[] = [];
  const missingSections: PrdSectionId[] = [];
  for (const requirement of PRD_SECTION_REQUIREMENTS) {
    const present = sections.some((section) => requirement.match.test(section.heading));
    if (present) presentSections.push(requirement.id);
    else missingSections.push(requirement.id);
  }
  const missingBySeverity = new Map<ProductIssueSeverity, PrdSectionRequirement[]>();
  for (const requirement of PRD_SECTION_REQUIREMENTS) {
    if (!missingSections.includes(requirement.id)) continue;
    const bucket = missingBySeverity.get(requirement.severity) ?? [];
    bucket.push(requirement);
    missingBySeverity.set(requirement.severity, bucket);
  }
  for (const severity of PRODUCT_ISSUE_SEVERITIES) {
    const missing = missingBySeverity.get(severity);
    if (!missing || missing.length === 0) continue;
    for (const requirement of missing) {
      findings.push({
        code: 'prd_missing_section',
        severity,
        message: `PRD 缺少章节：${requirement.label}。`,
        fix: `新增 \`## ${requirement.label}\` 章节，并写入基于真实输入的内容。`,
        samples: [requirement.id],
      });
    }
  }

  const storyItems = [
    ...sectionItems(sections, prdSectionRequirement('user_stories').match),
    ...(input.userStories ? listItems(input.userStories.split(/\r?\n/)) : []),
  ];
  const uniqueStories = [...new Set(storyItems)];
  const wellFormedStories = uniqueStories.filter(isWellFormedUserStory);
  if (uniqueStories.length < PRD_MIN_USER_STORIES) {
    findings.push({
      code: 'prd_user_stories_too_few',
      severity: 'blocker',
      message: `只找到 ${uniqueStories.length} 条用户故事，至少需要 ${PRD_MIN_USER_STORIES} 条。`,
      fix: '为每个核心角色补齐用户故事，格式：`US-1 作为<角色>，我希望<能力>，以便<价值>`。',
    });
  } else if (wellFormedStories.length < PRD_MIN_USER_STORIES) {
    findings.push({
      code: 'prd_user_stories_malformed',
      severity: 'major',
      message: `${uniqueStories.length} 条用户故事中只有 ${wellFormedStories.length} 条写明了角色、能力和价值。`,
      fix: '把缺少“以便/so that”价值说明的故事改写为 `作为<角色>，我希望<能力>，以便<价值>`。',
      samples: sample(uniqueStories.filter((story) => !isWellFormedUserStory(story))),
    });
  }

  const acceptanceItems = [
    ...sectionItems(sections, prdSectionRequirement('acceptance_criteria').match),
    ...(input.acceptanceCriteria ? listItems(input.acceptanceCriteria.split(/\r?\n/)) : []),
  ];
  const uniqueAcceptance = [...new Set(acceptanceItems)];
  const testableAcceptance = uniqueAcceptance.filter(isTestableAcceptanceCriterion);
  const vagueAcceptance = uniqueAcceptance.filter((item) => VAGUE_RE.test(item));
  if (uniqueAcceptance.length < PRD_MIN_ACCEPTANCE_CRITERIA) {
    findings.push({
      code: 'prd_acceptance_too_few',
      severity: 'blocker',
      message: `只找到 ${uniqueAcceptance.length} 条验收标准，至少需要 ${PRD_MIN_ACCEPTANCE_CRITERIA} 条。`,
      fix: '为每条用户故事补齐可测试的验收标准，覆盖成功路径、边界、失败和权限场景。',
    });
  } else if (testableAcceptance.length < PRD_MIN_ACCEPTANCE_CRITERIA) {
    findings.push({
      code: 'prd_acceptance_not_testable',
      severity: 'blocker',
      message: `${uniqueAcceptance.length} 条验收标准中只有 ${testableAcceptance.length} 条可被测试验证。`,
      fix: '改写为 `给定<前置>，当<操作>，则<可观测结果>`，并给出阈值、状态或错误码等可断言的事实。',
      samples: sample(uniqueAcceptance.filter((item) => !isTestableAcceptanceCriterion(item))),
    });
  }
  if (vagueAcceptance.length > 0) {
    findings.push({
      code: 'prd_acceptance_vague',
      severity: 'major',
      message: `${vagueAcceptance.length} 条验收标准使用了不可度量的形容词。`,
      fix: '删除“良好/友好/流畅/尽量”等主观词，替换为可观测阈值或明确的状态断言。',
      samples: sample(vagueAcceptance),
    });
  }

  const storyIds = collectStoryIds(uniqueStories);
  const tracedStoryIds = storyIds.filter((id) => uniqueAcceptance.some((item) => collectStoryIds([item]).includes(id)));
  if (uniqueAcceptance.length >= PRD_MIN_ACCEPTANCE_CRITERIA && tracedStoryIds.length === 0) {
    findings.push({
      code: 'prd_acceptance_traceability_missing',
      severity: 'minor',
      message: '验收标准没有回引用户故事编号，下游无法验证覆盖率。',
      fix: '给用户故事编号（US-1、US-2…），并在每条验收标准前标注它所验证的故事编号。',
    });
  }

  const placeholderLines = prd.split(/\r?\n/).filter((line) => PLACEHOLDER_RE.test(line));
  if (placeholderLines.length > 0) {
    findings.push({
      code: 'prd_placeholder_content',
      severity: 'blocker',
      message: `PRD 中仍有 ${placeholderLines.length} 行占位内容（TODO/待补充/占位）。`,
      fix: '用真实需求内容替换占位；确实无法确定的项写入“假设”或“开放问题”并标注决策人。',
      samples: sample(placeholderLines.map((line) => line.trim())),
    });
  }

  const score = Math.max(
    0,
    Math.min(100, 100 - findings.reduce((total, finding) => total + SEVERITY_WEIGHT[finding.severity], 0)),
  );
  const hasBlocker = findings.some((finding) => finding.severity === 'blocker');
  return {
    ok: !hasBlocker && score >= PRD_QUALITY_MIN_SCORE,
    score,
    findings,
    stats: {
      chars: trimmed.length,
      presentSections,
      missingSections,
      userStories: uniqueStories.length,
      wellFormedUserStories: wellFormedStories.length,
      acceptanceCriteria: uniqueAcceptance.length,
      testableAcceptanceCriteria: testableAcceptance.length,
      storyIds,
      tracedStoryIds,
    },
  };
}

/** One-line rejection reason for maker promotion + retry feedback. */
export function renderPrdQualityFeedback(assessment: PrdQualityAssessment): string {
  const blockers = assessment.findings.filter((finding) => finding.severity === 'blocker');
  const others = assessment.findings.filter((finding) => finding.severity !== 'blocker');
  const lines = [`PRD quality score ${assessment.score}/100 (min ${PRD_QUALITY_MIN_SCORE}).`];
  for (const finding of [...blockers, ...others]) {
    lines.push(`- [${finding.severity}] ${finding.message} → ${finding.fix}`);
  }
  return lines.join('\n');
}

/** Compact single-line reason used where a full report does not fit. */
export function summarizePrdQualityFailure(assessment: PrdQualityAssessment): string {
  const blockers = assessment.findings.filter((finding) => finding.severity === 'blocker');
  const head = blockers.length > 0 ? blockers : assessment.findings;
  return [
    `${PRODUCT_MAKER_PRD_RELATIVE_PATH} failed the PRD quality contract (score ${assessment.score}/100, min ${PRD_QUALITY_MIN_SCORE})`,
    ...head.slice(0, 4).map((finding) => `${finding.message} ${finding.fix}`),
  ].join(' — ');
}

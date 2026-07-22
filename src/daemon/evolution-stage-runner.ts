import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EVOLUTION_ARTIFACTS_MAX,
  EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS,
  EVOLUTION_DISCUSSION_ITEMS_MAX,
  EVOLUTION_EVIDENCE_ITEMS_MAX,
  EVOLUTION_ROLE_IDS,
  canTransitionEvolutionStage,
  isEvolutionTerminalStage,
  type EvolutionArtifactKind,
  type EvolutionDesignTargetSurface,
  type EvolutionRoleId,
  type EvolutionRoleStatus,
  type EvolutionStage,
} from '../../shared/evolution-pipeline-constants.js';
import type {
  EvolutionArtifactRef,
  EvolutionArtifactPreview,
  EvolutionDiscussionMessage,
  EvolutionEvidence,
  EvolutionRun,
  EvolutionScore,
} from '../../shared/evolution-pipeline-types.js';
import { getEvolutionRunPaths, writeEvolutionRun } from './evolution-artifact-store.js';
import { runEvolutionTasteHifiGeneration } from './evolution-design-runner.js';

export interface RunEvolutionPlanningStagesOptions {
  projectRoot: string;
  run: EvolutionRun;
  nowMs?: number;
  onStage?: (run: EvolutionRun) => Promise<void> | void;
  shouldPauseAfterStage?: (run: EvolutionRun) => boolean;
}

interface RequirementDigest {
  title: string;
  summary: string;
  bullets: string[];
  raw: string;
}

interface WarRoomInstruction {
  roleId?: EvolutionRoleId;
  author: string;
  text: string;
  stage: EvolutionStage;
  createdAt: number;
}

interface DesignReferenceImage {
  originalRelativePath: string;
  runRelativePath: string;
  fileName: string;
  extension: string;
  sha256: string;
  bytes: number;
}

interface ProductUiModel {
  type: 'business_app' | 'evolution_war_room' | 'generic';
  title: string;
  audience: string;
  primarySurface: string;
  navigation: string[];
  entities: string[];
  actions: string[];
  screens: Array<{ name: string; purpose: string; states: string[] }>;
  components: string[];
  visualMood: string;
  colors: Record<string, string>;
}

const TASTE_SKILL_SOURCE_URL = 'https://github.com/Leonxlnx/taste-skill';
const TASTE_SKILL_INSTALL_NAME = 'design-taste-frontend';
const TASTE_SKILL_IMAGEGEN_WEB_NAME = 'imagegen-frontend-web';
const BUILT_IN_TASTE_OUTPUT_RELATIVE_PATH = 'design/taste-hifi-output.md';
const REFERENCE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const REFERENCE_IMAGE_SCAN_DIRS = ['.', 'assets', 'images', 'image', 'screenshots', 'screenshot', 'refs', 'references', '截图', '参考图'];
const DESIGN_REFERENCE_MANIFEST_RELATIVE_PATH = 'design/reference-images.md';

const PLANNING_STAGE_MESSAGES: Partial<Record<EvolutionStage, string>> = {
  intake_normalized: '需求已标准化，进入产品讨论。',
  product_discussion: '产品经理与产品审查已完成第一轮需求讨论。',
  prd_ready: 'PRD、用户故事和验收标准已生成。',
  design_lofi: 'UX 流程和低保真线框已生成。',
  design_hifi: '高保真设计说明已生成。',
  architecture_baseline: '技术框架、架构基线和 ADR 已生成。',
  tasks_ready: 'OpenSpec change、实现任务、测试计划和交付计划已生成。',
};

function nowFrom(options: RunEvolutionPlanningStagesOptions): number {
  return options.nowMs ?? Date.now();
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeJoin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('evolution_artifact_path_outside_root');
  return resolvedPath;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRequirementSignal(value: string): string {
  return normalizeLine(value
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\|+|\|+$/g, '')
    .replace(/\s*\|\s*/g, ' / '));
}

function uniqueRequirementSignals(values: Array<string | null | undefined>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeRequirementSignal(String(value ?? ''));
    if (!normalized || normalized.length < 4) continue;
    const clipped = normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= max) break;
  }
  return out;
}

function bulletizeRequirement(raw: string): string[] {
  const candidateLines: string[] = [];
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = normalizeLine(originalLine);
    if (!line) continue;
    const heading = line.match(/^#{1,4}\s+(.+)$/)?.[1];
    if (heading) {
      candidateLines.push(heading);
      continue;
    }
    const normalized = normalizeRequirementSignal(line);
    if (!normalized || normalized.length < 6) continue;
    if (
      /^(\||[-*+]|\d+[.)])/.test(line) ||
      /(目标|背景|范围|对象|角色|页面|端|H5|PC|后台|管理端|模型|字段|接口|API|权限|状态|库存|资格|账号|验收|风险|二期|不默认|不支持|新增|创建|编辑|删除|停用|充值|绑定|解绑|导入|导出|查看|查询|筛选|测试|部署)/i.test(normalized) ||
      candidateLines.length < 18
    ) {
      candidateLines.push(normalized);
    }
  }
  const interesting = uniqueRequirementSignals(candidateLines, 48);
  return interesting.length > 0 ? interesting : ['需求文档内容较短，需要在产品讨论阶段补充业务边界。'];
}

function digestRequirement(raw: string, fallbackTitle: string): RequirementDigest {
  const heading = raw.split(/\r?\n/).map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim()).find(Boolean);
  const title = normalizeLine(heading ?? fallbackTitle.replace(/\.[^.]+$/, '')) || 'Evolution Requirement';
  const bullets = bulletizeRequirement(raw);
  return {
    title,
    summary: bullets.slice(0, 3).join('；'),
    bullets,
    raw,
  };
}

function requiresScreenshotReferences(digest: RequirementDigest): boolean {
  return /(截图|参考图|设计图|原型图|页面图|用户提供.*图|需求图|高保真.*图|\d+\s*张图|screenshots?|reference images?|mockups?)/i.test(digest.raw);
}

function resolveProjectRelativeCandidate(projectRoot: string, baseDir: string, candidate: string): string | null {
  const cleaned = candidate
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^['"]|['"]$/g, '')
    .split(/[?#]/)[0] ?? '';
  if (!cleaned || /^https?:\/\//i.test(cleaned) || cleaned.startsWith('data:')) return null;
  const decoded = decodeURIComponent(cleaned);
  const absolute = isAbsolute(decoded)
    ? resolve(decoded)
    : resolve(projectRoot, baseDir, decoded);
  const rel = relative(resolve(projectRoot), absolute).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

function extractMarkdownImageCandidates(raw: string, projectRoot: string, sourceRelativePath: string): string[] {
  const baseDir = dirname(sourceRelativePath);
  const candidates = new Set<string>();
  const markdownImagePattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+['"][^'"]*['"])?\)/g;
  const htmlImagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const plainImagePattern = /(?:^|[\s`'"(])([^\s`'"()]+?\.(?:png|jpe?g|webp|svg))(?:$|[\s`'")])/gim;
  for (const pattern of [markdownImagePattern, htmlImagePattern, plainImagePattern]) {
    for (const match of raw.matchAll(pattern)) {
      const maybe = resolveProjectRelativeCandidate(projectRoot, baseDir, match[1] ?? '');
      if (maybe) candidates.add(maybe);
    }
  }
  return [...candidates];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function collectImageFilesUnder(projectRoot: string, dirRelativePath: string, depth = 0): Promise<string[]> {
  if (depth > 1) return [];
  const dirPath = safeJoin(projectRoot, dirRelativePath);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.DS_Store')) continue;
    const rel = join(dirRelativePath, entry.name).replaceAll('\\', '/');
    if (entry.isFile() && REFERENCE_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(rel);
    } else if (entry.isDirectory() && depth === 0 && REFERENCE_IMAGE_SCAN_DIRS.includes(entry.name)) {
      found.push(...await collectImageFilesUnder(projectRoot, rel, depth + 1));
    }
    if (found.length >= 24) break;
  }
  return found;
}

async function collectLatestReferenceBundleImages(projectRoot: string, sourceDir: string): Promise<string[]> {
  const dirPath = safeJoin(projectRoot, sourceDir);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const referenceDirs = entries
    .filter((entry) => entry.isDirectory() && /^reference-\d{14}/.test(entry.name))
    .map((entry) => join(sourceDir, entry.name).replaceAll('\\', '/'))
    .sort((a, b) => b.localeCompare(a));
  const latest = referenceDirs[0];
  if (!latest) return [];
  return collectImageFilesUnder(projectRoot, latest);
}

async function collectDesignReferenceImages(projectRoot: string, run: EvolutionRun, digest: RequirementDigest): Promise<DesignReferenceImage[]> {
  const sourceDir = dirname(run.source.relativePath);
  const explicit = extractMarkdownImageCandidates(digest.raw, projectRoot, run.source.relativePath);
  const siblingImages = await collectImageFilesUnder(projectRoot, sourceDir);
  const latestReferenceBundleImages = explicit.length === 0 && requiresScreenshotReferences(digest)
    ? await collectLatestReferenceBundleImages(projectRoot, sourceDir)
    : [];
  const sourceStem = basename(run.source.relativePath).replace(/\.[^.]+$/, '').toLowerCase();
  const screenshotReferenceRequested = requiresScreenshotReferences(digest);
  const candidates = [...new Set([...explicit, ...siblingImages, ...latestReferenceBundleImages])]
    .filter((rel) => REFERENCE_IMAGE_EXTENSIONS.has(extname(rel).toLowerCase()))
    .filter((rel) => {
      if (explicit.includes(rel)) return true;
      if (dirname(rel) !== sourceDir) return true;
      if (screenshotReferenceRequested) return true;
      const name = basename(rel).toLowerCase();
      return name.includes(sourceStem) || /截图|参考|screen|shot|mock|ui|页面|设计|原型|界面|样式|style|reference/.test(name);
    })
    .slice(0, 24);

  const refs: DesignReferenceImage[] = [];
  for (const originalRelativePath of candidates) {
    const sourcePath = safeJoin(projectRoot, originalRelativePath);
    if (!await fileExists(sourcePath)) continue;
    const bytes = await readFile(sourcePath);
    const ext = extname(originalRelativePath).toLowerCase();
    const index = refs.length + 1;
    const safeName = basename(originalRelativePath).replace(/[^\w.\-\u4e00-\u9fff]/g, '-');
    const runRelativePath = `design/reference-images/${String(index).padStart(2, '0')}-${safeName}`;
    const targetPath = safeJoin(projectRoot, `.imc/evolution/${run.runId}/${runRelativePath}`);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, bytes);
    refs.push({
      originalRelativePath,
      runRelativePath,
      fileName: basename(originalRelativePath),
      extension: ext,
      sha256: sha256(bytes),
      bytes: bytes.byteLength,
    });
  }
  return refs;
}

function uniqueNonEmpty(values: Array<string | null | undefined>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeLine(String(value ?? '').replace(/^[#>*\-\d.)\s]+/, '').replace(/[：:，,。；;]+$/, ''));
    if (!normalized || normalized.length < 2 || normalized.length > 48) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function extractMarkdownHeadings(raw: string): string[] {
  return uniqueNonEmpty(raw.split(/\r?\n/).map((line) => line.match(/^#{1,4}\s+(.+)$/)?.[1]), 12);
}

function extractAudience(raw: string): string {
  const candidates = [
    ...Array.from(raw.matchAll(/(?:面向|使用者|目标用户|用户角色|角色|受众)[：:\s]*([^\n。；;]{2,40})/g)).map((match) => match[1]),
    ...Array.from(raw.matchAll(/作为([^，,。；;]{2,24})/g)).map((match) => match[1]),
    ...Array.from(raw.matchAll(/([^，,。；;\n]{2,18}(?:管理员|运营|用户|客户|商家|教师|学生|医生|患者|司机|骑手|开发者|审核员|负责人))/g)).map((match) => match[1]),
  ];
  return uniqueNonEmpty(candidates, 3).join('、') || '需求文档定义的业务用户';
}

function extractNavigation(raw: string, headings: string[]): string[] {
  const headingNav = headings.filter((heading) => /(首页|概览|看板|工作台|管理|列表|详情|配置|设置|报表|统计|订单|账号|用户|权限|流程|页面|Dashboard|Settings|List|Detail)/i.test(heading));
  const inlineNav = Array.from(raw.matchAll(/(?:导航|菜单|入口|tab|Tab|顶部|侧边栏)[：:\s]*([^\n。；;]{2,80})/gi))
    .flatMap((match) => String(match[1] ?? '').split(/[、,，/｜|>→\s]+/));
  const pageTerms = Array.from(raw.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,18}(?:首页|概览|看板|工作台|管理|列表|详情|配置|设置|报表|统计|中心|页面))/g)).map((match) => match[1]);
  return uniqueNonEmpty([...headingNav, ...inlineNav, ...pageTerms], 6);
}

function extractEntities(raw: string, headings: string[], bullets: string[]): string[] {
  const labeledDomainTerms = Array.from(raw.matchAll(/(?:^|\n)\s*(?:[-*]\s*)?[`“「『"']?([\u4e00-\u9fa5A-Za-z0-9]{2,18}(?:用户|客户|订单|商品|课程|项目|任务|账号|角色|权限|配置|记录|明细|流水|库存|余额|积分|消息|通知|报告|文档|文件|图片|素材|表单|数据|代理|商家|门店|设备|资产|工单|合同|发票|成员|团队|组织|部门|内容|文章|视频|页面|版本|环境|服务|应用|模型|会话|管理员))[`”」』"']?[：:]/gm)).map((match) => match[1]);
  const accountEditionTerms = Array.from(raw.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,12}版账号)/g)).map((match) => String(match[1] ?? '').replace(/^[有和及与、，,。\s]+/, ''));
  const tableHeaders = Array.from(raw.matchAll(/^\|(.+)\|$/gm))
    .flatMap((match) => String(match[1] ?? '').split('|'));
  const quoted = [
    ...Array.from(raw.matchAll(/`([^`]{2,32})`/g)).map((match) => match[1]),
    ...Array.from(raw.matchAll(/[“「『]([^”」』]{2,32})[”」』]/g)).map((match) => match[1]),
  ];
  const nounPhrases = Array.from(raw.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,18}(?:用户|客户|订单|商品|课程|项目|任务|账号|角色|权限|配置|记录|明细|流水|库存|余额|积分|消息|通知|报告|文档|文件|图片|素材|表单|数据|代理|商家|门店|设备|资产|工单|合同|发票|成员|团队|组织|部门|内容|文章|视频|页面|版本|环境|服务|应用|模型|会话))/g)).map((match) => match[1]);
  const bulletTerms = bullets.flatMap((bullet) => bullet.split(/[，,。；;、/\s]+/).filter((part) => /[\u4e00-\u9fa5]{2,}/.test(part) && part.length <= 16));
  return uniqueNonEmpty([...labeledDomainTerms, ...accountEditionTerms, ...nounPhrases, ...tableHeaders, ...quoted, ...headings, ...bulletTerms], 14);
}

function extractActions(raw: string): string[] {
  const actionTerms = Array.from(raw.matchAll(/(新增|新建|创建|编辑|修改|删除|停用|启用|冻结|解冻|查看|查询|筛选|搜索|导入|导出|上传|下载|提交|保存|确认|取消|审批|审核|发布|部署|回滚|支付|退款|充值|绑定|解绑|分配|配置|授权|登录|注册|邀请|生成|分析|同步|刷新|重置|排序|复制|分享)(?:[\u4e00-\u9fa5A-Za-z0-9]{0,10})/g)).map((match) => match[0]);
  const explicit = Array.from(raw.matchAll(/(?:操作|动作|功能|按钮|支持)[：:\s]*([^\n。；;]{2,120})/g))
    .flatMap((match) => String(match[1] ?? '').split(/[、,，/｜|>→\s]+/));
  return uniqueNonEmpty([...explicit, ...actionTerms], 10);
}

function inferScreens(digest: RequirementDigest, navigation: string[], entities: string[], actions: string[]): ProductUiModel['screens'] {
  const screenNames = uniqueNonEmpty([
    ...navigation,
    ...entities.filter((entity) => /(首页|概览|看板|工作台|管理|列表|详情|配置|设置|页面|中心|报表|统计)/.test(entity)),
    digest.title,
  ], 6);
  return (screenNames.length ? screenNames : [digest.title]).map((name, index) => {
    const entity = entities[index % Math.max(1, entities.length)] ?? '核心对象';
    const action = actions[index % Math.max(1, actions.length)] ?? '查看/提交';
    return {
      name,
      purpose: index === 0
        ? `承接“${digest.title}”的主流程入口，展示关键状态并引导核心操作。`
        : `围绕“${entity}”完成${action}、状态反馈和异常处理。`,
      states: index === 0 ? ['default', 'empty', 'loading', 'permission-denied'] : ['default', 'filtered', 'validation-error', 'success'],
    };
  });
}

function inferComponents(raw: string): string[] {
  const components = [
    '页面标题与上下文说明',
    /(筛选|搜索|查询|过滤)/.test(raw) ? '筛选/搜索区' : null,
    /(列表|表格|table|清单)/i.test(raw) ? '数据列表/表格' : null,
    /(卡片|统计|概览|看板|指标)/.test(raw) ? '统计卡片/概览卡片' : null,
    /(详情|抽屉|drawer)/i.test(raw) ? '详情页/详情抽屉' : null,
    /(弹窗|modal|dialog|表单|填写|输入)/i.test(raw) ? '表单弹窗' : null,
    /(tab|Tab|标签页|分组)/.test(raw) ? 'Tab 分组' : null,
    /(上传|图片|附件|文件)/.test(raw) ? '文件/图片上传控件' : null,
    /(状态|启用|停用|审核|审批|失败|成功)/.test(raw) ? '状态标签与反馈提示' : null,
    '操作按钮组',
    '空/加载/错误/无权限状态',
  ];
  return uniqueNonEmpty(components, 10);
}

function inferPrimarySurface(digest: RequirementDigest, raw: string): string {
  const surfaces: string[] = [];
  if (/H5|移动端|手机|小程序|mobile/i.test(raw)) surfaces.push('H5/移动端');
  if (/PC|桌面|后台|管理端|admin|dashboard/i.test(raw)) surfaces.push('PC/管理端');
  if (/Web|网页|浏览器/i.test(raw)) surfaces.push('Web');
  const surfacePrefix = surfaces.length ? `${surfaces.join(' + ')} ` : '';
  return `${surfacePrefix}${digest.title}`.trim();
}

function isEvolutionWarRoomRequirement(digest: RequirementDigest): boolean {
  const source = `${digest.title}\n${digest.raw.slice(0, 10_000)}`;
  const explicitEvolutionProduct = /(自我进化控制台|自我进化\s*(?:War Room|控制台|工厂|Factory)|Evolution\s+(?:Factory|War Room)|IM\.?codes\s+(?:Evolution|War Room|自我进化|控制台)|OpenSpec\s+Auto\s+Deliver)/i.test(source);
  if (!explicitEvolutionProduct) return false;
  const businessProductSignals = /(taojinshu|淘金树|taoAi|taojinshu-AI|taojinshu-ai-admin|区域代理|官方代理|体验版账号|标准版账号|绑定账号|会员|订单|课程|教师|商品|门店|库存|充值|后台管理|H5|PC 管理端|管理端页面|业务页面)/i.test(source);
  const explicitlyAboutImcodesProduct = /(IM\.?codes\s+(?:Evolution|War Room|自我进化)|Evolution\s+Factory|Evolution\s+War Room|自我进化控制台)/i.test(digest.title);
  return explicitlyAboutImcodesProduct || !businessProductSignals;
}

function deriveProductUiModel(digest: RequirementDigest): ProductUiModel {
  const raw = digest.raw;
  if (isEvolutionWarRoomRequirement(digest)) {
    return {
      type: 'evolution_war_room',
      title: digest.title,
      audience: 'IM.codes operators and product/engineering roles',
      primarySurface: 'Evolution War Room operations console',
      navigation: ['需求入口', '任务进度', '角色聊天室', '设计产物', '交付状态'],
      entities: ['Run', 'Stage', 'Role', 'Artifact', 'Evidence', 'Roundtable', 'Gate'],
      actions: ['启动需求', '扫描 inbox', '发送角色指令', '解除阻塞', '启动开发 Loop', '检查 Staging'],
      screens: [
        { name: 'Evolution War Room', purpose: 'Observe the self-evolving delivery run and intervene by role.', states: ['empty', 'running', 'needs-human', 'human-release-gate'] },
      ],
      components: ['stage timeline pills', 'role status cards', 'P2P roundtable rows', 'artifact preview cards', 'evidence feed', 'role-targeted command composer', 'human gate blocker panel'],
      visualMood: 'dark technical war-room, evidence-first, high-control operations console',
      colors: {
        background: '#020617',
        surface: '#0f172a',
        border: '#334155',
        primary: '#38bdf8',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#fb7185',
        accent: '#a78bfa',
      },
    };
  }

  const headings = extractMarkdownHeadings(raw);
  const navigation = extractNavigation(raw, headings);
  const entities = extractEntities(raw, headings, digest.bullets);
  const actions = extractActions(raw);
  const inferredNavigation = navigation.length ? navigation : uniqueNonEmpty([headings[0], '概览', entities[0] ? `${entities[0]}管理` : '管理', '详情'], 4);
  const inferredEntities = entities.length ? entities : uniqueNonEmpty(digest.bullets.slice(0, 6), 6);
  const inferredActions = actions.length ? actions : ['新增', '编辑', '查看详情', '提交', '筛选'];
  const screens = inferScreens(digest, inferredNavigation, inferredEntities, inferredActions);
  const components = inferComponents(raw);
  const isSparse = digest.summary.length < 60 && digest.bullets.length <= 3;

  return {
    type: isSparse ? 'generic' : 'business_app',
    title: digest.title,
    audience: extractAudience(raw),
    primarySurface: inferPrimarySurface(digest, raw),
    navigation: inferredNavigation,
    entities: inferredEntities,
    actions: inferredActions,
    screens,
    components,
    visualMood: '与需求文档、参考图和现有项目风格一致的业务产品界面；信息架构、颜色、文案和控件不得脱离源材料。',
    colors: {
      background: '#f8fafc',
      surface: '#ffffff',
      border: '#e2e8f0',
      primary: '#2563eb',
      success: '#16a34a',
      warning: '#f59e0b',
      danger: '#ef4444',
      accent: '#7c3aed',
    },
  };
}

function designTargetSurfaceLabel(target: EvolutionDesignTargetSurface | undefined): string {
  switch (target) {
    case 'mobile': return '移动端/H5';
    case 'pc': return 'PC/管理端';
    case 'both': return '移动端/H5 + PC/管理端';
    case 'auto':
    default: return '自动识别';
  }
}

function targetScreenSuffix(target: EvolutionDesignTargetSurface | undefined): string {
  switch (target) {
    case 'mobile': return '移动端';
    case 'pc': return 'PC 管理端';
    case 'both': return '双端';
    case 'auto':
    default: return '';
  }
}

function applyDesignTargetSurface(uiModel: ProductUiModel, target: EvolutionDesignTargetSurface | undefined): ProductUiModel {
  const normalized = target ?? 'auto';
  if (normalized === 'auto') return uiModel;
  const label = designTargetSurfaceLabel(normalized);
  const suffix = targetScreenSuffix(normalized);
  const withScreenSuffix = (screen: ProductUiModel['screens'][number], surface: string): ProductUiModel['screens'][number] => ({
    ...screen,
    name: `${screen.name} · ${surface}`,
    purpose: `${screen.purpose} 高保真目标端：${surface}。`,
  });
  const baseScreens = uiModel.screens.length ? uiModel.screens : [{
    name: uiModel.title,
    purpose: `承接“${uiModel.title}”主流程。`,
    states: ['default', 'empty', 'loading', 'permission-denied'],
  }];
  const screens = normalized === 'both'
    ? [
        ...baseScreens.map((screen) => withScreenSuffix(screen, '移动端/H5')),
        ...baseScreens.map((screen) => withScreenSuffix(screen, 'PC/管理端')),
      ].slice(0, Math.max(2, baseScreens.length * 2))
    : baseScreens.map((screen) => withScreenSuffix(screen, suffix || label));
  return {
    ...uiModel,
    primarySurface: normalized === 'both'
      ? `H5/移动端 + PC/管理端 ${uiModel.title}`.trim()
      : normalized === 'mobile'
        ? `H5/移动端 ${uiModel.title}`.trim()
        : `PC/管理端 ${uiModel.title}`.trim(),
    navigation: uniqueNonEmpty([
      normalized === 'both' ? '移动端/H5' : normalized === 'mobile' ? '移动端/H5' : 'PC/管理端',
      ...uiModel.navigation,
      normalized === 'both' ? 'PC/管理端' : null,
    ], 8),
    screens,
    visualMood: `${uiModel.visualMood} 高保真目标端：${label}。`,
  };
}

function referenceLines(refs: DesignReferenceImage[]): string[] {
  if (refs.length === 0) return ['- 未找到可用参考图。若需求依赖截图，高保真必须暂停，等待用户补充图片。'];
  return refs.map((ref, index) => `- R${index + 1}: \`${ref.runRelativePath}\` ← \`${ref.originalRelativePath}\` (${ref.bytes} bytes, sha256 ${ref.sha256.slice(0, 12)})`);
}

function renderDesignReferenceManifest(run: EvolutionRun, digest: RequirementDigest, refs: DesignReferenceImage[]): string {
  return [
    `# Design Reference Images: ${digest.title}`,
    '',
    '## Status',
    refs.length > 0 ? `READY — found ${refs.length} reference image(s).` : 'MISSING — no reference images were found.',
    '',
    '## Source Requirement',
    `- File: \`${run.source.relativePath}\``,
    `- Mentions screenshots/reference images: ${requiresScreenshotReferences(digest) ? 'yes' : 'no'}`,
    '',
    '## Contract',
    '- 低保真和高保真必须先读取这些参考图，复用其信息架构、页面语义、文案层级、颜色、间距和控件样式。',
    '- 如果参考图缺失但需求提到“截图/参考图/用户提供图片”，不得生成无关高保真，必须进入人工阻塞。',
    '- Taste Skill 输出必须解释与参考图的对应关系；不能生成 IM.codes / War Room 等无关界面。',
    '',
    '## Images',
    ...referenceLines(refs),
    '',
  ].join('\n');
}

function shouldPauseForMissingDesignReferences(digest: RequirementDigest, uiModel: ProductUiModel, refs: DesignReferenceImage[]): boolean {
  if (refs.length > 0) return false;
  const raw = digest.raw;
  const explicitStrictReference = /(必须|严格|像素级|完全|一比一|还原|照着|按照).{0,16}(截图|参考图|设计图|原型图|页面图|7\s*张图|七\s*张图)|(?:(截图|参考图|设计图|原型图|页面图|7\s*张图|七\s*张图).{0,16}(必须|严格|像素级|完全|一比一|还原|照着|按照))/i.test(raw);
  const sparseBrief = digest.bullets.length <= 2 || digest.summary.length < 40;
  return explicitStrictReference || (requiresScreenshotReferences(digest) && uiModel.type === 'generic' && sparseBrief);
}

function referenceStatusLine(refs: DesignReferenceImage[]): string {
  return refs.length > 0
    ? `已纳入 ${refs.length} 张参考图：${refs.map((ref) => ref.runRelativePath).join(', ')}`
    : '未找到随需求提交的参考图；若前置机器人已把图片讨论结果沉淀到 MD，则以 MD 为准，否则应先补图或补充风格描述。';
}

function uiModelBulletLines(uiModel: ProductUiModel): string[] {
  return [
    `- 产品/页面类型：${uiModel.primarySurface}`,
    `- 目标用户：${uiModel.audience}`,
    `- 信息架构：${uiModel.navigation.join(' / ')}`,
    `- 核心对象：${uiModel.entities.join('、')}`,
    `- 核心动作：${uiModel.actions.join('、')}`,
    `- 视觉方向：${uiModel.visualMood}`,
  ];
}

function screenBlueprintLines(uiModel: ProductUiModel): string[] {
  return uiModel.screens.map((screen, index) => `${index + 1}. ${screen.name}：${screen.purpose} 状态：${screen.states.join(' / ')}`);
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateForSvg(value: string, max = 80): string {
  const normalized = normalizeLine(value);
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function svgTextLines(lines: string[], x: number, y: number, options: { fill?: string; size?: number; weight?: number; gap?: number } = {}): string {
  const fill = options.fill ?? '#cbd5e1';
  const size = options.size ?? 20;
  const weight = options.weight ?? 500;
  const gap = options.gap ?? Math.round(size * 1.45);
  return lines.map((line, index) =>
    `<text x="${x}" y="${y + index * gap}" fill="${fill}" font-size="${size}" font-weight="${weight}">${xmlEscape(line)}</text>`
  ).join('\n');
}

function artifactId(kind: EvolutionArtifactKind, path: string): string {
  return `${kind}:${path}`;
}

function previewTypeForPath(path: string): EvolutionArtifactPreview['previewType'] | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.svg')) return 'svg';
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown';
  if (/\.(txt|json|yaml|yml|log)$/i.test(lower)) return 'text';
  return null;
}

function imageMimeTypeForPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

function buildImageArtifactPreview(path: string, content: Buffer): EvolutionArtifactPreview | undefined {
  const mimeType = imageMimeTypeForPath(path);
  if (!mimeType) return undefined;
  const dataUrl = `data:${mimeType};base64,${content.toString('base64')}`;
  if (dataUrl.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) return undefined;
  return {
    previewType: 'image',
    content: dataUrl,
    language: mimeType,
  };
}

function languageForPath(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.log')) return 'log';
  if (lower.endsWith('.svg')) return 'svg';
  return undefined;
}

function buildArtifactPreview(path: string, content: string): EvolutionArtifactPreview | undefined {
  const previewType = previewTypeForPath(path);
  if (!previewType) return undefined;
  const truncated = content.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS;
  const previewContent = truncated ? content.slice(0, EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) : content;
  const language = languageForPath(path);
  return {
    previewType,
    content: previewContent,
    ...(language ? { language } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

function buildFileArtifactPreview(path: string, content: Buffer): EvolutionArtifactPreview | undefined {
  const imagePreview = buildImageArtifactPreview(path, content);
  if (imagePreview) return imagePreview;
  return buildArtifactPreview(path, content.toString('utf8'));
}

function referenceTitleForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.svg')) return 'taste-skill High-Fidelity SVG Reference';
  if (lower.endsWith('.png')) return 'taste-skill High-Fidelity PNG Reference';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'taste-skill High-Fidelity JPG Reference';
  if (lower.endsWith('.webp')) return 'taste-skill High-Fidelity WebP Reference';
  return 'taste-skill High-Fidelity Visual Reference';
}

function truncateInstruction(value: string, max = 500): string {
  const normalized = normalizeLine(value);
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function collectWarRoomInstructions(run: EvolutionRun): WarRoomInstruction[] {
  return (run.discussion ?? [])
    .filter((entry) => entry.kind === 'user_message')
    .map((entry) => ({
      ...(entry.roleId ? { roleId: entry.roleId } : {}),
      author: entry.author,
      text: truncateInstruction(entry.text),
      stage: entry.stage,
      createdAt: entry.createdAt,
    }))
    .slice(-12);
}

function warRoomInstructionLines(instructions: WarRoomInstruction[], prefix = '-'): string[] {
  if (instructions.length === 0) return [`${prefix} 暂无 War Room 用户补充指令。`];
  return instructions.map((instruction) => {
    const target = instruction.roleId ? ` → ${instruction.roleId}` : '';
    return `${prefix} ${instruction.author}${target} @ ${instruction.stage}: ${instruction.text}`;
  });
}

function warRoomInstructionObjects(instructions: WarRoomInstruction[]): Array<Record<string, string | number>> {
  return instructions.map((instruction) => ({
    author: instruction.author,
    ...(instruction.roleId ? { roleId: instruction.roleId } : {}),
    stage: instruction.stage,
    text: instruction.text,
    createdAt: instruction.createdAt,
  }));
}

function upsertArtifact(run: EvolutionRun, artifact: EvolutionArtifactRef): void {
  const index = run.artifacts.findIndex((entry) => entry.id === artifact.id || entry.path === artifact.path);
  if (index >= 0) run.artifacts[index] = artifact;
  else run.artifacts.push(artifact);
  run.artifacts = run.artifacts.slice(-EVOLUTION_ARTIFACTS_MAX);
}

function appendEvidence(run: EvolutionRun, evidence: EvolutionEvidence): void {
  run.evidence = [...run.evidence, evidence].slice(-EVOLUTION_EVIDENCE_ITEMS_MAX);
}

function appendDiscussion(run: EvolutionRun, message: Omit<EvolutionDiscussionMessage, 'id'>): void {
  const id = `discussion-${sha256(`${message.kind}:${message.stage}:${message.roleId ?? 'system'}:${message.text}:${message.createdAt}`).slice(0, 16)}`;
  const existing = new Set((run.discussion ?? []).map((entry) => entry.id));
  if (existing.has(id)) return;
  run.discussion = [...(run.discussion ?? []), { id, ...message }].slice(-EVOLUTION_DISCUSSION_ITEMS_MAX);
}

function upsertScore(run: EvolutionRun, score: EvolutionScore): void {
  const index = run.scores.findIndex((entry) => entry.module === score.module);
  if (index >= 0) run.scores[index] = score;
  else run.scores.push(score);
}

function roleStatusForStage(roleId: EvolutionRoleId, stage: EvolutionStage): EvolutionRoleStatus {
  const runningByStage: Record<EvolutionStage, readonly EvolutionRoleId[]> = {
    detected: ['loop_supervisor'],
    intake_normalized: ['loop_supervisor', 'product_manager'],
    product_discussion: ['product_manager', 'product_critic'],
    prd_ready: ['product_manager', 'product_critic'],
    design_lofi: ['ux_designer'],
    design_hifi: ['ux_designer', 'visual_designer'],
    architecture_baseline: ['tech_director', 'security_reviewer'],
    tasks_ready: ['tech_director', 'backend_developer', 'frontend_developer', 'qa_engineer'],
    implementation_loop: ['backend_developer', 'frontend_developer', 'tech_director'],
    qa_completion: ['qa_engineer', 'security_reviewer'],
    delivery_ready: ['ops_release_manager', 'qa_engineer'],
    deployed_staging: ['ops_release_manager', 'qa_engineer'],
    human_release_gate: ['loop_supervisor', 'ops_release_manager'],
    deployed_production: [],
    needs_human: ['loop_supervisor'],
    failed: [],
    stopped: [],
  };
  if (stage === 'failed') return roleId === 'loop_supervisor' ? 'failed' : 'pending';
  if (stage === 'stopped') return roleId === 'loop_supervisor' ? 'complete' : 'pending';
  if (stage === 'deployed_production') return 'complete';
  if (runningByStage[stage].includes(roleId)) return stage === 'needs_human' || stage === 'human_release_gate' ? 'waiting' : 'running';
  return 'pending';
}

function currentActionForRole(roleId: EvolutionRoleId, stage: EvolutionStage): string | undefined {
  const actions: Partial<Record<EvolutionRoleId, Partial<Record<EvolutionStage, string>>>> = {
    loop_supervisor: {
      intake_normalized: '归档输入、维护 run.json、推进 loop gate',
      tasks_ready: '等待进入实现 loop 或人工调整任务',
    },
    product_manager: {
      intake_normalized: '提取业务目标、用户、约束',
      product_discussion: '生成 PRD、用户故事、验收标准',
      prd_ready: '等待设计与技术拆解',
    },
    product_critic: {
      product_discussion: '审查矛盾、遗漏、风险和不可测需求',
      prd_ready: '确认 PRD 可进入设计/架构',
    },
    ux_designer: {
      design_lofi: '生成用户流程与低保真线框',
      design_hifi: '补齐交互状态和视觉层级',
    },
    visual_designer: {
      design_hifi: '生成高保真视觉规范和组件方向',
    },
    tech_director: {
      architecture_baseline: '制定技术基线、ADR、边界和风险',
      tasks_ready: '拆分可执行任务并准备 OpenSpec',
    },
    backend_developer: {
      tasks_ready: '等待 OpenSpec Auto Deliver 分派后端任务',
      implementation_loop: '实现后端任务并更新 checkbox',
    },
    frontend_developer: {
      tasks_ready: '等待 OpenSpec Auto Deliver 分派前端任务',
      implementation_loop: '实现前端任务并更新 checkbox',
    },
    qa_engineer: {
      tasks_ready: '补齐测试用例和验收命令',
      qa_completion: '执行测试和回归验证',
    },
    security_reviewer: {
      architecture_baseline: '审查鉴权、隐私、支付、配置和部署风险',
      qa_completion: '审查安全回归与风险项',
    },
    ops_release_manager: {
      delivery_ready: '准备 staging 发布与回滚计划',
      deployed_staging: '验证 staging 交付证据',
      human_release_gate: '等待生产发布人工门禁',
    },
  };
  return actions[roleId]?.[stage];
}

function applyRoleStates(run: EvolutionRun, stage: EvolutionStage, nowMs: number): void {
  const existing = new Map(run.roles.map((role) => [role.roleId, role]));
  run.roles = EVOLUTION_ROLE_IDS.map((roleId) => {
    const previous = existing.get(roleId);
    const currentAction = currentActionForRole(roleId, stage);
    const next = {
      ...previous,
      roleId,
      status: roleStatusForStage(roleId, stage),
      stage,
      updatedAt: nowMs,
    };
    if (currentAction) next.currentAction = currentAction;
    else delete next.currentAction;
    return next;
  });
}

async function writeRunArtifact(options: {
  projectRoot: string;
  run: EvolutionRun;
  kind: EvolutionArtifactKind;
  path: string;
  title: string;
  roleId?: EvolutionRoleId;
  stage?: EvolutionStage;
  content: string;
  nowMs: number;
}): Promise<void> {
  const paths = getEvolutionRunPaths(options.projectRoot, options.run.runId);
  const fullPath = safeJoin(paths.runDir, options.path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, options.content, 'utf8');
  const preview = buildArtifactPreview(options.path, options.content);
  upsertArtifact(options.run, {
    id: artifactId(options.kind, options.path),
    kind: options.kind,
    path: options.path,
    title: options.title,
    ...(preview ? { preview } : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    sha256: sha256(options.content),
    bytes: Buffer.byteLength(options.content),
    createdAt: options.nowMs,
  });
}

async function registerExistingRunArtifact(options: {
  projectRoot: string;
  run: EvolutionRun;
  kind: EvolutionArtifactKind;
  path: string;
  title: string;
  roleId?: EvolutionRoleId;
  stage?: EvolutionStage;
  nowMs: number;
}): Promise<void> {
  const paths = getEvolutionRunPaths(options.projectRoot, options.run.runId);
  const fullPath = safeJoin(paths.runDir, options.path);
  const content = await readFile(fullPath);
  const preview = buildFileArtifactPreview(options.path, content);
  upsertArtifact(options.run, {
    id: artifactId(options.kind, options.path),
    kind: options.kind,
    path: options.path,
    title: options.title,
    ...(preview ? { preview } : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    sha256: sha256(content),
    bytes: content.byteLength,
    createdAt: options.nowMs,
  });
}

async function writeProjectArtifact(options: {
  projectRoot: string;
  run: EvolutionRun;
  kind: EvolutionArtifactKind;
  path: string;
  title: string;
  roleId?: EvolutionRoleId;
  stage?: EvolutionStage;
  content: string;
  nowMs: number;
}): Promise<void> {
  const fullPath = safeJoin(options.projectRoot, options.path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, options.content, 'utf8');
  const preview = buildArtifactPreview(options.path, options.content);
  upsertArtifact(options.run, {
    id: artifactId(options.kind, options.path),
    kind: options.kind,
    path: options.path,
    title: options.title,
    ...(preview ? { preview } : {}),
    ...(options.roleId ? { roleId: options.roleId } : {}),
    ...(options.stage ? { stage: options.stage } : {}),
    sha256: sha256(options.content),
    bytes: Buffer.byteLength(options.content),
    createdAt: options.nowMs,
  });
}

async function transition(options: RunEvolutionPlanningStagesOptions, stage: EvolutionStage, summary?: string): Promise<void> {
  const { run } = options;
  if (stage !== 'needs_human' && run.stage === 'needs_human' && run.blockingQuestions.some((question) => question.id.startsWith('user-pause-'))) {
    throw new EvolutionPlanningPausedError(stage);
  }
  if (run.stage !== stage) {
    if (!canTransitionEvolutionStage(run.stage, stage)) {
      throw new Error(`invalid_evolution_stage_transition:${run.stage}->${stage}`);
    }
    run.stage = stage;
  }
  const nowMs = nowFrom(options);
  applyRoleStates(run, stage, nowMs);
  run.latestMessage = summary ?? PLANNING_STAGE_MESSAGES[stage] ?? `Evolution stage advanced to ${stage}.`;
  appendEvidence(run, {
    source: 'evolution_loop',
    summary: run.latestMessage,
    createdAt: nowMs,
  });
  run.updatedAt = nowMs;
  await writeEvolutionRun(options.projectRoot, run);
  await options.onStage?.(run);
  if (options.shouldPauseAfterStage?.(run)) {
    throw new EvolutionPlanningPausedError(stage);
  }
}

export class EvolutionPlanningPausedError extends Error {
  constructor(readonly pausedAtStage: EvolutionStage) {
    super(`evolution_planning_paused:${pausedAtStage}`);
  }
}

function renderNormalizedRequirement(digest: RequirementDigest, run: EvolutionRun, instructions: WarRoomInstruction[]): string {
  return [
    `# Normalized Requirement: ${digest.title}`,
    '',
    '## Source',
    `- File: \`${run.source.relativePath}\``,
    `- SHA-256: \`${run.source.sha256 ?? 'unknown'}\``,
    '',
    '## Business Summary',
    digest.summary,
    '',
    '## Extracted Requirement Points',
    ...digest.bullets.map((entry) => `- ${entry}`),
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
    '',
    '## Loop Constraints',
    '- Maker/checker split is required: implementers cannot verify their own work.',
    '- Production deployment requires a human gate.',
    '- Auth, payments, privacy, secrets, database migrations, and infrastructure changes require explicit review.',
  ].join('\n');
}

function renderProductDiscussion(digest: RequirementDigest, instructions: WarRoomInstruction[]): string {
  return [
    '# Product Discussion Log',
    '',
    '## Product Manager',
    `目标：把“${digest.title}”转化为可验收的最小可交付能力。`,
    '',
    '## Product Critic',
    '- 检查需求是否包含明确用户、触发条件、成功标准和失败场景。',
    '- 对含糊描述先转为假设，并在 PRD 中显式标注。',
    '- 高风险或不可逆动作进入 human gate。',
    '',
    '## Current Decision',
    '进入 PRD 草稿，默认以 MVP 范围优先，避免过早扩大技术面。',
    '',
    '## User-Provided Constraints',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function sourceExcerptLines(digest: RequirementDigest, max = 18): string[] {
  return digest.bullets.slice(0, max).map((entry) => `- ${entry}`);
}

function extractNonGoalLines(digest: RequirementDigest): string[] {
  const matches = digest.raw.split(/\r?\n/)
    .map(normalizeRequirementSignal)
    .filter((line) => /(不默认|不支持|不改造|不应|不得|不纳入|二期|后续|暂不|不自动|不绕过|人工门禁|拒绝删除|不释放|不回滚)/.test(line));
  const normalized = uniqueRequirementSignals(matches, 8);
  if (normalized.length > 0) return normalized.map((entry) => `- ${entry}`);
  return [
    '- 不扩展需求文档未覆盖的业务范围。',
    '- 不绕过账号、权限、库存、数据迁移、生产发布等高风险门禁。',
    '- 不在未确认业务口径前把假设沉淀为不可逆实现。',
  ];
}

function renderEvolutionWarRoomPrd(digest: RequirementDigest, instructions: WarRoomInstruction[]): string {
  return [
    `# PRD: ${digest.title}`,
    '',
    '## Problem',
    digest.summary,
    '',
    '## Goals',
    '- 将原始需求转化为可执行、可测试、可交付的功能增量。',
    '- 让产品、设计、技术、开发、测试和运维角色在同一 run ledger 中协作。',
    '- 对每个阶段保留 artifact、evidence、score 和 blocker。',
    '',
    '## Non-Goals',
    '- 首期不自动生产发布。',
    '- 首期不绕过测试、审查或安全门禁。',
    '- 首期不处理需求文档之外的无边界扩展。',
    '',
    '## User Stories',
    '- 作为产品负责人，我希望把需求文档放入 inbox 后自动得到 PRD、设计、技术方案和任务清单。',
    '- 作为技术负责人，我希望看到架构基线、风险项和可执行任务，以便控制实现范围。',
    '- 作为 QA，我希望任务自带验收标准和测试计划，以便自动交付后可验证。',
    '- 作为用户，我希望在 War Room 中看到角色状态并能直接给指定角色补充指令。',
    '',
    '## Acceptance Criteria',
    '- 系统能读取 `.imcodes/inbox/requirements/` 下的需求文档并创建 Evolution Run。',
    '- Run 必须生成 PRD、设计说明、架构基线、OpenSpec proposal/design/tasks、测试计划和部署计划。',
    '- War Room 必须展示当前阶段、角色状态、产物、证据和阻塞问题。',
    '- `tasks.md` 必须包含可被 OpenSpec Auto Deliver 解析的 checkbox 任务。',
    '- 生产发布必须停在人工门禁。',
    '',
    '## Source Signals',
    ...digest.bullets.map((entry) => `- ${entry}`),
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderBusinessPrd(digest: RequirementDigest, uiModel: ProductUiModel, instructions: WarRoomInstruction[]): string {
  const primaryEntities = uiModel.entities.slice(0, 8);
  const primaryActions = uiModel.actions.slice(0, 8);
  const screens = uiModel.screens.slice(0, 6);
  const primaryEntity = primaryEntities[0] ?? '核心业务对象';
  const secondaryEntity = primaryEntities[1] ?? primaryEntity;
  const primaryAction = primaryActions[0] ?? '查看';
  const secondaryAction = primaryActions[1] ?? '编辑';

  return [
    `# PRD: ${digest.title}`,
    '',
    '## Problem',
    digest.summary,
    '',
    '## Target Users',
    `- ${uiModel.audience}`,
    '',
    '## Product Surface',
    `- ${uiModel.primarySurface}`,
    `- Navigation / IA: ${uiModel.navigation.join(' / ')}`,
    '',
    '## Goals',
    `- 在 ${uiModel.primarySurface} 中交付需求文档定义的主流程，不生成 IM.codes War Room 默认页面。`,
    `- 覆盖核心对象：${primaryEntities.join('、') || '按需求文档继续补齐'}。`,
    `- 支持核心动作：${primaryActions.join('、') || '按需求文档继续补齐'}，并补齐权限、校验、成功/失败反馈。`,
    '- 保持与现有项目和参考图一致的术语、页面层级、颜色、组件和交互风格。',
    '',
    '## Non-Goals',
    ...extractNonGoalLines(digest),
    '',
    '## User Stories',
    `- 作为${uiModel.audience}，我希望在 ${screens[0]?.name ?? uiModel.primarySurface} 中快速理解 ${primaryEntity} 的状态和可执行动作。`,
    `- 作为${uiModel.audience}，我希望完成 ${primaryAction}、${secondaryAction} 等操作时看到明确的权限、校验、成功和失败反馈。`,
    `- 作为${uiModel.audience}，我希望围绕 ${secondaryEntity} 查看详情、关联关系、库存/配额或业务流水，避免在多个旧页面之间来回切换。`,
    '- 作为技术/测试负责人，我希望 PRD 的对象、页面、状态和验收标准都能追溯到原始 MD 和参考图。',
    '',
    '## Functional Scope',
    ...sourceExcerptLines(digest, 24),
    '',
    '## Screen Requirements',
    ...screens.map((screen) => `- ${screen.name}: ${screen.purpose} 必须覆盖状态 ${screen.states.join(' / ')}。`),
    '',
    '## Acceptance Criteria',
    `- 页面和接口必须使用需求文档中的领域术语，例如 ${primaryEntities.slice(0, 5).join('、') || digest.title}，不得替换成通用模板文案。`,
    `- ${primaryEntities.slice(0, 5).join('、') || '核心对象'} 的列表、详情、状态、权限和异常场景必须可验证。`,
    `- ${primaryActions.slice(0, 6).join('、') || '核心动作'} 必须有明确入口、前置校验、结果反馈和失败处理。`,
    '- H5/PC/后台等多端要求必须按源文档拆分页面和验收，不得只产出单一无关页面。',
    '- 如果参考图存在，高保真必须逐张映射信息架构、布局、颜色、组件和状态；如果参考图缺失，必须显式记录 MD 推导假设。',
    '- 生产发布、账号权限、库存/配额、数据迁移和破坏性变更必须保留人工门禁。',
    '',
    '## Open Questions / Assumptions',
    ...extractNonGoalLines(digest).slice(0, 6),
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderPrd(digest: RequirementDigest, uiModel: ProductUiModel, instructions: WarRoomInstruction[]): string {
  return uiModel.type === 'evolution_war_room'
    ? renderEvolutionWarRoomPrd(digest, instructions)
    : renderBusinessPrd(digest, uiModel, instructions);
}

function renderPrdReview(): string {
  return [
    '# PRD Review',
    '',
    '## Verdict',
    'PASS_WITH_ASSUMPTIONS',
    '',
    '## Findings',
    '- PRD 已包含目标、非目标、用户故事和验收标准。',
    '- 原始需求若缺少业务细节，已转为显式假设。',
    '- 后续实现不得跳过 maker/checker 分离和 QA 验收。',
    '',
    '## Required Follow-ups',
    '- 若涉及账号、支付、隐私或生产配置，需要人工确认。',
    '- 若设计稿需要像素级视觉稿，应在 design_hifi 后接入 Figma/图片生成工具。',
  ].join('\n');
}

function renderUxFlow(digest: RequirementDigest, instructions: WarRoomInstruction[], uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  return [
    `# UX Flow: ${digest.title}`,
    '',
    '## Source-of-Truth Mode',
    '- 如果需求文档是由前置图片/手稿讨论生成的 MD，本阶段不重复原始圆桌，只把 MD 当成唯一需求源继续细化。',
    '- War Room 的“与角色交流”用于补充新约束或解除阻塞；不会要求用户重复同一轮图片讨论。',
    `- 参考图状态：${referenceStatusLine(refs)}`,
    '',
    '## Product UI Model',
    ...uiModelBulletLines(uiModel),
    '',
    '## Primary Flow',
    ...screenBlueprintLines(uiModel),
    '',
    '## Interaction Notes',
    ...uiModel.actions.slice(0, 8).map((action) => `- ${action}: 必须有明确入口、权限/校验反馈、成功/失败状态和可审计结果。`),
    '',
    '## User Instruction Constraints',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderWireframe(uiModel: ProductUiModel): string {
  const nav = uiModel.navigation.join(' / ');
  const entities = uiModel.entities.slice(0, 5).join(' / ');
  const actions = uiModel.actions.slice(0, 5).join(' / ');
  return [
    '# Low-Fidelity Wireframe',
    '',
    '```text',
    '+----------------------------------------------------------+',
    `| ${uiModel.title.padEnd(56).slice(0, 56)} |`,
    `| Nav: ${nav.padEnd(51).slice(0, 51)} |`,
    '+-----------------------------+----------------------------+',
    '| Summary / Metrics           | Main List / Cards          |',
    `| ${entities.padEnd(27).slice(0, 27)} | filters / status / quota |`,
    '+-----------------------------+----------------------------+',
    '| Detail Drawer / Tabs        | Action Forms / Modals      |',
    `| ${actions.padEnd(27).slice(0, 27)} | validation / audit trail  |`,
    '+----------------------------------------------------------+',
    '| Role instruction / blocker / reference image notes       |',
    '+----------------------------------------------------------+',
    '```',
  ].join('\n');
}

function renderWireframeSvg(digest: RequirementDigest, uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  const title = truncateForSvg(uiModel.title || digest.title, 58);
  const subtitle = truncateForSvg(uiModel.primarySurface, 78);
  const nav = uiModel.navigation.slice(0, 5);
  const entities = uiModel.entities.slice(0, 7);
  const screens = uiModel.screens.slice(0, 5).map((screen) => truncateForSvg(screen.name, 26));
  const colors = uiModel.colors;
  const referenceNote = refs.length > 0 ? `${refs.length} reference images locked` : 'MD-first · no image lock';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="920" viewBox="0 0 1440 920" role="img" aria-labelledby="title desc">',
    `<title id="title">Low-fidelity wireframe for ${xmlEscape(title)}</title>`,
    `<desc id="desc">Low-fidelity wireframe based on ${xmlEscape(uiModel.primarySurface)}.</desc>`,
    `<rect width="1440" height="920" fill="${colors.background}"/>`,
    '<rect x="64" y="56" width="1312" height="808" rx="28" fill="#ffffff" stroke="#cbd5e1" stroke-width="3"/>',
    `<rect x="96" y="92" width="1248" height="92" rx="18" fill="${colors.surface}" stroke="${colors.border}"/>`,
    svgTextLines([title, subtitle], 128, 130, { fill: '#0f172a', size: 28, weight: 800, gap: 34 }),
    `<rect x="1090" y="118" width="220" height="38" rx="19" fill="${colors.primary}" fill-opacity="0.12" stroke="${colors.primary}"/>`,
    svgTextLines([referenceNote], 1116, 144, { fill: colors.primary, size: 15, weight: 800 }),
    '<rect x="96" y="220" width="1248" height="64" rx="18" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="2"/>',
    svgTextLines(nav.length ? nav : ['概览', '管理', '详情'], 136, 260, { fill: '#475569', size: 20, weight: 700, gap: 0 }),
    '<rect x="96" y="318" width="380" height="430" rx="22" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>',
    '<rect x="516" y="318" width="392" height="430" rx="22" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>',
    '<rect x="948" y="318" width="396" height="430" rx="22" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>',
    svgTextLines(['信息对象'], 128, 362, { fill: '#0f172a', size: 26, weight: 800 }),
    svgTextLines(entities.length ? entities : ['核心对象待补充'], 128, 414, { fill: '#334155', size: 20, weight: 600, gap: 46 }),
    svgTextLines(['主页面/状态'], 548, 362, { fill: '#0f172a', size: 26, weight: 800 }),
    svgTextLines(screens.length ? screens : ['主页面'], 548, 414, { fill: '#334155', size: 20, weight: 600, gap: 46 }),
    svgTextLines(['操作与反馈'], 980, 362, { fill: '#0f172a', size: 26, weight: 800 }),
    svgTextLines(uiModel.actions.slice(0, 6).map((entry) => truncateForSvg(entry, 26)), 980, 414, { fill: '#334155', size: 20, weight: 600, gap: 46 }),
    '<rect x="96" y="784" width="1248" height="48" rx="20" fill="#e2e8f0"/>',
    svgTextLines(['设计输入：需求 MD 为主；有参考图则锁定信息架构/颜色/控件风格；War Room 指令作为增量约束'], 128, 816, { fill: '#475569', size: 18, weight: 700 }),
    '</svg>',
  ].join('\n');
}

function renderHifiSpec(instructions: WarRoomInstruction[], uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  const referenceScreenContract = refs.length > 0
    ? `- 必须输出多页面/多状态高保真包：${refs.length} 张参考图至少对应 ${refs.length} 个 screen/state，不得只生成一张泛化图。`
    : '- 若后续补充参考图，需要重新生成多页面/多状态高保真包并逐张映射。';
  return [
    '# High-Fidelity Design Spec',
    '',
    '## Design Source Contract',
    '- 高保真必须围绕需求 MD 的业务页面生成，不能退回 IM.codes / Evolution War Room 默认界面。',
    '- 若 MD 来自前置“图片/手稿 → 4 机器人讨论 → brief.md”，这里直接继承该 MD，不重复前置讨论。',
    `- 参考图状态：${referenceStatusLine(refs)}`,
    referenceScreenContract,
    '',
    '## Product UI Model',
    ...uiModelBulletLines(uiModel),
    '',
    '## Visual Direction',
    `- ${uiModel.visualMood}`,
    `- 背景 ${uiModel.colors.background}，主表面 ${uiModel.colors.surface}，主色 ${uiModel.colors.primary}，边框 ${uiModel.colors.border}。`,
    '- 保留现有项目风格优先级：项目 CSS/组件 > 参考图 > 本 handoff token > taste-skill 默认。',
    '',
    '## Components',
    ...uiModel.components.map((component) => `- ${component}`),
    '',
    '## Screens',
    ...screenBlueprintLines(uiModel),
    '',
    '## Lightweight High-Fidelity Hook',
    `默认把该 spec 交给 taste-skill（${TASTE_SKILL_INSTALL_NAME} / ${TASTE_SKILL_IMAGEGEN_WEB_NAME}）继续展开；Figma 仅作为后续可选导出，不是必需依赖。`,
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

interface HifiScreenTarget {
  name: string;
  purpose: string;
  states: string[];
  sourceLabel: string;
  reference?: DesignReferenceImage;
}

function hifiScreenTargets(uiModel: ProductUiModel, refs: DesignReferenceImage[]): HifiScreenTarget[] {
  if (refs.length > 0) {
    return refs.slice(0, 12).map((ref, index) => {
      const screen = uiModel.screens[index % Math.max(1, uiModel.screens.length)];
      return {
        name: screen?.name ?? `参考图 ${index + 1} 对应页面`,
        purpose: screen?.purpose ?? `根据 ${ref.fileName} 还原对应业务页面/状态。`,
        states: screen?.states ?? ['default', 'empty', 'loading', 'permission-denied'],
        sourceLabel: `R${index + 1} · ${ref.fileName}`,
        reference: ref,
      };
    });
  }
  return uiModel.screens.slice(0, 6).map((screen, index) => ({
    name: screen.name,
    purpose: screen.purpose,
    states: screen.states,
    sourceLabel: `S${index + 1} · MD-derived`,
  }));
}

function renderHifiScreenSvg(digest: RequirementDigest, uiModel: ProductUiModel, target: HifiScreenTarget, index: number, total: number): string {
  const colors = uiModel.colors;
  const title = truncateForSvg(target.name, 46);
  const purpose = truncateForSvg(target.purpose, 82);
  const entities = uiModel.entities.slice(index, index + 4).length > 0
    ? uiModel.entities.slice(index, index + 4)
    : uiModel.entities.slice(0, 4);
  const actions = uiModel.actions.slice(index, index + 4).length > 0
    ? uiModel.actions.slice(index, index + 4)
    : uiModel.actions.slice(0, 4);
  const refNote = target.reference
    ? `Ref ${index + 1}/${total}: ${truncateForSvg(target.reference.fileName, 38)}`
    : `Screen ${index + 1}/${total}: MD-derived`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="920" viewBox="0 0 1440 920" role="img" aria-labelledby="title desc">',
    `<title id="title">High-fidelity screen ${index + 1} for ${xmlEscape(digest.title)}</title>`,
    `<desc id="desc">${xmlEscape(refNote)}. ${xmlEscape(purpose)}</desc>`,
    '<defs>',
    `<linearGradient id="screenBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${colors.background}"/><stop offset="100%" stop-color="#ffffff"/></linearGradient>`,
    '<filter id="shadow"><feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#0f172a" flood-opacity="0.14"/></filter>',
    '</defs>',
    '<rect width="1440" height="920" fill="url(#screenBg)"/>',
    '<rect x="70" y="54" width="1300" height="812" rx="34" fill="#ffffff" stroke="#dbe3ef" filter="url(#shadow)"/>',
    `<rect x="104" y="88" width="1232" height="96" rx="26" fill="${colors.surface}" stroke="${colors.border}"/>`,
    svgTextLines([title, purpose], 140, 128, { fill: '#0f172a', size: 30, weight: 900, gap: 38 }),
    `<rect x="1096" y="112" width="198" height="44" rx="22" fill="${colors.primary}" opacity="0.94"/>`,
    svgTextLines([refNote], 1120, 142, { fill: '#ffffff', size: 15, weight: 900 }),
    '<rect x="104" y="226" width="282" height="560" rx="28" fill="#f8fafc" stroke="#dbe3ef"/>',
    svgTextLines(['导航/对象'], 140, 276, { fill: '#0f172a', size: 25, weight: 900 }),
    svgTextLines(uiModel.navigation.slice(0, 5), 140, 326, { fill: '#475569', size: 18, weight: 750, gap: 42 }),
    '<rect x="426" y="226" width="520" height="560" rx="28" fill="#ffffff" stroke="#dbe3ef"/>',
    svgTextLines(['主内容', ...entities.map((entity) => `• ${truncateForSvg(entity, 30)}`)], 464, 282, { fill: '#0f172a', size: 24, weight: 850, gap: 44 }),
    `<rect x="464" y="514" width="420" height="54" rx="18" fill="${colors.primary}" opacity="0.10" stroke="${colors.primary}"/>`,
    svgTextLines([actions[0] ? `主操作：${truncateForSvg(actions[0], 24)}` : '主操作：按 MD 补齐'], 492, 550, { fill: colors.primary, size: 19, weight: 900 }),
    '<rect x="986" y="226" width="350" height="560" rx="28" fill="#f8fafc" stroke="#dbe3ef"/>',
    svgTextLines(['状态/反馈', ...target.states.slice(0, 6).map((state) => `• ${state}`)], 1024, 282, { fill: '#0f172a', size: 23, weight: 850, gap: 42 }),
    '<rect x="140" y="808" width="1156" height="32" rx="16" fill="#f1f5f9"/>',
    svgTextLines([target.reference ? `必须追溯到 ${target.reference.runRelativePath} 的布局、颜色、间距、组件与文案层级。` : '从 MD 推导高保真；补图后需重新逐张映射。'], 166, 830, { fill: '#64748b', size: 15, weight: 700 }),
    '</svg>',
  ].join('\n');
}

function renderHifiMockupSvg(digest: RequirementDigest, uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  const title = truncateForSvg(uiModel.title || digest.title, 52);
  const subtitle = truncateForSvg(uiModel.primarySurface, 86);
  const colors = uiModel.colors;
  const screens = uiModel.screens.slice(0, 4);
  const entities = uiModel.entities.slice(0, 6);
  const actions = uiModel.actions.slice(0, 6);
  const screenCards = screens.map((screen, index) => {
    const x = 96 + (index % 2) * 420;
    const y = 286 + Math.floor(index / 2) * 184;
    return [
      `<rect x="${x}" y="${y}" width="384" height="146" rx="24" fill="${colors.surface}" stroke="${colors.border}"/>`,
      `<circle cx="${x + 32}" cy="${y + 38}" r="10" fill="${index % 2 === 0 ? colors.primary : colors.accent}"/>`,
      svgTextLines([truncateForSvg(screen.name, 24)], x + 54, y + 46, { fill: '#0f172a', size: 22, weight: 850 }),
      svgTextLines([truncateForSvg(screen.purpose, 42)], x + 28, y + 88, { fill: '#64748b', size: 15, weight: 600 }),
      svgTextLines([screen.states.slice(0, 3).join(' / ')], x + 28, y + 124, { fill: colors.primary, size: 14, weight: 800 }),
    ].join('\n');
  }).join('\n');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="920" viewBox="0 0 1440 920" role="img" aria-labelledby="title desc">',
    `<title id="title">High-fidelity mockup for ${xmlEscape(title)}</title>`,
    '<desc id="desc">Deterministic high-fidelity visual mockup based on the requirement product model.</desc>',
    '<defs>',
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${colors.background}"/><stop offset="100%" stop-color="#eef2ff"/></linearGradient>`,
    '<filter id="soft"><feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#0f172a" flood-opacity="0.16"/></filter>',
    '</defs>',
    '<rect width="1440" height="920" fill="url(#bg)"/>',
    `<circle cx="1180" cy="120" r="230" fill="${colors.primary}" opacity="0.10"/>`,
    `<circle cx="220" cy="850" r="260" fill="${colors.accent}" opacity="0.09"/>`,
    '<rect x="64" y="56" width="1312" height="808" rx="34" fill="#ffffff" stroke="#dbe3ef" stroke-width="1.5" filter="url(#soft)"/>',
    `<rect x="96" y="92" width="1248" height="142" rx="28" fill="${colors.surface}" stroke="${colors.border}"/>`,
    svgTextLines([title, subtitle], 128, 142, { fill: '#0f172a', size: 34, weight: 900, gap: 44 }),
    `<rect x="1048" y="118" width="248" height="46" rx="23" fill="${colors.primary}" opacity="0.95"/>`,
    svgTextLines([refs.length > 0 ? `${refs.length} refs locked` : 'MD-first design'], 1092, 150, { fill: '#ffffff', size: 18, weight: 900 }),
    '<g filter="url(#soft)">',
    screenCards,
    '</g>',
    '<rect x="936" y="286" width="376" height="330" rx="28" fill="#f8fafc" stroke="#dbe3ef"/>',
    svgTextLines(['核心对象'], 970, 336, { fill: '#0f172a', size: 26, weight: 900 }),
    svgTextLines(entities.length ? entities : ['对象待补充'], 970, 386, { fill: '#334155', size: 20, weight: 700, gap: 40 }),
    '<rect x="96" y="674" width="802" height="98" rx="28" fill="#f8fafc" stroke="#dbe3ef"/>',
    svgTextLines(['关键操作', actions.join(' / ') || '新增 / 编辑 / 查看 / 提交'], 128, 720, { fill: '#0f172a', size: 24, weight: 850, gap: 34 }),
    '<rect x="936" y="654" width="376" height="118" rx="28" fill="#fff7ed" stroke="#fed7aa"/>',
    svgTextLines(['设计约束', truncateForSvg(uiModel.visualMood, 34)], 970, 704, { fill: '#7c2d12', size: 22, weight: 850, gap: 34 }),
    '<rect x="96" y="804" width="1216" height="34" rx="17" fill="#f1f5f9" stroke="#dbe3ef"/>',
    svgTextLines(['该 mockup 来源于业务需求模型，不是 IM.codes War Room 默认界面；前端实现需继续读取 hifi-spec 与 design-handoff。'], 128, 827, { fill: '#64748b', size: 16, weight: 700 }),
    '</svg>',
  ].join('\n');
}

function renderTasteHifiPrompt(digest: RequirementDigest, run: EvolutionRun, instructions: WarRoomInstruction[], uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  const targets = hifiScreenTargets(uiModel, refs);
  return [
    `# taste-skill High-Fidelity UI Prompt: ${digest.title}`,
    '',
    '## Provider',
    `- Source: ${TASTE_SKILL_SOURCE_URL}`,
    `- Primary skill: \`${TASTE_SKILL_INSTALL_NAME}\``,
    `- Optional image reference skill: \`${TASTE_SKILL_IMAGEGEN_WEB_NAME}\``,
    '- Intent: generate high-fidelity UI direction without making Figma a required dependency.',
    '',
    '## Non-Negotiable Source Contract',
    '- The source requirement MD is authoritative. Do not design an IM.codes / Evolution War Room unless the requirement explicitly asks for that product.',
    '- If the MD was generated from screenshots by an earlier IM.codes discussion, treat that MD as the distilled result and do not repeat the same discussion.',
    `- Reference image status: ${referenceStatusLine(refs)}`,
    '',
    '## Design Read',
    `Reading this as: ${uiModel.primarySurface} for ${uiModel.audience}, with ${uiModel.visualMood}.`,
    '',
    '## Product UI Model',
    ...uiModelBulletLines(uiModel),
    '',
    '## Reference Images',
    ...referenceLines(refs),
    '',
    '## Inputs to Load',
    `- Run ledger: \`.imc/evolution/${run.runId}/run.json\``,
    '- PRD: `artifacts/prd.md`',
    '- PRD review: `artifacts/prd-review.md`',
    '- UX flow: `design/ux-flow.md`',
    '- Low-fidelity wireframe: `design/wireframe.svg`',
    '- High-fidelity spec: `design/hifi-spec.md`',
    '- Deterministic mockup seed: `design/hifi-mockup.svg`',
    '- Design handoff JSON: `design/design-handoff.json`',
    '',
    '## Required Output',
    '- A production-implementable high-fidelity UI brief or frontend implementation plan that can be executed by the frontend agent.',
    refs.length > 0
      ? `- Multi-reference requirement: generate a high-fidelity screen/state pack with at least ${refs.length} screens or states. Do not collapse ${refs.length} reference images into one generic screen.`
      : '- If no reference images exist, generate the screen/state pack from the MD and explicitly mark assumptions.',
    `- Screens must cover: ${uiModel.screens.map((screen) => screen.name).join('、')}`,
    `- Screen/state targets: ${targets.map((target, index) => `${index + 1}. ${target.name} (${target.sourceLabel})`).join('；')}`,
    `- Components must cover: ${uiModel.components.join('、')}`,
    '- Design tokens for color, typography, spacing, radii, elevation, motion, and state colors.',
    '- Component states for default, loading, empty, validation-error, blocked, disabled, success and permission-denied.',
    '- Responsive notes for the declared primary surface and any H5/PC split in the MD.',
    '',
    '## taste-skill Guardrails',
    '- Avoid generic AI-purple hero layouts, boilerplate glass cards, and unrelated operations-console pages.',
    '- Keep the UI implementable in the existing project stack before adding dependencies.',
    '- Preserve business terminology from the MD; do not rename domain entities into generic labels.',
    '- If reference images are available, map each major visual choice back to at least one reference image.',
    '- For each reference image, describe which layout, color, spacing, component, typography, icon, or interaction decision was preserved or intentionally changed.',
    '- If image references are missing, explicitly state the MD-derived assumptions instead of hallucinating screenshots.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderBuiltInTasteHifiOutput(digest: RequirementDigest, run: EvolutionRun, instructions: WarRoomInstruction[], uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  const requirementSignals = digest.bullets.slice(0, 8).map((entry) => `- ${entry}`);
  const targets = hifiScreenTargets(uiModel, refs);
  return [
    `# Built-in taste-skill High-Fidelity Output: ${digest.title}`,
    '',
    '## Source',
    `- taste-skill source: ${TASTE_SKILL_SOURCE_URL}`,
    `- Applied skill shape: \`${TASTE_SKILL_INSTALL_NAME}\``,
    `- Optional image reference skill: \`${TASTE_SKILL_IMAGEGEN_WEB_NAME}\``,
    '- Mode: built-in distilled pass because no external `.imc/evolution/design.json` runner is configured.',
    '- Figma: optional later export only. This artifact is directly consumable by frontend and review agents.',
    '',
    '## Design Read',
    `Reading this as: ${uiModel.primarySurface} for ${uiModel.audience}, with ${uiModel.visualMood}.`,
    `Reference status: ${referenceStatusLine(refs)}`,
    '',
    '## Dial Settings',
    `- DESIGN_VARIANCE: ${uiModel.type === 'evolution_war_room' ? 6 : 5} - business consistency before novelty.`,
    `- MOTION_INTENSITY: ${uiModel.type === 'business_app' ? 3 : 4} - state transitions and feedback only.`,
    `- VISUAL_DENSITY: ${uiModel.type === 'business_app' ? 8 : 7} - management data needs compact hierarchy.`,
    '',
    '## Requirement Signals',
    ...(requirementSignals.length ? requirementSignals : ['- Requirement document is sparse; preserve explicit assumptions and surface blockers early.']),
    '',
    '## High-Fidelity Screen Composition',
    ...screenBlueprintLines(uiModel),
    '',
    '## Reference-to-Screen Mapping',
    ...(targets.length > 0
      ? targets.map((target, index) => `- ${index + 1}. ${target.name}: ${target.sourceLabel}; states ${target.states.join(' / ')}; deliverable \`design/hifi-screens/screen-${String(index + 1).padStart(2, '0')}.svg\`.`)
      : ['- No screen targets were inferred; block before implementation.']),
    refs.length > 0
      ? `- ${refs.length} reference image(s) require a multi-screen/state pack; a single generic high-fidelity image is insufficient.`
      : '- No reference images were attached; this pass is MD-derived and should be re-run if screenshots arrive.',
    '',
    '## Component Matrix',
    '| Component | High-fidelity treatment | Failure / empty state |',
    '| --- | --- | --- |',
    ...uiModel.components.map((component) => `| ${component} | align with source MD and reference-image/project style; clear labels, hierarchy, and affordance | empty copy, validation error, disabled state, permission reason |`),
    '',
    '## Tokens',
    '```json',
    JSON.stringify({
      color: uiModel.colors,
      typography: {
        heading: '700-900 weight system/geometric sans; keep Chinese labels readable',
        body: 'system sans, 13-15px for dense admin data',
        mono: 'ui-monospace only for ids, commands, artifact paths',
      },
      radius: { panel: 18, card: 14, pill: 999 },
      spacing: { panelPadding: 16, cardGap: 12, denseRow: 8 },
      motion: { entry: 'opacity + translateY only', hover: 'border-color and transform -1px', reducedMotion: 'disable transforms above 150ms' },
    }, null, 2),
    '```',
    '',
    '## Frontend Implementation Notes',
    '- Read existing project styles before implementation; reuse palette, typography, radius, spacing rhythm and component motifs.',
    '- Do not introduce a second unrelated design system or IM.codes War Room visuals for a business feature page.',
    '- Keep domain labels from the requirement visible in navigation, tables, filters, buttons, and detail states.',
    '- If design/reference images are later attached, re-run the high-fidelity pass and cite changed visual decisions.',
    '',
    '## Acceptance Checklist',
    `- User can identify the product surface “${uiModel.primarySurface}” in under 3 seconds.`,
    '- Main entities, actions, and states from the requirement appear in the UI plan.',
    '- Existing project style or reference-image style is not contradicted without an explicit note.',
    '- Empty/loading/error/permission/disabled states are covered for core components.',
    '- Frontend agent can implement without needing Figma.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
    '',
    '## Handoff',
    `Use \`.imc/evolution/${run.runId}/design/design-handoff.json\` plus this file as the frontend implementation brief. External taste-skill or image generation can replace this artifact later by writing the same path.`,
  ].join('\n');
}

function renderDesignHandoffPackage(digest: RequirementDigest, run: EvolutionRun, instructions: WarRoomInstruction[], uiModel: ProductUiModel, refs: DesignReferenceImage[]): string {
  return JSON.stringify({
    schema: 'imcodes.evolution.design-handoff.v2',
    runId: run.runId,
    title: uiModel.title || digest.title,
    summary: digest.summary,
    source: run.source.relativePath,
    stage: 'design_hifi',
    domain: uiModel.type,
    designTargetSurface: run.designTargetSurface ?? 'auto',
    audience: uiModel.audience,
    primarySurface: uiModel.primarySurface,
    referenceImages: refs.map((ref) => ({
      originalRelativePath: ref.originalRelativePath,
      runRelativePath: ref.runRelativePath,
      fileName: ref.fileName,
      sha256: ref.sha256,
      bytes: ref.bytes,
    })),
    referenceImageContract: referenceStatusLine(refs),
    warRoomInstructions: warRoomInstructionObjects(instructions),
    artifacts: {
      prd: 'artifacts/prd.md',
      prdReview: 'artifacts/prd-review.md',
      referenceManifest: DESIGN_REFERENCE_MANIFEST_RELATIVE_PATH,
      uxFlow: 'design/ux-flow.md',
      wireframe: 'design/wireframe.svg',
      hifiSpec: 'design/hifi-spec.md',
      hifiMockup: 'design/hifi-mockup.svg',
      tasteHifiPrompt: 'design/taste-hifi-prompt.md',
      tasteHifiOutput: BUILT_IN_TASTE_OUTPUT_RELATIVE_PATH,
    },
    highFidelityProvider: {
      type: 'taste-skill',
      source: TASTE_SKILL_SOURCE_URL,
      primarySkill: TASTE_SKILL_INSTALL_NAME,
      optionalImageReferenceSkill: TASTE_SKILL_IMAGEGEN_WEB_NAME,
      promptArtifact: 'design/taste-hifi-prompt.md',
      outputArtifact: BUILT_IN_TASTE_OUTPUT_RELATIVE_PATH,
      configPath: '.imc/evolution/design.json',
      rationale: 'Lightweight agent-skill high-fidelity generation is the default; Figma remains optional for later design handoff only.',
    },
    hifiScreens: hifiScreenTargets(uiModel, refs).map((target, index) => ({
      path: `design/hifi-screens/screen-${String(index + 1).padStart(2, '0')}.svg`,
      name: target.name,
      purpose: target.purpose,
      states: target.states,
      sourceLabel: target.sourceLabel,
      ...(target.reference ? { referenceImage: target.reference.runRelativePath } : {}),
    })),
    designSystem: {
      mood: uiModel.visualMood,
      navigation: uiModel.navigation,
      entities: uiModel.entities,
      actions: uiModel.actions,
      typography: { heading: 'bold readable system/geometric sans', body: 'system sans', code: 'ui-monospace' },
      colors: uiModel.colors,
      components: uiModel.components,
    },
    screens: uiModel.screens,
    tasteSkillPrompt: [
      `Use taste-skill to create a high-fidelity UI direction for ${uiModel.primarySurface}.`,
      'Use the provided PRD, UX flow, wireframe SVG, hifi spec, mockup SVG, and design reference manifest as source artifacts.',
      refs.length > 0 ? `Preserve style and layout evidence from these reference images: ${refs.map((ref) => ref.runRelativePath).join(', ')}.` : 'No original reference images were found; rely on the distilled MD and explicitly state assumptions.',
      `Preserve domain entities: ${uiModel.entities.join(', ')}.`,
      `Preserve key actions: ${uiModel.actions.join(', ')}.`,
    ].join(' '),
    figmaPrompt: [
      `Optional later export: create an editable high-fidelity design for ${uiModel.primarySurface}.`,
      'Use the taste-skill prompt, PRD, UX flow, wireframe SVG, hifi spec, mockup SVG, and reference manifest as source artifacts.',
      'Do not convert the design into an IM.codes War Room unless the domain is explicitly evolution_war_room.',
    ].join(' '),
    imageGenerationPrompt: [
      `Premium high-fidelity product UI mockup for "${uiModel.title || digest.title}".`,
      `${uiModel.primarySurface}; ${uiModel.visualMood}.`,
      `Navigation: ${uiModel.navigation.join(', ')}. Components: ${uiModel.components.join(', ')}.`,
      refs.length > 0 ? `Reference images: ${refs.map((ref) => ref.runRelativePath).join(', ')}.` : 'No source screenshots attached; use the distilled requirement MD.',
    ].join(' '),
    acceptanceChecklist: [
      'UI matches the source requirement domain, not a generic IM.codes War Room.',
      'Main entities, actions, screens, and states from the MD are visible in the plan.',
      'Reference-image/project style consistency is documented.',
      'Design remains implementable in the existing web stack.',
    ],
  }, null, 2);
}

function renderArchitectureBaseline(digest: RequirementDigest, uiModel: ProductUiModel, changeSlug: string, instructions: WarRoomInstruction[]): string {
  if (uiModel.type === 'evolution_war_room') {
    return [
      '# Architecture Baseline',
      '',
      '## Pattern',
      'Evolution Pipeline sits above existing IM.codes P2P, OpenSpec Auto Deliver, MCP, timeline and session runtime.',
      '',
      '## Components',
      '- Inbox watcher: discovers stable requirement documents.',
      '- Artifact store: persists `.imc/evolution/<runId>/run.json` and generated artifacts.',
      '- Stage runner: advances deterministic planning stages and records evidence.',
      '- War Room: browser-visible projection and user-to-role instruction channel.',
      '- OpenSpec bridge: materializes `openspec/changes/<change>/` for downstream Auto Deliver.',
      '',
      '## OpenSpec Change',
      `- Change slug: \`${changeSlug}\``,
      `- Change root: \`openspec/changes/${changeSlug}/\``,
      '',
      '## Safety Baseline',
      '- Report/planning stages are automatic.',
      '- Implementation must use separate maker/checker roles.',
      '- Staging can be automated after tests pass.',
      '- Production requires explicit human release gate.',
      '',
      '## War Room User Instructions',
      ...warRoomInstructionLines(instructions),
    ].join('\n');
  }
  return [
    '# Architecture Baseline',
    '',
    '## Source-Bound Pattern',
    `Implement "${digest.title}" inside the existing project surfaces described by the source MD, not as a new IM.codes orchestration product.`,
    '',
    '## Target Surfaces',
    `- ${uiModel.primarySurface}`,
    `- Navigation / IA: ${uiModel.navigation.join(' / ')}`,
    '',
    '## Domain Objects',
    ...uiModel.entities.slice(0, 12).map((entity) => `- ${entity}`),
    '',
    '## Core Operations',
    ...uiModel.actions.slice(0, 12).map((action) => `- ${action}: enforce permission checks, validation, auditability and failure feedback.`),
    '',
    '## OpenSpec Change',
    `- Change slug: \`${changeSlug}\``,
    `- Change root: \`openspec/changes/${changeSlug}/\``,
    '',
    '## Safety Baseline',
    '- Reuse existing project modules, auth, API conventions, UI components and design tokens before adding abstractions.',
    '- Data model, quota/inventory, account binding, permissions, migrations and production deploy require explicit review.',
    '- Frontend implementation must read project styles and reference images before creating new UI.',
    '- Tests must cover success, empty/loading/error, no-permission, validation failure and destructive-operation guards.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderAdr(digest: RequirementDigest, uiModel: ProductUiModel): string {
  if (uiModel.type === 'evolution_war_room') {
    return [
      '# ADR-0001: Evolution Pipeline over Existing IM.codes Orchestration',
      '',
      '## Status',
      'Accepted for MVP',
      '',
      '## Decision',
      'Build a thin Evolution Pipeline on top of existing IM.codes primitives instead of creating a separate orchestration product.',
      '',
      '## Consequences',
      '- Reuses P2P, OpenSpec Auto Deliver, timeline, MCP and browser session controls.',
      '- Keeps state durable in run.json so loops survive chat context loss.',
      '- Allows staged rollout from report/planning automation to assisted implementation and later unattended loops.',
    ].join('\n');
  }
  return [
    `# ADR-0001: Source-Bound Implementation for ${digest.title}`,
    '',
    '## Status',
    'Accepted for MVP',
    '',
    '## Decision',
    `Implement the requested ${uiModel.primarySurface} capability in the existing application architecture and keep the source MD as the delivery contract.`,
    '',
    '## Consequences',
    `- Domain terminology stays anchored to: ${uiModel.entities.slice(0, 8).join('、')}.`,
    `- UI work targets: ${uiModel.screens.map((screen) => screen.name).join('、')}.`,
    '- Existing auth, data, API, UI style and test conventions take precedence over generated defaults.',
    '- Any ambiguity in quotas, account lifecycle, migration or permissions remains a documented assumption until confirmed.',
  ].join('\n');
}

function renderOpenSpecProposal(digest: RequirementDigest, uiModel: ProductUiModel, instructions: WarRoomInstruction[]): string {
  return [
    `# Change: ${digest.title}`,
    '',
    '## Why',
    digest.summary,
    '',
    '## What Changes',
    `- Add/extend the product behavior for ${uiModel.primarySurface}.`,
    `- Preserve domain objects and labels: ${uiModel.entities.slice(0, 10).join('、')}.`,
    `- Implement/validate core actions: ${uiModel.actions.slice(0, 10).join('、')}.`,
    '- Add tests that prove the requested behavior, states, permissions and failure paths.',
    '',
    '## Impact',
    `- Product: source-bound PRD for ${uiModel.audience}.`,
    '- Engineering: concrete backend/frontend/data tasks derived from the MD.',
    '- QA/Ops: test and staging delivery plan before production gate.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderOpenSpecDesign(digest: RequirementDigest, uiModel: ProductUiModel, instructions: WarRoomInstruction[]): string {
  return [
    `# Design: ${digest.title}`,
    '',
    '## Approach',
    `Implement the smallest coherent increment that satisfies the PRD for ${uiModel.primarySurface}.`,
    '',
    '## Implementation Notes',
    '- Keep changes scoped to the OpenSpec tasks and source MD.',
    '- Reuse existing project patterns before adding abstractions or dependencies.',
    `- Preserve domain objects: ${uiModel.entities.slice(0, 10).join('、')}.`,
    `- Preserve UI states: ${uiModel.screens.flatMap((screen) => screen.states).slice(0, 12).join(' / ')}.`,
    '- Preserve observability: tests, evidence, and task checkboxes must be updated.',
    '- Treat War Room user instructions as first-class constraints unless a safety gate blocks them.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
    '',
    '## Validation',
    '- Run targeted tests for changed behavior.',
    '- Run typecheck/lint/build where the repository supports them.',
    '- Record commands and results in the final implementation evidence.',
  ].join('\n');
}

function renderOpenSpecTasks(digest: RequirementDigest, uiModel: ProductUiModel, instructions: WarRoomInstruction[]): string {
  const entities = uiModel.entities.slice(0, 8);
  const actions = uiModel.actions.slice(0, 8);
  const screens = uiModel.screens.slice(0, 6);
  return [
    '# Tasks',
    '',
    `- [ ] Inspect current project structure for "${digest.title}" and identify exact backend/frontend/data files affected by the source MD.`,
    `- [ ] Map domain objects (${entities.join('、') || 'source-defined objects'}) to existing or new data/API contracts; document migrations and compatibility rules.`,
    `- [ ] Implement core actions (${actions.join('、') || 'source-defined actions'}) with permissions, validation, success/failure feedback and audit evidence.`,
    ...screens.map((screen) => `- [ ] Implement or update UI screen "${screen.name}" with states ${screen.states.join(' / ')} and source/reference-image terminology.`),
    '- [ ] Preserve existing project style: colors, typography, spacing, radius, components and responsive rules before adding a new design system.',
    '- [ ] Add or update automated tests for success, empty/loading/error, validation failure, no-permission and destructive-operation guards.',
    '- [ ] Run targeted validation and record command evidence.',
    ...(instructions.length > 0
      ? ['- [ ] Verify implementation and tests satisfy War Room user instructions captured in PRD/design/architecture artifacts.']
      : []),
    '- [ ] Update user-facing documentation or release notes if behavior changes.',
    '- [ ] Prepare staging deployment notes and rollback plan; leave production behind human gate.',
  ].join('\n');
}

function renderOpenSpecSpec(digest: RequirementDigest, instructions: WarRoomInstruction[]): string {
  return [
    '# evolution-factory Specification',
    '',
    '## ADDED Requirements',
    '',
    '### Requirement: Requirement-driven delivery loop',
    'The system SHALL transform a stable requirement document into a tracked delivery run with PRD, design, architecture, tasks, tests, and delivery evidence.',
    '',
    '#### Scenario: Requirement document enters inbox',
    '- **GIVEN** a supported `.md`, `.txt`, or `.json` file under `.imcodes/inbox/requirements/`',
    '- **WHEN** the watcher sees the file after its stability window',
    '- **THEN** the system creates an Evolution Run and records generated artifacts.',
    '',
    '### Requirement: War Room observability',
    'The system SHALL expose the run stage, role states, artifacts, evidence, blockers, and user-to-role messages in the browser War Room.',
    '',
    '#### Scenario: User sends a role instruction',
    '- **GIVEN** an active Evolution Run',
    '- **WHEN** the user sends a message to a role',
    '- **THEN** the message is recorded as run evidence, reflected in the latest projection, and carried into downstream PRD/design/architecture/task artifacts.',
    '',
    '### Requirement: Human-gated production delivery',
    'The system SHALL prevent production deployment from running without explicit human approval.',
    '',
    ...(instructions.length > 0 ? [
      '### Requirement: War Room instruction propagation',
      'The system SHALL treat user instructions sent through the War Room as first-class planning constraints.',
      '',
      '#### Scenario: Planning artifacts are generated after user instruction',
      '- **GIVEN** a user message recorded before planning artifacts are generated',
      '- **WHEN** the Evolution planning loop writes PRD, design, architecture, and OpenSpec artifacts',
      '- **THEN** those artifacts include the user instruction or an explicit safety gate reason.',
      '',
    ] : []),
    `<!-- Source title: ${digest.title} -->`,
  ].join('\n');
}

function renderImplementationTaskMatrix(digest: RequirementDigest, changeSlug: string, instructions: WarRoomInstruction[]): string {
  return [
    `# Multi-Agent Implementation Task Matrix: ${digest.title}`,
    '',
    '## Development Loop Contract',
    '- Tech Director owns scope control, task ordering, and architecture/risk decisions.',
    '- Backend and frontend developers implement only assigned slices and update OpenSpec checkboxes.',
    '- QA, security, and ops are checker roles; they do not self-verify developer output.',
    '- Failed validation returns to `implementation_loop`; repeated or irreversible risk enters `needs_human`.',
    '',
    '## OpenSpec Source',
    `- Change: \`${changeSlug}\``,
    `- Tasks: \`openspec/changes/${changeSlug}/tasks.md\``,
    '',
    '## Maker/Checker Ownership',
    '| Role | Owned Work | Required Inputs | Required Output / Evidence | Exit Gate |',
    '|---|---|---|---|---|',
    '| 技术总监 | Confirm scope, dependency risk, file ownership, and implementation order. | PRD, architecture baseline, OpenSpec tasks, design handoff. | Updated task ordering, risk notes, handoff to dev roles. | No hidden production/auth/payment/migration risk. |',
    '| 后端开发 | Implement API, daemon, validation, persistence, watcher, and delivery runner changes. | OpenSpec tasks, architecture baseline, test cases. | Code changes, service tests, task checkbox updates, command evidence. | QA can run backend/contract validation independently. |',
    '| 前端开发 | Implement War Room UI, previews, controls, and role interaction states. | Design handoff, hifi/taste artifacts, OpenSpec tasks. | UI code, interaction tests or smoke evidence, screenshots when relevant. | UX/QA can verify role visibility and user-message flow. |',
    '| QA 工程师 | Convert PRD acceptance criteria into executable tests and regression scenarios. | PRD, test cases, changed files, command list. | Test results, coverage gaps, failed scenario evidence. | All critical cases pass or have explicit blocker. |',
    '| 安全审查 | Review path safety, command execution, secrets, auth, privacy, migration and supply-chain risk. | Architecture baseline, delivery config, code diff. | Security findings, gate recommendation, required mitigations. | No high-risk change proceeds without human approval. |',
    '| 运维/发布经理 | Prepare staging run, rollback, env vars, monitoring and production gate notes. | Deployment plan, staging config, QA evidence. | Staging log, rollback notes, release gate checklist. | Staging can pass; production remains human-gated. |',
    '',
    '## Loop Iteration Checklist',
    '- [ ] Assign every OpenSpec checkbox to one maker role and one checker role.',
    '- [ ] Run implementation in the smallest independent slice first.',
    '- [ ] Update checkboxes only after code, tests, and evidence exist.',
    '- [ ] Route failed tests back to the owning maker with exact failure output.',
    '- [ ] Record final validation evidence before staging delivery.',
    '',
    '## Requirement Signals',
    ...digest.bullets.map((entry, index) => `- R${String(index + 1).padStart(2, '0')}: ${entry}`),
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderTestPlan(instructions: WarRoomInstruction[]): string {
  return [
    '# Test Plan',
    '',
    '## Contract Tests',
    '- Validate inbox path safety, file extension, file size, and launch payload normalization.',
    '- Validate state transitions and terminal states.',
    '- Validate generated OpenSpec tasks contain parseable checkboxes.',
    '',
    '## Integration Tests',
    '- Launch a run from a requirement file and verify artifacts exist.',
    '- Verify War Room projection receives stage updates.',
    '- Verify stop/continue/user-message commands mutate run ledger safely.',
    ...(instructions.length > 0 ? ['- Verify War Room user instructions are propagated into generated planning artifacts.'] : []),
    '',
    '## Manual QA',
    '- Open War Room, inspect role status and generated artifacts.',
    '- Send a message to product/QA/tech director and confirm evidence updates.',
  ].join('\n');
}

function renderTestCases(digest: RequirementDigest, instructions: WarRoomInstruction[]): string {
  const requirementCases = digest.bullets.slice(0, 8).flatMap((entry, index) => {
    const id = `REQ-${String(index + 1).padStart(3, '0')}`;
    return [
      `### ${id}: Requirement signal is satisfied`,
      `- Source signal: ${entry}`,
      '- Type: acceptance',
      '- Priority: high',
      '- Given: the requirement has been materialized into PRD, design, architecture and tasks.',
      '- When: the implementation loop completes the related OpenSpec task.',
      '- Then: the user-visible behavior or generated artifact satisfies this source signal and has reproducible evidence.',
      '- Evidence: automated test, artifact diff, screenshot, command log, or explicit QA note.',
      '',
    ];
  });
  return [
    `# QA Test Cases: ${digest.title}`,
    '',
    '## Coverage Contract',
    '- Every PRD acceptance criterion must map to at least one executable or manually verifiable case.',
    '- Every War Room user instruction must be tested or explicitly safety-gated.',
    '- Implementation is not complete until maker evidence and checker evidence are both present.',
    '',
    '## Requirement-Derived Cases',
    ...requirementCases,
    '## Evolution Loop System Cases',
    '',
    '### EVT-001: Requirement inbox creates a run',
    '- Type: integration',
    '- Priority: critical',
    '- Given: a stable `.md`, `.txt`, or `.json` file is placed under `.imcodes/inbox/requirements/`.',
    '- When: the watcher stability window elapses.',
    '- Then: an Evolution Run is created once, with source metadata, role states, and initial discussion evidence.',
    '',
    '### EVT-002: Planning artifacts are complete before implementation',
    '- Type: contract',
    '- Priority: critical',
    '- Given: an Evolution Run reaches `tasks_ready`.',
    '- When: artifacts are inspected.',
    '- Then: PRD, PRD review, UX flow, hifi/taste design artifacts, architecture baseline, OpenSpec tasks, implementation matrix, test plan, test cases, and deployment plan exist.',
    '',
    '### EVT-003: War Room role instruction propagates',
    '- Type: integration',
    '- Priority: high',
    '- Given: the user sends a role-targeted War Room message before planning completes.',
    '- When: downstream artifacts are generated.',
    '- Then: PRD/design/architecture/tasks/test artifacts include the instruction or a safety-gate reason.',
    '',
    '### EVT-004: Multi-agent maker/checker loop is enforced',
    '- Type: process',
    '- Priority: high',
    '- Given: OpenSpec Auto Deliver starts implementation.',
    '- When: a developer marks work complete.',
    '- Then: QA/security/tech review evidence must exist before delivery readiness.',
    '',
    '### EVT-005: taste-skill high-fidelity path is lightweight',
    '- Type: integration',
    '- Priority: medium',
    '- Given: `.imc/evolution/design.json` is absent.',
    '- When: `design_hifi` runs.',
    '- Then: taste-skill prompt and design handoff are generated without blocking on Figma or external commands.',
    '',
    '### EVT-006: Required taste-skill generation gates failures',
    '- Type: integration',
    '- Priority: medium',
    '- Given: `.imc/evolution/design.json` sets `tasteSkill.required=true`.',
    '- When: the configured command fails or produces no output.',
    '- Then: the run pauses at `needs_human` with a log artifact and blocker.',
    '',
    '### EVT-007: Staging can automate but production stays gated',
    '- Type: release',
    '- Priority: critical',
    '- Given: OpenSpec implementation and QA pass.',
    '- When: staging delivery is configured.',
    '- Then: staging may run automatically; production remains at `human_release_gate` until explicit approval.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderDeploymentPlan(instructions: WarRoomInstruction[]): string {
  return [
    '# Deployment Plan',
    '',
    '## Staging',
    '- Run OpenSpec Auto Deliver after tasks are reviewed.',
    '- Execute repository validation commands and collect evidence.',
    '- Deploy only to staging automatically when tests pass.',
    '',
    '## Production Gate',
    '- Production requires explicit human approval.',
    '- Confirm rollback plan, environment variables, secrets, migrations, and monitoring.',
    '',
    '## Rollback',
    '- Revert generated implementation commit/PR if validation fails.',
    '- Stop active Evolution/OpenSpec run and preserve run ledger for audit.',
    '',
    '## Staging Setup Artifact',
    '- See `delivery/staging-setup.md` for the safe staging command contract.',
    '- See `delivery/delivery.example.json` for a copyable `.imc/evolution/delivery.json` template.',
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

function renderStagingDeliveryConfigExample(): string {
  return `${JSON.stringify({
    staging: {
      enabled: true,
      command: 'npm',
      args: ['run', 'deploy:staging'],
      cwd: '.',
      timeoutMs: 600000,
    },
  }, null, 2)}\n`;
}

function renderStagingSetup(digest: RequirementDigest, run: EvolutionRun, changeSlug: string, instructions: WarRoomInstruction[]): string {
  return [
    `# Staging Delivery Setup: ${digest.title}`,
    '',
    '## Purpose',
    'This run can automatically deliver to staging after OpenSpec Auto Deliver passes. Production remains behind `human_release_gate` and is never executed by this setup.',
    '',
    '## Enable Staging Automation',
    '1. Create or review your repository staging command, for example `npm run deploy:staging`.',
    '2. Copy `delivery/delivery.example.json` to project root `.imc/evolution/delivery.json`.',
    '3. Replace the command/args with the real staging deployment script.',
    '4. Keep production credentials, production targets, migrations, and destructive commands out of this config.',
    '',
    '```bash',
    'mkdir -p .imc/evolution',
    `cp .imc/evolution/${run.runId}/delivery/delivery.example.json .imc/evolution/delivery.json`,
    '# edit .imc/evolution/delivery.json so it calls only staging',
    '```',
    '',
    '## Safe Command Contract',
    '- Executed with `execFile` and `shell: false`.',
    '- Shell wrappers such as `sh`, `bash`, `zsh`, `cmd`, `powershell`, `pwsh`, and `sudo` are rejected.',
    '- Command/args containing `prod` or `production` are rejected.',
    '- Output is captured as `staging_deploy_log` and shown in War Room evidence.',
    '- On failure, the run enters `needs_human` with a blocking question.',
    '',
    '## Required Environment Checklist',
    '- Staging endpoint/project/app id is explicit and non-production.',
    '- Secrets are provided by the deployment environment, never committed in `delivery.json`.',
    '- Rollback command or manual rollback path is documented below.',
    '- Monitoring/log links for staging validation are available to QA/Ops.',
    '- Database migration or data-destructive work is either absent or separately human-gated.',
    '',
    '## Rollback Checklist',
    '- Identify the artifact, deployment id, container tag, or preview URL produced by staging.',
    '- Keep the previous deploy id/tag before switching traffic.',
    '- Re-run the previous staging deployment or revert the generated implementation commit/PR.',
    '- Preserve `.imc/evolution/<runId>/run.json`, delivery logs, test evidence, and release gate notes.',
    '',
    '## OpenSpec Change',
    `- Change: \`${changeSlug}\``,
    `- Tasks: \`openspec/changes/${changeSlug}/tasks.md\``,
    '',
    '## War Room User Instructions',
    ...warRoomInstructionLines(instructions),
  ].join('\n');
}

async function readRequirement(projectRoot: string, run: EvolutionRun): Promise<string> {
  const sourcePath = safeJoin(projectRoot, run.source.relativePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error('evolution_requirement_source_missing');
  return readFile(sourcePath, 'utf8');
}

export async function runEvolutionPlanningStages(options: RunEvolutionPlanningStagesOptions): Promise<EvolutionRun> {
  const { projectRoot, run } = options;
  if (isEvolutionTerminalStage(run.stage) || run.stage === 'needs_human' || run.stage === 'tasks_ready' || run.stage === 'implementation_loop') return run;
  const raw = await readRequirement(projectRoot, run);
  const digest = digestRequirement(raw, run.source.fileName);
  const uiModel = applyDesignTargetSurface(deriveProductUiModel(digest), run.designTargetSurface ?? 'auto');
  const designReferenceImages = await collectDesignReferenceImages(projectRoot, run, digest);
  const missingRequiredDesignReferences = shouldPauseForMissingDesignReferences(digest, uiModel, designReferenceImages);
  const nowMs = nowFrom(options);
  const baseSlug = slugify(digest.title, slugify(run.source.fileName, 'requirement'));
  const runSlugSuffix = sha256(run.runId).slice(0, 10);
  const changeSlug = slugify(`evo-${baseSlug}-${runSlugSuffix}`, `evo-${runSlugSuffix}`);
  const instructions = collectWarRoomInstructions(run);

  if (run.stage === 'detected') {
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'normalized_requirement',
      path: 'artifacts/normalized-requirement.md',
      title: 'Normalized Requirement',
      roleId: 'loop_supervisor',
      stage: 'intake_normalized',
      content: renderNormalizedRequirement(digest, run, instructions),
      nowMs,
    });
    upsertScore(run, { module: 'product', score: 7, maxScore: 10, summary: 'Requirement normalized with assumptions for missing details.' });
    appendDiscussion(run, {
      kind: 'role_update',
      stage: 'intake_normalized',
      roleId: 'product_manager',
      author: '产品经理',
      text: '已完成需求标准化：提取业务目标、约束和初始假设，下一步进入产品经理与产品审查的 maker/checker 讨论。',
      artifactIds: [artifactId('normalized_requirement', 'artifacts/normalized-requirement.md')],
      createdAt: nowMs,
    });
    await transition(options, 'intake_normalized');
  }

  if (run.stage === 'intake_normalized') {
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'discussion',
      path: 'discussions/product-discussion.md',
      title: 'Product Discussion',
      roleId: 'product_manager',
      stage: 'product_discussion',
      content: renderProductDiscussion(digest, instructions),
      nowMs,
    });
    appendDiscussion(run, {
      kind: 'role_update',
      stage: 'product_discussion',
      roleId: 'product_manager',
      author: '产品经理',
      text: `我会把“${digest.title}”收敛为 MVP PRD，优先明确用户、目标、非目标和验收标准。`,
      artifactIds: [artifactId('discussion', 'discussions/product-discussion.md')],
      createdAt: nowMs,
    });
    appendDiscussion(run, {
      kind: 'role_update',
      stage: 'product_discussion',
      roleId: 'product_critic',
      author: '产品审查',
      text: '我会审查矛盾、遗漏、不可测需求和高风险动作；缺失信息先转成显式假设或阻塞问题。',
      artifactIds: [artifactId('discussion', 'discussions/product-discussion.md')],
      createdAt: nowMs,
    });
    await transition(options, 'product_discussion');
  }

  if (run.stage === 'product_discussion') {
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'prd',
      path: 'artifacts/prd.md',
      title: 'PRD',
      roleId: 'product_manager',
      stage: 'prd_ready',
      content: renderPrd(digest, uiModel, instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'prd_review',
      path: 'artifacts/prd-review.md',
      title: 'PRD Review',
      roleId: 'product_critic',
      stage: 'prd_ready',
      content: renderPrdReview(),
      nowMs,
    });
    upsertScore(run, { module: 'product', score: 8, maxScore: 10, summary: 'PRD includes goals, non-goals, user stories, acceptance criteria, and explicit assumptions.' });
    appendDiscussion(run, {
      kind: 'artifact_summary',
      stage: 'prd_ready',
      roleId: 'product_manager',
      author: '产品经理',
      text: 'PRD 已生成，包含目标、非目标、用户故事、验收标准和来源信号，可交给设计与技术拆解。',
      artifactIds: [artifactId('prd', 'artifacts/prd.md')],
      createdAt: nowMs,
    });
    appendDiscussion(run, {
      kind: 'artifact_summary',
      stage: 'prd_ready',
      roleId: 'product_critic',
      author: '产品审查',
      text: 'PRD 审查通过但保留假设：涉及账号、支付、隐私或生产配置时必须进入人工确认。',
      artifactIds: [artifactId('prd_review', 'artifacts/prd-review.md')],
      createdAt: nowMs,
    });
    await transition(options, 'prd_ready');
  }

  if (run.stage === 'prd_ready') {
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'design_reference_manifest',
      path: DESIGN_REFERENCE_MANIFEST_RELATIVE_PATH,
      title: 'Design Reference Image Manifest',
      roleId: 'visual_designer',
      stage: 'design_lofi',
      content: renderDesignReferenceManifest(run, digest, designReferenceImages),
      nowMs,
    });
    for (const ref of designReferenceImages) {
      await registerExistingRunArtifact({
        projectRoot,
        run,
        kind: 'design_reference_image',
        path: ref.runRelativePath,
        title: `Design Reference Image · ${ref.fileName}`,
        roleId: 'visual_designer',
        stage: 'design_lofi',
        nowMs,
      });
    }
    if (missingRequiredDesignReferences) {
      const questionId = `design-reference-images-missing-${run.runId}`;
      if (!run.blockingQuestions.some((question) => question.id === questionId)) {
        run.blockingQuestions.push({
          id: questionId,
          stage: 'needs_human',
          roleId: 'visual_designer',
          question: `需求明确要求严格参考截图/设计图，但未在 ${dirname(run.source.relativePath)} 或其 assets/images/screenshots 子目录找到图片。请补充参考图，或在 War Room 说明“使用 MD 沉淀结果继续，不要求原图还原”。`,
          createdAt: nowMs,
        });
      }
      appendDiscussion(run, {
        kind: 'gate',
        stage: 'needs_human',
        roleId: 'visual_designer',
        author: '视觉设计师',
        text: '检测到严格参考图依赖但没有找到图片，已暂停生成低/高保真，避免生成与用户材料无关的界面。',
        artifactIds: [artifactId('design_reference_manifest', DESIGN_REFERENCE_MANIFEST_RELATIVE_PATH)],
        createdAt: nowMs,
      });
      upsertScore(run, { module: 'design', score: 4, maxScore: 10, summary: 'Strict reference-image requirement is unresolved; design generation paused before hallucinating UI.' });
      await transition(options, 'needs_human', '设计参考图缺失，已暂停高保真生成。');
      return run;
    }
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'ux_flow',
      path: 'design/ux-flow.md',
      title: 'UX Flow',
      roleId: 'ux_designer',
      stage: 'design_lofi',
      content: renderUxFlow(digest, instructions, uiModel, designReferenceImages),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'wireframe',
      path: 'design/wireframe.md',
      title: 'Low-Fidelity Wireframe',
      roleId: 'ux_designer',
      stage: 'design_lofi',
      content: renderWireframe(uiModel),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'lofi_mockup',
      path: 'design/wireframe.svg',
      title: 'Low-Fidelity Wireframe SVG',
      roleId: 'ux_designer',
      stage: 'design_lofi',
      content: renderWireframeSvg(digest, uiModel, designReferenceImages),
      nowMs,
    });
    upsertScore(run, { module: 'design', score: 7, maxScore: 10, summary: 'UX flow, low-fidelity structure, and SVG wireframe are available for review.' });
    appendDiscussion(run, {
      kind: 'artifact_summary',
      stage: 'design_lofi',
      roleId: 'ux_designer',
      author: 'UX 设计师',
      text: '已输出用户流程、低保真线框文档和可打开的 SVG 设计稿，War Room 作为统一观察/介入入口，角色、阶段、产物和讨论流并列展示。',
      artifactIds: [
        artifactId('design_reference_manifest', DESIGN_REFERENCE_MANIFEST_RELATIVE_PATH),
        ...designReferenceImages.map((ref) => artifactId('design_reference_image', ref.runRelativePath)),
        artifactId('ux_flow', 'design/ux-flow.md'),
        artifactId('wireframe', 'design/wireframe.md'),
        artifactId('lofi_mockup', 'design/wireframe.svg'),
      ],
      createdAt: nowMs,
    });
    await transition(options, 'design_lofi');
  }

  if (run.stage === 'design_lofi') {
    const hifiArtifactIds = [
      artifactId('design_reference_manifest', DESIGN_REFERENCE_MANIFEST_RELATIVE_PATH),
      ...designReferenceImages.map((ref) => artifactId('design_reference_image', ref.runRelativePath)),
      artifactId('hifi_spec', 'design/hifi-spec.md'),
      artifactId('hifi_mockup', 'design/hifi-mockup.svg'),
      artifactId('taste_hifi_prompt', 'design/taste-hifi-prompt.md'),
      artifactId('design_handoff', 'design/design-handoff.json'),
    ];
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'hifi_spec',
      path: 'design/hifi-spec.md',
      title: 'High-Fidelity Design Spec',
      roleId: 'visual_designer',
      stage: 'design_hifi',
      content: renderHifiSpec(instructions, uiModel, designReferenceImages),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'hifi_mockup',
      path: 'design/hifi-mockup.svg',
      title: 'High-Fidelity Mockup SVG',
      roleId: 'visual_designer',
      stage: 'design_hifi',
      content: renderHifiMockupSvg(digest, uiModel, designReferenceImages),
      nowMs,
    });
    const hifiTargets = hifiScreenTargets(uiModel, designReferenceImages);
    for (const [targetIndex, target] of hifiTargets.entries()) {
      const screenPath = `design/hifi-screens/screen-${String(targetIndex + 1).padStart(2, '0')}.svg`;
      await writeRunArtifact({
        projectRoot,
        run,
        kind: 'hifi_mockup',
        path: screenPath,
        title: `High-Fidelity Screen ${targetIndex + 1} · ${target.name}`,
        roleId: 'visual_designer',
        stage: 'design_hifi',
        content: renderHifiScreenSvg(digest, uiModel, target, targetIndex, hifiTargets.length),
        nowMs,
      });
      hifiArtifactIds.push(artifactId('hifi_mockup', screenPath));
    }
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'taste_hifi_prompt',
      path: 'design/taste-hifi-prompt.md',
      title: 'taste-skill High-Fidelity Prompt',
      roleId: 'visual_designer',
      stage: 'design_hifi',
      content: renderTasteHifiPrompt(digest, run, instructions, uiModel, designReferenceImages),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'design_handoff',
      path: 'design/design-handoff.json',
      title: 'Design Handoff Package',
      roleId: 'visual_designer',
      stage: 'design_hifi',
      content: renderDesignHandoffPackage(digest, run, instructions, uiModel, designReferenceImages),
      nowMs,
    });
    const tasteResult = await runEvolutionTasteHifiGeneration({ projectRoot, runId: run.runId, nowMs });
    let hifiOutputAvailable = false;
    if (tasteResult.logRelativePath && tasteResult.logContent) {
      await writeRunArtifact({
        projectRoot,
        run,
        kind: 'taste_hifi_log',
        path: tasteResult.logRelativePath,
        title: 'taste-skill High-Fidelity Generation Log',
        roleId: 'visual_designer',
        stage: tasteResult.status === 'passed' ? 'design_hifi' : 'needs_human',
        content: tasteResult.logContent,
        nowMs: tasteResult.completedAt,
      });
      hifiArtifactIds.push(artifactId('taste_hifi_log', tasteResult.logRelativePath));
    }
    if (tasteResult.styleAuditRelativePath && tasteResult.styleAuditContent) {
      await writeRunArtifact({
        projectRoot,
        run,
        kind: 'project_style_audit',
        path: tasteResult.styleAuditRelativePath,
        title: 'Existing Project Style Audit',
        roleId: 'visual_designer',
        stage: tasteResult.status === 'passed' ? 'design_hifi' : 'needs_human',
        content: tasteResult.styleAuditContent,
        nowMs: tasteResult.completedAt,
      });
      hifiArtifactIds.push(artifactId('project_style_audit', tasteResult.styleAuditRelativePath));
    }
    if (tasteResult.status === 'passed' && tasteResult.outputRelativePath && tasteResult.outputContent) {
      hifiOutputAvailable = true;
      await writeRunArtifact({
        projectRoot,
        run,
        kind: 'taste_hifi_output',
        path: tasteResult.outputRelativePath,
        title: 'taste-skill High-Fidelity Output',
        roleId: 'visual_designer',
        stage: 'design_hifi',
        content: tasteResult.outputContent,
        nowMs: tasteResult.completedAt,
      });
      hifiArtifactIds.push(artifactId('taste_hifi_output', tasteResult.outputRelativePath));
      if (
        tasteResult.referenceRelativePath
        && tasteResult.referenceRelativePath !== tasteResult.outputRelativePath
      ) {
        await registerExistingRunArtifact({
          projectRoot,
          run,
          kind: 'taste_hifi_reference',
          path: tasteResult.referenceRelativePath,
          title: referenceTitleForPath(tasteResult.referenceRelativePath),
          roleId: 'visual_designer',
          stage: 'design_hifi',
          nowMs: tasteResult.completedAt,
        });
        hifiArtifactIds.push(artifactId('taste_hifi_reference', tasteResult.referenceRelativePath));
      }
      appendEvidence(run, {
        source: 'taste_skill_hifi_generation',
        summary: tasteResult.summary,
        artifactId: artifactId('taste_hifi_output', tasteResult.outputRelativePath),
        createdAt: tasteResult.completedAt,
      });
    } else if (tasteResult.status === 'not_configured') {
      hifiOutputAvailable = true;
      await writeRunArtifact({
        projectRoot,
        run,
        kind: 'taste_hifi_output',
        path: BUILT_IN_TASTE_OUTPUT_RELATIVE_PATH,
        title: 'Built-in taste-skill High-Fidelity Output',
        roleId: 'visual_designer',
        stage: 'design_hifi',
        content: renderBuiltInTasteHifiOutput(digest, run, instructions, uiModel, designReferenceImages),
        nowMs,
      });
      hifiArtifactIds.push(artifactId('taste_hifi_output', BUILT_IN_TASTE_OUTPUT_RELATIVE_PATH));
      appendEvidence(run, {
        source: 'taste_skill_hifi_generation',
        summary: 'Built-in taste-skill high-fidelity output generated; no external design runner configured.',
        artifactId: artifactId('taste_hifi_output', BUILT_IN_TASTE_OUTPUT_RELATIVE_PATH),
        createdAt: nowMs,
      });
    } else if (tasteResult.status === 'failed') {
      appendEvidence(run, {
        source: 'taste_skill_hifi_generation',
        summary: tasteResult.summary,
        ...(tasteResult.logRelativePath ? { artifactId: artifactId('taste_hifi_log', tasteResult.logRelativePath) } : {}),
        createdAt: tasteResult.completedAt,
      });
      if (tasteResult.required) {
        const questionId = `taste-skill-required-${run.runId}`;
        if (!run.blockingQuestions.some((question) => question.id === questionId)) {
          run.blockingQuestions.push({
            id: questionId,
            stage: 'needs_human',
            roleId: 'visual_designer',
            question: `Required taste-skill high-fidelity generation failed: ${tasteResult.error ?? tasteResult.summary}`,
            createdAt: tasteResult.completedAt,
          });
        }
        appendDiscussion(run, {
          kind: 'gate',
          stage: 'needs_human',
          roleId: 'visual_designer',
          author: '视觉设计师',
          text: `必需的 taste-skill 高保真生成失败，已暂停进入人工处理：${tasteResult.error ?? tasteResult.summary}`,
          ...(tasteResult.logRelativePath ? { artifactIds: [artifactId('taste_hifi_log', tasteResult.logRelativePath)] } : {}),
          createdAt: tasteResult.completedAt,
        });
        upsertScore(run, { module: 'design', score: 5, maxScore: 10, summary: 'Required taste-skill high-fidelity generation failed; human intervention is needed.' });
        await transition(options, 'needs_human', tasteResult.summary);
        return run;
      }
    }
    upsertScore(run, {
      module: 'design',
      score: hifiOutputAvailable ? 9 : 8,
      maxScore: 10,
      summary: hifiOutputAvailable
        ? 'High-fidelity design direction, taste-skill generated output, component inventory, and SVG mockup are ready.'
        : 'High-fidelity design direction, taste-skill prompt, component inventory, and SVG mockup are ready.',
    });
    appendDiscussion(run, {
      kind: 'artifact_summary',
      stage: 'design_hifi',
      roleId: 'visual_designer',
      author: '视觉设计师',
      text: hifiOutputAvailable
        ? '已输出高保真设计方向、组件清单、可打开的高保真 SVG mockup、项目风格审计、taste-skill 高保真提示词、taste-skill 生成结果，以及可消费的 design handoff JSON；Figma 仅作为可选后续导出。'
        : '已输出高保真设计方向、组件清单、可打开的高保真 SVG mockup、taste-skill 高保真提示词，以及可消费的 design handoff JSON；Figma 仅作为可选后续导出。',
      artifactIds: hifiArtifactIds,
      createdAt: nowMs,
    });
    await transition(options, 'design_hifi');
  }

  if (run.stage === 'design_hifi') {
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'architecture_baseline',
      path: 'artifacts/architecture-baseline.md',
      title: 'Architecture Baseline',
      roleId: 'tech_director',
      stage: 'architecture_baseline',
      content: renderArchitectureBaseline(digest, uiModel, changeSlug, instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'adr',
      path: 'artifacts/adr-0001-evolution-pipeline.md',
      title: 'ADR-0001 Evolution Pipeline',
      roleId: 'tech_director',
      stage: 'architecture_baseline',
      content: renderAdr(digest, uiModel),
      nowMs,
    });
    upsertScore(run, { module: 'architecture', score: 8, maxScore: 10, summary: 'Architecture baseline chooses a thin loop layer over existing IM.codes primitives.' });
    upsertScore(run, { module: 'risk', score: 7, maxScore: 10, summary: 'Production deploy, auth, payments, secrets, migrations, and infra remain human-gated.' });
    appendDiscussion(run, {
      kind: 'artifact_summary',
      stage: 'architecture_baseline',
      roleId: 'tech_director',
      author: '技术总监',
      text: '架构基线已确定：在 IM.codes 现有 P2P、OpenSpec Auto Deliver、MCP、timeline、session runtime 之上增加薄 orchestration layer。',
      artifactIds: [
        artifactId('architecture_baseline', 'artifacts/architecture-baseline.md'),
        artifactId('adr', 'artifacts/adr-0001-evolution-pipeline.md'),
      ],
      createdAt: nowMs,
    });
    appendDiscussion(run, {
      kind: 'role_update',
      stage: 'architecture_baseline',
      roleId: 'security_reviewer',
      author: '安全审查',
      text: '安全基线：生产发布、鉴权、支付、隐私、密钥、数据库迁移和基础设施变更必须保留人工门禁。',
      artifactIds: [artifactId('architecture_baseline', 'artifacts/architecture-baseline.md')],
      createdAt: nowMs,
    });
    await transition(options, 'architecture_baseline');
  }

  if (run.stage === 'architecture_baseline') {
    const changeRoot = `openspec/changes/${changeSlug}`;
    await writeProjectArtifact({
      projectRoot,
      run,
      kind: 'openspec_proposal',
      path: `${changeRoot}/proposal.md`,
      title: 'OpenSpec Proposal',
      roleId: 'tech_director',
      stage: 'tasks_ready',
      content: renderOpenSpecProposal(digest, uiModel, instructions),
      nowMs,
    });
    await writeProjectArtifact({
      projectRoot,
      run,
      kind: 'openspec_design',
      path: `${changeRoot}/design.md`,
      title: 'OpenSpec Design',
      roleId: 'tech_director',
      stage: 'tasks_ready',
      content: renderOpenSpecDesign(digest, uiModel, instructions),
      nowMs,
    });
    await writeProjectArtifact({
      projectRoot,
      run,
      kind: 'openspec_tasks',
      path: `${changeRoot}/tasks.md`,
      title: 'OpenSpec Tasks',
      roleId: 'tech_director',
      stage: 'tasks_ready',
      content: renderOpenSpecTasks(digest, uiModel, instructions),
      nowMs,
    });
    await writeProjectArtifact({
      projectRoot,
      run,
      kind: 'openspec_spec',
      path: `${changeRoot}/specs/evolution-factory/spec.md`,
      title: 'OpenSpec Spec Delta',
      roleId: 'tech_director',
      stage: 'tasks_ready',
      content: renderOpenSpecSpec(digest, instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'implementation_task_matrix',
      path: 'implementation/agent-task-matrix.md',
      title: 'Multi-Agent Implementation Task Matrix',
      roleId: 'tech_director',
      stage: 'tasks_ready',
      content: renderImplementationTaskMatrix(digest, changeSlug, instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'test_plan',
      path: 'artifacts/test-plan.md',
      title: 'Test Plan',
      roleId: 'qa_engineer',
      stage: 'tasks_ready',
      content: renderTestPlan(instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'test_cases',
      path: 'artifacts/test-cases.md',
      title: 'QA Test Cases',
      roleId: 'qa_engineer',
      stage: 'tasks_ready',
      content: renderTestCases(digest, instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'deployment_plan',
      path: 'delivery/deployment-plan.md',
      title: 'Deployment Plan',
      roleId: 'ops_release_manager',
      stage: 'tasks_ready',
      content: renderDeploymentPlan(instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'staging_setup',
      path: 'delivery/staging-setup.md',
      title: 'Staging Delivery Setup',
      roleId: 'ops_release_manager',
      stage: 'tasks_ready',
      content: renderStagingSetup(digest, run, changeSlug, instructions),
      nowMs,
    });
    await writeRunArtifact({
      projectRoot,
      run,
      kind: 'staging_config_example',
      path: 'delivery/delivery.example.json',
      title: 'Staging delivery.json Example',
      roleId: 'ops_release_manager',
      stage: 'tasks_ready',
      content: renderStagingDeliveryConfigExample(),
      nowMs,
    });
    run.linkedOpenSpecChange = changeSlug;
    upsertScore(run, { module: 'tasks', score: 8, maxScore: 10, summary: 'OpenSpec tasks and multi-agent ownership matrix are materialized for Auto Deliver.' });
    upsertScore(run, { module: 'tests', score: 8, maxScore: 10, summary: 'Initial test plan and detailed QA test cases cover acceptance, loop, design, and delivery checks.' });
    upsertScore(run, { module: 'delivery', score: 7, maxScore: 10, summary: 'Staging is allowed after validation; production remains gated.' });
    appendDiscussion(run, {
      kind: 'artifact_summary',
      stage: 'tasks_ready',
      roleId: 'tech_director',
      author: '技术总监',
      text: `OpenSpec change 已生成：${changeSlug}。实现清单已拆成 checkbox，可交给 Auto Deliver / 多 agent 开发 loop。`,
      artifactIds: [
        artifactId('openspec_proposal', `${changeRoot}/proposal.md`),
        artifactId('openspec_design', `${changeRoot}/design.md`),
        artifactId('openspec_tasks', `${changeRoot}/tasks.md`),
        artifactId('implementation_task_matrix', 'implementation/agent-task-matrix.md'),
      ],
      createdAt: nowMs,
    });
    appendDiscussion(run, {
      kind: 'role_update',
      stage: 'tasks_ready',
      roleId: 'qa_engineer',
      author: '测试工程师',
      text: '测试计划和详细测试用例已补齐 acceptance、contract、integration、UI、taste-skill、staging/production gate 场景；Auto Deliver 完成后我会以测试与验收证据回流评分。',
      artifactIds: [
        artifactId('test_plan', 'artifacts/test-plan.md'),
        artifactId('test_cases', 'artifacts/test-cases.md'),
      ],
      createdAt: nowMs,
    });
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'tasks_ready',
      roleId: 'ops_release_manager',
      author: '运维/发布经理',
      text: '交付策略：通过验证后允许 staging 自动化；production 保持人工门禁。已生成 staging 配置示例和回滚/环境检查手册，必须确认回滚、环境变量、密钥、迁移和监控。',
      artifactIds: [
        artifactId('deployment_plan', 'delivery/deployment-plan.md'),
        artifactId('staging_setup', 'delivery/staging-setup.md'),
        artifactId('staging_config_example', 'delivery/delivery.example.json'),
      ],
      createdAt: nowMs,
    });
    await transition(options, 'tasks_ready');
  }

  return run;
}

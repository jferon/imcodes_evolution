import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import {
  EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS,
  EVOLUTION_REQUIREMENT_FILE_MAX_BYTES,
  EVOLUTION_RUN_ROOT_DIR,
  type EvolutionRoleId,
  type EvolutionRoleStatus,
} from '../../shared/evolution-pipeline-constants.js';
import type {
  EvolutionArtifactRef,
  EvolutionArtifactPreview,
  EvolutionBudget,
  EvolutionLaunchRequest,
  EvolutionRoleState,
  EvolutionRun,
} from '../../shared/evolution-pipeline-types.js';
import {
  validateEvolutionLaunchRequest,
  validateEvolutionRunId,
} from '../../shared/evolution-pipeline-validators.js';
import { getProjectSkillEscapeHatchPath } from '../../shared/skill-store.js';
import { parseSkillMarkdown } from '../../shared/skill-store.js';

export interface CreateEvolutionRunOptions {
  projectRoot: string;
  request: EvolutionLaunchRequest;
  nowMs?: number;
  runId?: string;
}

export interface EvolutionRunPaths {
  runDir: string;
  inputDir: string;
  artifactsDir: string;
  discussionsDir: string;
  designDir: string;
  deliveryDir: string;
  runJsonPath: string;
}

export interface UpdateEvolutionRoleSkillFileResult {
  artifact: EvolutionArtifactRef;
  previousContent: string | null;
  previousSha256?: string;
  skillName: string;
  relativePath: string;
}

export const DEFAULT_EVOLUTION_BUDGET: EvolutionBudget = {
  maxRoleTurns: 40,
  maxElapsedMinutes: 480,
  maxImplementationAttempts: 3,
  maxAutoDeployStage: 'staging',
};

export const EVOLUTION_ROLE_SKILL_CATEGORY = 'evolution' as const;
export const EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR = 'config/evolution/role-skills/approved' as const;
const EVOLUTION_ROLE_SKILL_MAX_BYTES = 128 * 1024;

export interface EvolutionRoleSkillDefinition {
  roleId: EvolutionRoleId;
  label: string;
  skillName: string;
  skillSummary: string;
  responsibilities: string[];
  outputs: string[];
  checklist: string[];
  handoff: string;
  status?: EvolutionRoleStatus;
}

export const EVOLUTION_ROLE_SKILL_DEFINITIONS: EvolutionRoleSkillDefinition[] = [
  {
    roleId: 'loop_supervisor',
    label: 'Loop Supervisor / 总控',
    skillName: 'evolution-loop-supervisor',
    skillSummary: '维护状态机、预算、证据、门禁和人工升级。',
    responsibilities: ['推进阶段', '维护 run.json', '触发 OpenSpec Auto Deliver', '生产门禁'],
    outputs: ['run.json 状态账本', 'blockingQuestions', 'evidence ledger', 'human gate 决策'],
    checklist: ['每个阶段都有 artifact/evidence', '失败或超预算进入 needs_human', '生产发布不自动越过人工门禁'],
    handoff: '把当前阶段、证据、阻塞问题和下一步动作写回 War Room。',
    status: 'running',
  },
  {
    roleId: 'product_manager',
    label: '产品经理',
    skillName: 'product-prd',
    skillSummary: '澄清需求、用户故事、验收标准和 MVP 边界。',
    responsibilities: ['需求分析', 'PRD', '用户故事', '验收标准'],
    outputs: ['artifacts/prd.md', '用户故事', '验收标准', 'MVP/Non-goals'],
    checklist: ['目标用户明确', '成功/失败场景明确', '验收标准可测试', '高风险假设显式标注'],
    handoff: '把 PRD 交给产品审查、UX 和技术总监，等待反例与边界反馈。',
  },
  {
    roleId: 'product_critic',
    label: '产品审查',
    skillName: 'product-critic',
    skillSummary: '找矛盾、遗漏、不可测需求和高风险假设。',
    responsibilities: ['反例审查', '边界条件', '风险问题', '可测性'],
    outputs: ['artifacts/prd-review.md', '矛盾清单', '边界问题', 'REWORK/PASS 建议'],
    checklist: ['PRD 没有自相矛盾', '每个故事都有可测结果', '缺失信息已转为假设或 blocker'],
    handoff: '若发现不可测或互斥要求，要求产品经理重写；否则允许进入设计阶段。',
  },
  {
    roleId: 'ux_designer',
    label: 'UX 设计师',
    skillName: 'ux-flow-wireframe',
    skillSummary: '输出用户流程、信息架构和低保真线框。',
    responsibilities: ['用户流程', '低保真', '状态流', '交互边界'],
    outputs: ['design/ux-flow.md', 'design/wireframe.md', 'design/wireframe.svg'],
    checklist: ['主流程和异常流程完整', '关键状态明确', '入口/出口/空状态可实现'],
    handoff: '把低保真流程交给视觉设计和前端开发，暴露交互风险。',
  },
  {
    roleId: 'visual_designer',
    label: '视觉设计师',
    skillName: 'visual-hifi',
    skillSummary: '输出高保真方向、组件层级、视觉 token 和动效建议。',
    responsibilities: ['高保真规格', '设计 token', '组件状态', '动效建议'],
    outputs: ['design/hifi-spec.md', 'design/hifi-mockup.svg', 'design/taste-hifi-prompt.md', 'design/taste-hifi-output.md（配置后）', '设计 token', '组件状态'],
    checklist: ['视觉层级清晰', '组件状态覆盖 hover/loading/error/empty', 'token 可被代码实现'],
    handoff: '把高保真规格和 taste-skill 提示词交给技术总监和前端开发；Figma 仅作为后续可选导出。',
  },
  {
    roleId: 'visual_fidelity_checker',
    label: '视觉保真审查',
    skillName: 'visual-fidelity-check',
    skillSummary: '用 Read 工具逐张查看参考图与生成的高保真产物，按布局/配色/字体/间距逐项对比并给出 PASS/REWORK 结论。',
    responsibilities: ['参考图对比', '保真度评审', '具体差异清单', 'PASS/REWORK 结论'],
    outputs: ['design/visual-fidelity-report.md'],
    checklist: ['先用 Read 工具真实查看每张参考图', '逐项列出布局/配色/字体/间距差异', 'REWORK 时给出可执行的具体修改点', '结论以 PASS 或 REWORK 开头'],
    handoff: '把保真度报告和具体差异清单交回视觉设计师用于下一轮重生成；PASS 后交给技术总监进入架构基线。',
  },
  {
    roleId: 'tech_director',
    label: '技术总监',
    skillName: 'tech-baseline-adr',
    skillSummary: '制定技术框架、架构基线、ADR、任务拆分和质量门禁。',
    responsibilities: ['架构基线', 'ADR', 'OpenSpec 任务', '技术风险'],
    outputs: ['artifacts/architecture-baseline.md', 'artifacts/adr-0001-evolution-pipeline.md', 'openspec/changes/*/tasks.md', 'implementation/agent-task-matrix.md'],
    checklist: ['边界清晰', '任务可并行', '风险有 owner', '每个任务有 maker/checker', 'OpenSpec tasks 可被 Auto Deliver 解析'],
    handoff: '把架构和任务交给开发、QA、安全和运维；开发前等待规划圆桌 PASS。',
  },
  {
    roleId: 'backend_developer',
    label: '后端开发',
    skillName: 'backend-implementation',
    skillSummary: '按 OpenSpec 任务实现后端、数据和接口变更。',
    responsibilities: ['后端实现', '接口契约', '数据迁移', '服务测试'],
    outputs: ['后端代码变更', '接口契约', '服务层测试', '任务 checkbox 更新'],
    checklist: ['实现范围匹配 OpenSpec', '不越权修改生产配置', '失败路径有测试', '迁移需要门禁'],
    handoff: '把实现证据交给 QA 和安全审查，不能自验收。',
  },
  {
    roleId: 'frontend_developer',
    label: '前端开发',
    skillName: 'frontend-implementation',
    skillSummary: '按设计与任务实现 UI、交互、状态和前端测试。',
    responsibilities: ['前端实现', 'UI 状态', '交互联调', '前端测试'],
    outputs: ['前端代码变更', '组件状态', '交互测试', '视觉回归证据'],
    checklist: ['实现贴合设计规格', '响应式/可访问性不退化', 'loading/error/empty 状态完整'],
    handoff: '把 UI 行为、截图或测试证据交给 QA/视觉复核。',
  },
  {
    roleId: 'qa_engineer',
    label: '测试工程师',
    skillName: 'qa-acceptance',
    skillSummary: '补齐测试计划、自动化测试、回归验证和验收证据。',
    responsibilities: ['测试计划', '自动化用例', '回归验证', '验收证据'],
    outputs: ['artifacts/test-plan.md', 'artifacts/test-cases.md', '测试命令', '测试结果', '验收证据'],
    checklist: ['覆盖验收标准', '覆盖 War Room 指令', '覆盖失败/边界场景', '测试命令可复现', '不由开发自验收'],
    handoff: '把测试结果交给运维发布和 Loop Supervisor，失败则退回实现 loop。',
  },
  {
    roleId: 'security_reviewer',
    label: '安全审查',
    skillName: 'security-risk-review',
    skillSummary: '审查鉴权、隐私、支付、配置、迁移和供应链风险。',
    responsibilities: ['安全风险', '隐私合规', '密钥配置', '迁移审查'],
    outputs: ['安全风险清单', '门禁建议', '配置/密钥/隐私审查结论'],
    checklist: ['无密钥泄漏', '权限边界明确', '支付/隐私/迁移需要人工门禁', '依赖风险可接受'],
    handoff: '风险可接受时允许 QA/运维继续；高风险时创建 blocking question。',
  },
  {
    roleId: 'ops_release_manager',
    label: '运维/发布经理',
    skillName: 'ops-release',
    skillSummary: '准备 staging 发布、回滚、环境配置和生产门禁。',
    responsibilities: ['部署计划', '回滚计划', '环境变量', '发布门禁'],
    outputs: ['delivery/deployment-plan.md', '回滚计划', 'staging 验证', '生产发布门禁'],
    checklist: ['staging 可自动化', 'production 必须人工确认', '回滚路径明确', '环境变量不进仓库'],
    handoff: 'staging 通过后进入 human_release_gate，等待用户批准生产发布。',
  },
];

function safeJoin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('evolution_path_outside_project');
  return resolvedPath;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function markdownPreview(content: string): EvolutionArtifactPreview {
  const truncated = content.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS;
  return {
    previewType: 'markdown',
    content: truncated ? content.slice(0, EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) : content,
    language: 'markdown',
    ...(truncated ? { truncated: true } : {}),
  };
}

function formatRunIdTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:.]/g, '');
}

export function buildEvolutionRunId(nowMs: number, sourceSha256: string): string {
  return `evo-${formatRunIdTimestamp(nowMs)}-${sourceSha256.slice(0, 12)}`;
}

export function buildDefaultEvolutionRoles(nowMs: number): EvolutionRoleState[] {
  return EVOLUTION_ROLE_SKILL_DEFINITIONS.map((entry) => ({
    roleId: entry.roleId,
    label: entry.label,
    skillName: entry.skillName,
    skillSummary: entry.skillSummary,
    responsibilities: [...entry.responsibilities],
    status: entry.status ?? 'pending',
    updatedAt: nowMs,
  }));
}

function renderEvolutionRoleSkill(definition: EvolutionRoleSkillDefinition): string {
  return [
    '---',
    `name: ${definition.skillName}`,
    `category: ${EVOLUTION_ROLE_SKILL_CATEGORY}`,
    `description: ${JSON.stringify(definition.skillSummary)}`,
    'enforcement: additive',
    '---',
    '',
    `# ${definition.label}`,
    '',
    '## Mission',
    definition.skillSummary,
    '',
    '## Responsibilities',
    ...definition.responsibilities.map((item) => `- ${item}`),
    '',
    '## Inputs',
    '- 当前 Evolution Run 的 `run.json`。',
    '- 当前阶段已有 artifacts、discussion、evidence 和 blocking questions。',
    '- 用户在 War Room 中发给本角色的最新指令。',
    '',
    '## Required Outputs',
    ...definition.outputs.map((item) => `- ${item}`),
    '',
    '## Quality Checklist',
    ...definition.checklist.map((item) => `- ${item}`),
    '',
    '## Handoff Rule',
    definition.handoff,
    '',
    '## Operating Rules',
    '- 只基于当前 run 的需求、产物和用户补充指令行动。',
    '- 结论必须能落到 artifact、discussion 或 evidence；不要只停留在聊天。',
    '- 发现不可逆、生产、密钥、支付、隐私、迁移风险时，要求进入 human gate。',
  ].join('\n');
}

async function readApprovedEvolutionRoleSkillTemplate(
  projectRoot: string,
  definition: EvolutionRoleSkillDefinition,
): Promise<{ content: string; relativePath: string; sha256: string; bytes: number } | null> {
  const relativePath = `${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/${definition.skillName}.md`;
  const absolutePath = safeJoin(projectRoot, relativePath);
  const raw = await readOptionalUtf8(absolutePath);
  if (raw === null) return null;
  const content = normalizeRoleSkillMarkdown(raw);
  const bytes = Buffer.byteLength(content);
  if (bytes > EVOLUTION_ROLE_SKILL_MAX_BYTES) throw new Error(`approved_role_skill_too_large:${definition.skillName}`);
  const parsed = parseSkillMarkdown(content, {
    name: definition.skillName,
    category: EVOLUTION_ROLE_SKILL_CATEGORY,
  });
  if (parsed.metadata.name !== definition.skillName) {
    throw new Error(`approved_role_skill_name_mismatch:${definition.skillName}:${parsed.metadata.name}`);
  }
  if (parsed.metadata.category !== EVOLUTION_ROLE_SKILL_CATEGORY) {
    throw new Error(`approved_role_skill_category_mismatch:${definition.skillName}:${parsed.metadata.category}`);
  }
  return {
    content,
    relativePath,
    sha256: sha256(Buffer.from(content)),
    bytes,
  };
}

export async function ensureDefaultEvolutionRoleSkillFiles(projectRoot: string, nowMs: number): Promise<EvolutionArtifactRef[]> {
  const artifacts: EvolutionArtifactRef[] = [];
  for (const definition of EVOLUTION_ROLE_SKILL_DEFINITIONS) {
    const skillPath = getProjectSkillEscapeHatchPath({
      projectRoot,
      category: EVOLUTION_ROLE_SKILL_CATEGORY,
      skillName: definition.skillName,
    });
    const approvedTemplate = await readApprovedEvolutionRoleSkillTemplate(projectRoot, definition);
    let seededFromApprovedLibrary = false;
    await mkdir(dirname(skillPath), { recursive: true });
    try {
      await writeFile(skillPath, approvedTemplate?.content ?? renderEvolutionRoleSkill(definition), { encoding: 'utf8', flag: 'wx' });
      seededFromApprovedLibrary = approvedTemplate !== null;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const content = await readFile(skillPath);
    const contentText = content.toString('utf8');
    const relativePath = relative(resolve(projectRoot), skillPath).replace(/\\/g, '/');
    artifacts.push({
      id: `role_skill:${definition.skillName}`,
      kind: 'role_skill',
      path: relativePath,
      title: definition.skillName,
      preview: markdownPreview(contentText),
      roleId: definition.roleId,
      stage: 'detected',
      sha256: sha256(content),
      bytes: content.byteLength,
      createdAt: nowMs,
    });
    if (approvedTemplate && seededFromApprovedLibrary) {
      artifacts.push({
        id: `role_skill_library:${definition.skillName}:${approvedTemplate.sha256.slice(0, 12)}`,
        kind: 'role_skill_library',
        path: approvedTemplate.relativePath,
        title: `Approved library · ${definition.skillName}`,
        preview: markdownPreview(approvedTemplate.content),
        roleId: definition.roleId,
        stage: 'detected',
        sha256: approvedTemplate.sha256,
        bytes: approvedTemplate.bytes,
        createdAt: nowMs,
      });
    }
  }
  return artifacts;
}

function normalizeRoleSkillMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}

export async function updateEvolutionRoleSkillFile(options: {
  projectRoot: string;
  roleId: EvolutionRoleId;
  markdown: string;
  nowMs: number;
}): Promise<UpdateEvolutionRoleSkillFileResult> {
  const definition = EVOLUTION_ROLE_SKILL_DEFINITIONS.find((entry) => entry.roleId === options.roleId);
  if (!definition) throw new Error(`unknown_evolution_role:${options.roleId}`);
  if (typeof options.markdown !== 'string' || options.markdown.trim().length === 0) {
    throw new Error('role_skill_markdown_empty');
  }
  const markdown = normalizeRoleSkillMarkdown(options.markdown);
  const bytes = Buffer.byteLength(markdown);
  if (bytes > EVOLUTION_ROLE_SKILL_MAX_BYTES) throw new Error('role_skill_markdown_too_large');
  if (!markdown.startsWith('---\n')) throw new Error('role_skill_frontmatter_required');
  const parsed = parseSkillMarkdown(markdown, {
    name: definition.skillName,
    category: EVOLUTION_ROLE_SKILL_CATEGORY,
  });
  if (parsed.metadata.name !== definition.skillName) {
    throw new Error(`role_skill_name_mismatch:${parsed.metadata.name}`);
  }
  if (parsed.metadata.category !== EVOLUTION_ROLE_SKILL_CATEGORY) {
    throw new Error(`role_skill_category_mismatch:${parsed.metadata.category}`);
  }

  const skillPath = getProjectSkillEscapeHatchPath({
    projectRoot: options.projectRoot,
    category: EVOLUTION_ROLE_SKILL_CATEGORY,
    skillName: definition.skillName,
  });
  const previousContent = await readOptionalUtf8(skillPath);
  await writeTextAtomic(skillPath, markdown);
  const content = Buffer.from(markdown);
  const relativePath = relative(resolve(options.projectRoot), skillPath).replace(/\\/g, '/');
  return {
    artifact: {
      id: `role_skill:${definition.skillName}`,
      kind: 'role_skill',
      path: relativePath,
      title: definition.skillName,
      preview: markdownPreview(markdown),
      roleId: definition.roleId,
      stage: 'detected',
      sha256: sha256(content),
      bytes: content.byteLength,
      createdAt: options.nowMs,
    },
    previousContent,
    ...(previousContent ? { previousSha256: sha256(Buffer.from(previousContent)) } : {}),
    skillName: definition.skillName,
    relativePath,
  };
}

export function getEvolutionRunPaths(projectRoot: string, runId: string): EvolutionRunPaths {
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) {
    throw new Error(`invalid_evolution_run_id:${validRunId.issues.map((issue) => issue.code).join(',')}`);
  }
  const runDir = join(projectRoot, EVOLUTION_RUN_ROOT_DIR, runId);
  return {
    runDir,
    inputDir: join(runDir, 'input'),
    artifactsDir: join(runDir, 'artifacts'),
    discussionsDir: join(runDir, 'discussions'),
    designDir: join(runDir, 'design'),
    deliveryDir: join(runDir, 'delivery'),
    runJsonPath: join(runDir, 'run.json'),
  };
}

async function ensureEvolutionRunDirectories(paths: EvolutionRunPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.inputDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.discussionsDir, { recursive: true }),
    mkdir(paths.designDir, { recursive: true }),
    mkdir(paths.deliveryDir, { recursive: true }),
  ]);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export async function writeEvolutionRun(projectRoot: string, run: EvolutionRun): Promise<void> {
  const paths = getEvolutionRunPaths(projectRoot, run.runId);
  await writeJsonAtomic(paths.runJsonPath, run);
}

export async function readEvolutionRun(projectRoot: string, runId: string): Promise<EvolutionRun> {
  const paths = getEvolutionRunPaths(projectRoot, runId);
  const raw = await readFile(paths.runJsonPath, 'utf8');
  return JSON.parse(raw) as EvolutionRun;
}

export async function createEvolutionRunFromRequirement(options: CreateEvolutionRunOptions): Promise<EvolutionRun> {
  const validated = validateEvolutionLaunchRequest(options.request);
  if (!validated.ok) {
    throw new Error(`invalid_evolution_launch_request:${validated.issues.map((issue) => issue.code).join(',')}`);
  }

  const request = validated.value;
  const nowMs = options.nowMs ?? Date.now();
  const sourcePath = safeJoin(options.projectRoot, request.sourceRelativePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error('evolution_source_not_file');
  if (sourceStat.size > EVOLUTION_REQUIREMENT_FILE_MAX_BYTES) throw new Error('evolution_source_too_large');
  const sourceBytes = await readFile(sourcePath);
  const sourceSha256 = sha256(sourceBytes);
  if (request.sourceSha256 && request.sourceSha256 !== sourceSha256) throw new Error('evolution_source_sha256_mismatch');

  const runId = options.runId ?? buildEvolutionRunId(nowMs, sourceSha256);
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) throw new Error(`invalid_evolution_run_id:${validRunId.issues.map((issue) => issue.code).join(',')}`);
  const paths = getEvolutionRunPaths(options.projectRoot, runId);
  await ensureEvolutionRunDirectories(paths);

  const sourceFileName = basename(request.sourceRelativePath);
  const inputArtifactPath = `input/${sourceFileName}`;
  await writeFile(join(paths.runDir, inputArtifactPath), sourceBytes);

  const inputArtifact: EvolutionArtifactRef = {
    id: 'input',
    kind: 'input',
    path: inputArtifactPath,
    title: sourceFileName,
    sha256: sourceSha256,
    bytes: sourceBytes.byteLength,
    createdAt: nowMs,
  };
  const roleSkillArtifacts = await ensureDefaultEvolutionRoleSkillFiles(options.projectRoot, nowMs);

  const run: EvolutionRun = {
    runId,
    requestId: request.requestId,
    stage: 'detected',
    ...(request.serverId ? { serverId: request.serverId } : {}),
    sessionName: request.sessionName,
    ...(request.projectName ? { projectName: request.projectName } : {}),
    projectRoot: options.projectRoot,
    source: {
      relativePath: request.sourceRelativePath,
      fileName: sourceFileName,
      requestedBy: request.requestedBy,
      sizeBytes: sourceBytes.byteLength,
      sha256: sourceSha256,
      ingestedAt: nowMs,
    },
    roles: buildDefaultEvolutionRoles(nowMs),
    artifacts: [inputArtifact, ...roleSkillArtifacts],
    scores: [],
    blockingQuestions: [],
    discussion: [{
      id: `discussion-${runId}-detected`,
      kind: 'system',
      stage: 'detected',
      roleId: 'loop_supervisor',
      author: 'Loop Supervisor / 总控',
      text: `已检测到需求文档 ${request.sourceRelativePath}，创建自我进化 run，并准备进入产品/设计/架构 loop。`,
      artifactIds: [inputArtifact.id],
      createdAt: nowMs,
    }],
    roundtables: [],
    roundtableGateMode: request.roundtableGateMode ?? 'planning',
    designTargetSurface: request.designTargetSurface ?? 'auto',
    evidence: [{
      source: 'daemon',
      summary: `Requirement file ingested from ${request.sourceRelativePath}.`,
      artifactId: inputArtifact.id,
      createdAt: nowMs,
    }],
    budget: { ...DEFAULT_EVOLUTION_BUDGET },
    autoDelivery: {
      enabled: request.autoStartImplementation === true,
      presetId: request.autoDeliverPresetId ?? 'standard',
      autoCommitPush: request.autoCommitPush === true,
      requestedBy: request.requestedBy,
    },
    latestMessage: 'Requirement detected and Evolution Run created.',
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  await writeEvolutionRun(options.projectRoot, run);
  return run;
}

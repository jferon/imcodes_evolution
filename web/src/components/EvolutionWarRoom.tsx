import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { uploadFile } from '../api.js';
import type { EvolutionDesignTargetSurface, EvolutionInboxWatcherStatus, EvolutionProjection, EvolutionReferenceAttachmentInput, EvolutionReferenceBriefImportResult, EvolutionRoleId, EvolutionRoundtableGateMode } from '../evolution-pipeline.js';
import {
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  type EvolutionArtifactKind,
} from '@shared/evolution-pipeline-constants.js';
import { EVOLUTION_ROLE_IDS, EVOLUTION_STAGES, isEvolutionActiveProjection, isEvolutionTerminalProjection } from '../evolution-pipeline.js';

interface Props {
  projection: EvolutionProjection | null;
  watchers?: EvolutionInboxWatcherStatus[];
  serverId?: string;
  sessionName?: string | null;
  projectRoot?: string | null;
  launchPending?: boolean;
  scanPending?: boolean;
  stagingCheckPending?: boolean;
  skillUpdatePending?: boolean;
  stopPending?: boolean;
  continuePending?: boolean;
  referenceBriefPending?: boolean;
  lastReferenceBrief?: EvolutionReferenceBriefImportResult | null;
  autoDeliverPending?: boolean;
  lastError?: string | null;
  onClose: () => void;
  onLaunch: (sourceRelativePath: string, options: { autoStartImplementation: boolean; roundtableGateMode: EvolutionRoundtableGateMode; designTargetSurface: EvolutionDesignTargetSurface }) => void;
  onLaunchDemo: (options: { autoStartImplementation: boolean; roundtableGateMode: EvolutionRoundtableGateMode; designTargetSurface: EvolutionDesignTargetSurface }) => void;
  onCreateReferenceBrief: (options: { attachments: EvolutionReferenceAttachmentInput[]; note?: string; taskName?: string }) => string | null;
  onScanInbox: () => void;
  onCheckStaging: () => void;
  onStop: () => void;
  onContinue: (message?: string) => void;
  onStartAutoDeliver?: (changeName: string) => void;
  onSendUserMessage: (text: string, roleId?: EvolutionRoleId) => void;
  onUpdateRoleSkill: (roleId: EvolutionRoleId, markdown: string) => void;
  onApproveRoleSkillCandidate: (roleId: EvolutionRoleId, candidateArtifactId: string, approvalMessage?: string, approverId?: string) => void;
  onRefresh: () => void;
}

type EvolutionRoleFocus = 'all' | EvolutionRoleId;
type EvolutionMessageTarget = 'all' | EvolutionRoleId;
type ManualActionKind = 'launch' | 'demo' | 'scan';

interface ManualAction {
  kind: ManualActionKind;
  label: string;
  sourceRelativePath?: string;
  createdAt: number;
}

function formatTime(ms: number | undefined): string {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

function roleLabel(roleId: string): string {
  return roleId.split('_').map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(' ');
}

function stageIndex(stage: string | undefined): number {
  return Math.max(0, EVOLUTION_STAGES.findIndex((entry) => entry === stage));
}

function stageLabel(stage: string | undefined): string {
  switch (stage) {
    case 'detected': return '已检测需求';
    case 'intake_normalized': return '需求已归一化';
    case 'product_discussion': return '产品讨论中';
    case 'prd_ready': return 'PRD 已生成';
    case 'design_lofi': return '低保真设计';
    case 'design_hifi': return '高保真设计';
    case 'architecture_baseline': return '架构基线';
    case 'tasks_ready': return '任务清单';
    case 'implementation_loop': return '开发 Loop';
    case 'qa_completion': return '测试补齐';
    case 'delivery_ready': return '交付准备';
    case 'deployed_staging': return 'Staging 已部署';
    case 'human_release_gate': return '生产发布门禁';
    case 'deployed_production': return '生产已发布';
    case 'needs_human': return '等待人工处理';
    case 'failed': return '失败';
    case 'stopped': return '已停止';
    default: return '尚未开始';
  }
}

function designTargetLabel(target: string | undefined): string {
  switch (target) {
    case 'mobile': return '移动端/H5';
    case 'pc': return 'PC 端/管理后台';
    case 'both': return '两端都生成';
    case 'auto': return '自动识别';
    default: return '未设置';
  }
}

function stageGuidance(stage: string | undefined): string {
  switch (stage) {
    case 'needs_human': return '查看下方阻塞问题或错误提示，处理后点击“继续/解除阻塞”。';
    case 'human_release_gate': return '已经到生产发布门禁；确认风险后再点击“确认生产门禁”。';
    case 'failed': return '运行失败；查看错误、证据或日志产物后重新启动。';
    case 'stopped': return '运行已停止；需要继续时请重新从需求文档或 Demo 启动。';
    case 'deployed_production': return '运行已完成，生产发布记录已生成。';
    case undefined: return '先确认需求文件真实存在，再点击“从需求文档启动”或“立即扫描 inbox”。';
    default: return '系统正在按需求分析、PRD、设计、架构、任务、开发、测试、交付路径推进。';
  }
}

function isStagingNotConfigured(projection: EvolutionProjection | null | undefined): boolean {
  const text = [
    projection?.stagingDelivery?.status,
    projection?.stagingDelivery?.summary,
    projection?.latestMessage,
  ].filter(Boolean).join(' ');
  return projection?.stagingDelivery?.status === 'not_configured' ||
    /no staging delivery config found|delivery\.json/i.test(text);
}

function userPauseQuestion(projection: EvolutionProjection | null | undefined) {
  if (!projection) return null;
  return projection.blockingQuestions.find((question) => question.id.startsWith(`user-pause-${projection.runId}-`)) ?? null;
}

function isUserPaused(projection: EvolutionProjection | null | undefined): boolean {
  return !!userPauseQuestion(projection);
}

function deliveryConfigPath(projectRoot?: string): string {
  return projectRoot ? `${projectRoot}/.imc/evolution/delivery.json` : '.imc/evolution/delivery.json';
}

function isPausing(projection: EvolutionProjection | null | undefined): boolean {
  return projection?.userPauseState === 'pausing';
}

function projectionStatusDetail(projection: EvolutionProjection, projectRoot?: string): string {
  const pauseQuestion = userPauseQuestion(projection);
  if (pauseQuestion && projection.stage === 'needs_human') {
    return isPausing(projection)
      ? `暂停请求已受理，正在等待当前执行中的步骤到达检查点后停止；暂停前阶段：${stageLabel(pauseQuestion.stage)}。`
      : `任务已暂停，暂停前阶段：${stageLabel(pauseQuestion.stage)}。稍后点击“继续执行”会从该阶段恢复。`;
  }
  if (projection.stage === 'stopped') {
    const reason = projection.terminalReason ?? '当前 Run 已停止。';
    return `${stageGuidance(projection.stage)} 当前原因：${reason}`;
  }
  if (projection.stage === 'delivery_ready' && isStagingNotConfigured(projection)) {
    return `已到交付准备，但没有 staging 自动交付配置；系统不会猜测或执行部署命令。需要自动 staging 时创建 ${deliveryConfigPath(projectRoot)}，否则可以停在人工交付门禁。`;
  }
  return `${stageGuidance(projection.stage)}${projection.latestMessage ? ` 最近消息：${projection.latestMessage}` : ''}`;
}

const REQUIRED_OPENSPEC_LOOP_ARTIFACTS: Array<{ kind: EvolutionArtifactKind; label: string }> = [
  { kind: 'prd', label: 'PRD' },
  { kind: 'acceptance_criteria', label: '验收标准' },
  { kind: 'hifi_spec', label: '高保真说明' },
  { kind: 'hifi_mockup', label: '高保真产物' },
  { kind: 'architecture_baseline', label: '架构基线' },
  { kind: 'openspec_proposal', label: 'OpenSpec proposal' },
  { kind: 'openspec_design', label: 'OpenSpec design' },
  { kind: 'openspec_tasks', label: 'OpenSpec tasks' },
  { kind: 'implementation_task_matrix', label: '实现任务矩阵' },
  { kind: 'test_plan', label: '测试计划' },
  { kind: 'test_cases', label: '测试用例' },
];

const REQUIRED_OPENSPEC_LOOP_ROUNDTABLES: Array<{ id: string; label: string }> = [
  { id: 'product-review', label: '产品圆桌' },
  { id: 'design-review', label: '设计圆桌' },
  { id: 'architecture-review', label: '架构圆桌' },
  { id: 'planning-review', label: '任务规划圆桌' },
];

const EVOLUTION_PROGRESS_STAGES = EVOLUTION_STAGES.filter((stage) => !['needs_human', 'failed', 'stopped'].includes(stage));

function isRoundtablePass(summary: string | undefined): boolean {
  const text = (summary ?? '').trim();
  if (!text) return false;
  if (/(REWORK|BLOCKED|FAIL|FAILED|不允许|不能进入|不能\s*PASS|阻塞|失败|返工|重做)/i.test(text)) return false;
  return /(^|[^\w])PASS([^\w]|$)|结论\s*[：:]\s*PASS|通过|可进入|允许进入/i.test(text);
}

function evaluateOpenSpecLoopGate(
  projection: EvolutionProjection,
  options: { handlerAvailable: boolean; pending: boolean },
): { canStart: boolean; reason: string } {
  if (!options.handlerAvailable) return { canStart: false, reason: '当前页面没有绑定 Auto Deliver 启动器。' };
  if (options.pending) return { canStart: false, reason: 'OpenSpec 开发 Loop 正在启动中。' };
  if (!projection.linkedOpenSpecChange) return { canStart: false, reason: '尚未生成 OpenSpec change。' };
  if (projection.stage === 'needs_human') {
    const blocker = projection.blockingQuestions[0]?.question ?? projection.autoDelivery?.lastError;
    return {
      canStart: false,
      reason: blocker ? `当前处于人工阻塞：${blocker.slice(0, 120)}${blocker.length > 120 ? '…' : ''}` : '当前处于人工阻塞，需先点击“继续/解除阻塞”。',
    };
  }
  if (projection.stage !== 'tasks_ready') {
    return { canStart: false, reason: `当前阶段是“${stageLabel(projection.stage)}”，必须先到“任务清单”。` };
  }
  if (projection.blockingQuestions.length > 0) {
    return { canStart: false, reason: `还有 ${projection.blockingQuestions.length} 个阻塞问题未处理。` };
  }
  if (projection.autoDelivery?.lastError) {
    return { canStart: false, reason: `上次自动开发门禁失败：${projection.autoDelivery.lastError.slice(0, 120)}${projection.autoDelivery.lastError.length > 120 ? '…' : ''}` };
  }

  const artifactKinds = new Set(projection.artifacts.map((artifact) => artifact.kind));
  const missingArtifacts = REQUIRED_OPENSPEC_LOOP_ARTIFACTS
    .filter((required) => !artifactKinds.has(required.kind))
    .map((required) => required.label);
  if (missingArtifacts.length > 0) {
    return { canStart: false, reason: `缺少前置产物：${missingArtifacts.join('、')}。` };
  }

  for (const required of REQUIRED_OPENSPEC_LOOP_ROUNDTABLES) {
    const roundtable = projection.roundtables.find((entry) => entry.id === required.id);
    if (!roundtable) return { canStart: false, reason: `${required.label}还未生成。` };
    if (roundtable.status !== 'complete') return { canStart: false, reason: `${required.label}当前是 ${roundtable.status}，还没有完成。` };
    if (!isRoundtablePass(roundtable.summary)) return { canStart: false, reason: `${required.label}未 PASS，不能进入开发 Loop。` };
  }

  return { canStart: true, reason: '所有前置产物与圆桌门禁已 PASS，可以启动 OpenSpec 开发 Loop。' };
}

function isVisualArtifact(path: string): boolean {
  return /\.(svg|png|jpg|jpeg|webp)$/i.test(path);
}

function artifactPreviewUrl(preview: { previewType: string; content: string }): string {
  if (preview.previewType === 'image') return preview.content;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview.content)}`;
}

function artifactPreviewText(content: string): string {
  return content.length > 1200 ? `${content.slice(0, 1200)}\n…` : content;
}

function displayInboxPath(projectRoot: string | null | undefined): string {
  if (!projectRoot) return EVOLUTION_REQUIREMENT_INBOX_DIR;
  return `${projectRoot.replace(/\/+$/, '')}/${EVOLUTION_REQUIREMENT_INBOX_DIR}`;
}

function defaultLaunchSourcePath(projectRoot: string | null | undefined): string {
  return `${displayInboxPath(projectRoot)}/brief.md`;
}

function normalizeLaunchSourcePath(value: string, projectRoot: string | null | undefined): string {
  const trimmed = value.trim();
  if (!projectRoot) return trimmed;
  const inboxAbsolute = displayInboxPath(projectRoot).replace(/\/+$/, '');
  const normalized = trimmed.replace(/\\/g, '/');
  if (!normalized.startsWith(`${inboxAbsolute}/`)) return trimmed;
  const fileName = normalized.slice(inboxAbsolute.length + 1).replace(/^\/+/, '');
  return fileName ? `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${fileName}` : trimmed;
}

function isReferenceBriefError(error: string | null | undefined): boolean {
  return /reference image brief|reference.*brief|reference.*image|参考图|手稿/i.test(error ?? '');
}

function isReferenceImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|svg)$/i.test(file.name);
}


function stageProgressIndex(stage: string | undefined): number {
  if (!stage) return -1;
  return EVOLUTION_PROGRESS_STAGES.findIndex((entry) => entry === stage);
}

function latestProgressStage(projection: EvolutionProjection): string | undefined {
  if (!['needs_human', 'failed', 'stopped'].includes(projection.stage)) return projection.stage;
  const stageCandidates = [
    ...projection.blockingQuestions.map((question) => question.stage),
    ...projection.roundtables.map((roundtable) => roundtable.stage),
    ...projection.executionTimeline.map((item) => item.stage),
    ...projection.artifacts.map((artifact) => artifact.stage).filter((stage): stage is NonNullable<typeof stage> => !!stage),
    ...projection.roles.map((role) => role.stage).filter((stage): stage is NonNullable<typeof stage> => !!stage),
  ];
  let bestStage: string | undefined;
  let bestIndex = -1;
  for (const stage of stageCandidates) {
    const index = stageProgressIndex(stage);
    if (index > bestIndex) {
      bestStage = stage;
      bestIndex = index;
    }
  }
  return bestStage ?? 'detected';
}

function buildProgressOverview(projection: EvolutionProjection | null): {
  percent: number;
  currentStep: string;
  currentLabel: string;
  nextLabel: string;
  artifactCount: number;
  roundtableComplete: number;
  roundtableTotal: number;
  roundtableRunning: number;
  blockerCount: number;
} {
  if (!projection) {
    return {
      percent: 0,
      currentStep: `0/${EVOLUTION_PROGRESS_STAGES.length}`,
      currentLabel: '等待启动',
      nextLabel: '放入需求文档或点击启动',
      artifactCount: 0,
      roundtableComplete: 0,
      roundtableTotal: 0,
      roundtableRunning: 0,
      blockerCount: 0,
    };
  }
  const effectiveStage = latestProgressStage(projection);
  const pauseQuestion = userPauseQuestion(projection);
  const index = stageProgressIndex(effectiveStage);
  const total = EVOLUTION_PROGRESS_STAGES.length;
  const clampedIndex = Math.max(0, index);
  const percent = projection.stage === 'deployed_production'
    ? 100
    : Math.min(99, Math.max(1, Math.round(((clampedIndex + 1) / total) * 100)));
  const nextStage = pauseQuestion
    ? '点击继续执行恢复'
    : projection.stage === 'needs_human'
    ? '处理阻塞后继续'
    : projection.stage === 'failed'
      ? '修复失败原因后重新启动'
      : projection.stage === 'stopped'
        ? '重新启动新的 Run'
        : projection.stage === 'deployed_production'
          ? '完成'
          : stageLabel(EVOLUTION_PROGRESS_STAGES[Math.min(total - 1, clampedIndex + 1)]);
  const roundtables = projection.roundtables ?? [];
  return {
    percent,
    currentStep: `${clampedIndex + 1}/${total}`,
    currentLabel: pauseQuestion
      ? isPausing(projection)
        ? `暂停中——等待当前步骤停止（原阶段 ${stageLabel(pauseQuestion.stage)}）`
        : `已暂停（原阶段 ${stageLabel(pauseQuestion.stage)}）`
      : projection.stage === 'needs_human'
      ? `等待人工处理（卡在 ${stageLabel(effectiveStage)}）`
      : stageLabel(projection.stage),
    nextLabel: nextStage,
    artifactCount: projection.artifacts.length,
    roundtableComplete: roundtables.filter((roundtable) => roundtable.status === 'complete').length,
    roundtableTotal: roundtables.length,
    roundtableRunning: roundtables.filter((roundtable) => roundtable.status === 'running').length,
    blockerCount: projection.blockingQuestions.length,
  };
}

function operatorGuidance(options: {
  projection: EvolutionProjection | null;
  launchPending: boolean;
  scanPending: boolean;
  lastError?: string | null;
  activeWatcher: EvolutionInboxWatcherStatus | null;
  projectRoot?: string | null;
  inboxPath: string;
  launchPathExample: string;
}): { phase: string; system: string; action: string; next: string } {
  const { projection, launchPending, scanPending, lastError, activeWatcher, projectRoot, inboxPath, launchPathExample } = options;
  if (lastError) {
    if (isReferenceBriefError(lastError)) {
      return {
        phase: '参考图 brief 生成失败',
        system: lastError,
        action: '重新选择参考图后点击“生成 brief”或“生成 brief 并启动”；如果 daemon 刚重启过，需要重新上传图片。',
        next: `成功后会写入 ${inboxPath}/reference-*/brief.md，并自动填入上方启动路径。`,
      };
    }
    return {
      phase: '启动/扫描失败',
      system: lastError,
      action: `检查需求文件是否在 ${inboxPath}/，或把完整文件路径粘贴到输入框后重新点“从需求文档启动”。`,
      next: '修正路径或文件后重新启动；如果只是想体验，可以点“运行内置 Demo”。',
    };
  }
  if (launchPending) {
    return {
      phase: '启动中',
      system: '启动请求已经发给 daemon，正在等 ACK 或第一条执行状态。',
      action: '先等几秒，不需要重复点击。',
      next: '成功后会自动进入“已检测需求”或“产品讨论中”。',
    };
  }
  if (scanPending) {
    return {
      phase: '扫描中',
      system: `正在扫描 ${inboxPath}/ 里的 .md/.txt/.json 文件。`,
      action: '先等扫描结束；如果没有变化，确认目录里有新需求文件。',
      next: '扫描到稳定文件后会自动创建 Run。',
    };
  }
  if (!projection) {
    return activeWatcher
      ? {
          phase: '等待需求文件',
          system: `Watcher 正在监听 ${inboxPath}/。`,
          action: `把一个 .md/.txt/.json 需求文件拷贝到 ${inboxPath}/ 即可。`,
          next: '文件稳定约 2 秒后会自动启动；也可以粘贴完整文件路径后手动启动。',
        }
      : {
          phase: '等待启动',
          system: projectRoot ? `当前没有正在执行的 Run；完整需求目录是 ${inboxPath}/。` : '当前 Session 没有 projectRoot，自动监听不可用。',
          action: projectRoot ? `把需求文件放到完整目录，或粘贴例如 ${launchPathExample} 后点击“从需求文档启动”。` : '请选择带项目目录的 Session，或运行内置 Demo。',
          next: '启动成功后这里会显示当前阶段和 Run ID。',
        };
  }
  if (projection.stage === 'delivery_ready' && isStagingNotConfigured(projection)) {
    return {
      phase: '交付配置待补',
      system: '系统已经到交付准备，但没有 staging 自动交付配置；为了安全不会自动猜测部署命令。',
      action: `如果要自动部署 staging，创建 ${deliveryConfigPath(projectRoot ?? undefined)}；如果只是本地验证，可以不处理或人工交付。`,
      next: '补好配置后点击“检查 Staging 配置”；通过后再进入 staging/生产发布门禁。',
    };
  }
  const pauseQuestion = userPauseQuestion(projection);
  if (projection.stage === 'needs_human' && pauseQuestion) {
    if (isPausing(projection)) {
      return {
        phase: '暂停中',
        system: `暂停请求已受理；当前执行中的步骤会运行到下一个检查点后停止，不会再推进后续阶段或自动交付。暂停前阶段是 ${stageLabel(pauseQuestion.stage)}。`,
        action: '无需操作；稍候片刻状态会变为“已暂停”。也可以直接点击“继续执行”撤销暂停。',
        next: `完全停止后，点击“继续执行”会回到 ${stageLabel(pauseQuestion.stage)} 并重新触发后续自我进化流程。`,
      };
    }
    return {
      phase: '已暂停',
      system: `任务已按你的要求暂停；暂停前阶段是 ${stageLabel(pauseQuestion.stage)}，不会继续推进后续阶段或自动交付。`,
      action: '换个时间回来后，直接点击“继续执行”。',
      next: `系统会回到 ${stageLabel(pauseQuestion.stage)} 并重新触发后续自我进化流程。`,
    };
  }
  if (projection.stage === 'needs_human') {
    return {
      phase: '等待你处理',
      system: projection.latestMessage ?? '系统遇到需要人工判断的阻塞点。',
      action: '查看下方“阻塞问题”，处理后点击“继续/解除阻塞”。',
      next: '解除后系统会继续进入后续 PRD、设计、架构、任务或交付阶段。',
    };
  }
  if (projection.stage === 'human_release_gate') {
    return {
      phase: '等待你确认发布门禁',
      system: '系统已经走到生产发布前的人工门禁。',
      action: '如果只是本地测试，可以先不确认；要记录通过门禁时点击“确认生产门禁”。',
      next: '确认后只记录生产门禁，不会在 smoke 里真正执行生产命令。',
    };
  }
  if (projection.stage === 'failed') {
    return {
      phase: '运行失败',
      system: projection.terminalReason ?? projection.latestMessage ?? '当前 Run 已失败。',
      action: '查看错误、证据、日志产物，修正后重新从需求文档启动。',
      next: '重新启动会创建新的 Run。',
    };
  }
  if (projection.stage === 'stopped') {
    return {
      phase: '已停止',
      system: projection.terminalReason ?? '当前 Run 已停止，不会继续消耗资源。',
      action: isStagingNotConfigured(projection)
        ? `这不是还在卡住；这是已停止的旧 Run。若下次要自动 staging，请先创建 ${deliveryConfigPath(projectRoot ?? undefined)}。`
        : '这不是还在卡住；如果要接着做，请点“从当前需求重新启动”。',
      next: '会用当前 Run 的同一个需求文件创建新的 Run；旧 Run 只保留为历史记录。',
    };
  }
  if (projection.stage === 'deployed_production') {
    return {
      phase: '已完成',
      system: 'Run 已到生产发布记录阶段。',
      action: '通常不需要你继续操作，可查看产物和证据。',
      next: '有新需求时再放入 inbox 或重新启动。',
    };
  }
  return {
    phase: stageLabel(projection.stage),
    system: projection.latestMessage ?? stageGuidance(projection.stage),
    action: '暂时不用操作；如果需求有变化，可以在“与角色交流”里给全部角色或单个角色追加指令。',
    next: '系统会继续推进到下一阶段，遇到门禁或阻塞时这里会提示你处理。',
  };
}

function triggerLabel(trigger: string | undefined): string {
  switch (trigger) {
    case 'watcher': return 'watcher 自动触发';
    case 'api': return 'API 启动';
    case 'cron': return '定时触发';
    case 'user': return '手动启动';
    case 'demo': return '内置 Demo';
    default: return '等待需求';
  }
}

function loopModeLabel(mode: string): string {
  switch (mode) {
    case 'auto_implementation': return '自动开发 loop';
    case 'planning_only': return '规划优先';
    case 'human_gate': return '人工门禁';
    case 'terminal': return '已结束';
    default: return mode;
  }
}

function loopSignalLabel(status: string): string {
  switch (status) {
    case 'complete': return '完成';
    case 'ready': return '就绪';
    case 'running': return '运行中';
    case 'blocked': return '阻塞';
    case 'missing': return '待生成';
    default: return status;
  }
}

export function EvolutionWarRoomPanel({
  projection,
  watchers = [],
  serverId,
  sessionName,
  projectRoot,
  launchPending = false,
  scanPending = false,
  stagingCheckPending = false,
  skillUpdatePending = false,
  stopPending = false,
  continuePending = false,
  referenceBriefPending = false,
  lastReferenceBrief = null,
  autoDeliverPending = false,
  lastError,
  onClose,
  onLaunch,
  onLaunchDemo,
  onCreateReferenceBrief,
  onScanInbox,
  onCheckStaging,
  onStop,
  onContinue,
  onStartAutoDeliver,
  onSendUserMessage,
  onUpdateRoleSkill,
  onApproveRoleSkillCandidate,
  onRefresh,
}: Props) {
  const [sourcePath, setSourcePath] = useState(() => defaultLaunchSourcePath(projectRoot));
  const [autoStartImplementation, setAutoStartImplementation] = useState(true);
  const [roundtableGateMode, setRoundtableGateMode] = useState<EvolutionRoundtableGateMode>('planning');
  const [designTargetSurface, setDesignTargetSurface] = useState<EvolutionDesignTargetSurface>('auto');
  const [message, setMessage] = useState('');
  const [selectedTarget, setSelectedTarget] = useState<EvolutionMessageTarget>('all');
  const [focusRole, setFocusRole] = useState<EvolutionRoleFocus>('all');
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillDrafts, setSkillDrafts] = useState<Record<string, string>>({});
  const [skillApproverId, setSkillApproverId] = useState('war-room-user');
  const [lastManualAction, setLastManualAction] = useState<ManualAction | null>(null);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [referenceNote, setReferenceNote] = useState('');
  const [referenceStatus, setReferenceStatus] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [referenceProgress, setReferenceProgress] = useState(0);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [pendingReferenceLaunchRequestId, setPendingReferenceLaunchRequestId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const active = isEvolutionActiveProjection(projection);
  const terminal = isEvolutionTerminalProjection(projection);
  const paused = isUserPaused(projection);
  const canPause = active && !paused && projection?.stage !== 'needs_human' && projection?.stage !== 'human_release_gate';
  const currentStageIndex = stageIndex(projection?.stage);
  const visibleStages = useMemo(() => EVOLUTION_STAGES.filter((stage) => !['failed', 'stopped'].includes(stage)), []);
  const discussion = projection?.discussion ?? [];
  const executionTimeline = projection?.executionTimeline ?? [];
  const liveEvents = projection?.liveEvents ?? [];
  const defaultInboxPath = useMemo(() => displayInboxPath(projectRoot), [projectRoot]);
  const launchPathExample = useMemo(() => defaultLaunchSourcePath(projectRoot), [projectRoot]);
  useEffect(() => {
    setSourcePath((current) => {
      const oldRelativeDefault = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`;
      if (!current.trim() || current === oldRelativeDefault || current.endsWith('/.imcodes/inbox/requirements/brief.md')) {
        return defaultLaunchSourcePath(projectRoot);
      }
      return current;
    });
  }, [projectRoot]);
  const activeWatcher = useMemo(() => (
    watchers.find((watcher) => (
      watcher.active
      && (!sessionName || watcher.sessionName === sessionName)
      && (!projectRoot || watcher.projectRoot === projectRoot)
    )) ?? null
  ), [projectRoot, sessionName, watchers]);
  const inboxPath = activeWatcher?.inboxAbsolutePath ?? defaultInboxPath;
  const trigger = projection?.source.requestedBy
    ?? projection?.autoDelivery?.requestedBy
    ?? (projection?.requestId.startsWith('watcher-') ? 'watcher' : undefined);
  const launchSourceLabel = triggerLabel(trigger);
  const isProductionGate = projection?.stage === 'human_release_gate';
  const focusedRole = focusRole === 'all' ? null : projection?.roles.find((role) => role.roleId === focusRole) ?? null;
  const filteredExecutionTimeline = useMemo(() => (
    focusRole === 'all' ? executionTimeline : executionTimeline.filter((item) => item.roleId === focusRole)
  ), [executionTimeline, focusRole]);
  const filteredLiveEvents = useMemo(() => (
    focusRole === 'all' ? liveEvents : liveEvents.filter((item) => item.roleId === focusRole)
  ), [focusRole, liveEvents]);
  const filteredDiscussion = useMemo(() => (
    focusRole === 'all' ? discussion : discussion.filter((entry) => entry.roleId === focusRole)
  ), [discussion, focusRole]);
  const filteredRoundtables = useMemo(() => (
    focusRole === 'all' ? projection?.roundtables ?? [] : (projection?.roundtables ?? []).filter((roundtable) => roundtable.roles.includes(focusRole))
  ), [focusRole, projection?.roundtables]);
  const filteredArtifacts = useMemo(() => (
    focusRole === 'all' ? projection?.artifacts ?? [] : (projection?.artifacts ?? []).filter((artifact) => artifact.roleId === focusRole)
  ), [focusRole, projection?.artifacts]);
  const filteredRoleSkillArtifacts = useMemo(() => (
    focusRole === 'all'
      ? (projection?.artifacts ?? []).filter((artifact) => artifact.kind === 'role_skill')
      : (projection?.artifacts ?? []).filter((artifact) => artifact.kind === 'role_skill' && artifact.roleId === focusRole)
  ), [focusRole, projection?.artifacts]);
  const filteredRoleSkillCandidateArtifacts = useMemo(() => (
    focusRole === 'all'
      ? (projection?.artifacts ?? []).filter((artifact) => artifact.kind === 'role_skill_release_candidate')
      : (projection?.artifacts ?? []).filter((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === focusRole)
  ), [focusRole, projection?.artifacts]);
  const filteredRoleSkillLibraryArtifacts = useMemo(() => (
    focusRole === 'all'
      ? (projection?.artifacts ?? []).filter((artifact) => artifact.kind === 'role_skill_library')
      : (projection?.artifacts ?? []).filter((artifact) => artifact.kind === 'role_skill_library' && artifact.roleId === focusRole)
  ), [focusRole, projection?.artifacts]);
  const focusRoleLabel = focusedRole?.label ?? (focusRole === 'all' ? '全部角色' : roleLabel(focusRole));
  const statusTone = lastError
    ? 'error'
      : launchPending || scanPending
        ? 'pending'
      : projection
        ? terminal ? 'complete' : paused ? 'pending' : active ? 'running' : 'ready'
        : lastManualAction ? 'pending' : 'idle';
  const statusTitle = lastError
    ? '启动或扫描失败'
    : launchPending
      ? '启动请求已发送'
        : scanPending
          ? '正在扫描需求入口'
        : projection
          ? isUserPaused(projection) ? '当前执行到：已暂停' : `当前执行到：${stageLabel(projection.stage)}`
          : lastManualAction
            ? `${lastManualAction.label}已发出，等待状态回传`
            : '等待启动';
  const statusDetail = lastError
    ? isReferenceBriefError(lastError)
      ? `${lastError}。这是参考图上传/brief 生成链路没有收到 daemon ACK，不是需求文件路径问题。请重新上传参考图再生成；如果刚重启 daemon，旧上传临时句柄会失效。`
      : `${lastError}。请确认文件存在于完整目录 ${inboxPath}/；手动启动可粘贴完整文件路径，例如 ${launchPathExample}。`
    : launchPending
      ? '正在等待 daemon 返回 ACK 或第一条 Projection；正常会很快进入“已检测需求/产品讨论中”。'
        : scanPending
          ? '正在扫描 inbox 中已稳定的 .md/.txt/.json 文件；若没有新运行，通常是目录里没有符合条件的新需求文件。'
        : projection
          ? projectionStatusDetail(projection, projectRoot ?? undefined)
          : lastManualAction
            ? '如果这里长时间没有变成具体阶段，请检查 daemon 是否在线、当前 Session 是否有 projectRoot、需求文件路径是否真实存在。'
            : `先确认需求文件真实存在于 ${inboxPath}/，再点击“从需求文档启动”或“立即扫描 inbox”。`;
  const statusFacts = [
    projection?.runId ? `Run: ${projection.runId}` : null,
    projection?.stage ? `阶段: ${stageLabel(projection.stage)}（${projection.stage}）` : null,
    projection?.designTargetSurface ? `高保真目标端: ${designTargetLabel(projection.designTargetSurface)}` : null,
    projection?.source.relativePath ? `需求: ${projection.source.relativePath}` : lastManualAction?.sourceRelativePath ? `目标: ${lastManualAction.sourceRelativePath}` : null,
    lastManualAction ? `操作时间: ${formatTime(lastManualAction.createdAt)}` : null,
    activeWatcher ? 'Watcher: active' : projectRoot ? 'Watcher: inactive' : 'Watcher: unavailable',
  ].filter((item): item is string => !!item);
  const guidance = operatorGuidance({
    projection,
    launchPending,
    scanPending,
    lastError,
    activeWatcher,
    projectRoot,
    inboxPath,
    launchPathExample,
  });
  const progressOverview = useMemo(() => buildProgressOverview(projection), [projection]);
  const currentStep = projection ? progressOverview.currentStep : '未开始';
  const openSpecLoopGate = projection
    ? evaluateOpenSpecLoopGate(projection, { handlerAvailable: !!onStartAutoDeliver, pending: autoDeliverPending })
    : null;
  const canImportReferenceBrief = !!serverId && !!projectRoot && referenceFiles.length > 0 && !referenceBriefPending && !referenceUploading;

  useEffect(() => {
    if (!lastReferenceBrief) return;
    setSourcePath(lastReferenceBrief.sourceRelativePath);
    setReferenceStatus(`已生成 ${lastReferenceBrief.sourceRelativePath}（${lastReferenceBrief.imageCount} 张参考图）。`);
  }, [lastReferenceBrief]);

  useEffect(() => {
    if (!lastReferenceBrief || lastReferenceBrief.requestId !== pendingReferenceLaunchRequestId) return;
    setLastManualAction({
      kind: 'launch',
      label: '参考图生成 brief 并启动',
      sourceRelativePath: lastReferenceBrief.sourceRelativePath,
      createdAt: Date.now(),
    });
    onLaunch(lastReferenceBrief.sourceRelativePath, { autoStartImplementation, roundtableGateMode, designTargetSurface });
    setPendingReferenceLaunchRequestId(null);
  }, [autoStartImplementation, designTargetSurface, lastReferenceBrief, onLaunch, pendingReferenceLaunchRequestId, roundtableGateMode]);

  const handleReferenceFilesChange = (event: Event) => {
    const files = Array.from((event.currentTarget as HTMLInputElement).files ?? [])
      .filter(isReferenceImageFile)
      .slice(0, 24);
    setReferenceFiles(files);
    setReferenceError(null);
    setReferenceStatus(files.length > 0 ? `已选择 ${files.length} 张参考图。` : null);
    setReferenceProgress(0);
  };

  const handleCreateReferenceBrief = async (autoLaunch: boolean) => {
    if (!serverId) {
      setReferenceError('当前没有 serverId，不能上传参考图。');
      return;
    }
    if (!projectRoot) {
      setReferenceError('当前 Session 没有 projectRoot，不能写入项目需求目录。');
      return;
    }
    if (referenceFiles.length === 0) {
      setReferenceError('请先选择至少 1 张参考图或手稿。');
      return;
    }
    setReferenceError(null);
    setReferenceStatus('正在上传参考图…');
    setReferenceProgress(0);
    setReferenceUploading(true);
    try {
      const attachments: EvolutionReferenceAttachmentInput[] = [];
      for (let index = 0; index < referenceFiles.length; index += 1) {
        const file = referenceFiles[index];
        const uploadResult = await uploadFile(serverId, file, (pct) => {
          setReferenceProgress(Math.round(((index + (pct / 100)) / referenceFiles.length) * 100));
        });
        attachments.push({
          attachmentId: uploadResult.attachment.id,
          originalName: uploadResult.attachment.originalName ?? file.name,
          mime: uploadResult.attachment.mime ?? file.type,
          size: uploadResult.attachment.size ?? file.size,
        });
      }
      setReferenceStatus('参考图已上传，正在生成 brief.md…');
      const requestId = onCreateReferenceBrief({
        attachments,
        note: referenceNote,
        taskName: referenceNote.trim() ? referenceNote.trim().slice(0, 48) : 'reference-ui-brief',
      });
      if (!requestId) {
        setReferenceError('生成 brief 请求未发出，请确认 daemon 已连接。');
        return;
      }
      if (autoLaunch) setPendingReferenceLaunchRequestId(requestId);
      setReferenceStatus(autoLaunch ? 'brief.md 生成后会自动启动自我进化。' : 'brief.md 生成中，完成后会自动填入上方启动路径。');
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : String(error));
      setPendingReferenceLaunchRequestId(null);
    } finally {
      setReferenceUploading(false);
    }
  };

  const handleLaunch = () => {
    const trimmed = sourcePath.trim();
    const sourceRelativePath = normalizeLaunchSourcePath(trimmed, projectRoot);
    setLastManualAction({
      kind: 'launch',
      label: '从需求文档启动',
      sourceRelativePath: trimmed,
      createdAt: Date.now(),
    });
    onLaunch(sourceRelativePath, { autoStartImplementation, roundtableGateMode, designTargetSurface });
  };

  const handleRestartFromCurrentRequirement = () => {
    if (!projection?.source.relativePath) return;
    setSourcePath(projection.source.relativePath);
    setLastManualAction({
      kind: 'launch',
      label: '从当前需求重新启动',
      sourceRelativePath: projection.source.relativePath,
      createdAt: Date.now(),
    });
    onLaunch(projection.source.relativePath, { autoStartImplementation, roundtableGateMode, designTargetSurface });
  };

  const handleLaunchDemo = () => {
    setLastManualAction({ kind: 'demo', label: '运行内置 Demo', createdAt: Date.now() });
    onLaunchDemo({ autoStartImplementation, roundtableGateMode, designTargetSurface });
  };

  const handleScanInbox = () => {
    setLastManualAction({ kind: 'scan', label: '立即扫描 inbox', createdAt: Date.now() });
    onScanInbox();
  };

  return (
    <div class="evolution-war-room-overlay" onClick={onClose}>
      <div class="evolution-war-room-panel" onClick={(event) => event.stopPropagation()}>
        <div class="evolution-war-room-header">
          <div>
            <div class="evolution-war-room-kicker">Evolution Factory</div>
            <h2>自我进化 War Room</h2>
            <div class="evolution-war-room-meta">{sessionName ?? 'No session'}{projectRoot ? ` · ${projectRoot}` : ''}</div>
          </div>
          <button class="fb-close" onClick={onClose}>✕</button>
        </div>

        <div class={`evolution-war-room-status status-${statusTone}`} role="status" aria-live="polite" data-testid="evolution-run-status">
          <div class="evolution-war-room-status-main">
            <span class="evolution-war-room-status-dot" />
            <div>
              <strong>{statusTitle}</strong>
              <p>{statusDetail}</p>
            </div>
          </div>
          <div class="evolution-war-room-status-facts">
            {statusFacts.map((fact) => <span key={fact}>{fact}</span>)}
          </div>
          <div class="evolution-operator-guide" data-testid="evolution-operator-guide">
            <div>
              <span>当前环节</span>
              <strong>{currentStep} · {guidance.phase}</strong>
            </div>
            <div>
              <span>系统正在做</span>
              <strong>{guidance.system}</strong>
            </div>
            <div>
              <span>你需要做</span>
              <strong>{guidance.action}</strong>
            </div>
            <div>
              <span>下一步</span>
              <strong>{guidance.next}</strong>
            </div>
          </div>
        </div>

        <div class="evolution-war-room-launch">
          <input
            value={sourcePath}
            onInput={(event) => setSourcePath((event.currentTarget as HTMLInputElement).value)}
            placeholder={launchPathExample}
          />
          <button class="btn btn-primary" disabled={launchPending || !sourcePath.trim()} onClick={handleLaunch}>
            {launchPending ? '启动中…' : '从需求文档启动'}
          </button>
          <button class="btn btn-secondary" disabled={launchPending || !sessionName} onClick={handleLaunchDemo}>
            {launchPending ? '启动中…' : '运行内置 Demo'}
          </button>
          <button class="btn btn-secondary" disabled={scanPending || !activeWatcher} onClick={handleScanInbox}>
            {scanPending ? '扫描中…' : '立即扫描 inbox'}
          </button>
          <button class="btn btn-secondary" onClick={onRefresh}>刷新</button>
        </div>
        <div class="evolution-reference-import" data-testid="evolution-reference-import">
          <div class="evolution-reference-copy">
            <strong>参考图/手稿生成需求</strong>
            <span>上传页面截图、手稿或竞品图，系统会写入项目内 <code>.imcodes/inbox/requirements/&lt;任务&gt;/brief.md</code>，并把图片作为相对引用，后续 Taste Skill 会先对齐原项目风格。</span>
          </div>
          <div class="evolution-reference-controls">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              multiple
              onChange={handleReferenceFilesChange}
            />
            <textarea
              value={referenceNote}
              onInput={(event) => setReferenceNote((event.currentTarget as HTMLTextAreaElement).value)}
              placeholder="可选：补充业务目标、页面名称、必须保留的品牌/交互约束…"
            />
            <div class="evolution-reference-actions">
              <button
                type="button"
                class="btn btn-secondary"
                disabled={referenceBriefPending || referenceUploading}
                onClick={() => {
                  setReferenceFiles([]);
                  setReferenceNote('');
                  setReferenceProgress(0);
                  setReferenceStatus(null);
                  setReferenceError(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
              >
                清空
              </button>
              <button type="button" class="btn btn-secondary" disabled={!canImportReferenceBrief} onClick={() => void handleCreateReferenceBrief(false)}>
                {referenceUploading ? '上传中…' : referenceBriefPending ? '生成中…' : '生成 brief'}
              </button>
              <button type="button" class="btn btn-primary" disabled={!canImportReferenceBrief} onClick={() => void handleCreateReferenceBrief(true)}>
                {referenceUploading ? '上传中…' : referenceBriefPending ? '生成中…' : '生成 brief 并启动'}
              </button>
            </div>
          </div>
          <div class="evolution-reference-meta">
            <span class={serverId && projectRoot ? 'watcher-active' : 'watcher-inactive'}>
              {serverId && projectRoot ? '可上传并写入项目' : '需要已连接 daemon 且 Session 有 projectRoot'}
            </span>
            <span>{referenceFiles.length > 0 ? `${referenceFiles.length} 张图` : '未选择图片'}</span>
            {referenceProgress > 0 && referenceProgress < 100 && <span>上传 {referenceProgress}%</span>}
            {lastReferenceBrief?.sourceRelativePath && <span>最近 brief：{lastReferenceBrief.sourceRelativePath}</span>}
          </div>
          {referenceFiles.length > 0 && (
            <div class="evolution-reference-file-list">
              {referenceFiles.map((file) => (
                <span key={`${file.name}-${file.size}`}>{file.name} · {Math.round(file.size / 1024)}KB</span>
              ))}
            </div>
          )}
          {referenceStatus && <div class="evolution-reference-status">{referenceStatus}</div>}
          {referenceError && <div class="evolution-reference-error">{referenceError}</div>}
        </div>
        <label class="evolution-war-room-toggle">
          <input
            type="checkbox"
            checked={autoStartImplementation}
            onChange={(event) => setAutoStartImplementation((event.currentTarget as HTMLInputElement).checked)}
          />
          自动启动开发 Loop（生成 OpenSpec 任务后触发 Auto Deliver；生产仍需人工门禁）
        </label>
        <label class="evolution-war-room-toggle">
          <input
            type="checkbox"
            checked={roundtableGateMode === 'strict'}
            onChange={(event) => setRoundtableGateMode((event.currentTarget as HTMLInputElement).checked ? 'strict' : 'planning')}
          />
          严格圆桌门禁（产品/设计/架构圆桌也必须 PASS 才继续）
        </label>
        <label class="evolution-war-room-field evolution-design-target-field">
          <span>高保真目标端</span>
          <select
            aria-label="高保真目标端"
            value={designTargetSurface}
            onInput={(event) => setDesignTargetSurface((event.currentTarget as HTMLSelectElement).value as EvolutionDesignTargetSurface)}
            onChange={(event) => setDesignTargetSurface((event.currentTarget as HTMLSelectElement).value as EvolutionDesignTargetSurface)}
          >
            <option value="auto">自动识别（按需求文档）</option>
            <option value="mobile">移动端 / H5</option>
            <option value="pc">PC 端 / 管理后台</option>
            <option value="both">两端都生成</option>
          </select>
          <small>会影响 PRD、低保真、高保真 screen pack 和 taste-skill 提示词；参考图会逐张映射到对应端/页面状态。</small>
        </label>

        <div class="evolution-war-room-inbox">
          <div>
            <strong>需求入口 / Inbox Watcher</strong>
            <span>
              {projectRoot
                ? '把 .md/.txt/.json 放进目录，文件稳定约 2 秒后 daemon 会自动触发自我进化。'
                : '当前会话缺少 projectRoot，自动扫描不可用；仍可手动填写项目内相对路径启动。'}
            </span>
          </div>
          <code title={inboxPath}>{inboxPath}</code>
          <div class="evolution-war-room-inbox-meta">
            <span>本次来源：{launchSourceLabel}</span>
            {projection?.source.relativePath && <span>需求文档：{projection.source.relativePath}</span>}
            <span class={activeWatcher ? 'watcher-active' : 'watcher-inactive'}>
              Watcher：{activeWatcher ? 'active' : projectRoot ? 'inactive' : 'unavailable'}
            </span>
            {activeWatcher && <span>扫描：{Math.round(activeWatcher.intervalMs / 1000)}s</span>}
            {activeWatcher && <span>稳定窗口：{Math.round(activeWatcher.stableMs / 1000)}s</span>}
            {activeWatcher && <span>启动：{formatTime(activeWatcher.startedAt)}</span>}
          </div>
        </div>

        {lastError && <div class="evolution-war-room-error">{lastError}</div>}

        {projection ? (
          <>
            <div class="evolution-war-room-summary">
              <div><span>Run</span><strong>{projection.runId}</strong></div>
              <div><span>阶段</span><strong>{stageLabel(projection.stage)}</strong></div>
              <div><span>圆桌门禁</span><strong>{projection.roundtableGateMode}</strong></div>
              <div><span>Staging</span><strong>{projection.stagingDelivery?.status ?? '—'}</strong></div>
              <div><span>状态</span><strong>{terminal ? 'terminal' : paused ? 'paused' : active ? 'active' : 'idle'}</strong></div>
              <div><span>来源</span><strong>{launchSourceLabel}</strong></div>
              <div><span>更新</span><strong>{formatTime(projection.updatedAt)}</strong></div>
            </div>

            <div class={`evolution-war-room-progress status-${projection.stage}`} data-testid="evolution-progress-overview">
              <div class="evolution-war-room-progress-head">
                <div>
                  <span>总进度</span>
                  <strong>{progressOverview.percent}%</strong>
                </div>
                <div>
                  <span>当前</span>
                  <strong>{progressOverview.currentStep} · {progressOverview.currentLabel}</strong>
                </div>
                <div>
                  <span>下一步</span>
                  <strong>{progressOverview.nextLabel}</strong>
                </div>
              </div>
              <div
                class="evolution-war-room-progress-bar"
                role="progressbar"
                aria-label="自我进化总进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressOverview.percent}
              >
                <i style={{ width: `${progressOverview.percent}%` }} />
              </div>
              <div class="evolution-war-room-progress-meta">
                <span>产物 {progressOverview.artifactCount}</span>
                <span>圆桌 {progressOverview.roundtableComplete}/{progressOverview.roundtableTotal}</span>
                {progressOverview.roundtableRunning > 0 && <span>运行中圆桌 {progressOverview.roundtableRunning}</span>}
                <span class={progressOverview.blockerCount > 0 ? 'is-blocked' : 'is-clear'}>阻塞 {progressOverview.blockerCount}</span>
              </div>
            </div>

            <div class="evolution-war-room-stages">
              {visibleStages.map((stage, index) => (
                <div key={stage} class={`evolution-stage-pill${index < currentStageIndex ? ' done' : ''}${stage === projection.stage ? ' current' : ''}`}>
                  {index + 1}. {stageLabel(stage)} <small>{stage}</small>
                </div>
              ))}
            </div>

            <div class="evolution-war-room-actions">
              <button class="btn btn-secondary" disabled={!canPause || stopPending} onClick={onStop}>{stopPending ? '暂停中…' : '暂停'}</button>
              <button class="btn btn-secondary" disabled={terminal || continuePending} onClick={() => onContinue(message)}>
                {continuePending ? '继续中…' : isProductionGate ? '确认生产门禁' : paused ? '继续执行' : '继续/解除阻塞'}
              </button>
              {projection.stage === 'stopped' && projection.source.relativePath && (
                <button class="btn btn-primary" disabled={launchPending} onClick={handleRestartFromCurrentRequirement}>
                  {launchPending ? '启动中…' : '从当前需求重新启动'}
                </button>
              )}
              {projection.linkedOpenSpecChange && (
                <div class="evolution-openspec-loop-action">
                  <button
                    class="btn btn-primary"
                    disabled={!openSpecLoopGate?.canStart}
                    title={openSpecLoopGate?.reason}
                    onClick={() => {
                      if (!openSpecLoopGate?.canStart) return;
                      onStartAutoDeliver?.(projection.linkedOpenSpecChange!);
                    }}
                  >
                    {autoDeliverPending ? '开发 Loop 启动中…' : '启动 OpenSpec 开发 Loop'}
                  </button>
                  <span class={openSpecLoopGate?.canStart ? 'gate-pass' : 'gate-blocked'}>
                    {openSpecLoopGate?.reason}
                  </span>
                </div>
              )}
              <button class="btn btn-secondary" disabled={stagingCheckPending} onClick={onCheckStaging}>
                {stagingCheckPending ? '检查中…' : '检查 Staging 配置'}
              </button>
            </div>

            <section class="evolution-loop-control">
              <div class="evolution-section-heading">
                <h3>Loop Control · loop-engineering</h3>
                <span>{projection.loopControl.source}</span>
              </div>
              <div class="evolution-loop-control-top">
                <div class="evolution-loop-score">
                  <span>Readiness</span>
                  <strong>{projection.loopControl.readinessScore}%</strong>
                  <div class="evolution-loop-readiness-bar">
                    <i style={{ width: `${Math.min(100, Math.max(0, projection.loopControl.readinessScore))}%` }} />
                  </div>
                </div>
                <div class="evolution-loop-facts">
                  <div><span>模式</span><strong>{loopModeLabel(projection.loopControl.mode)}</strong></div>
                  <div><span>可自动继续</span><strong>{projection.loopControl.canAutonomouslyContinue ? 'yes' : 'no'}</strong></div>
                  <div><span>当前 Gate</span><strong title={projection.loopControl.currentGate}>{projection.loopControl.currentGate}</strong></div>
                </div>
              </div>
              <div class="evolution-loop-budget">
                <span>角色回合 {projection.loopControl.usage.roleTurns}/{projection.loopControl.budget.maxRoleTurns}</span>
                <span>耗时 {projection.loopControl.usage.elapsedMinutes}/{projection.loopControl.budget.maxElapsedMinutes}m</span>
                <span>实现尝试 {projection.loopControl.usage.implementationAttempts}/{projection.loopControl.budget.maxImplementationAttempts}</span>
                <span>产物 {projection.loopControl.usage.artifactCount}</span>
                <span>证据 {projection.loopControl.usage.evidenceCount}</span>
                <span>讨论 {projection.loopControl.usage.discussionCount}</span>
              </div>
              <div class="evolution-loop-signals">
                {projection.loopControl.signals.map((signal) => (
                  <div key={signal.id} class={`evolution-loop-signal status-${signal.status}`}>
                    <div class="evolution-loop-signal-head">
                      <strong>{signal.label}</strong>
                      <span>{loopSignalLabel(signal.status)}</span>
                    </div>
                    <p>{signal.detail}</p>
                    {signal.artifactIds && signal.artifactIds.length > 0 && (
                      <div class="evolution-discussion-artifacts">
                        {signal.artifactIds.slice(0, 4).map((artifactId) => <code key={artifactId}>{artifactId}</code>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <div class="evolution-role-focus-bar">
              <button
                type="button"
                class={focusRole === 'all' ? 'active' : ''}
                onClick={() => {
                  setFocusRole('all');
                  setSelectedTarget('all');
                }}
              >
                全部角色
              </button>
              {projection.roles.map((role) => (
                <button
                  key={role.roleId}
                  type="button"
                  class={focusRole === role.roleId ? 'active' : ''}
                  onClick={() => {
                    setFocusRole(role.roleId);
                    setSelectedTarget(role.roleId);
                  }}
                >
                  {role.label ?? roleLabel(role.roleId)}
                  <span>{role.status}</span>
                </button>
              ))}
            </div>

            <div class="evolution-war-room-grid">
              <section>
                <h3>角色状态 · {focusRoleLabel}</h3>
                <div class="evolution-role-list">
                  {projection.roles.map((role) => (
                    <button
                      key={role.roleId}
                      type="button"
                      class={`evolution-role-card status-${role.status}${focusRole === role.roleId ? ' focused' : ''}`}
                      onClick={() => {
                        setFocusRole(role.roleId);
                        setSelectedTarget(role.roleId);
                      }}
                    >
                      <div class="evolution-role-title">{role.label ?? roleLabel(role.roleId)}</div>
                      {role.skillName && <div class="evolution-role-skill">{role.skillName}</div>}
                      <div>{role.status}{role.currentAction ? ` · ${role.currentAction}` : ''}</div>
                      {role.skillSummary && <div class="evolution-role-summary">{role.skillSummary}</div>}
                      {role.responsibilities && role.responsibilities.length > 0 && (
                        <div class="evolution-role-tags">
                          {role.responsibilities.slice(0, 4).map((item) => <span key={item}>{item}</span>)}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <h3>与角色交流</h3>
                <div class="evolution-role-focus-hint">
                  当前关注：{focusRoleLabel}。选择“全部角色”会把指令广播成全局约束；点击角色卡会切到单角色指令。
                </div>
                <select value={selectedTarget} onChange={(event) => {
                  const next = (event.currentTarget as HTMLSelectElement).value;
                  setSelectedTarget(next === 'all' ? 'all' : next as EvolutionRoleId);
                }}>
                  <option value="all">全部角色 / 全局约束</option>
                  {EVOLUTION_ROLE_IDS.map((roleId) => {
                    const role = projection.roles.find((entry) => entry.roleId === roleId);
                    return <option key={roleId} value={roleId}>{role?.label ?? roleLabel(roleId)}</option>;
                  })}
                </select>
                <textarea value={message} onInput={(event) => setMessage((event.currentTarget as HTMLTextAreaElement).value)} placeholder="给全部角色广播约束，或给产品/技术总监/QA/运维等单个角色发指令…" />
                <button
                  class="btn btn-primary"
                  disabled={!message.trim()}
                  onClick={() => {
                    onSendUserMessage(message, selectedTarget === 'all' ? undefined : selectedTarget);
                    setMessage('');
                  }}
                >
                  {selectedTarget === 'all' ? '广播给全部角色' : '发送给角色'}
                </button>
              </section>
            </div>

            <section class="evolution-war-room-skills">
              <div class="evolution-section-heading">
                <h3>角色 Skill Playbooks · {focusRoleLabel}</h3>
                <span>{filteredRoleSkillArtifacts.length}/{projection.artifacts.filter((artifact) => artifact.kind === 'role_skill').length} skills</span>
              </div>
              <div class="evolution-skill-grid">
                {filteredRoleSkillArtifacts.length === 0 ? <div class="evolution-empty">暂无匹配角色 skill；创建 run 时会自动物化到 .imc/skills/evolution/。</div> : filteredRoleSkillArtifacts.map((artifact) => {
                  const role = projection.roles.find((entry) => entry.roleId === artifact.roleId);
                  const isEditing = editingSkillId === artifact.id;
                  const previewContent = artifact.preview?.content ?? '';
                  const draft = skillDrafts[artifact.id] ?? previewContent;
                  const canEdit = !!artifact.roleId && !artifact.preview?.truncated;
                  return (
                    <div key={artifact.id} class="evolution-skill-card">
                      <div class="evolution-skill-head">
                        <div>
                          <strong>{role?.label ?? (artifact.roleId ? roleLabel(artifact.roleId) : artifact.title ?? 'Role Skill')}</strong>
                          <span>{role?.skillName ?? artifact.title}</span>
                        </div>
                        <div class="evolution-skill-actions">
                          <code>{artifact.path}</code>
                          <button
                            type="button"
                            class="btn btn-secondary btn-compact"
                            disabled={!canEdit}
                            onClick={() => {
                              setEditingSkillId(isEditing ? null : artifact.id);
                              if (!skillDrafts[artifact.id]) {
                                setSkillDrafts((current) => ({ ...current, [artifact.id]: previewContent }));
                              }
                            }}
                          >
                            {isEditing ? '收起' : '编辑'}
                          </button>
                        </div>
                      </div>
                      {role?.skillSummary && <p>{role.skillSummary}</p>}
                      {role?.responsibilities && role.responsibilities.length > 0 && (
                        <div class="evolution-role-tags">
                          {role.responsibilities.slice(0, 5).map((item) => <span key={item}>{item}</span>)}
                        </div>
                      )}
                      {isEditing && artifact.roleId ? (
                        <div class="evolution-skill-editor">
                          <div class="evolution-role-focus-hint">
                            修改会直接写入 <code>{artifact.path}</code>，并在当前 run 中记录 revision backup / evidence。请保留 frontmatter 的 name/category。
                          </div>
                          <textarea
                            value={draft}
                            onInput={(event) => {
                              const value = (event.currentTarget as HTMLTextAreaElement).value;
                              setSkillDrafts((current) => ({ ...current, [artifact.id]: value }));
                            }}
                          />
                          <div class="evolution-skill-editor-actions">
                            <button
                              type="button"
                              class="btn btn-primary"
                              disabled={skillUpdatePending || !draft.trim() || draft === previewContent}
                              onClick={() => {
                                onUpdateRoleSkill(artifact.roleId!, draft);
                                setEditingSkillId(null);
                              }}
                            >
                              {skillUpdatePending ? '保存中…' : '保存 skill'}
                            </button>
                            <button
                              type="button"
                              class="btn btn-secondary"
                              onClick={() => {
                                setSkillDrafts((current) => ({ ...current, [artifact.id]: previewContent }));
                                setEditingSkillId(null);
                              }}
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      ) : artifact.preview && (
                        <pre class="evolution-skill-preview">
                          {artifactPreviewText(artifact.preview.content)}
                          {artifact.preview.truncated ? '\n…预览已截断' : ''}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
              {(filteredRoleSkillCandidateArtifacts.length > 0 || filteredRoleSkillLibraryArtifacts.length > 0) && (
                <div class="evolution-skill-governance">
                  {filteredRoleSkillCandidateArtifacts.length > 0 && (
                    <>
                      <h4>待审批发布候选</h4>
                      <label class="evolution-war-room-toggle">
                        审批人
                        <input
                          value={skillApproverId}
                          onInput={(event) => setSkillApproverId((event.currentTarget as HTMLInputElement).value)}
                          placeholder="war-room-user / tech-lead / qa-owner"
                        />
                      </label>
                      {filteredRoleSkillCandidateArtifacts.map((artifact) => {
                        const role = projection.roles.find((entry) => entry.roleId === artifact.roleId);
                        return (
                          <div key={artifact.id} class="evolution-skill-governance-row">
                            <div>
                              <strong>{role?.label ?? (artifact.roleId ? roleLabel(artifact.roleId) : artifact.title ?? 'Role Skill')}</strong>
                              <span>{artifact.path}</span>
                            </div>
                            <button
                              type="button"
                              class="btn btn-primary btn-compact"
                              disabled={skillUpdatePending || !artifact.roleId}
                              onClick={() => artifact.roleId && onApproveRoleSkillCandidate(
                                artifact.roleId,
                                artifact.id,
                                'Approved from Evolution War Room.',
                                skillApproverId,
                              )}
                            >
                              {skillUpdatePending ? '审批中…' : '批准为共享模板'}
                            </button>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {filteredRoleSkillLibraryArtifacts.length > 0 && (
                    <>
                      <h4>已发布共享模板</h4>
                      {filteredRoleSkillLibraryArtifacts.map((artifact) => (
                        <div key={artifact.id} class="evolution-skill-governance-row approved">
                          <div>
                            <strong>{artifact.title ?? artifact.kind}</strong>
                            <span>{artifact.path}</span>
                          </div>
                          <code>{artifact.sha256?.slice(0, 12) ?? artifact.id}</code>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </section>

            <section class="evolution-war-room-execution">
              <div class="evolution-section-heading">
                <h3>实时事件流 · {focusRoleLabel}</h3>
                <span>{filteredLiveEvents.length}/{liveEvents.length} live</span>
              </div>
              {filteredLiveEvents.length === 0 ? <div class="evolution-empty">暂无实时事件；开发 loop、P2P 圆桌、staging 命令和审批动作会进入这里。</div> : (
                <div class="evolution-live-events">
                  {filteredLiveEvents.slice(-40).reverse().map((item) => {
                    const role = item.roleId ? projection.roles.find((entry) => entry.roleId === item.roleId) : null;
                    const percent = item.progress ? Math.min(100, Math.max(0, Math.round((item.progress.current / Math.max(1, item.progress.total)) * 100))) : null;
                    return (
                      <div key={item.id} class={`evolution-live-event severity-${item.severity} kind-${item.kind}`}>
                        <div class="evolution-live-event-head">
                          <strong>{item.title}</strong>
                          <span>{item.source} · {role?.label ?? (item.roleId ? roleLabel(item.roleId) : 'system')} · {formatTime(item.createdAt)}</span>
                        </div>
                        <div class="evolution-discussion-text">{item.detail}</div>
                        {item.progress && percent !== null && (
                          <div class="evolution-live-progress">
                            <i style={{ width: `${percent}%` }} />
                            <span>{item.progress.label ?? `${item.progress.current}/${item.progress.total}`}</span>
                          </div>
                        )}
                        {(item.command || item.exitCode !== undefined || (item.artifactIds && item.artifactIds.length > 0)) && (
                          <div class="evolution-discussion-artifacts">
                            {item.command && <code>{item.command}</code>}
                            {item.exitCode !== undefined && <code>exit {item.exitCode}</code>}
                            {item.artifactIds?.map((artifactId) => <code key={artifactId}>{artifactId}</code>)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section class="evolution-war-room-execution">
              <div class="evolution-section-heading">
                <h3>角色执行轨迹 · {focusRoleLabel}</h3>
                <span>{filteredExecutionTimeline.length}/{executionTimeline.length} events</span>
              </div>
              {filteredExecutionTimeline.length === 0 ? <div class="evolution-empty">暂无匹配执行轨迹；切回“全部角色”可查看完整战情。</div> : (
                <div class="evolution-execution-track">
                  {filteredExecutionTimeline.slice(0, 36).map((item) => {
                    const role = projection.roles.find((entry) => entry.roleId === item.roleId);
                    return (
                      <div key={item.id} class={`evolution-execution-item status-${item.status}`}>
                        <div class="evolution-execution-dot" />
                        <div class="evolution-execution-body">
                          <div class="evolution-discussion-head">
                            <strong>{role?.label ?? roleLabel(item.roleId)} · {item.title}</strong>
                            <span>{item.stage} · {item.source} · {formatTime(item.createdAt)}</span>
                          </div>
                          <div class="evolution-discussion-text">{item.detail}</div>
                          {item.artifactIds && item.artifactIds.length > 0 && (
                            <div class="evolution-discussion-artifacts">
                              {item.artifactIds.map((artifactId) => <code key={artifactId}>{artifactId}</code>)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section class="evolution-war-room-roundtables">
              <h3>圆桌复核 · {focusRoleLabel}</h3>
              <div class="evolution-roundtable-explainer" data-testid="evolution-roundtable-explainer">
                <strong>为什么会有多个圆桌？</strong>
                <span>
                  这是 2 轮多机器人讨论，不是重复审查：第 1 轮按产品/设计/技术/测试等 role skill 发散补齐，第 2 轮交叉挑战并收敛为 PASS/REWORK。
                  产品圆桌细化需求/PRD，设计圆桌确认参考图和高保真一致，架构圆桌确认技术边界与风险，规划圆桌决定是否允许进入开发 Loop。
                  当前 {projection.roundtableGateMode === 'strict' ? '严格模式：每个圆桌都必须 PASS 才继续。' : '规划模式：产品/设计/架构圆桌提供建议，只有规划圆桌阻断开发。'}
                </span>
              </div>
              {filteredRoundtables.length === 0 ? <div class="evolution-empty">暂无匹配圆桌；系统会在产品、设计、架构和任务准备阶段优先启动 P2P 圆桌，无 helper 时生成本地复核产物。</div> : filteredRoundtables.map((roundtable) => (
                <div key={roundtable.id} class={`evolution-roundtable-row status-${roundtable.status}`}>
                  <div class="evolution-discussion-head">
                    <strong>{roundtable.topic}</strong>
                    <span>{roundtable.stage} · {roundtable.status} · {formatTime(roundtable.updatedAt)}</span>
                  </div>
                  <div class="evolution-discussion-text">
                    角色：{roundtable.roles.map(roleLabel).join(' / ')}
                    {roundtable.p2pRunId ? ` · P2P ${roundtable.p2pRunId}` : ''}
                    {roundtable.discussionId ? ` · discussion ${roundtable.discussionId}` : ''}
                    {roundtable.currentTargetSession ? ` · 当前 ${roundtable.currentTargetSession}` : ''}
                    {roundtable.completedAt ? ` · 完成 ${roundtable.completedAt}` : ''}
                    {roundtable.error ? ` · ${roundtable.error}` : ''}
                  </div>
                  {roundtable.summary && <div class="evolution-roundtable-summary">{roundtable.summary}</div>}
                  {roundtable.contextPath && <div class="evolution-discussion-artifacts"><code>{roundtable.contextPath}</code></div>}
                </div>
              ))}
            </section>

            {projection.stagingDelivery && (
              <section class="evolution-war-room-roundtables">
                <h3>Staging 自动交付</h3>
                <div class={`evolution-roundtable-row status-${projection.stagingDelivery.status === 'failed' ? 'failed' : projection.stagingDelivery.status === 'running' ? 'running' : 'complete'}`}>
                  <div class="evolution-discussion-head">
                    <strong>{projection.stagingDelivery.status}</strong>
                    <span>{projection.stagingDelivery.completedAt ? formatTime(projection.stagingDelivery.completedAt) : formatTime(projection.stagingDelivery.startedAt)}</span>
                  </div>
                  <div class="evolution-discussion-text">
                    {projection.stagingDelivery.summary ?? '—'}
                    {projection.stagingDelivery.exitCode !== undefined ? ` · exit ${projection.stagingDelivery.exitCode}` : ''}
                  </div>
                  {projection.stagingDelivery.command && <div class="evolution-discussion-artifacts"><code>{projection.stagingDelivery.command}</code></div>}
                  {projection.stagingDelivery.logArtifactId && <div class="evolution-discussion-artifacts"><code>{projection.stagingDelivery.logArtifactId}</code></div>}
                  {projection.stagingDelivery.status === 'ready' && (
                    <div class="evolution-role-focus-hint">
                      配置已通过只读体检；OpenSpec 通过并进入 delivery_ready 后才会执行 staging，production 仍保留人工门禁。
                    </div>
                  )}
                </div>
              </section>
            )}

            <section class="evolution-war-room-discussion">
              <h3>角色讨论流 · {focusRoleLabel}</h3>
              {filteredDiscussion.length === 0 ? <div class="evolution-empty">暂无匹配讨论消息</div> : filteredDiscussion.slice(-20).map((entry) => (
                <div key={entry.id} class={`evolution-discussion-row kind-${entry.kind}`}>
                  <div class="evolution-discussion-head">
                    <strong>{entry.author}</strong>
                    <span>{entry.stage} · {entry.kind} · {formatTime(entry.createdAt)}</span>
                  </div>
                  <div class="evolution-discussion-text">{entry.text}</div>
                  {entry.artifactIds && entry.artifactIds.length > 0 && (
                    <div class="evolution-discussion-artifacts">
                      {entry.artifactIds.map((artifactId) => <code key={artifactId}>{artifactId}</code>)}
                    </div>
                  )}
                </div>
              ))}
            </section>

            <div class="evolution-war-room-grid">
              <section>
                <h3>产物 · {focusRoleLabel}</h3>
                {filteredArtifacts.length === 0 ? <div class="evolution-empty">暂无匹配产物</div> : filteredArtifacts.map((artifact) => (
                  <div key={artifact.id} class={`evolution-artifact-card${isVisualArtifact(artifact.path) ? ' visual-artifact' : ''}`}>
                    <div class="evolution-list-row">
                      <strong>{isVisualArtifact(artifact.path) ? '🖼 ' : ''}{artifact.kind}</strong><span>{artifact.path}</span>
                    </div>
                    {(artifact.preview?.previewType === 'svg' || artifact.preview?.previewType === 'image') && (
                      <div class="evolution-artifact-preview evolution-artifact-preview-svg">
                        <img src={artifactPreviewUrl(artifact.preview)} alt={artifact.title ?? artifact.path} />
                        {artifact.preview.truncated && <div class="evolution-preview-truncated">预览已截断</div>}
                      </div>
                    )}
                    {artifact.preview && artifact.preview.previewType !== 'svg' && artifact.preview.previewType !== 'image' && (
                      <pre class="evolution-artifact-preview evolution-artifact-preview-text">
                        {artifactPreviewText(artifact.preview.content)}
                        {artifact.preview.truncated ? '\n…预览已截断' : ''}
                      </pre>
                    )}
                  </div>
                ))}
              </section>
              <section>
                <h3>证据 / 事件</h3>
                {projection.evidence.length === 0 ? <div class="evolution-empty">暂无证据</div> : projection.evidence.slice(-8).map((entry, index) => (
                  <div key={`${entry.createdAt}-${index}`} class="evolution-list-row evolution-evidence-row">
                    <strong>{entry.source}</strong>
                    <span>
                      {entry.summary}
                      {entry.exitCode !== undefined ? ` · exit ${entry.exitCode}` : ''}
                    </span>
                    {(entry.command || entry.artifactId) && (
                      <div class="evolution-discussion-artifacts">
                        {entry.command && <code>{entry.command}</code>}
                        {entry.artifactId && <code>{entry.artifactId}</code>}
                      </div>
                    )}
                  </div>
                ))}
              </section>
            </div>

            {projection.blockingQuestions.length > 0 && (
              <section class="evolution-war-room-blockers">
                <h3>阻塞问题</h3>
                {projection.blockingQuestions.map((question) => (
                  <div key={question.id} class="evolution-list-row"><strong>{question.stage}</strong><span>{question.question}</span></div>
                ))}
              </section>
            )}
          </>
        ) : (
          <div class="evolution-war-room-empty">
            把需求文件放到 <code>{inboxPath}/</code>，也可以把完整文件路径粘贴到上方输入框后启动；或点击“运行内置 Demo”立即生成一份示例需求并启动完整 War Room。
          </div>
        )}
      </div>
    </div>
  );
}

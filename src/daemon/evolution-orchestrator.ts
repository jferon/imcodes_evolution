import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS,
  EVOLUTION_AUTO_DELIVER_PRESET_IDS,
  EVOLUTION_DEVELOPMENT_MODES,
  EVOLUTION_DESIGN_TARGET_SURFACES,
  EVOLUTION_EXECUTION_POLICIES,
  EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX,
  EVOLUTION_GATE_ACTIONS,
  EVOLUTION_GREENFIELD_TOPOLOGIES,
  EVOLUTION_PIPELINE_MSG,
  EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID,
  EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
  EVOLUTION_PROJECT_POLICY_RELATIVE_PATH,
  EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID,
  type EvolutionAttemptKind,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  EVOLUTION_RUN_ROOT_DIR,
  EVOLUTION_ROLE_IDS,
  EVOLUTION_ROUNDTABLE_GATE_MODES,
  canTransitionEvolutionStage,
  isEvolutionTerminalStage,
  isEvolutionStage,
  type EvolutionArtifactKind,
  type EvolutionAutoDeliverPresetId,
  type EvolutionDevelopmentMode,
  type EvolutionDesignTargetSurface,
  type EvolutionExecutionPolicy,
  type EvolutionGateAction,
  type EvolutionGreenfieldTopology,
  type EvolutionRoundtableGateMode,
  type EvolutionScoreModuleId,
  type EvolutionRoleId,
  type EvolutionRoleStatus,
  type EvolutionStage,
} from '../../shared/evolution-pipeline-constants.js';
import type {
  EvolutionArtifactRef,
  EvolutionArtifactPreview,
  EvolutionEvidence,
  EvolutionExecutionTimelineItem,
  EvolutionLaunchRequest,
  EvolutionLoopControl,
  EvolutionLoopControlMode,
  EvolutionLoopControlSignal,
  EvolutionLoopControlSignalStatus,
  EvolutionProjection,
  EvolutionProjectPolicy,
  EvolutionReferenceAttachmentInput,
  EvolutionReferenceBriefImportResult,
  EvolutionRun,
  EvolutionRoundtableRef,
  EvolutionValidationIssue,
  EvolutionValidationResult,
} from '../../shared/evolution-pipeline-types.js';
import type { OpenSpecAutoDeliverProjection } from '../../shared/openspec-auto-deliver-types.js';
import type { P2pRunUpdatePayload, P2pRunStatus } from '../../shared/p2p-status.js';
import {
  validateEvolutionLaunchRequest,
  validateEvolutionProjectPolicy,
  validateEvolutionRunId,
  validateEvolutionStageTransition,
} from '../../shared/evolution-pipeline-validators.js';
import {
  createEvolutionRunFromRequirement,
  EVOLUTION_ROLE_SKILL_DEFINITIONS,
  EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR,
  EVOLUTION_ROLE_SKILL_CATEGORY,
  getEvolutionRunPaths,
  readEvolutionRun,
  updateEvolutionRoleSkillFile,
  writeEvolutionRun,
} from './evolution-artifact-store.js';
import { checkEvolutionStagingDeliveryConfig, runEvolutionStagingDelivery } from './evolution-delivery-runner.js';
import { runEvolutionTasteHifiGeneration } from './evolution-design-runner.js';
import {
  EvolutionPlanningPausedError,
  PRODUCT_MAKER_ACCEPTANCE_RELATIVE_PATH,
  PRODUCT_MAKER_PRD_RELATIVE_PATH,
  PRODUCT_MAKER_USER_STORIES_RELATIVE_PATH,
  registerDesignMakerOutputArtifacts,
  registerProductMakerOutputArtifacts,
  registerVisualReportArtifact,
  runEvolutionPlanningStages,
} from './evolution-stage-runner.js';
import {
  DESIGN_SYSTEM_TOKENS_RELATIVE_PATH,
  UI_PREVIEW_HTML_RELATIVE_PATH,
  UI_SPEC_RELATIVE_PATH,
  UI_VISUAL_REPORT_PASS_THRESHOLD,
  parseUiVisualReportMarker,
  renderUiVisualReportFeedback,
} from '../../shared/ui-spec.js';
import { appendDiscussion, appendEvidence, appendLiveEvent, shortSha256, upsertArtifact, upsertScore } from './evolution-run-helpers.js';
import { bootstrapGreenfieldFoundation, probeFoundationCapabilities } from './evolution-foundation.js';
import type { FoundationProbeResult } from './evolution-foundation.js';
import { lookupAttachmentById } from './file-transfer-handler.js';
import { recordEvolutionInboxSeenFiles } from './evolution-inbox-watcher.js';
import type { EvolutionInboxCandidate, EvolutionInboxCandidateFile, EvolutionInboxCandidateGroup } from './evolution-inbox-watcher.js';
import { parseSkillMarkdown } from '../../shared/skill-store.js';
import { getSession } from '../store/session-store.js';
import {
  captureEvolutionSkillSnapshot,
  completeEvolutionAttempt,
  createEvolutionAttempt,
  initializeEvolutionControlState,
  nextEvolutionRunRevision,
  persistEvolutionGate,
  persistEvolutionReviewSet,
  recordEvolutionVerdict,
  registerEvolutionArtifactRevision,
  requireAuthorizedEvolutionRevision,
} from './evolution-control-plane.js';
import { withEvolutionMutationCommit } from './evolution-mutation-controller.js';

interface RuntimeEntry {
  projectRoot: string;
  run: EvolutionRun;
}

export interface LaunchEvolutionRunOptions {
  projectRoot: string;
  request: EvolutionLaunchRequest;
  nowMs?: number;
  runId?: string;
}

export interface LaunchEvolutionDemoRunOptions {
  projectRoot: string;
  requestId: string;
  serverId?: string;
  sessionName: string;
  projectName?: string;
  locale?: string;
  autoStart?: boolean;
  autoStartImplementation?: boolean;
  autoDeliverPresetId?: EvolutionAutoDeliverPresetId;
  autoCommitPush?: boolean;
  roundtableGateMode?: EvolutionRoundtableGateMode;
  designTargetSurface?: EvolutionDesignTargetSurface;
  developmentMode?: EvolutionDevelopmentMode;
  executionPolicy?: EvolutionExecutionPolicy;
  developmentTargetRelativeDir?: string;
  greenfieldTopology?: EvolutionGreenfieldTopology;
  requireHifiHumanApproval?: boolean;
  nowMs?: number;
}

export interface ImportEvolutionReferenceBriefOptions {
  projectRoot: string;
  requestId: string;
  serverId?: string;
  sessionName: string;
  projectName?: string;
  taskName?: string;
  note?: string;
  attachments: EvolutionReferenceAttachmentInput[];
  nowMs?: number;
}

export interface AdvanceEvolutionRunStageOptions {
  runId: string;
  nextStage: EvolutionStage;
  reason?: string;
  nowMs?: number;
}

export interface StopEvolutionRunOptions {
  runId: string;
  reason?: string;
  nowMs?: number;
}

export interface PauseEvolutionRunOptions {
  runId: string;
  reason?: string;
  nowMs?: number;
}

export interface ContinueEvolutionRunOptions {
  runId: string;
  targetStage?: EvolutionStage;
  message?: string;
  nowMs?: number;
}

export interface ApplyEvolutionGateActionOptions {
  runId: string;
  gateId: string;
  action: EvolutionGateAction;
  mutationId: string;
  expectedRunRevision: number;
  feedback?: string;
  nowMs?: number;
}

export interface CheckEvolutionStagingConfigOptions {
  runId: string;
  nowMs?: number;
}

export interface RecordEvolutionUserMessageOptions {
  runId: string;
  roleId?: EvolutionRoleId;
  text: string;
  nowMs?: number;
}

export interface UpdateEvolutionRoleSkillOptions {
  runId: string;
  roleId: EvolutionRoleId;
  markdown: string;
  nowMs?: number;
}

export interface ApproveEvolutionRoleSkillCandidateOptions {
  runId: string;
  roleId: EvolutionRoleId;
  candidateArtifactId: string;
  approvalMessage?: string;
  approverId?: string;
  nowMs?: number;
}

export interface EvolutionRoundtableUserMessageRequest {
  runId: string;
  roundtable: EvolutionRoundtableRef;
  roleId?: EvolutionRoleId;
  roleLabel?: string;
  author: string;
  text: string;
  createdAt: number;
}

export interface EvolutionRoundtableUserMessageResult {
  ok: boolean;
  contextPath?: string;
  currentTargetSession?: string | null;
  error?: string;
}

export type EvolutionRoundtableUserMessageSink = (
  request: EvolutionRoundtableUserMessageRequest,
) => Promise<EvolutionRoundtableUserMessageResult>;

export interface RecordEvolutionOpenSpecProjectionOptions {
  projection: OpenSpecAutoDeliverProjection;
  serverLink?: EvolutionServerLink | null;
  nowMs?: number;
}

export interface RecordEvolutionP2pRunProjectionOptions {
  run: P2pRunUpdatePayload;
  serverLink?: EvolutionServerLink | null;
  nowMs?: number;
}

export type EvolutionOrchestratorResult<T> = EvolutionValidationResult<T>;

export interface EvolutionServerLink {
  send(message: Record<string, unknown>): void;
  getServerId?(): string;
}

export interface EvolutionAutoDeliverLaunchRequest {
  requestId: string;
  sessionName: string;
  projectName?: string;
  changeName: string;
  presetId: EvolutionAutoDeliverPresetId;
  locale?: string;
  autoCommitPush: boolean;
}

export interface EvolutionAutoDeliverLaunchResult {
  ok: boolean;
  projection?: OpenSpecAutoDeliverProjection;
  error?: string;
}

export type EvolutionAutoDeliverLauncher = (
  request: EvolutionAutoDeliverLaunchRequest,
  serverLink: EvolutionServerLink,
) => Promise<EvolutionAutoDeliverLaunchResult>;

export interface EvolutionRoundtableLaunchRequest {
  requestId: string;
  runId: string;
  sessionName: string;
  projectRoot: string;
  stage: EvolutionStage;
  topic: string;
  roles: EvolutionRoleId[];
  roleInstructions: EvolutionRoundtableRoleInstruction[];
  prompt: string;
  artifactPaths: string[];
  /**
   * Identifies which EvolutionRoundtableSpec produced this request. `stage`
   * alone cannot disambiguate — design_hifi hosts both `design-review` and
   * `visual-fidelity-review`, which need different helper-eligibility rules.
   */
  roundtableSpecId: string;
}

export interface EvolutionRoundtableRoleInstruction {
  roleId: EvolutionRoleId;
  label: string;
  skillName?: string;
  skillSummary?: string;
  responsibilities: string[];
  currentAction?: string;
  skillSnapshotId?: string;
  skillSha256?: string;
  skillContent?: string;
}

export interface EvolutionRoundtableLaunchResult {
  ok: boolean;
  p2pRunId?: string;
  discussionId?: string;
  contextPath?: string;
  skippedReason?: string;
  error?: string;
}

export type EvolutionRoundtableLauncher = (
  request: EvolutionRoundtableLaunchRequest,
  serverLink: EvolutionServerLink | null,
) => Promise<EvolutionRoundtableLaunchResult>;

/**
 * Cancels a linked OpenSpec Auto Deliver run on behalf of Evolution's own
 * STOP/pause path. Registered by openspec-auto-deliver-orchestrator.ts (same
 * one-way registration pattern as EvolutionAutoDeliverLauncher — a direct
 * import the other way would create a module cycle).
 */
export type EvolutionAutoDeliverCanceller = (runId: string, sessionName: string) => Promise<boolean>;

const runsById = new Map<string, RuntimeEntry>();
const requestProjectionByFingerprint = new Map<string, EvolutionProjection>();
const activeAutopilotRuns = new Map<string, Promise<EvolutionOrchestratorResult<EvolutionProjection>>>();
let autoDeliverLauncher: EvolutionAutoDeliverLauncher | null = null;
let autoDeliverCanceller: EvolutionAutoDeliverCanceller | null = null;
let roundtableLauncher: EvolutionRoundtableLauncher | null = null;
let roundtableUserMessageSink: EvolutionRoundtableUserMessageSink | null = null;
const PLANNING_ROUNDTABLE_ID = 'planning-review' as const;

interface EvolutionRoundtableSpec {
  id: string;
  stage: EvolutionStage;
  topic: string;
  roles: EvolutionRoleId[];
  artifactKinds: EvolutionArtifactKind[];
  prompt: (run: EvolutionRun) => string;
  gatesAutoDelivery?: boolean;
  /**
   * Enforced regardless of `roundtableGateMode`. The strict/planning toggle
   * modulates subjective planning-agreement reviews; an `alwaysGate` spec is
   * an evidence-checkable hard bar (e.g. visual fidelity against a reference
   * image) that must never silently degrade to advisory-only under the
   * default non-strict mode — and must never take the deterministic local
   * text-only fallback, which cannot check what this gate exists to check.
   */
  alwaysGate?: boolean;
  /** When present and false for a run, the roundtable is not started at all. */
  shouldRun?: (run: EvolutionRun) => boolean;
  /**
   * Attempt kind recorded for this dispatch. Defaults to 'checker' (review
   * roundtables); 'maker' marks a production dispatch whose PASS additionally
   * requires output promotion (validated files, not just a verdict token).
   */
  attemptKind?: EvolutionAttemptKind;
}

export function setEvolutionAutoDeliverLauncher(launcher: EvolutionAutoDeliverLauncher | null): void {
  autoDeliverLauncher = launcher;
}

export function setEvolutionAutoDeliverCanceller(canceller: EvolutionAutoDeliverCanceller | null): void {
  autoDeliverCanceller = canceller;
}

/**
 * Best-effort cancellation of the nested Auto Deliver run when the user stops
 * or pauses the parent Evolution run. Without this, STOP only detaches the
 * parent while the nested run keeps executing (and spending) to completion.
 */
async function cancelLinkedAutoDelivery(run: EvolutionRun): Promise<void> {
  if (!run.linkedAutoDeliverRunId || !autoDeliverCanceller) return;
  try {
    await autoDeliverCanceller(run.linkedAutoDeliverRunId, run.sessionName);
  } catch { /* best effort — the linked run may already be terminal or gone */ }
}

export function setEvolutionRoundtableLauncher(launcher: EvolutionRoundtableLauncher | null): void {
  roundtableLauncher = launcher;
}

export function setEvolutionRoundtableUserMessageSink(sink: EvolutionRoundtableUserMessageSink | null): void {
  roundtableUserMessageSink = sink;
}

function issue(code: string, message: string, path?: string): EvolutionValidationIssue {
  return { code, message, path, severity: 'error' };
}

function ok<T>(value: T): EvolutionOrchestratorResult<T> {
  return { ok: true, value, issues: [] };
}

function fail<T = never>(code: string, message: string, path?: string): EvolutionOrchestratorResult<T> {
  return { ok: false, issues: [issue(code, message, path)] };
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function launchFingerprint(request: EvolutionLaunchRequest): string {
  return JSON.stringify({
    requestId: request.requestId,
    sessionName: request.sessionName,
    sourceRelativePath: request.sourceRelativePath,
    sourceSha256: request.sourceSha256 ?? null,
    sourceSizeBytes: request.sourceSizeBytes ?? null,
    autoStartImplementation: request.autoStartImplementation === true,
    autoDeliverPresetId: request.autoDeliverPresetId ?? 'standard',
    autoCommitPush: request.autoCommitPush === true,
    roundtableGateMode: request.roundtableGateMode ?? 'planning',
    designTargetSurface: request.designTargetSurface ?? 'auto',
    developmentMode: request.developmentMode ?? 'brownfield_refactor',
    developmentTargetRelativeDir: request.developmentTargetRelativeDir ?? null,
    requireHifiHumanApproval: request.requireHifiHumanApproval === true,
  });
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function upsertRuntime(projectRoot: string, run: EvolutionRun): RuntimeEntry {
  const entry: RuntimeEntry = { projectRoot, run };
  runsById.set(run.runId, entry);
  return entry;
}

function getRuntimeEntry(runId: string): RuntimeEntry | null {
  return runsById.get(runId) ?? null;
}

function safeProjectRoot(projectRoot: string): string {
  if (!projectRoot || projectRoot.includes('\0')) throw new Error('invalid_project_root');
  return resolve(projectRoot);
}

function normalizeEvolutionLaunchSourcePath(projectRoot: string, sourceRelativePath: string): string {
  const trimmed = sourceRelativePath.trim();
  const normalizedSeparators = trimmed.replace(/\\/g, '/');
  if (!isAbsolute(trimmed)) return normalizedSeparators;

  const resolvedRoot = safeProjectRoot(projectRoot);
  const resolvedSource = resolve(trimmed);
  const relativeSource = relative(resolvedRoot, resolvedSource).replace(/\\/g, '/');
  if (relativeSource === '' || relativeSource.startsWith('..') || isAbsolute(relativeSource)) return normalizedSeparators;
  return relativeSource;
}

function normalizeEvolutionLaunchRequest(projectRoot: string, request: EvolutionLaunchRequest): EvolutionLaunchRequest {
  if (typeof request.sourceRelativePath !== 'string') return request;
  const normalizedSourcePath = normalizeEvolutionLaunchSourcePath(projectRoot, request.sourceRelativePath);
  if (normalizedSourcePath === request.sourceRelativePath) return request;
  return { ...request, sourceRelativePath: normalizedSourcePath };
}

function safeRunArtifactPath(runDir: string, artifactPath: string): string {
  const resolvedRoot = resolve(runDir);
  const resolvedPath = resolve(resolvedRoot, artifactPath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('evolution_artifact_path_outside_run');
  return resolvedPath;
}

function safeProjectRelativePath(projectRoot: string, relativePath: string): string {
  const resolvedRoot = resolve(projectRoot);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('evolution_path_outside_project');
  return resolvedPath;
}

type GreenfieldTargetInspection =
  | { ok: true; inventorySha256: string }
  | { ok: false; code: string; message: string };

async function inspectGreenfieldTarget(
  projectRoot: string,
  targetRelativeDir: string,
): Promise<GreenfieldTargetInspection> {
  const resolvedRoot = safeProjectRoot(projectRoot);
  const targetPath = safeProjectRelativePath(resolvedRoot, targetRelativeDir);
  try {
    const canonicalRoot = await realpath(resolvedRoot);
    const segments = relative(resolvedRoot, targetPath).split(/[\\/]/).filter(Boolean);
    let cursor = resolvedRoot;
    let targetExists = true;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      try {
        const entry = await lstat(cursor);
        if (entry.isSymbolicLink()) {
          return {
            ok: false,
            code: 'greenfield_target_symlink',
            message: 'Greenfield target and its existing parent path must not contain symbolic links.',
          };
        }
        if (!entry.isDirectory()) {
          return {
            ok: false,
            code: 'greenfield_target_not_empty',
            message: 'Greenfield target must be absent or an empty directory; existing content will not be overwritten.',
          };
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          targetExists = false;
          break;
        }
        return {
          ok: false,
          code: 'greenfield_target_unreadable',
          message: `Greenfield target could not be inspected safely: ${describeUnknownError(error)}`,
        };
      }
    }
    const canonicalExistingParent = await realpath(cursor).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return realpath(dirname(cursor));
    });
    const canonicalRelative = relative(canonicalRoot, canonicalExistingParent);
    if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
      return {
        ok: false,
        code: 'greenfield_target_outside_project',
        message: 'Greenfield target resolves outside the canonical project root.',
      };
    }
    const entries = targetExists ? (await readdir(targetPath)).sort() : [];
    if (entries.length > 0) {
      return {
        ok: false,
        code: 'greenfield_target_not_empty',
        message: 'Greenfield target must be absent or an empty directory; existing content will not be overwritten.',
      };
    }
    return {
      ok: true,
      inventorySha256: sha256(JSON.stringify({
        targetRelativeDir: targetRelativeDir.replace(/\\/g, '/').replace(/\/+$/, ''),
        exists: targetExists,
        entries,
      })),
    };
  } catch (error) {
    return {
      ok: false,
      code: 'greenfield_target_unreadable',
      message: `Greenfield target could not be inspected safely: ${describeUnknownError(error)}`,
    };
  }
}

function sanitizeDemoPathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return sanitized || 'manual';
}

const REFERENCE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

function sanitizeReferenceTaskSegment(value: string | undefined): string {
  return sanitizeDemoPathSegment(value ?? 'reference');
}

function referenceImageExtension(input: EvolutionReferenceAttachmentInput, originalName: string): string {
  const existing = extname(originalName).toLowerCase();
  if (REFERENCE_IMAGE_EXTENSIONS.has(existing)) return existing;
  const mime = (input.mime ?? '').toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('svg')) return '.svg';
  return existing;
}

function sanitizeReferenceFileName(originalName: string, fallbackBase: string, requiredExt: string): string {
  const parsedExt = extname(originalName).toLowerCase();
  const base = basename(originalName, parsedExt)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || fallbackBase;
  const ext = REFERENCE_IMAGE_EXTENSIONS.has(parsedExt) ? parsedExt : requiredExt;
  return `${base}${ext}`;
}

function buildReferenceRequirementRelativeDir(requestId: string, taskName: string | undefined, nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/\D/g, '').slice(0, 14);
  const segment = sanitizeReferenceTaskSegment(taskName || requestId);
  return `${EVOLUTION_REQUIREMENT_INBOX_DIR}/reference-${stamp}-${segment}`;
}

function renderReferenceBriefMarkdown(options: {
  createdAt: number;
  projectName?: string;
  note?: string;
  copiedImages: EvolutionReferenceBriefImportResult['copiedImages'];
}): string {
  const { createdAt, projectName, note, copiedImages } = options;
  return [
    '# 参考图驱动的设计与需求 Brief',
    '',
    `Created at: ${new Date(createdAt).toISOString()}`,
    projectName ? `Project: ${projectName}` : '',
    '',
    '## 输入说明',
    '',
    '- 这是由 War Room 根据用户上传的参考图/手稿自动生成的启动文档。',
    '- 后续产品、设计、架构与开发角色必须先阅读下方参考图，再进入 PRD、低保真、高保真和实现拆解。',
    '- 如果当前项目已有页面或设计系统，必须先分析原项目的颜色、间距、字体、组件风格和交互模式，再生成新页面，避免与现有产品割裂。',
    '- 高保真设计必须与参考图表达的布局、信息层级、视觉气质和核心业务目标保持可追溯关系；不得输出通用模板化页面。',
    '',
    '## 用户补充',
    '',
    note?.trim() ? note.trim() : '- 用户未补充文字说明，请以参考图为主要需求来源，并在不确定处列出假设。',
    '',
    '## 参考图',
    '',
    ...copiedImages.flatMap((image, index) => [
      `### ${index + 1}. ${image.originalName ?? image.relativePath}`,
      '',
      `![${image.originalName ?? `reference-${index + 1}`}](${image.relativePath.split('/').slice(-2).join('/')})`,
      '',
      `- 文件：\`${image.relativePath}\``,
      image.mime ? `- MIME：${image.mime}` : '',
      typeof image.size === 'number' ? `- 大小：${image.size} bytes` : '',
      '',
    ].filter(Boolean)),
    '## 期望输出',
    '',
    '1. 结合参考图和原项目风格，补全可执行 PRD、用户故事和验收标准。',
    '2. 生成低保真流程/线框，说明每张参考图如何影响信息架构。',
    '3. 生成高保真 UI 说明与可交付设计产物，明确颜色、字体、间距、组件状态和响应式策略。',
    '4. 输出技术架构基线、OpenSpec proposal/design/tasks、实现任务矩阵、测试计划和交付门禁。',
    '',
  ].join('\n');
}

function buildDemoRequirementRelativePath(requestId: string, nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/\D/g, '').slice(0, 14);
  return `${EVOLUTION_REQUIREMENT_INBOX_DIR}/demo/evolution-factory-${stamp}-${sanitizeDemoPathSegment(requestId)}.md`;
}

export function renderEvolutionDemoRequirement(nowMs: number = Date.now()): string {
  return [
    '# IM.codes Evolution Factory Demo',
    '',
    `Created at: ${new Date(nowMs).toISOString()}`,
    '',
    '## Goal',
    'Build a lightweight self-evolving product delivery room for a SaaS onboarding dashboard. A user drops one requirements document into the inbox, then IM.codes coordinates product, UX, visual design, technical planning, implementation, QA, security, and ops agents with minimal manual intervention.',
    '',
    '## Target User',
    '- Founder or product lead who wants to turn an idea into a validated staging build quickly.',
    '- Technical director who needs a traceable PRD, architecture baseline, task list, test plan, and release gate.',
    '',
    '## Core Flow',
    '1. Detect the requirements document from `.imcodes/inbox/requirements/`.',
    '2. Normalize the requirement and produce a concise PRD with measurable acceptance criteria.',
    '3. Run product critique, UX flow, wireframe, high-fidelity taste-skill direction, architecture baseline, and OpenSpec task generation.',
    '4. Show every role state, discussion message, artifact, score, and live delivery event in the War Room.',
    '5. Auto-start the development loop when the planning gate is ready; keep production behind a human release gate.',
    '',
    '## Demo Screen Requirements',
    '- Dashboard header showing current evolution stage, readiness score, and next gate.',
    '- Role cards for Product, UX, Visual, Tech Director, Frontend, Backend, QA, Security, and Ops.',
    '- Real-time event stream for OpenSpec task progress, P2P roundtables, staging commands, and user instructions.',
    '- Artifact gallery with PRD, design handoff, architecture baseline, task matrix, test plan, and deployment plan previews.',
    '',
    '## Acceptance Criteria',
    '- A War Room run can be started from this demo without creating a separate requirements file manually.',
    '- The run records a demo requirement artifact and shows `demo` as the launch source.',
    '- Generated planning artifacts are sufficient for OpenSpec Auto Deliver to start implementation tasks.',
    '- Staging deployment is allowed only when local staging config is present; production still requires explicit user approval.',
    '',
    '## Constraints',
    '- Prefer taste-skill/high-fidelity SVG or image references over mandatory Figma usage.',
    '- Do not require external production credentials for the demo.',
    '- Preserve evidence for every automated step so the user can audit what each role did.',
    '',
  ].join('\n');
}

function markdownPreview(content: string): EvolutionArtifactPreview {
  const truncated = content.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS;
  return {
    previewType: 'markdown',
    content: truncated ? content.slice(0, EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) : content,
    ...(truncated ? { truncated: true } : {}),
  };
}

function roleInstructionTargetLabel(run: EvolutionRun, roleId: EvolutionRoleId | undefined): string {
  if (!roleId) return '全部角色';
  return run.roles.find((role) => role.roleId === roleId)?.label ?? roleId;
}

function roleInstructionAcknowledgement(run: EvolutionRun, roleId: EvolutionRoleId | undefined, text: string): {
  roleId: EvolutionRoleId;
  author: string;
  text: string;
} {
  const targetRoleId = roleId ?? 'loop_supervisor';
  const role = run.roles.find((entry) => entry.roleId === targetRoleId);
  const label = role?.label ?? targetRoleId;
  const instruction = truncateTimelineDetail(text, 120);
  if (!roleId) {
    return {
      roleId: 'loop_supervisor',
      author: label,
      text: `收到全局 War Room 指令：“${instruction}”。我会把它作为后续产品、设计、技术、实现、测试与发布阶段的共同约束，并在匹配的 P2P 圆桌中同步。`,
    };
  }
  return {
    roleId,
    author: label,
    text: `收到 War Room 指令：“${instruction}”。我会把它作为本角色后续输出、复核和交接的约束；若当前有匹配 P2P 圆桌，会同步注入讨论上下文。`,
  };
}

async function writeWarRoomInstructionArtifact(
  entry: RuntimeEntry,
  roleId: EvolutionRoleId | undefined,
  text: string,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const target = roleId ?? 'all_roles';
  const artifactPath = `discussions/user-instructions/${nowMs}-${target}-${shortSha256(text)}.md`;
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const targetLabel = roleInstructionTargetLabel(entry.run, roleId);
  const acknowledgement = roleInstructionAcknowledgement(entry.run, roleId, text);
  const content = [
    '# War Room Instruction',
    '',
    `- Run: \`${entry.run.runId}\``,
    `- Stage: \`${entry.run.stage}\``,
    `- Target role: ${targetLabel}`,
    `- Created at: ${new Date(nowMs).toISOString()}`,
    '',
    '## User Instruction',
    '',
    text,
    '',
    '## Routing Contract',
    '',
    '- This instruction is stored as a run artifact and discussion message.',
    '- Future PRD, design, architecture, task, test, and delivery artifacts consume War Room instructions as first-class constraints.',
    '- If a matching IM.codes P2P roundtable is running, the instruction is injected into that roundtable context.',
    '',
    '## Role Acknowledgement',
    '',
    acknowledgement.text,
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  const artifact: EvolutionArtifactRef = {
    id: `war_room_instruction:${shortSha256(`${artifactPath}:${text}`)}`,
    kind: 'discussion',
    path: artifactPath,
    title: `War Room Instruction · ${targetLabel}`,
    preview: markdownPreview(content),
    roleId: acknowledgement.roleId,
    stage: entry.run.stage,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
  upsertArtifact(entry.run, artifact);
  return artifact;
}

function roleInstructionResponseBullets(run: EvolutionRun, roleId: EvolutionRoleId, text: string): string[] {
  const role = run.roles.find((entry) => entry.roleId === roleId);
  const action = currentActionForRole(roleId, run.stage) ?? role?.currentAction ?? '等待下一次阶段推进时消费该指令';
  const base = [
    `当前阶段：${run.stage}`,
    `当前角色动作：${action}`,
    `指令摘要：${truncateTimelineDetail(text, 180)}`,
  ];
  if (roleId === 'product_manager') {
    return [...base, '影响范围：PRD、用户故事、验收标准、需求假设。'];
  }
  if (roleId === 'product_critic') {
    return [...base, '影响范围：反例审查、可测性检查、REWORK/PASS 建议。'];
  }
  if (roleId === 'ux_designer' || roleId === 'visual_designer') {
    return [...base, '影响范围：UX flow、低/高保真设计、taste-skill prompt、design handoff。'];
  }
  if (roleId === 'tech_director') {
    return [...base, '影响范围：架构基线、ADR、OpenSpec tasks、maker/checker 分派和开发前门禁。'];
  }
  if (roleId === 'backend_developer' || roleId === 'frontend_developer') {
    return [...base, '影响范围：实现任务、接口/组件状态、开发 loop 证据和回归修复。'];
  }
  if (roleId === 'qa_engineer') {
    return [...base, '影响范围：测试计划、测试用例、验收命令、回归证据。'];
  }
  if (roleId === 'security_reviewer') {
    return [...base, '影响范围：鉴权、隐私、密钥、迁移、供应链和安全门禁。'];
  }
  if (roleId === 'ops_release_manager') {
    return [...base, '影响范围：staging 配置、部署计划、回滚计划和生产人工门禁。'];
  }
  return [...base, '影响范围：状态机、证据账本、圆桌门禁、自动交付推进。'];
}

async function writeRoleInstructionResponseArtifact(
  entry: RuntimeEntry,
  roleId: EvolutionRoleId | undefined,
  text: string,
  instructionArtifact: EvolutionArtifactRef,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const acknowledgement = roleInstructionAcknowledgement(entry.run, roleId, text);
  const targetRoleId = acknowledgement.roleId;
  const targetLabel = roleInstructionTargetLabel(entry.run, roleId);
  const artifactPath = `discussions/role-responses/${nowMs}-${targetRoleId}-${shortSha256(text)}.md`;
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const content = [
    `# Role Instruction Response: ${targetLabel}`,
    '',
    `- Run: \`${entry.run.runId}\``,
    `- Stage: \`${entry.run.stage}\``,
    `- Target role: ${targetLabel}`,
    `- Source instruction artifact: \`${instructionArtifact.path}\``,
    `- Created at: ${new Date(nowMs).toISOString()}`,
    '',
    '## Response',
    '',
    acknowledgement.text,
    '',
    '## Local Execution Plan',
    '',
    ...roleInstructionResponseBullets(entry.run, targetRoleId, text).map((item) => `- ${item}`),
    '',
    '## Conversation Contract',
    '',
    '- This response is visible in War Room as the role-local acknowledgement for the user instruction.',
    '- It is consumed by later PRD/design/architecture/task/test/delivery artifacts through the shared War Room instruction ledger.',
    '- If a matching P2P roundtable is running, the same instruction is also forwarded into that live discussion context.',
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  const artifact: EvolutionArtifactRef = {
    id: `role_instruction_response:${shortSha256(`${artifactPath}:${text}`)}`,
    kind: 'role_instruction_response',
    path: artifactPath,
    title: `Role Response · ${targetLabel}`,
    preview: markdownPreview(content),
    roleId: targetRoleId,
    stage: entry.run.stage,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
  upsertArtifact(entry.run, artifact);
  return artifact;
}

function roundtablePrimaryRole(spec: EvolutionRoundtableSpec): EvolutionRoleId {
  if (spec.gatesAutoDelivery) return 'tech_director';
  if (spec.id === 'product-review') return 'product_manager';
  if (spec.id === 'design-review') return 'visual_designer';
  if (spec.id === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID) return 'visual_designer';
  if (spec.id === 'architecture-review') return 'tech_director';
  return spec.roles[0] ?? 'loop_supervisor';
}

function roundtablePrimaryRoleByRoles(roles: readonly EvolutionRoleId[]): EvolutionRoleId {
  return roles[0] ?? 'loop_supervisor';
}

function localRoundtableChecklist(spec: EvolutionRoundtableSpec, artifactPaths: string[]): string[] {
  const base = [
    `输入产物数量：${artifactPaths.length}`,
    `参与角色：${spec.roles.join(', ')}`,
  ];
  if (spec.id === 'product-review') {
    return [
      ...base,
      'PRD 前检查：目标用户、MVP 边界、验收标准和风险假设已进入后续产物。',
      '结论：没有发现需要阻塞自动推进的产品矛盾；真实 helper 可用时仍建议用 P2P 做反例审查。',
    ];
  }
  if (spec.id === 'design-review') {
    return [
      ...base,
      '设计检查：UX flow、低/高保真 SVG、taste-skill 输出和 design handoff 已形成前端输入。',
      '结论：设计足够进入架构与任务拆解；后续实现阶段需保留 loading/error/empty 状态证据。',
    ];
  }
  if (spec.id === 'architecture-review') {
    return [
      ...base,
      '架构检查：架构基线、ADR、OpenSpec 边界、安全/测试/部署风险已显式产物化。',
      '结论：可进入任务准备；实现 loop 仍需 maker/checker 与 QA 证据闭环。',
    ];
  }
  return [
    ...base,
    '规划检查：PRD、设计、架构、OpenSpec tasks、任务矩阵、测试用例和部署计划已对齐。',
    '结论：允许进入 OpenSpec Auto Deliver 开发 loop；production 仍必须保留人工发布门禁。',
  ];
}

async function writeLocalRoundtableReviewArtifact(
  entry: RuntimeEntry,
  spec: EvolutionRoundtableSpec,
  summary: string,
  reason: string,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const artifactPath = `discussions/roundtables/${spec.id}-local-review.md`;
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const artifactPaths = roundtableArtifactPaths(entry.run, spec);
  const content = [
    `# Local Roundtable Review: ${spec.topic}`,
    '',
    `- Run: \`${entry.run.runId}\``,
    `- Stage: \`${spec.stage}\``,
    `- Fallback reason: ${reason}`,
    `- Verdict: ${summary}`,
    `- Created at: ${new Date(nowMs).toISOString()}`,
    '',
    '## Role Perspectives',
    '',
    ...spec.roles.map((roleId) => `- ${roleId}: reviewed the current stage artifacts from its responsibility boundary.`),
    '',
    '## Checklist',
    '',
    ...localRoundtableChecklist(spec, artifactPaths).map((item) => `- ${item}`),
    '',
    '## Input Artifacts',
    '',
    ...(artifactPaths.length > 0 ? artifactPaths.map((path) => `- \`${path}\``) : ['- No matching artifacts were available at fallback time.']),
    '',
    '## Operating Boundary',
    '',
    '- This is a deterministic local fallback used only when no live IM.codes P2P helper session can run the roundtable.',
    '- It preserves auditability and keeps the self-evolution loop moving with minimal human intervention.',
    '- When helper sessions are available, the real IM.codes P2P roundtable remains the preferred adversarial review path.',
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  const artifact: EvolutionArtifactRef = {
    id: `roundtable_review:${spec.id}`,
    kind: 'roundtable_review',
    path: artifactPath,
    title: `Local Roundtable Review · ${spec.topic}`,
    preview: markdownPreview(content),
    roleId: roundtablePrimaryRole(spec),
    stage: spec.stage,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
  upsertArtifact(entry.run, artifact);
  return artifact;
}

function resolveProjectRootFromCommand(cmd: Record<string, unknown>): string | null {
  if (typeof cmd.projectRoot === 'string' && cmd.projectRoot.length > 0) return safeProjectRoot(cmd.projectRoot);
  if (typeof cmd.sessionName === 'string' && cmd.sessionName.length > 0) {
    const session = getSession(cmd.sessionName);
    if (session?.projectDir) return safeProjectRoot(session.projectDir);
  }
  return null;
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
      needs_human: '等待用户解除阻塞或确认门禁',
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
      implementation_loop: '监督实现 loop、约束技术基线和风险',
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
      delivery_ready: '确认 staging 候选质量证据',
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

function applyRoleStatesForStage(run: EvolutionRun, stage: EvolutionStage, nowMs: number): void {
  run.roles = run.roles.map((role) => {
    const currentAction = currentActionForRole(role.roleId, stage);
    const next = {
      ...role,
      status: roleStatusForStage(role.roleId, stage),
      stage,
      updatedAt: nowMs,
    };
    if (currentAction) next.currentAction = currentAction;
    else delete next.currentAction;
    return next;
  });
}

function upsertRoundtable(run: EvolutionRun, roundtable: EvolutionRoundtableRef): void {
  const existing = run.roundtables ?? [];
  const index = existing.findIndex((entry) => entry.id === roundtable.id);
  if (index >= 0) {
    run.roundtables = existing.map((entry, entryIndex) => entryIndex === index ? roundtable : entry);
  } else {
    run.roundtables = [...existing, roundtable];
  }
}

function roundtableMatchesRole(roundtable: EvolutionRoundtableRef, roleId: EvolutionRoleId | undefined): boolean {
  return !roleId || roundtable.roles.includes(roleId);
}

function runningRoundtablesForUserMessage(run: EvolutionRun, roleId: EvolutionRoleId | undefined): EvolutionRoundtableRef[] {
  const running = (run.roundtables ?? [])
    .filter((roundtable) => roundtable.status === 'running' && !!roundtable.p2pRunId && roundtableMatchesRole(roundtable, roleId));
  const currentStage = running.filter((roundtable) => roundtable.stage === run.stage);
  return currentStage.length > 0 ? currentStage : running;
}

function pauseQuestionId(runId: string, stage: EvolutionStage): string {
  return `user-pause-${runId}-${stage}`;
}

function pauseQuestionStage(run: EvolutionRun, questionId: string): EvolutionStage | null {
  const prefix = `user-pause-${run.runId}-`;
  if (!questionId.startsWith(prefix)) return null;
  const stage = questionId.slice(prefix.length);
  return isEvolutionStage(stage) ? stage : null;
}

function findUserPauseQuestion(run: EvolutionRun): { id: string; stage: EvolutionStage } | null {
  for (const question of [...run.blockingQuestions].reverse()) {
    const stage = pauseQuestionStage(run, question.id);
    if (stage) return { id: question.id, stage };
  }
  return null;
}

function inferHumanContinueTargetStage(run: EvolutionRun): EvolutionStage | null {
  const pauseQuestion = findUserPauseQuestion(run);
  if (pauseQuestion) return pauseQuestion.stage;
  for (const question of [...run.blockingQuestions].reverse()) {
    const strictMatch = question.id.match(new RegExp(`^strict-roundtable-${run.runId}-(.+)-blocked$`));
    if (strictMatch?.[1]) {
      const roundtable = (run.roundtables ?? []).find((entry) => entry.id === strictMatch[1]);
      if (roundtable) return roundtable.stage;
    }
    if (question.id === `planning-roundtable-${run.runId}-blocked`) return 'tasks_ready';
    if (question.id === `auto-delivery-${run.runId}-blocked`) return 'tasks_ready';
    if (question.id === `requirement-classification-${run.runId}`) return 'detected';
    if (question.id === `design-reference-images-missing-${run.runId}`) return 'design_lofi';
    if (question.id === `taste-skill-required-${run.runId}`) return 'design_lofi';
    if (question.id === `design-hifi-approval-${run.runId}`) return 'design_hifi';
    if (question.id === `design-hifi-regeneration-unchanged-${run.runId}`) return 'design_lofi';
    if (question.id.startsWith(`staging-config-${run.runId}-`)) return 'delivery_ready';
    if (question.id.startsWith(`staging-delivery-${run.runId}-`)) return 'delivery_ready';
    if (question.id.startsWith('openspec-')) return 'implementation_loop';
  }
  return null;
}

function releaseUserPauseGateForHumanContinue(
  run: EvolutionRun,
  targetStage: EvolutionStage,
  message: string | undefined,
  nowMs: number,
): void {
  const pauseQuestion = findUserPauseQuestion(run);
  if (!pauseQuestion) return;
  run.blockingQuestions = run.blockingQuestions.filter((question) => !pauseQuestionStage(run, question.id));
  appendDiscussion(run, {
    kind: 'gate',
    stage: targetStage,
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: `用户恢复自我进化任务，回到 ${targetStage} 继续执行。${message ? `说明：${message}` : ''}`,
    createdAt: nowMs,
  });
  appendEvidence(run, {
    source: 'user_pause_gate',
    summary: `Released user pause gate and resumed at ${targetStage}.`,
    createdAt: nowMs,
  });
}

function releaseRoundtableGateForHumanContinue(
  run: EvolutionRun,
  targetStage: EvolutionStage,
  message: string | undefined,
  nowMs: number,
): boolean {
  const releaseTargets = (run.roundtables ?? []).filter((roundtable) => {
    if (roundtable.stage !== targetStage) return false;
    if (roundtable.id === PLANNING_ROUNDTABLE_ID) {
      return planningRoundtableGateDecision(run).disposition === 'block';
    }
    if ((run.roundtableGateMode ?? 'planning') !== 'strict') return false;
    return roundtableGateDecision(roundtable, run).disposition === 'block';
  });
  for (const roundtable of releaseTargets) {
    // A human asking the pipeline to continue is not an agent/checker PASS.
    // Preserve the failed verdict as evidence, then remove only the active
    // roundtable reference so the same governed stage launches a fresh attempt.
    run.roundtables = (run.roundtables ?? []).filter((entry) => entry.id !== roundtable.id);
    appendDiscussion(run, {
      kind: 'gate',
      stage: targetStage,
      roleId: 'loop_supervisor',
      author: 'Loop Supervisor / 总控',
      text: `人工要求重新执行 ${roundtable.topic}，恢复到 ${targetStage} 后将启动新的受治理圆桌；原 REWORK/失败结论保持不变。${message ? `说明：${message}` : ''}`,
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'human_roundtable_retry',
      summary: [
        `Human requested a fresh ${roundtable.id} attempt at ${targetStage}.`,
        `Previous status=${roundtable.status}.`,
        roundtable.p2pRunId ? `Previous p2pRunId=${roundtable.p2pRunId}.` : '',
        roundtable.summary ? `Previous verdict=${roundtable.summary.slice(0, 500)}.` : '',
        roundtable.error ? `Previous error=${roundtable.error.slice(0, 500)}.` : '',
      ].filter(Boolean).join(' '),
      createdAt: nowMs,
    });
    run.blockingQuestions = run.blockingQuestions.filter((question) => (
      question.id !== `strict-roundtable-${run.runId}-${roundtable.id}-blocked` &&
      question.id !== `planning-roundtable-${run.runId}-blocked`
    ));
  }
  return releaseTargets.length > 0;
}

function evolutionScoreModuleForOpenSpec(module: string): EvolutionScoreModuleId | null {
  if (module === 'spec') return 'architecture';
  if (module === 'tasks') return 'tasks';
  if (module === 'implementation') return 'implementation';
  if (module === 'tests') return 'tests';
  if (module === 'risk') return 'risk';
  return null;
}

async function persistAndProject(entry: RuntimeEntry, nowMs: number): Promise<EvolutionProjection> {
  return withEvolutionMutationCommit(entry.run.runId, async () => {
    initializeEvolutionControlState(entry.run);
    nextEvolutionRunRevision(entry.run);
    entry.run.updatedAt = nowMs;
    await writeEvolutionRun(entry.projectRoot, entry.run);
    return buildEvolutionProjection(entry.run, nowMs);
  });
}

function isManualWarRoomStopReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && /stopped from evolution war room|stopped by request|manual stop|用户要求结束当前自我进化任务/i.test(reason);
}

function isWarRoomPauseReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && /paused from evolution war room|pause from evolution war room|用户暂停|暂停任务/i.test(reason);
}

function normalizeHydratedEvolutionRun(run: EvolutionRun, nowMs: number): boolean {
  let changed = false;
  if (run.controlVersion !== 2) {
    initializeEvolutionControlState(run);
    for (const artifact of run.artifacts) {
      artifact.status ??= artifact.kind === 'input' || artifact.kind === 'role_skill' ? 'approved' : 'candidate';
      artifact.assurance ??= artifact.kind === 'input' || artifact.kind === 'role_skill' ? 'observed' : 'legacy_unverified';
    }
    for (const score of run.scores) score.source ??= 'heuristic';
    changed = true;
  }
  if (run.stage === 'stopped' && isManualWarRoomStopReason(run.terminalReason) && run.latestMessage !== run.terminalReason) {
    run.latestMessage = run.terminalReason;
    changed = true;
  }
  if (changed && run.updatedAt < nowMs) run.updatedAt = nowMs;
  return changed;
}

async function writeProductionReleaseGateArtifact(
  entry: RuntimeEntry,
  approvalMessage: string,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const artifactPath = 'release/release-gate.md';
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const content = [
    '# Production Release Gate',
    '',
    `- Run: \`${entry.run.runId}\``,
    `- Stage before approval: \`${entry.run.stage}\``,
    `- Approved at: ${new Date(nowMs).toISOString()}`,
    `- Approved by: War Room human operator`,
    `- Requirement: \`${entry.run.source.relativePath}\``,
    `- Staging status: ${entry.run.stagingDelivery?.status ?? 'not_recorded'}`,
    entry.run.stagingDelivery?.logArtifactId ? `- Staging log: \`${entry.run.stagingDelivery.logArtifactId}\`` : '- Staging log: not recorded',
    '',
    '## Approval Message',
    '',
    approvalMessage.trim() || 'Production release gate approved from Evolution War Room.',
    '',
    '## Safety Boundary',
    '',
    '- This gate records human approval and completes the Evolution run ledger.',
    '- IM.codes does not execute any production deployment command from this gate.',
    '- Production execution remains an external/manual action or a separately audited workflow.',
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return {
    id: 'release_gate:release/release-gate.md',
    kind: 'release_gate',
    path: artifactPath,
    title: 'Production Release Gate',
    preview: markdownPreview(content),
    roleId: 'ops_release_manager',
    stage: 'human_release_gate',
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
}

async function snapshotRejectedHifiReviewSet(
  entry: RuntimeEntry,
  feedback: string,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const revisionName = `human-${new Date(nowMs).toISOString().replace(/[-:.]/g, '')}`;
  const revisionRelativeDir = `design/revisions/${revisionName}`;
  const visualArtifacts = entry.run.artifacts.filter((artifact) => (
    artifact.stage === 'design_hifi'
    && /\.(?:svg|png|jpe?g|webp)$/i.test(artifact.path)
  ));
  const copied: Array<{ artifactId: string; sourcePath: string; snapshotPath: string; sha256?: string }> = [];
  for (const artifact of visualArtifacts) {
    const snapshotRelativePath = `${revisionRelativeDir}/${artifact.path.replace(/^design\//, '')}`;
    const sourcePath = safeRunArtifactPath(paths.runDir, artifact.path);
    const snapshotPath = safeRunArtifactPath(paths.runDir, snapshotRelativePath);
    await mkdir(dirname(snapshotPath), { recursive: true });
    await copyFile(sourcePath, snapshotPath);
    copied.push({
      artifactId: artifact.id,
      sourcePath: artifact.path,
      snapshotPath: snapshotRelativePath,
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
    });
  }
  const manifestRelativePath = `${revisionRelativeDir}/review.json`;
  const manifestPath = safeRunArtifactPath(paths.runDir, manifestRelativePath);
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    runId: entry.run.runId,
    verdict: 'REWORK',
    verdictSource: 'human_gate',
    feedback: feedback.slice(0, 2_000),
    frozenAt: new Date(nowMs).toISOString(),
    artifacts: copied,
  }, null, 2)}\n`;
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, manifest, 'utf8');
  return {
    id: `visual_fidelity_report:${manifestRelativePath}`,
    kind: 'visual_fidelity_report',
    path: manifestRelativePath,
    title: `Rejected High-Fidelity Review Set · ${revisionName}`,
    preview: {
      previewType: 'text',
      content: manifest,
      language: 'json',
    },
    roleId: 'visual_designer',
    stage: 'design_hifi',
    sha256: sha256(manifest),
    bytes: Buffer.byteLength(manifest),
    createdAt: nowMs,
  };
}

function executionTimelineId(source: string, value: string, createdAt: number): string {
  return `exec-${shortSha256(`${source}:${value}:${createdAt}`)}`;
}

function truncateTimelineDetail(value: string, max = 180): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function parseRoleIdFromEvidenceSource(source: string): EvolutionRoleId | null {
  const [, maybeRoleId] = source.split(':', 2);
  if (maybeRoleId && (EVOLUTION_ROLE_IDS as readonly string[]).includes(maybeRoleId)) {
    return maybeRoleId as EvolutionRoleId;
  }
  return null;
}

function timelineRoleForEvidence(evidence: EvolutionEvidence): EvolutionRoleId {
  const source = evidence.source.toLowerCase();
  const summary = evidence.summary.toLowerCase();
  const explicitRole = source.startsWith('user:') ? parseRoleIdFromEvidenceSource(source) : null;
  if (explicitRole) return explicitRole;
  if (source.includes('release_gate') || summary.includes('production release')) return 'ops_release_manager';
  if (source.startsWith('openspec_score:')) return openSpecModuleRole(source.split(':')[1] ?? 'implementation');
  if (source === 'openspec_task_board') return 'tech_director';
  if (source.includes('taste') || source.includes('hifi') || summary.includes('taste-skill') || summary.includes('high-fidelity')) return 'visual_designer';
  if (source.includes('staging') || source.includes('delivery') || summary.includes('staging') || summary.includes('deployment')) return 'ops_release_manager';
  if (source.includes('p2p') || source.includes('roundtable')) return 'tech_director';
  if (source.includes('human') || summary.includes('needs human') || summary.includes('gate')) return 'loop_supervisor';
  if (source.includes('openspec') || summary.includes('openspec')) {
    if (summary.includes('implementation_audit') || summary.includes('audit') || summary.includes('test') || summary.includes('passed')) return 'qa_engineer';
    if (summary.includes('frontend') || summary.includes('ui')) return 'frontend_developer';
    return 'backend_developer';
  }
  if (summary.includes('security')) return 'security_reviewer';
  if (summary.includes('frontend') || summary.includes('ui')) return 'frontend_developer';
  if (summary.includes('implementation') || summary.includes('task') || summary.includes('prompt') || summary.includes('build')) return 'backend_developer';
  if (summary.includes('test') || summary.includes('qa') || summary.includes('audit')) return 'qa_engineer';
  if (summary.includes('prd') || summary.includes('product')) return 'product_manager';
  return 'loop_supervisor';
}

function timelineStageForEvidence(evidence: EvolutionEvidence, fallback: EvolutionStage): EvolutionStage {
  const source = evidence.source.toLowerCase();
  const summary = evidence.summary.toLowerCase();
  if (source.includes('release_gate') || summary.includes('production release')) return 'human_release_gate';
  if (source.includes('taste') || source.includes('hifi') || summary.includes('taste-skill') || summary.includes('high-fidelity')) return 'design_hifi';
  if (source.includes('staging') || summary.includes('staging delivery')) {
    if (summary.includes('failed') || summary.includes('invalid')) return 'needs_human';
    if (summary.includes('passed')) return 'deployed_staging';
    return 'delivery_ready';
  }
  if (source.includes('openspec') || summary.includes('openspec auto deliver')) {
    if (summary.includes('needs_human') || summary.includes('needs human')) return 'needs_human';
    if (summary.includes('failed')) return 'failed';
    if (summary.includes('stopped')) return 'stopped';
    if (summary.includes('implementation_audit')) return 'qa_completion';
    if (summary.includes('passed')) return 'delivery_ready';
    if (summary.includes('implementation') || summary.includes('task')) return 'implementation_loop';
  }
  return fallback;
}

function timelineStatusForEvidence(evidence: EvolutionEvidence, stage: EvolutionStage): EvolutionRoleStatus {
  const source = evidence.source.toLowerCase();
  const summary = evidence.summary.toLowerCase();
  if (typeof evidence.exitCode === 'number') return evidence.exitCode === 0 ? 'complete' : 'failed';
  if (source.startsWith('user:') || source === 'user') return 'waiting';
  if (stage === 'failed') return 'failed';
  if (stage === 'needs_human' || summary.includes('failed') || summary.includes('blocked') || summary.includes('could not') || summary.includes('invalid')) return 'blocked';
  if (summary.includes('starting') || summary.includes('running') || summary.includes('dispatched')) return 'running';
  if (summary.includes('waiting') || summary.includes('disabled') || summary.includes('not_configured') || summary.includes('not configured') || summary.includes('gate')) return 'waiting';
  return 'complete';
}

function buildExecutionTimeline(run: EvolutionRun): EvolutionExecutionTimelineItem[] {
  const entries: EvolutionExecutionTimelineItem[] = [];
  for (const role of run.roles) {
    if (role.currentAction) {
      entries.push({
        id: executionTimelineId('role', role.roleId, role.updatedAt),
        roleId: role.roleId,
        stage: role.stage ?? run.stage,
        status: role.status,
        title: `${role.label ?? role.roleId} · 当前任务`,
        detail: role.currentAction,
        source: 'role',
        createdAt: role.updatedAt,
      });
    }
  }
  for (const message of run.discussion ?? []) {
    if (!message.roleId) continue;
    entries.push({
      id: executionTimelineId('discussion', message.id, message.createdAt),
      roleId: message.roleId,
      stage: message.stage,
      status: run.roles.find((role) => role.roleId === message.roleId)?.status ?? 'pending',
      title: `${message.author} · ${message.kind}`,
      detail: truncateTimelineDetail(message.text),
      ...(message.artifactIds ? { artifactIds: [...message.artifactIds] } : {}),
      source: 'discussion',
      createdAt: message.createdAt,
    });
  }
  for (const artifact of run.artifacts ?? []) {
    if (!artifact.roleId) continue;
    entries.push({
      id: executionTimelineId('artifact', artifact.id, artifact.createdAt),
      roleId: artifact.roleId,
      stage: artifact.stage ?? run.stage,
      status: run.roles.find((role) => role.roleId === artifact.roleId)?.status ?? 'pending',
      title: `产物 · ${artifact.title ?? artifact.kind}`,
      detail: artifact.path,
      artifactIds: [artifact.id],
      source: 'artifact',
      createdAt: artifact.createdAt,
    });
  }
  for (const [index, evidence] of (run.evidence ?? []).entries()) {
    const stage = timelineStageForEvidence(evidence, run.stage);
    entries.push({
      id: executionTimelineId('evidence', `${evidence.source}:${index}`, evidence.createdAt),
      roleId: timelineRoleForEvidence(evidence),
      stage,
      status: timelineStatusForEvidence(evidence, stage),
      title: `证据 · ${evidence.source}`,
      detail: truncateTimelineDetail(evidence.command ? `${evidence.summary} · ${evidence.command}` : evidence.summary),
      ...(evidence.artifactId ? { artifactIds: [evidence.artifactId] } : {}),
      source: 'evidence',
      createdAt: evidence.createdAt,
    });
  }
  for (const roundtable of run.roundtables ?? []) {
    for (const roleId of roundtable.roles) {
      entries.push({
        id: executionTimelineId('roundtable', `${roundtable.id}:${roleId}`, roundtable.updatedAt),
        roleId,
        stage: roundtable.stage,
        status: roundtable.status === 'failed' ? 'blocked' : roundtable.status === 'running' ? 'running' : roundtable.status === 'complete' ? 'complete' : 'waiting',
        title: `圆桌 · ${roundtable.topic}`,
        detail: truncateTimelineDetail(roundtable.summary ?? roundtable.error ?? `${roundtable.status}${roundtable.p2pRunId ? ` · ${roundtable.p2pRunId}` : ''}`),
        source: 'roundtable',
        createdAt: roundtable.updatedAt,
      });
    }
  }
  return entries
    .sort((a, b) => b.createdAt - a.createdAt || a.roleId.localeCompare(b.roleId))
    .slice(0, 80);
}

function stageOrderIndex(stage: EvolutionStage): number {
  const order: EvolutionStage[] = [
    'detected',
    'intake_normalized',
    'product_discussion',
    'prd_ready',
    'design_lofi',
    'design_hifi',
    'architecture_baseline',
    'tasks_ready',
    'implementation_loop',
    'qa_completion',
    'delivery_ready',
    'deployed_staging',
    'human_release_gate',
    'deployed_production',
  ];
  const index = order.indexOf(stage);
  return index >= 0 ? index : order.length;
}

function artifactIdsForKinds(run: EvolutionRun, kinds: readonly EvolutionArtifactKind[]): string[] {
  return run.artifacts
    .filter((artifact) => kinds.includes(artifact.kind))
    .map((artifact) => artifact.id);
}

function loopSignalWeight(status: EvolutionLoopControlSignalStatus): number {
  switch (status) {
    case 'complete': return 1;
    case 'ready': return 0.75;
    case 'running': return 0.6;
    case 'blocked': return 0.2;
    case 'missing': return 0;
  }
}

function buildLoopControlMode(run: EvolutionRun): EvolutionLoopControlMode {
  if (isEvolutionTerminalStage(run.stage)) return 'terminal';
  if (run.stage === 'needs_human' || run.stage === 'human_release_gate') return 'human_gate';
  return run.autoDelivery?.enabled ? 'auto_implementation' : 'planning_only';
}

function roundtableSignal(run: EvolutionRun): EvolutionLoopControlSignal {
  const roundtables = run.roundtables ?? [];
  const failed = roundtables.find((roundtable) => roundtable.status === 'failed');
  const running = roundtables.find((roundtable) => roundtable.status === 'running');
  const planned = roundtables.find((roundtable) => roundtable.status === 'planned');
  if (failed) {
    return {
      id: 'p2p_roundtables',
      label: 'P2P roundtables',
      status: 'blocked',
      detail: `${failed.topic} blocked: ${failed.error ?? failed.summary ?? 'unknown failure'}`,
    };
  }
  if (running) {
    return {
      id: 'p2p_roundtables',
      label: 'P2P roundtables',
      status: 'running',
      detail: `${running.topic} is running${running.currentTargetSession ? ` with ${running.currentTargetSession}` : ''}.`,
    };
  }
  if (planned) {
    return {
      id: 'p2p_roundtables',
      label: 'P2P roundtables',
      status: 'ready',
      detail: `${planned.topic} is planned and waiting for worker dispatch.`,
    };
  }
  if (roundtables.length > 0) {
    const verified = roundtables.filter((roundtable) => {
      const verdict = roundtable.verdictId
        ? (run.verdictRecords ?? []).find((entry) => entry.id === roundtable.verdictId)
        : undefined;
      return roundtable.status === 'complete' && verdict?.machineReadable === true && verdict.verdict === 'PASS';
    });
    return {
      id: 'p2p_roundtables',
      label: 'P2P roundtables',
      status: verified.length === roundtables.length ? 'complete' : 'blocked',
      detail: `${verified.length}/${roundtables.length} roundtables have a bound machine-readable PASS verdict.`,
    };
  }
  return {
    id: 'p2p_roundtables',
    label: 'P2P roundtables',
    status: 'ready',
    detail: 'Roundtable checkpoints are registered for product, design, architecture, and planning review stages.',
  };
}

function buildLoopControlSignals(run: EvolutionRun): EvolutionLoopControlSignal[] {
  const roleSkillArtifacts = run.artifacts.filter((artifact) => artifact.kind === 'role_skill');
  const makerCheckerArtifactIds = artifactIdsForKinds(run, ['implementation_task_matrix', 'openspec_tasks']);
  const hifiArtifactIds = artifactIdsForKinds(run, ['hifi_mockup', 'taste_hifi_prompt', 'taste_hifi_output', 'design_handoff']);
  const qaArtifactIds = artifactIdsForKinds(run, ['test_plan', 'test_cases', 'test_evidence']);
  const deliveryArtifactIds = artifactIdsForKinds(run, ['deployment_plan', 'staging_setup', 'staging_config_example', 'staging_deploy_log', 'release_gate']);
  const implementationBlocked = run.blockingQuestions.some((question) => question.id.startsWith('openspec-'));
  const afterQa = stageOrderIndex(run.stage) >= stageOrderIndex('qa_completion');
  const deliveryBlocked = run.stagingDelivery?.status === 'failed';
  const scoreCount = run.scores.length;
  const lowScore = run.scores.find((score) => score.score < 5);
  const verifiedScoreCount = run.scores.filter((score) => score.source === 'checker' || score.source === 'human').length;
  const authorizedMakerChecker = ['implementation/agent-task-matrix.md', run.linkedOpenSpecChange ? `openspec/changes/${run.linkedOpenSpecChange}/tasks.md` : '']
    .filter(Boolean)
    .every((path) => !!run.authorizedRevisions?.[path]);
  const hifiApproved = (run.designReviewSets ?? []).some((reviewSet) => reviewSet.status === 'approved');
  const snapshotRoleCount = new Set((run.skillSnapshots ?? []).map((snapshot) => snapshot.roleId)).size;
  return [
    {
      id: 'state_memory',
      label: 'State + memory',
      status: run.controlVersion === 2 && typeof run.runRevision === 'number' ? 'complete' : 'ready',
      detail: run.controlVersion === 2
        ? `v2 run ledger revision ${run.runRevision ?? 0} persists attempts, immutable revisions, verdicts, gates, and review sets for ${run.runId}.`
        : 'Legacy run is viewable but has no verified v2 authorization ledger.',
    },
    {
      id: 'role_skills',
      label: 'Role skills',
      status: snapshotRoleCount >= run.roles.length ? 'complete' : 'missing',
      detail: `${snapshotRoleCount}/${run.roles.length} exact role-skill byte snapshots are available; a snapshot becomes execution evidence only when an attempt binds it.`,
      artifactIds: roleSkillArtifacts.slice(0, 6).map((artifact) => artifact.id),
    },
    roundtableSignal(run),
    {
      id: 'high_fidelity_design',
      label: 'High-fidelity design',
      status: hifiApproved
        ? 'complete'
        : hifiArtifactIds.length > 0
          ? (run.executionPolicy ?? 'draft_preview') === 'draft_preview' ? 'complete' : 'ready'
          : 'missing',
      detail: hifiArtifactIds.length > 0
        ? hifiApproved
          ? 'The frozen high-fidelity review set is human-approved and can be consumed downstream.'
          : 'High-fidelity candidates exist but are not an approved downstream input yet.'
        : 'Waiting for design_hifi stage to create taste-skill/high-fidelity handoff.',
      ...(hifiArtifactIds.length > 0 ? { artifactIds: hifiArtifactIds.slice(0, 6) } : {}),
    },
    {
      id: 'maker_checker_tasks',
      label: 'Maker/checker tasks',
      status: authorizedMakerChecker
        ? 'complete'
        : makerCheckerArtifactIds.length > 0
          ? (run.executionPolicy ?? 'draft_preview') === 'draft_preview' ? 'complete' : 'ready'
          : stageOrderIndex(run.stage) >= stageOrderIndex('architecture_baseline') ? 'ready' : 'missing',
      detail: makerCheckerArtifactIds.length > 0
        ? authorizedMakerChecker
          ? 'OpenSpec tasks and implementation matrix are authorized by a bound planning verdict.'
          : 'Task candidates assign ownership but are waiting for a bound planning verdict.'
        : 'Task matrix is generated after architecture baseline.',
      ...(makerCheckerArtifactIds.length > 0 ? { artifactIds: makerCheckerArtifactIds.slice(0, 4) } : {}),
    },
    {
      id: 'quality_scores',
      label: 'Quality scores',
      status: lowScore ? 'blocked' : verifiedScoreCount >= 6 ? 'complete' : scoreCount > 0 ? 'ready' : 'missing',
      detail: lowScore
        ? `${lowScore.module} score is ${lowScore.score}/10 and requires repair.`
        : `${scoreCount} score modules recorded; ${verifiedScoreCount} are checker/human scores and the rest are heuristic previews.`,
      ...(qaArtifactIds.length > 0 ? { artifactIds: qaArtifactIds.slice(0, 4) } : {}),
    },
    {
      id: 'implementation_loop',
      label: 'Implementation loop',
      status: implementationBlocked ? 'blocked' : afterQa ? 'complete' : run.linkedAutoDeliverRunId || run.stage === 'implementation_loop' ? 'running' : run.linkedOpenSpecChange ? 'ready' : 'missing',
      detail: run.linkedAutoDeliverRunId
        ? `OpenSpec Auto Deliver run ${run.linkedAutoDeliverRunId} is linked back into this Evolution run.`
        : run.linkedOpenSpecChange
          ? `OpenSpec change ${run.linkedOpenSpecChange} is ready for multi-agent development.`
          : 'Implementation loop starts after tasks_ready and planning gate.',
    },
    {
      id: 'delivery_gate',
      label: 'Delivery + release gate',
      status: deliveryBlocked ? 'blocked' : run.stage === 'deployed_production' ? 'complete' : run.stage === 'human_release_gate' || run.stage === 'deployed_staging' ? 'ready' : stageOrderIndex(run.stage) >= stageOrderIndex('delivery_ready') ? 'running' : 'missing',
      detail: deliveryBlocked
        ? `Staging failed: ${run.stagingDelivery?.lastError ?? run.stagingDelivery?.summary ?? 'unknown error'}`
        : run.stage === 'human_release_gate'
          ? 'Staging is complete or bypassed; production remains a human gate.'
          : 'Staging can be automated, while production execution remains manually approved.',
      ...(deliveryArtifactIds.length > 0 ? { artifactIds: deliveryArtifactIds.slice(0, 5) } : {}),
    },
  ];
}

function buildCurrentLoopGate(run: EvolutionRun): string {
  const latestBlocker = [...run.blockingQuestions].reverse()[0];
  if (latestBlocker) return latestBlocker.question;
  if (run.stage === 'human_release_gate') return 'Production release requires explicit human approval.';
  if (run.stage === 'needs_human') return 'Human input is required before the loop can continue.';
  if (run.stage === 'tasks_ready' && !run.autoDelivery?.enabled) return 'Planning complete; auto implementation is disabled until manually started.';
  const activeRoundtable = (run.roundtables ?? []).find((roundtable) => roundtable.status === 'running' || roundtable.status === 'planned');
  if (activeRoundtable) return `${activeRoundtable.topic} is ${activeRoundtable.status}.`;
  if (isEvolutionTerminalStage(run.stage)) return run.terminalReason ?? `Terminal stage: ${run.stage}.`;
  return 'No blocking gate; loop may continue within configured budget and safety policy.';
}

function buildLoopControl(run: EvolutionRun, nowMs: number): EvolutionLoopControl {
  const signals = buildLoopControlSignals(run);
  const readinessScore = Math.round((signals.reduce((sum, signal) => sum + loopSignalWeight(signal.status), 0) / Math.max(1, signals.length)) * 100);
  const mode = buildLoopControlMode(run);
  const blocking = run.blockingQuestions.length > 0 || signals.some((signal) => signal.status === 'blocked');
  const manualImplementationGate = run.stage === 'tasks_ready' && !run.autoDelivery?.enabled;
  const elapsedMinutes = Math.max(0, Math.ceil((nowMs - run.createdAt) / 60000));
  const canAutonomouslyContinue = mode !== 'terminal'
    && mode !== 'human_gate'
    && !blocking
    && !manualImplementationGate
    && elapsedMinutes <= run.budget.maxElapsedMinutes;
  return {
    source: 'loop_engineering',
    mode,
    readinessScore,
    canAutonomouslyContinue,
    currentGate: buildCurrentLoopGate(run),
    budget: { ...run.budget },
    usage: {
      elapsedMinutes,
      roleTurns: run.discussion.filter((entry) => entry.kind === 'role_update' || entry.kind === 'artifact_summary').length,
      implementationAttempts: run.evidence.filter((entry) => entry.source.toLowerCase().includes('openspec') || entry.source.toLowerCase().includes('auto_deliver')).length,
      artifactCount: run.artifacts.length,
      evidenceCount: run.evidence.length,
      discussionCount: run.discussion.length,
    },
    signals,
    updatedAt: nowMs,
  };
}

export function buildEvolutionProjection(run: EvolutionRun, nowMs = Date.now()): EvolutionProjection {
  const executionTimeline = run.executionTimeline ?? buildExecutionTimeline(run);
  return {
    projectionVersion: 1,
    ...(run.controlVersion === 2 ? { controlVersion: 2 as const } : {}),
    ...(typeof run.runRevision === 'number' ? { runRevision: run.runRevision } : {}),
    runId: run.runId,
    requestId: run.requestId,
    stage: run.stage,
    ...(run.verdict ? { verdict: run.verdict } : {}),
    sessionName: run.sessionName,
    ...(run.projectName ? { projectName: run.projectName } : {}),
    source: { ...run.source },
    roles: run.roles.map((role) => ({ ...role })),
    artifacts: run.artifacts.map((artifact) => ({ ...artifact })),
    scores: run.scores.map((score) => ({ ...score })),
    blockingQuestions: run.blockingQuestions.map((question) => ({ ...question })),
    discussion: (run.discussion ?? []).map((entry) => ({
      ...entry,
      ...(entry.artifactIds ? { artifactIds: [...entry.artifactIds] } : {}),
    })),
    roundtables: (run.roundtables ?? []).map((entry) => ({
      ...entry,
      roles: [...entry.roles],
    })),
    roundtableGateMode: run.roundtableGateMode ?? 'planning',
    designTargetSurface: run.designTargetSurface ?? 'auto',
    developmentMode: run.developmentMode ?? 'brownfield_refactor',
    ...(run.developmentTargetRelativeDir ? { developmentTargetRelativeDir: run.developmentTargetRelativeDir } : {}),
    executionPolicy: run.executionPolicy ?? 'draft_preview',
    ...(run.greenfieldTopology ? { greenfieldTopology: run.greenfieldTopology } : {}),
    ...(run.writePolicy ? { writePolicy: {
      ...run.writePolicy,
      allowedRoots: [...run.writePolicy.allowedRoots],
      deniedRoots: [...run.writePolicy.deniedRoots],
      protectedRoots: [...run.writePolicy.protectedRoots],
    } } : {}),
    requireHifiHumanApproval: run.requireHifiHumanApproval === true,
    ...(run.roleProfiles ? { roleProfiles: run.roleProfiles.map((entry) => ({ ...entry, responsibilities: [...entry.responsibilities] })) } : {}),
    ...(run.skillSnapshots ? { skillSnapshots: run.skillSnapshots.map((entry) => ({ ...entry })) } : {}),
    ...(run.artifactRevisions ? { artifactRevisions: run.artifactRevisions.map((entry) => ({ ...entry })) } : {}),
    ...(run.attempts ? { attempts: run.attempts.map((entry) => ({
      ...entry,
      inputRevisionIds: [...entry.inputRevisionIds],
      skillSnapshotIds: [...entry.skillSnapshotIds],
      outputRevisionIds: [...entry.outputRevisionIds],
    })) } : {}),
    ...(run.verdictRecords ? { verdictRecords: run.verdictRecords.map((entry) => ({
      ...entry,
      inputRevisionIds: [...entry.inputRevisionIds],
      approvedRevisionIds: [...entry.approvedRevisionIds],
    })) } : {}),
    ...(run.gates ? { gates: run.gates.map((entry) => ({
      ...entry,
      candidateRevisionIds: [...entry.candidateRevisionIds],
      ...(entry.decision ? { decision: { ...entry.decision } } : {}),
    })) } : {}),
    ...(run.designReviewSets ? { designReviewSets: run.designReviewSets.map((entry) => ({ ...entry, revisionIds: [...entry.revisionIds] })) } : {}),
    ...(run.authorizedRevisions ? { authorizedRevisions: { ...run.authorizedRevisions } } : {}),
    ...(run.foundationEvidence ? { foundationEvidence: run.foundationEvidence.map((entry) => ({
      ...entry,
      artifactRevisionIds: [...entry.artifactRevisionIds],
    })) } : {}),
    evidence: run.evidence.map((entry) => ({ ...entry })),
    executionTimeline: executionTimeline.map((entry) => ({
      ...entry,
      ...(entry.artifactIds ? { artifactIds: [...entry.artifactIds] } : {}),
    })),
    liveEvents: (run.liveEvents ?? []).map((entry) => ({
      ...entry,
      ...(entry.progress ? { progress: { ...entry.progress } } : {}),
      ...(entry.artifactIds ? { artifactIds: [...entry.artifactIds] } : {}),
    })),
    loopControl: buildLoopControl(run, nowMs),
    ...(run.autoDelivery ? { autoDelivery: { ...run.autoDelivery } } : {}),
    ...(run.stagingDelivery ? { stagingDelivery: { ...run.stagingDelivery } } : {}),
    ...(run.linkedOpenSpecChange ? { linkedOpenSpecChange: run.linkedOpenSpecChange } : {}),
    ...(run.linkedAutoDeliverRunId ? { linkedAutoDeliverRunId: run.linkedAutoDeliverRunId } : {}),
    ...(run.latestMessage ? { latestMessage: run.latestMessage } : {}),
    ...(run.terminalReason ? { terminalReason: run.terminalReason } : {}),
    // B3 — while a user pause is in effect, distinguish "pausing" (the
    // autopilot task is still in flight until its next checkpoint) from
    // "paused" (nothing is executing anymore) so the UI never implies an
    // instantaneous stop that hasn't actually happened.
    ...(run.stage === 'needs_human' && findUserPauseQuestion(run)
      ? { userPauseState: activeAutopilotRuns.has(run.runId) ? 'pausing' as const : 'paused' as const }
      : {}),
    elapsedMs: Math.max(0, nowMs - run.createdAt),
    updatedAt: run.updatedAt,
  };
}

export async function launchEvolutionRun(options: LaunchEvolutionRunOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const normalizedRequest = normalizeEvolutionLaunchRequest(options.projectRoot, options.request);
  const validated = validateEvolutionLaunchRequest(normalizedRequest);
  if (!validated.ok) return validated as EvolutionOrchestratorResult<EvolutionProjection>;
  let greenfieldInventorySha256: string | undefined;
  if (validated.value.developmentMode === 'greenfield_new_system' && validated.value.developmentTargetRelativeDir) {
    const inspection = await inspectGreenfieldTarget(
      options.projectRoot,
      validated.value.developmentTargetRelativeDir,
    );
    if (!inspection.ok) return fail(inspection.code, inspection.message, 'developmentTargetRelativeDir');
    greenfieldInventorySha256 = inspection.inventorySha256;
  }
  const request = validated.value;
  const fingerprint = launchFingerprint(request);
  const cached = requestProjectionByFingerprint.get(fingerprint);
  if (cached) return ok(cached);

  const projectRoot = safeProjectRoot(options.projectRoot);
  try {
    const run = await createEvolutionRunFromRequirement({
      projectRoot,
      request,
      ...(typeof options.nowMs === 'number' ? { nowMs: options.nowMs } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    });
    if (greenfieldInventorySha256 && run.writePolicy && run.developmentTargetRelativeDir) {
      run.writePolicy.targetRelativeDir = run.developmentTargetRelativeDir;
      run.writePolicy.targetInventorySha256 = greenfieldInventorySha256;
      run.writePolicy.inventoryCapturedAt = options.nowMs ?? Date.now();
      await writeEvolutionRun(projectRoot, run);
    }
    upsertRuntime(projectRoot, run);
    const projection = buildEvolutionProjection(run, options.nowMs ?? Date.now());
    requestProjectionByFingerprint.set(fingerprint, projection);
    return ok(projection);
  } catch (error) {
    return fail('evolution_launch_failed', describeUnknownError(error));
  }
}

export async function launchEvolutionDemoRun(options: LaunchEvolutionDemoRunOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  if (!options.sessionName) return fail('missing_session_name', 'sessionName is required.', 'sessionName');
  if (!options.requestId) return fail('missing_request_id', 'requestId is required.', 'requestId');
  const projectRoot = safeProjectRoot(options.projectRoot);
  const nowMs = options.nowMs ?? Date.now();
  const content = renderEvolutionDemoRequirement(nowMs);
  const sourceRelativePath = buildDemoRequirementRelativePath(options.requestId, nowMs);
  const sourcePath = safeProjectRelativePath(projectRoot, sourceRelativePath);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, content, 'utf8');
  return launchEvolutionRun({
    projectRoot,
    nowMs,
    request: {
      requestId: options.requestId,
      ...(options.serverId ? { serverId: options.serverId } : {}),
      sessionName: options.sessionName,
      projectName: options.projectName ?? 'Evolution Factory Demo',
      sourceRelativePath,
      sourceSizeBytes: Buffer.byteLength(content),
      sourceSha256: sha256(content),
      locale: options.locale ?? 'zh-CN',
      requestedBy: 'demo',
      autoStart: options.autoStart ?? true,
      autoStartImplementation: options.autoStartImplementation ?? true,
      autoDeliverPresetId: options.autoDeliverPresetId ?? 'standard',
      autoCommitPush: options.autoCommitPush === true,
      roundtableGateMode: options.roundtableGateMode ?? 'planning',
      designTargetSurface: options.designTargetSurface ?? 'auto',
      developmentMode: options.developmentMode ?? 'brownfield_refactor',
      ...(options.executionPolicy ? { executionPolicy: options.executionPolicy } : {}),
      ...(options.developmentTargetRelativeDir ? { developmentTargetRelativeDir: options.developmentTargetRelativeDir } : {}),
      ...(options.greenfieldTopology ? { greenfieldTopology: options.greenfieldTopology } : {}),
      requireHifiHumanApproval: options.requireHifiHumanApproval === true,
    },
  });
}

export async function importEvolutionReferenceBrief(
  options: ImportEvolutionReferenceBriefOptions,
): Promise<EvolutionOrchestratorResult<EvolutionReferenceBriefImportResult>> {
  if (!options.sessionName) return fail('missing_session_name', 'sessionName is required.', 'sessionName');
  if (!options.requestId) return fail('missing_request_id', 'requestId is required.', 'requestId');
  if (!Array.isArray(options.attachments) || options.attachments.length === 0) {
    return fail('missing_reference_images', 'At least one reference image is required.', 'attachments');
  }
  if (options.attachments.length > 24) {
    return fail('too_many_reference_images', 'Reference image import supports up to 24 images.', 'attachments');
  }

  const projectRoot = safeProjectRoot(options.projectRoot);
  const nowMs = options.nowMs ?? Date.now();
  const taskRelativeDir = buildReferenceRequirementRelativeDir(options.requestId, options.taskName ?? options.note, nowMs);
  const referencesRelativeDir = `${taskRelativeDir}/references`;
  const referencesDir = safeProjectRelativePath(projectRoot, referencesRelativeDir);
  await mkdir(referencesDir, { recursive: true });

  const copiedImages: EvolutionReferenceBriefImportResult['copiedImages'] = [];
  const usedFileNames = new Set<string>();
  for (let index = 0; index < options.attachments.length; index += 1) {
    const input = options.attachments[index];
    const attachmentId = input.attachmentId?.trim();
    if (!attachmentId) return fail('missing_reference_attachment_id', 'Reference attachment id is required.', `attachments.${index}.attachmentId`);
    const attachment = lookupAttachmentById(attachmentId);
    if (!attachment) {
      return fail('reference_attachment_not_found', `Reference attachment ${attachmentId} was not found or expired.`, `attachments.${index}.attachmentId`);
    }
    const originalName = input.originalName || attachment.originalName || `${attachmentId}.png`;
    const ext = referenceImageExtension(input, originalName);
    if (!REFERENCE_IMAGE_EXTENSIONS.has(ext)) {
      return fail('unsupported_reference_image', `Unsupported reference image type for ${originalName}. Use png, jpg, webp, or svg.`, `attachments.${index}`);
    }
    const fallbackBase = `reference-${String(index + 1).padStart(2, '0')}`;
    let fileName = `${String(index + 1).padStart(2, '0')}-${sanitizeReferenceFileName(originalName, fallbackBase, ext)}`;
    let dedupe = 2;
    while (usedFileNames.has(fileName)) {
      fileName = `${String(index + 1).padStart(2, '0')}-${fallbackBase}-${dedupe}${ext}`;
      dedupe += 1;
    }
    usedFileNames.add(fileName);
    const relativePath = `${referencesRelativeDir}/${fileName}`;
    const targetPath = safeProjectRelativePath(projectRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(attachment.daemonPath, targetPath);
    copiedImages.push({
      attachmentId,
      originalName,
      relativePath,
      mime: input.mime ?? attachment.mime,
      size: input.size ?? attachment.size,
    });
  }

  const content = renderReferenceBriefMarkdown({
    createdAt: nowMs,
    ...(options.projectName ? { projectName: options.projectName } : {}),
    ...(options.note ? { note: options.note } : {}),
    copiedImages,
  });
  const sourceRelativePath = `${taskRelativeDir}/brief.md`;
  const sourcePath = safeProjectRelativePath(projectRoot, sourceRelativePath);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, content, 'utf8');

  // A3 — pre-seed the passive watcher's ledger with this deliberate flow's
  // own files. The watcher accepts image extensions now, so without this it
  // would see brief.md + the copied references as a brand-new requirement
  // group and auto-launch a duplicate run for a task the user just started
  // explicitly via the War Room button.
  await recordEvolutionInboxSeenFiles(projectRoot, [
    sourceRelativePath,
    ...copiedImages.map((image) => image.relativePath),
  ]);

  return ok({
    requestId: options.requestId,
    sourceRelativePath,
    taskRelativeDir,
    referencesRelativeDir,
    imageCount: copiedImages.length,
    copiedImages,
    createdAt: nowMs,
  });
}

/**
 * Read the versioned per-project policy for unattended launches. Absent or
 * invalid policy → null, and watcher launches keep the safe defaults
 * (governed + strict + hifi human approval + fail-closed). A policy can only
 * relax behavior by being explicitly present and valid — never by accident.
 */
export async function readEvolutionProjectPolicy(projectRoot: string): Promise<EvolutionProjectPolicy | null> {
  try {
    const raw = await readFile(safeProjectRelativePath(safeProjectRoot(projectRoot), EVOLUTION_PROJECT_POLICY_RELATIVE_PATH), 'utf8');
    const validated = validateEvolutionProjectPolicy(JSON.parse(raw));
    return validated.ok ? validated.value : null;
  } catch {
    return null;
  }
}

export async function launchEvolutionRunFromInboxCandidate(options: {
  projectRoot: string;
  sessionName: string;
  candidate: EvolutionInboxCandidate;
  requestId?: string;
  projectName?: string;
  autoStartImplementation?: boolean;
  nowMs?: number;
}): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const nowMs = options.nowMs ?? Date.now();
  const policy = await readEvolutionProjectPolicy(options.projectRoot);
  return launchEvolutionRun({
    projectRoot: options.projectRoot,
    nowMs,
    request: {
      requestId: options.requestId ?? `watcher-${shortSha256(`${options.sessionName}:${options.candidate.sourceRelativePath}:${options.candidate.sizeBytes}:${options.candidate.mtimeMs}`)}`,
      sessionName: options.sessionName,
      ...(options.projectName ? { projectName: options.projectName } : {}),
      sourceRelativePath: options.candidate.sourceRelativePath,
      sourceSizeBytes: options.candidate.sizeBytes,
      requestedBy: 'watcher',
      executionPolicy: policy?.executionPolicy ?? 'governed',
      autoStart: true,
      autoStartImplementation: options.autoStartImplementation ?? policy?.autoStartImplementation ?? true,
      autoDeliverPresetId: 'standard',
      roundtableGateMode: policy?.roundtableGateMode ?? 'strict',
      requireHifiHumanApproval: policy?.requireHifiHumanApproval ?? true,
      ...(policy?.developmentMode ? { developmentMode: policy.developmentMode } : {}),
      ...(policy?.developmentTargetRelativeDir ? { developmentTargetRelativeDir: policy.developmentTargetRelativeDir } : {}),
    },
  });
}

function renderWatcherGroupBriefMarkdown(options: {
  createdAt: number;
  images: EvolutionInboxCandidateFile[];
  briefRelativePath: string;
}): string {
  const briefDir = dirname(options.briefRelativePath);
  const linkFor = (relativePath: string): string => relative(briefDir, relativePath).split('\\').join('/');
  return [
    '# 手稿/参考图驱动的需求 Brief',
    '',
    `Created at: ${new Date(options.createdAt).toISOString()}`,
    '',
    '## 输入说明',
    '',
    '- 这是自我进化 inbox 监听器根据用户投递的手稿/参考图自动生成的启动文档。',
    '- 后续产品、设计、架构与开发角色必须先阅读下方参考图，再进入 PRD、低保真、高保真和实现拆解。',
    '- 高保真设计必须与参考图表达的布局、信息层级、视觉气质和核心业务目标保持可追溯关系；不得输出通用模板化页面。',
    '- 用户未附文字说明，请以参考图为主要需求来源，并在不确定处列出显式假设。',
    '',
    '## 参考图',
    '',
    ...options.images.flatMap((image, index) => [
      `### ${index + 1}. ${basename(image.relativePath)}`,
      '',
      `![reference-${index + 1}](${linkFor(image.relativePath)})`,
      '',
      `- 文件：\`${image.relativePath}\``,
      `- 大小：${image.sizeBytes} bytes`,
      '',
    ]),
    '## 期望输出',
    '',
    '1. 结合参考图补全可执行 PRD、用户故事和验收标准。',
    '2. 生成低保真流程/线框，说明每张参考图如何影响信息架构。',
    '3. 生成高保真 UI 说明与可交付设计产物。',
    '4. 输出技术架构基线、OpenSpec proposal/design/tasks、实现任务矩阵、测试计划和交付门禁。',
    '',
  ].join('\n');
}

function pickGroupPrimaryTextFile(files: EvolutionInboxCandidateFile[]): EvolutionInboxCandidateFile | null {
  const textFiles = files.filter((file) => file.kind === 'text');
  if (textFiles.length === 0) return null;
  return textFiles.find((file) => /brief/i.test(basename(file.relativePath)))
    ?? textFiles.find((file) => file.relativePath.toLowerCase().endsWith('.md'))
    ?? textFiles[0]!;
}

/**
 * A2 — one grouped inbox drop (a subdirectory of files, or a lone root-level
 * manuscript image) maps to exactly ONE Evolution run instead of N. A text
 * member becomes the run's source directly (sibling images are discovered by
 * the existing design-reference machinery); an images-only group first gets a
 * synthesized brief so the pipeline always has a text source document.
 */
export async function launchEvolutionRunFromInboxCandidateGroup(options: {
  projectRoot: string;
  sessionName: string;
  group: EvolutionInboxCandidateGroup;
  requestId?: string;
  projectName?: string;
  autoStartImplementation?: boolean;
  nowMs?: number;
}): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const nowMs = options.nowMs ?? Date.now();
  const projectRoot = safeProjectRoot(options.projectRoot);
  const { group } = options;
  if (group.files.length === 0) return fail('empty_inbox_candidate_group', 'Inbox candidate group contains no files.');

  const primary = pickGroupPrimaryTextFile(group.files);
  if (primary) {
    return launchEvolutionRunFromInboxCandidate({
      projectRoot,
      sessionName: options.sessionName,
      candidate: { sourceRelativePath: primary.relativePath, sizeBytes: primary.sizeBytes, mtimeMs: primary.mtimeMs },
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.projectName ? { projectName: options.projectName } : {}),
      ...(typeof options.autoStartImplementation === 'boolean' ? { autoStartImplementation: options.autoStartImplementation } : {}),
      nowMs,
    });
  }

  // Images-only drop — synthesize the text brief the pipeline needs.
  const images = group.files.filter((file) => file.kind === 'image');
  if (images.length === 0) return fail('empty_inbox_candidate_group', 'Inbox candidate group has neither text nor image files.');
  const atInboxRoot = group.groupRelativeDir === EVOLUTION_REQUIREMENT_INBOX_DIR;
  const briefRelativePath = atInboxRoot
    ? `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${basename(images[0]!.relativePath).replace(/\.[^.]+$/, '')}-brief.md`
    : `${group.groupRelativeDir}/brief.md`;
  const briefPath = safeProjectRelativePath(projectRoot, briefRelativePath);
  const content = renderWatcherGroupBriefMarkdown({ createdAt: nowMs, images, briefRelativePath });
  await mkdir(dirname(briefPath), { recursive: true });
  await writeFile(briefPath, content, 'utf8');
  // Our own write must never look like a fresh passive drop on the next poll.
  await recordEvolutionInboxSeenFiles(projectRoot, [briefRelativePath]);

  const briefStat = await stat(briefPath);
  const policy = await readEvolutionProjectPolicy(projectRoot);
  return launchEvolutionRun({
    projectRoot,
    nowMs,
    request: {
      requestId: options.requestId ?? `watcher-group-${shortSha256(`${options.sessionName}:${group.groupRelativeDir}:${images.map((image) => image.relativePath).join(',')}`)}`,
      sessionName: options.sessionName,
      ...(options.projectName ? { projectName: options.projectName } : {}),
      sourceRelativePath: briefRelativePath,
      sourceSizeBytes: briefStat.size,
      requestedBy: 'watcher',
      executionPolicy: policy?.executionPolicy ?? 'governed',
      autoStart: true,
      autoStartImplementation: options.autoStartImplementation ?? policy?.autoStartImplementation ?? true,
      autoDeliverPresetId: 'standard',
      roundtableGateMode: policy?.roundtableGateMode ?? 'strict',
      requireHifiHumanApproval: policy?.requireHifiHumanApproval ?? true,
      ...(policy?.developmentMode ? { developmentMode: policy.developmentMode } : {}),
      ...(policy?.developmentTargetRelativeDir ? { developmentTargetRelativeDir: policy.developmentTargetRelativeDir } : {}),
    },
  });
}

export async function hydrateEvolutionRun(projectRoot: string, runId: string, nowMs = Date.now()): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const root = safeProjectRoot(projectRoot);
  try {
    const run = await readEvolutionRun(root, validRunId.value);
    if (run.projectRoot) {
      const resolvedRecordedRoot = safeProjectRoot(run.projectRoot);
      if (resolvedRecordedRoot !== root) {
        return fail('evolution_project_root_mismatch', 'Stored run belongs to a different project root.');
      }
    }
    if (normalizeHydratedEvolutionRun(run, nowMs)) await writeEvolutionRun(root, run);
    upsertRuntime(root, run);
    const entry = getRuntimeEntry(run.runId);
    if (entry) await reconcileRuntimeRoundtableContextFiles(entry, nowMs);
    return ok(buildEvolutionProjection(run, nowMs));
  } catch (error) {
    return fail('evolution_hydrate_failed', describeUnknownError(error));
  }
}

async function hydrateRuntimeRunsForProject(projectRoot: string, sessionName?: string): Promise<void> {
  const root = safeProjectRoot(projectRoot);
  const entries = await readdir(safeProjectRelativePath(root, EVOLUTION_RUN_ROOT_DIR), { withFileTypes: true })
    .catch(() => null);
  if (!entries) return;
  const runIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => validateEvolutionRunId(name).ok)
    .sort()
    .reverse()
    .slice(0, 20);
  for (const runId of runIds) {
    try {
      if (runsById.has(runId)) continue;
      const run = await readEvolutionRun(root, runId);
      if (sessionName && run.sessionName !== sessionName) continue;
      if (run.projectRoot && safeProjectRoot(run.projectRoot) !== root) continue;
      if (normalizeHydratedEvolutionRun(run, Date.now())) await writeEvolutionRun(root, run);
      upsertRuntime(root, run);
    } catch {
      /* ignore unreadable historical run records */
    }
  }
}

export function getEvolutionRun(runId: string, nowMs = Date.now()): EvolutionOrchestratorResult<EvolutionProjection> {
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  return ok(buildEvolutionProjection(entry.run, nowMs));
}

export function listEvolutionRuns(nowMs = Date.now()): EvolutionProjection[] {
  return [...runsById.values()]
    .map((entry) => buildEvolutionProjection(entry.run, nowMs))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId));
}

export async function advanceEvolutionRunStage(options: AdvanceEvolutionRunStageOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  const run = entry.run;
  if (run.stage === options.nextStage) return ok(buildEvolutionProjection(run, options.nowMs ?? Date.now()));
  const transition = validateEvolutionStageTransition(run.stage, options.nextStage);
  if (!transition.ok) return transition as EvolutionOrchestratorResult<EvolutionProjection>;

  const nowMs = options.nowMs ?? Date.now();
  run.stage = options.nextStage;
  applyRoleStatesForStage(run, options.nextStage, nowMs);
  run.latestMessage = options.reason ?? `Evolution stage advanced to ${options.nextStage}.`;
  if (options.nextStage === 'needs_human') {
    run.verdict = 'BLOCKED';
  } else if (isEvolutionTerminalStage(options.nextStage)) {
    run.verdict = options.nextStage === 'deployed_production' ? 'PASS' : options.nextStage === 'failed' ? 'BLOCKED' : 'REWORK';
    run.terminalReason = options.reason ?? options.nextStage;
  } else {
    delete run.verdict;
    delete run.terminalReason;
  }
  appendEvidence(run, {
    source: 'orchestrator',
    summary: run.latestMessage,
    createdAt: nowMs,
  });

  const projection = await persistAndProject(entry, nowMs);
  return ok(projection);
}

export async function stopEvolutionRun(options: StopEvolutionRunOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  if (isEvolutionTerminalStage(entry.run.stage)) return ok(buildEvolutionProjection(entry.run, options.nowMs ?? Date.now()));
  await cancelLinkedAutoDelivery(entry.run);
  return advanceEvolutionRunStage({
    runId: validRunId.value,
    nextStage: 'stopped',
    reason: options.reason ?? 'Evolution run stopped by request.',
    ...(typeof options.nowMs === 'number' ? { nowMs: options.nowMs } : {}),
  });
}

export async function pauseEvolutionRun(options: PauseEvolutionRunOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  const run = entry.run;
  const nowMs = options.nowMs ?? Date.now();
  if (isEvolutionTerminalStage(run.stage)) return ok(buildEvolutionProjection(run, nowMs));
  const existingPause = findUserPauseQuestion(run);
  if (existingPause && run.stage === 'needs_human') return ok(buildEvolutionProjection(run, nowMs));
  await cancelLinkedAutoDelivery(run);
  const pausedFromStage = run.stage;
  const reason = options.reason ?? `Paused from Evolution War Room at ${pausedFromStage}.`;
  run.stage = 'needs_human';
  applyRoleStatesForStage(run, 'needs_human', nowMs);
  run.verdict = 'BLOCKED';
  delete run.terminalReason;
  run.latestMessage = reason;
  const id = pauseQuestionId(run.runId, pausedFromStage);
  run.blockingQuestions = run.blockingQuestions.filter((question) => !pauseQuestionStage(run, question.id));
  run.blockingQuestions.push({
    id,
    stage: pausedFromStage,
    roleId: 'loop_supervisor',
    question: `用户暂停了自我进化任务。暂停前阶段：${pausedFromStage}。稍后点击“继续执行”会从该阶段恢复。`,
    createdAt: nowMs,
  });
  appendDiscussion(run, {
    kind: 'gate',
    stage: 'needs_human',
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: `用户已暂停任务；暂停前阶段 ${pausedFromStage}。当前不会继续推进后续阶段或自动交付，恢复时从该阶段继续。`,
    createdAt: nowMs,
  });
  appendEvidence(run, {
    source: 'user_pause_gate',
    summary: `User paused Evolution run at ${pausedFromStage}.`,
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  return ok(projection);
}

export async function applyEvolutionGateAction(
  options: ApplyEvolutionGateActionOptions,
): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  const run = entry.run;
  const nowMs = options.nowMs ?? Date.now();
  initializeEvolutionControlState(run);
  if (!options.mutationId.trim()) return fail('invalid_mutation_id', 'mutationId is required.', 'mutationId');
  if ((run.processedMutationIds ?? []).includes(options.mutationId)) return ok(buildEvolutionProjection(run, nowMs));
  if (options.expectedRunRevision !== (run.runRevision ?? 0)) {
    return fail(
      'stale_evolution_run_revision',
      `Gate action expected run revision ${options.expectedRunRevision}, current revision is ${run.runRevision ?? 0}.`,
      'expectedRunRevision',
    );
  }
  const gate = (run.gates ?? []).find((entry) => entry.id === options.gateId);
  if (!gate) return fail('evolution_gate_not_found', `Gate not found: ${options.gateId}`, 'gateId');
  if (gate.status !== 'open') {
    return fail('evolution_gate_not_open', `Gate ${gate.id} is already ${gate.status}.`, 'gateId');
  }
  if (gate.kind !== 'design_review') {
    return fail('unsupported_evolution_gate_action', `Gate ${gate.kind} does not support this action yet.`, 'gateId');
  }
  if (options.action === 'waive') {
    return fail('evolution_gate_waiver_forbidden', 'High-fidelity human review cannot be waived.', 'action');
  }
  if (options.action === 'request_changes' && !options.feedback?.trim()) {
    return fail('evolution_gate_feedback_required', 'Request Changes requires feedback.', 'feedback');
  }
  if (options.action === 'approve') {
    const missingRevisionId = gate.candidateRevisionIds.find((revisionId) => (
      !(run.artifactRevisions ?? []).some((entry) => entry.id === revisionId)
    ));
    if (missingRevisionId) {
      return fail('evolution_gate_revision_missing', `Gate candidate revision is missing: ${missingRevisionId}`, 'gateId');
    }
  }

  gate.status = options.action === 'approve' ? 'approved' : 'rejected';
  gate.resolvedAt = nowMs;
  gate.decision = {
    id: options.mutationId,
    action: options.action,
    actor: 'human',
    expectedRunRevision: options.expectedRunRevision,
    ...(options.feedback?.trim() ? { feedback: options.feedback.trim().slice(0, 2_000) } : {}),
    createdAt: nowMs,
  };
  const reviewSet = gate.reviewSetId
    ? (run.designReviewSets ?? []).find((entry) => entry.id === gate.reviewSetId)
    : undefined;
  if (reviewSet) {
    reviewSet.status = options.action === 'approve' ? 'approved' : 'rejected';
    reviewSet.decidedAt = nowMs;
    if (options.feedback?.trim()) reviewSet.feedback = options.feedback.trim().slice(0, 2_000);
    await persistEvolutionReviewSet(entry.projectRoot, run, reviewSet);
  }
  if (options.action === 'approve') {
    for (const revisionId of gate.candidateRevisionIds) {
      const revision = (run.artifactRevisions ?? []).find((entry) => entry.id === revisionId);
      if (!revision) continue;
      revision.status = 'approved';
      revision.assurance = 'human_approved';
      run.authorizedRevisions![revision.logicalPath] = revision.id;
      const artifact = run.artifacts.find((entry) => entry.revisionId === revision.id);
      if (artifact) {
        artifact.status = 'approved';
        artifact.assurance = 'human_approved';
      }
    }
  } else {
    for (const revisionId of gate.candidateRevisionIds) {
      const revision = (run.artifactRevisions ?? []).find((entry) => entry.id === revisionId);
      if (!revision || revision.status === 'approved') continue;
      revision.status = 'rejected';
      const artifact = run.artifacts.find((entry) => entry.revisionId === revision.id);
      if (artifact) artifact.status = 'rejected';
    }
  }
  run.processedMutationIds = [...(run.processedMutationIds ?? []), options.mutationId].slice(-200);
  await persistEvolutionGate(entry.projectRoot, run, gate);
  await persistAndProject(entry, nowMs);

  const result = await continueEvolutionRun({
    runId: run.runId,
    targetStage: options.action === 'approve' ? 'design_hifi' : 'design_lofi',
    message: options.action === 'approve'
      ? 'High-fidelity review set approved through the typed gate.'
      : `${EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX} ${options.feedback?.trim() ?? ''}`,
    nowMs,
  });
  return result;
}

export async function continueEvolutionRun(options: ContinueEvolutionRunOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  const run = entry.run;
  const nowMs = options.nowMs ?? Date.now();
  if (run.stage === 'human_release_gate') {
    const approvalMessage = options.message?.trim() || 'Production release gate approved from Evolution War Room.';
    const artifact = await writeProductionReleaseGateArtifact(entry, approvalMessage, nowMs);
    upsertArtifact(run, artifact);
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'human_release_gate',
      roleId: 'ops_release_manager',
      author: '运维/发布经理',
      text: `生产发布人工门禁已批准并记录：${approvalMessage}`,
      artifactIds: [artifact.id],
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'human_release_gate',
      summary: 'Production release gate approved by War Room human operator; no production command executed by Evolution.',
      artifactId: artifact.id,
      createdAt: nowMs,
    });
    return advanceEvolutionRunStage({
      runId: validRunId.value,
      nextStage: 'deployed_production',
      reason: 'Human production release gate approved; production execution remains manual/audited.',
      nowMs,
    });
  }
  if (run.stage !== 'needs_human') {
    appendEvidence(run, {
      source: 'orchestrator',
      summary: options.message ?? 'Continue requested; run is not waiting for human input.',
      createdAt: nowMs,
    });
    run.latestMessage = options.message ?? 'Continue requested.';
    const projection = await persistAndProject(entry, nowMs);
    return ok(projection);
  }

  const openTypedGate = (run.executionPolicy ?? 'draft_preview') === 'governed'
    ? (run.gates ?? []).find((gate) => gate.status === 'open')
    : undefined;
  if (openTypedGate) {
    return fail(
      'typed_gate_action_required',
      `Gate ${openTypedGate.id} requires an explicit approve or request_changes action with revision CAS.`,
      'gateId',
    );
  }

  const targetStage = options.targetStage ?? inferHumanContinueTargetStage(run);
  if (!targetStage) {
    const unresolved = run.blockingQuestions.at(-1)?.id ?? 'unknown';
    return fail('unresolved_human_gate', `Cannot infer a safe resume stage for blocker: ${unresolved}.`, 'blockingQuestions');
  }
  if (!isEvolutionStage(targetStage)) return fail('invalid_target_stage', 'targetStage is not canonical.', 'targetStage');
  if (options.message?.startsWith(EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX)) {
    const feedback = options.message.slice(EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX.length).trim();
    const snapshot = await snapshotRejectedHifiReviewSet(entry, feedback, nowMs);
    upsertArtifact(run, snapshot);
    const invalidatedRoundtables = (run.roundtables ?? []).filter((roundtable) => roundtable.stage === 'design_hifi');
    if (invalidatedRoundtables.length > 0) {
      run.roundtables = (run.roundtables ?? []).filter((roundtable) => roundtable.stage !== 'design_hifi');
      const invalidatedIds = new Set(invalidatedRoundtables.map((roundtable) => roundtable.id));
      run.blockingQuestions = run.blockingQuestions.filter((question) => (
        ![...invalidatedIds].some((roundtableId) => question.id === `strict-roundtable-${run.runId}-${roundtableId}-blocked`)
      ));
      appendEvidence(run, {
        source: 'human_design_rework_review_invalidation',
        summary: [
          'Human Redesign invalidated prior design_hifi roundtable decisions so regenerated visuals require fresh governed review.',
          ...invalidatedRoundtables.map((roundtable) => (
            `${roundtable.id}: status=${roundtable.status}` +
            `${roundtable.p2pRunId ? `, p2pRunId=${roundtable.p2pRunId}` : ''}` +
            `${roundtable.summary ? `, verdict=${roundtable.summary.slice(0, 300)}` : ''}`
          )),
        ].join(' '),
        artifactId: snapshot.id,
        createdAt: nowMs,
      });
    }
    appendEvidence(run, {
      source: 'human_design_rework',
      summary: 'Human requested a new high-fidelity design pass; the rejected review set was frozen before regeneration.',
      artifactId: snapshot.id,
      createdAt: nowMs,
    });
    run.blockingQuestions = run.blockingQuestions.filter((question) => question.id !== `design-hifi-approval-${run.runId}`);
  }
  releaseUserPauseGateForHumanContinue(run, targetStage, options.message, nowMs);
  const retryRoundtable = releaseRoundtableGateForHumanContinue(run, targetStage, options.message, nowMs);
  const advanced = await advanceEvolutionRunStage({
    runId: validRunId.value,
    nextStage: targetStage,
    reason: options.message ?? `Human gate resolved; continuing at ${targetStage}.`,
    nowMs,
  });
  if (!advanced.ok || !retryRoundtable) return advanced;
  await maybeStartRoundtablesForStage(entry, null, nowMs, targetStage);
  return ok(buildEvolutionProjection(run, nowMs));
}

export async function recordEvolutionUserMessage(options: RecordEvolutionUserMessageOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  const text = options.text.trim();
  if (!text) return fail('empty_user_message', 'User message text is required.', 'text');
  const nowMs = options.nowMs ?? Date.now();
  entry.run.latestMessage = options.roleId ? `User to ${options.roleId}: ${text}` : `User: ${text}`;
  const role = options.roleId ? entry.run.roles.find((item) => item.roleId === options.roleId) : undefined;
  const instructionArtifact = await writeWarRoomInstructionArtifact(entry, options.roleId, text, nowMs);
  const responseArtifact = await writeRoleInstructionResponseArtifact(entry, options.roleId, text, instructionArtifact, nowMs);
  appendDiscussion(entry.run, {
    kind: 'user_message',
    stage: entry.run.stage,
    ...(options.roleId ? { roleId: options.roleId } : {}),
    author: role?.label ? `User → ${role.label}` : options.roleId ? `User → ${options.roleId}` : 'User',
    text: text.slice(0, 2000),
    artifactIds: [instructionArtifact.id],
    createdAt: nowMs,
  });
  const acknowledgement = roleInstructionAcknowledgement(entry.run, options.roleId, text);
  appendDiscussion(entry.run, {
    kind: 'role_update',
    stage: entry.run.stage,
    roleId: acknowledgement.roleId,
    author: acknowledgement.author,
    text: acknowledgement.text,
    artifactIds: [instructionArtifact.id, responseArtifact.id],
    createdAt: nowMs,
  });
  appendEvidence(entry.run, {
    source: options.roleId ? `user:${options.roleId}` : 'user',
    summary: `${text.slice(0, 1000)} · instruction=${instructionArtifact.path} · response=${responseArtifact.path}`,
    artifactId: responseArtifact.id,
    createdAt: nowMs,
  });
  appendLiveEvent(entry.run, {
    source: 'war_room',
    kind: 'message',
    severity: 'info',
    roleId: responseArtifact.roleId,
    stage: entry.run.stage,
    title: `Role response · ${responseArtifact.title ?? responseArtifact.roleId ?? 'role'}`,
    detail: acknowledgement.text,
    artifactIds: [instructionArtifact.id, responseArtifact.id],
    createdAt: nowMs,
  });
  if (roundtableUserMessageSink) {
    const runningRoundtables = runningRoundtablesForUserMessage(entry.run, options.roleId);
    for (const roundtable of runningRoundtables) {
      const result = await roundtableUserMessageSink({
        runId: entry.run.runId,
        roundtable,
        ...(options.roleId ? { roleId: options.roleId } : {}),
        ...(role?.label ? { roleLabel: role.label } : {}),
        author: role?.label ? `User → ${role.label}` : options.roleId ? `User → ${options.roleId}` : 'User',
        text,
        createdAt: nowMs,
      });
      if (result.ok) {
        appendDiscussion(entry.run, {
          kind: 'role_update',
          stage: entry.run.stage,
          roleId: 'loop_supervisor',
          author: 'Loop Supervisor / 总控',
          text: `已把用户指令注入正在运行的 ${roundtable.topic} 圆桌上下文${result.currentTargetSession ? `（当前目标 ${result.currentTargetSession}）` : ''}。`,
          createdAt: nowMs,
        });
        appendEvidence(entry.run, {
          source: 'p2p_roundtable_user_message',
          summary: `User message delivered to ${roundtable.topic}${result.contextPath ? ` (${result.contextPath})` : ''}.`,
          createdAt: nowMs,
        });
      } else {
        appendEvidence(entry.run, {
          source: 'p2p_roundtable_user_message',
          summary: `User message could not be delivered to ${roundtable.topic}: ${result.error ?? 'unknown_error'}`,
          createdAt: nowMs,
        });
      }
    }
  }
  const projection = await persistAndProject(entry, nowMs);
  return ok(projection);
}

async function writeRoleSkillRevisionArtifact(
  entry: RuntimeEntry,
  roleId: EvolutionRoleId,
  skillName: string,
  previousContent: string,
  previousSha256: string | undefined,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const artifactPath = `skills/revisions/${nowMs}-${skillName}-${shortSha256(previousContent)}.md`;
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const content = [
    '# Role Skill Revision Backup',
    '',
    `- Run: \`${entry.run.runId}\``,
    `- Role: \`${roleId}\``,
    `- Skill: \`${skillName}\``,
    `- Previous sha256: \`${previousSha256 ?? shortSha256(previousContent)}\``,
    `- Saved before War Room edit: ${new Date(nowMs).toISOString()}`,
    '',
    '## Previous Skill Markdown',
    '',
    previousContent,
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return {
    id: `role_skill_revision:${skillName}:${nowMs}`,
    kind: 'role_skill_revision',
    path: artifactPath,
    title: `Revision backup · ${skillName}`,
    preview: markdownPreview(content),
    roleId,
    stage: entry.run.stage,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
}

function normalizeSkillMarkdownForArtifact(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

async function writeRoleSkillReleaseCandidateArtifact(
  entry: RuntimeEntry,
  roleId: EvolutionRoleId,
  skillName: string,
  markdown: string,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const normalized = normalizeSkillMarkdownForArtifact(markdown);
  const artifactPath = `skills/release-candidates/${nowMs}-${skillName}-${shortSha256(normalized)}.md`;
  const approvalTarget = `${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/${skillName}.md`;
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const content = [
    normalized.trimEnd(),
    '',
    '## Release Candidate Governance',
    '',
    `- Source run: \`${entry.run.runId}\``,
    `- Role: \`${roleId}\``,
    `- Skill: \`${skillName}\``,
    `- Candidate sha256: \`${sha256(normalized)}\``,
    `- Created from War Room edit: ${new Date(nowMs).toISOString()}`,
    `- Approval target: \`${approvalTarget}\``,
    '',
    '### Approval Checklist',
    '- Reviewed by product/tech/QA owner or team skill maintainer.',
    '- Does not introduce production, secret, privacy, payment, or migration bypasses.',
    '- Keeps Maker/Checker separation and human gates intact.',
    '- If approved, copy this file to the approval target so future Evolution runs seed this role from the shared library.',
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return {
    id: `role_skill_release_candidate:${skillName}:${shortSha256(content)}`,
    kind: 'role_skill_release_candidate',
    path: artifactPath,
    title: `Release candidate · ${skillName}`,
    preview: markdownPreview(content),
    roleId,
    stage: entry.run.stage,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
}

export async function updateEvolutionRoleSkill(options: UpdateEvolutionRoleSkillOptions): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  if (!(EVOLUTION_ROLE_IDS as readonly string[]).includes(options.roleId)) {
    return fail('invalid_role_id', 'roleId is not a canonical Evolution role.', 'roleId');
  }
  const nowMs = options.nowMs ?? Date.now();
  try {
    const updated = await updateEvolutionRoleSkillFile({
      projectRoot: entry.projectRoot,
      roleId: options.roleId,
      markdown: options.markdown,
      nowMs,
    });
    if (updated.previousContent && updated.previousContent !== options.markdown) {
      const revision = await writeRoleSkillRevisionArtifact(
        entry,
        options.roleId,
        updated.skillName,
        updated.previousContent,
        updated.previousSha256,
        nowMs,
      );
      upsertArtifact(entry.run, revision);
    }
    const releaseCandidate = await writeRoleSkillReleaseCandidateArtifact(
      entry,
      options.roleId,
      updated.skillName,
      options.markdown,
      nowMs,
    );
    upsertArtifact(entry.run, updated.artifact);
    upsertArtifact(entry.run, releaseCandidate);
    const updatedSkillContent = await readFile(
      safeProjectRelativePath(entry.projectRoot, updated.relativePath),
      'utf8',
    );
    await registerEvolutionArtifactRevision({
      projectRoot: entry.projectRoot,
      run: entry.run,
      artifact: updated.artifact,
      content: updatedSkillContent,
      status: 'approved',
      assurance: 'human_approved',
    });
    await captureEvolutionSkillSnapshot({
      projectRoot: entry.projectRoot,
      run: entry.run,
      roleId: options.roleId,
      skillName: updated.skillName,
      sourcePath: updated.relativePath,
      source: 'custom_user',
      content: updatedSkillContent,
      nowMs,
    });
    const role = entry.run.roles.find((item) => item.roleId === options.roleId);
    if (role) {
      role.currentAction = `Skill playbook updated in War Room: ${updated.skillName}`;
      role.updatedAt = nowMs;
    }
    entry.run.latestMessage = `Role skill updated: ${updated.skillName}`;
    appendDiscussion(entry.run, {
      kind: 'role_update',
      stage: entry.run.stage,
      roleId: options.roleId,
      author: role?.label ?? options.roleId,
      text: `角色 skill 已从 War Room 更新并落盘到 ${updated.relativePath}；同时生成共享发布候选 ${releaseCandidate.path}，经团队审批后可复制到 ${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/${updated.skillName}.md 供后续项目/run 复用。`,
      artifactIds: [updated.artifact.id, releaseCandidate.id],
      createdAt: nowMs,
    });
    appendEvidence(entry.run, {
      source: 'role_skill_editor',
      summary: `Updated ${updated.skillName} at ${updated.relativePath}.`,
      artifactId: updated.artifact.id,
      createdAt: nowMs,
    });
    appendEvidence(entry.run, {
      source: 'role_skill_release_candidate',
      summary: `Created release candidate for ${updated.skillName}; approve by copying to ${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/${updated.skillName}.md.`,
      artifactId: releaseCandidate.id,
      createdAt: nowMs,
    });
    return ok(await persistAndProject(entry, nowMs));
  } catch (error) {
    return fail('role_skill_update_failed', describeUnknownError(error), 'markdown');
  }
}

function roleSkillDefinitionForRole(roleId: EvolutionRoleId) {
  return EVOLUTION_ROLE_SKILL_DEFINITIONS.find((entry) => entry.roleId === roleId);
}

function extractApprovedSkillMarkdownFromCandidate(candidateContent: string): string {
  const normalized = normalizeSkillMarkdownForArtifact(candidateContent);
  const governanceMarker = '\n## Release Candidate Governance\n';
  const governanceIndex = normalized.indexOf(governanceMarker);
  return normalizeSkillMarkdownForArtifact((governanceIndex >= 0 ? normalized.slice(0, governanceIndex) : normalized).trimEnd());
}

interface ApprovedRoleSkillManifestEntry {
  skillName: string;
  roleId: EvolutionRoleId;
  version: string;
  sha256: string;
  path: string;
  candidateArtifactId: string;
  runId: string;
  approvedAt: string;
  approvalMessage?: string;
  previousSha256?: string;
}

interface ApprovedRoleSkillManifest {
  version: 1;
  updatedAt: string;
  entries: ApprovedRoleSkillManifestEntry[];
}

interface RoleSkillApprovalPolicy {
  version: 1;
  requiredApprovals: number;
  approvers?: string[];
}

interface RoleSkillApprovalVote {
  approverId: string;
  approvedAt: string;
  runId: string;
  approvalMessage?: string;
}

interface RoleSkillApprovalRecord {
  version: 1;
  skillName: string;
  roleId: EvolutionRoleId;
  candidateArtifactId: string;
  candidateSha256: string;
  requiredApprovals: number;
  status: 'pending' | 'approved';
  votes: RoleSkillApprovalVote[];
  updatedAt: string;
}

const APPROVED_ROLE_SKILL_MANIFEST_RELATIVE_PATH = `${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/manifest.json` as const;
const ROLE_SKILL_APPROVAL_POLICY_RELATIVE_PATH = 'config/evolution/role-skills/approval-policy.json' as const;
const ROLE_SKILL_APPROVAL_RECORDS_DIR = 'config/evolution/role-skills/approvals' as const;

function isApprovedRoleSkillManifestEntry(value: unknown): value is ApprovedRoleSkillManifestEntry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.skillName === 'string'
    && typeof record.roleId === 'string'
    && (EVOLUTION_ROLE_IDS as readonly string[]).includes(record.roleId)
    && typeof record.version === 'string'
    && typeof record.sha256 === 'string'
    && typeof record.path === 'string'
    && typeof record.candidateArtifactId === 'string'
    && typeof record.runId === 'string'
    && typeof record.approvedAt === 'string'
    && (record.approvalMessage === undefined || typeof record.approvalMessage === 'string')
    && (record.previousSha256 === undefined || typeof record.previousSha256 === 'string');
}

async function readApprovedRoleSkillManifest(projectRoot: string): Promise<ApprovedRoleSkillManifest> {
  const manifestPath = safeProjectRelativePath(projectRoot, APPROVED_ROLE_SKILL_MANIFEST_RELATIVE_PATH);
  try {
    const raw = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ApprovedRoleSkillManifest>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('approved_role_skill_manifest_invalid');
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      entries: parsed.entries.filter(isApprovedRoleSkillManifestEntry),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
    }
    throw error;
  }
}

function nextApprovedRoleSkillVersion(manifest: ApprovedRoleSkillManifest, skillName: string): string {
  const latest = [...manifest.entries].reverse().find((entry) => entry.skillName === skillName);
  if (!latest) return '1.0.0';
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(latest.version);
  if (!match) return '1.0.0';
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return `${major}.${minor}.${patch + 1}`;
}

async function writeApprovedRoleSkillManifest(
  projectRoot: string,
  manifest: ApprovedRoleSkillManifest,
): Promise<void> {
  const manifestPath = safeProjectRelativePath(projectRoot, APPROVED_ROLE_SKILL_MANIFEST_RELATIVE_PATH);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function approvedRoleSkillManifestArtifact(
  manifest: ApprovedRoleSkillManifest,
  nowMs: number,
  roleId: EvolutionRoleId,
): EvolutionArtifactRef {
  const content = [
    '# Approved Role Skill Library Manifest',
    '',
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    '',
  ].join('\n');
  return {
    id: `role_skill_library_manifest:${shortSha256(JSON.stringify(manifest))}`,
    kind: 'role_skill_library',
    path: APPROVED_ROLE_SKILL_MANIFEST_RELATIVE_PATH,
    title: 'Approved role skill manifest',
    preview: markdownPreview(content),
    roleId,
    stage: 'detected',
    sha256: sha256(JSON.stringify(manifest)),
    bytes: Buffer.byteLength(JSON.stringify(manifest, null, 2)),
    createdAt: nowMs,
  };
}

function normalizeApproverId(value: string | undefined): string {
  const trimmed = value?.trim() || 'war-room-user';
  return trimmed.replace(/[^A-Za-z0-9_.:@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'war-room-user';
}

async function readRoleSkillApprovalPolicy(projectRoot: string): Promise<RoleSkillApprovalPolicy> {
  const policyPath = safeProjectRelativePath(projectRoot, ROLE_SKILL_APPROVAL_POLICY_RELATIVE_PATH);
  try {
    const raw = await readFile(policyPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RoleSkillApprovalPolicy>;
    const requiredApprovals = typeof parsed.requiredApprovals === 'number' && Number.isInteger(parsed.requiredApprovals)
      ? Math.min(12, Math.max(1, parsed.requiredApprovals))
      : 1;
    const approvers = Array.isArray(parsed.approvers)
      ? parsed.approvers.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(normalizeApproverId)
      : undefined;
    return {
      version: 1,
      requiredApprovals,
      ...(approvers && approvers.length > 0 ? { approvers } : {}),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, requiredApprovals: 1 };
    }
    throw error;
  }
}

function roleSkillApprovalRecordRelativePath(skillName: string, candidateSha256: string): string {
  return `${ROLE_SKILL_APPROVAL_RECORDS_DIR}/${skillName}-${candidateSha256.slice(0, 16)}.json`;
}

async function readRoleSkillApprovalRecord(
  projectRoot: string,
  skillName: string,
  candidateSha256: string,
): Promise<RoleSkillApprovalRecord | null> {
  const recordPath = safeProjectRelativePath(projectRoot, roleSkillApprovalRecordRelativePath(skillName, candidateSha256));
  try {
    const raw = await readFile(recordPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<RoleSkillApprovalRecord>;
    if (
      parsed.version !== 1
      || parsed.skillName !== skillName
      || parsed.candidateSha256 !== candidateSha256
      || !Array.isArray(parsed.votes)
    ) {
      return null;
    }
    return {
      version: 1,
      skillName,
      roleId: (EVOLUTION_ROLE_IDS as readonly string[]).includes(String(parsed.roleId)) ? parsed.roleId as EvolutionRoleId : 'loop_supervisor',
      candidateArtifactId: typeof parsed.candidateArtifactId === 'string' ? parsed.candidateArtifactId : '',
      candidateSha256,
      requiredApprovals: typeof parsed.requiredApprovals === 'number' && Number.isInteger(parsed.requiredApprovals) ? Math.max(1, parsed.requiredApprovals) : 1,
      status: parsed.status === 'approved' ? 'approved' : 'pending',
      votes: parsed.votes.filter((entry): entry is RoleSkillApprovalVote => (
        !!entry
        && typeof entry === 'object'
        && typeof (entry as RoleSkillApprovalVote).approverId === 'string'
        && typeof (entry as RoleSkillApprovalVote).approvedAt === 'string'
        && typeof (entry as RoleSkillApprovalVote).runId === 'string'
      )),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeRoleSkillApprovalRecord(
  projectRoot: string,
  record: RoleSkillApprovalRecord,
): Promise<void> {
  const recordPath = safeProjectRelativePath(projectRoot, roleSkillApprovalRecordRelativePath(record.skillName, record.candidateSha256));
  await mkdir(dirname(recordPath), { recursive: true });
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function writeRoleSkillApprovalRecordArtifact(
  entry: RuntimeEntry,
  record: RoleSkillApprovalRecord,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const relativeRecordPath = roleSkillApprovalRecordRelativePath(record.skillName, record.candidateSha256);
  const artifactPath = `skills/approvals/${nowMs}-${record.skillName}-${record.candidateSha256.slice(0, 12)}.md`;
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const content = [
    '# Role Skill Approval Record',
    '',
    `- Skill: \`${record.skillName}\``,
    `- Role: \`${record.roleId}\``,
    `- Candidate: \`${record.candidateArtifactId}\``,
    `- Candidate sha256: \`${record.candidateSha256}\``,
    `- Status: \`${record.status}\``,
    `- Votes: ${record.votes.length}/${record.requiredApprovals}`,
    `- Project record: \`${relativeRecordPath}\``,
    '',
    '## Votes',
    ...record.votes.map((vote) => `- ${vote.approverId} at ${vote.approvedAt}${vote.approvalMessage ? ` — ${vote.approvalMessage}` : ''}`),
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  return {
    id: `role_skill_approval_record:${record.skillName}:${record.candidateSha256.slice(0, 12)}:${record.votes.length}`,
    kind: 'role_skill_approval_record',
    path: artifactPath,
    title: `Approval record · ${record.skillName} · ${record.votes.length}/${record.requiredApprovals}`,
    preview: markdownPreview(content),
    roleId: record.roleId,
    stage: entry.run.stage,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
}

export async function approveEvolutionRoleSkillCandidate(
  options: ApproveEvolutionRoleSkillCandidateOptions,
): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  if (!(EVOLUTION_ROLE_IDS as readonly string[]).includes(options.roleId)) {
    return fail('invalid_role_id', 'roleId is not a canonical Evolution role.', 'roleId');
  }
  if (typeof options.candidateArtifactId !== 'string' || options.candidateArtifactId.trim().length === 0) {
    return fail('missing_candidate_artifact_id', 'candidateArtifactId is required.', 'candidateArtifactId');
  }

  const nowMs = options.nowMs ?? Date.now();
  const definition = roleSkillDefinitionForRole(options.roleId);
  if (!definition) return fail('invalid_role_id', `Unknown role: ${options.roleId}`, 'roleId');
  const candidate = entry.run.artifacts.find((artifact) => (
    artifact.id === options.candidateArtifactId
    && artifact.kind === 'role_skill_release_candidate'
    && artifact.roleId === options.roleId
  ));
  if (!candidate) {
    return fail('role_skill_candidate_not_found', 'Release candidate artifact was not found for this role/run.', 'candidateArtifactId');
  }

  try {
    const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
    const candidateContent = await readFile(safeRunArtifactPath(paths.runDir, candidate.path), 'utf8');
    const approvedMarkdown = extractApprovedSkillMarkdownFromCandidate(candidateContent);
    const parsed = parseSkillMarkdown(approvedMarkdown, {
      name: definition.skillName,
      category: EVOLUTION_ROLE_SKILL_CATEGORY,
    });
    if (parsed.metadata.name !== definition.skillName) {
      return fail('role_skill_candidate_name_mismatch', `Candidate name ${parsed.metadata.name} does not match ${definition.skillName}.`, 'candidateArtifactId');
    }
    if (parsed.metadata.category !== EVOLUTION_ROLE_SKILL_CATEGORY) {
      return fail('role_skill_candidate_category_mismatch', `Candidate category ${parsed.metadata.category} does not match evolution.`, 'candidateArtifactId');
    }

    const policy = await readRoleSkillApprovalPolicy(entry.projectRoot);
    const approverId = normalizeApproverId(options.approverId);
    if (policy.approvers && policy.approvers.length > 0 && !policy.approvers.includes(approverId)) {
      return fail('role_skill_approver_not_allowed', `Approver ${approverId} is not allowed by ${ROLE_SKILL_APPROVAL_POLICY_RELATIVE_PATH}.`, 'approverId');
    }
    const approvedAt = new Date(nowMs).toISOString();
    const candidateSha256 = sha256(candidateContent);
    const existingRecord = await readRoleSkillApprovalRecord(entry.projectRoot, definition.skillName, candidateSha256);
    const existingVotes = existingRecord?.votes ?? [];
    const nextVotes = existingVotes.some((vote) => vote.approverId === approverId)
      ? existingVotes
      : [...existingVotes, {
        approverId,
        approvedAt,
        runId: entry.run.runId,
        ...(options.approvalMessage?.trim() ? { approvalMessage: options.approvalMessage.trim() } : {}),
      }];
    const thresholdMet = nextVotes.length >= policy.requiredApprovals;
    const approvalRecord: RoleSkillApprovalRecord = {
      version: 1,
      skillName: definition.skillName,
      roleId: options.roleId,
      candidateArtifactId: candidate.id,
      candidateSha256,
      requiredApprovals: policy.requiredApprovals,
      status: thresholdMet ? 'approved' : 'pending',
      votes: nextVotes,
      updatedAt: approvedAt,
    };
    await writeRoleSkillApprovalRecord(entry.projectRoot, approvalRecord);
    const approvalRecordArtifact = await writeRoleSkillApprovalRecordArtifact(entry, approvalRecord, nowMs);
    upsertArtifact(entry.run, approvalRecordArtifact);

    if (!thresholdMet) {
      const role = entry.run.roles.find((item) => item.roleId === options.roleId);
      if (role) {
        role.currentAction = `Role skill approval pending: ${definition.skillName} ${nextVotes.length}/${policy.requiredApprovals}`;
        role.updatedAt = nowMs;
      }
      entry.run.latestMessage = `Role skill approval pending: ${definition.skillName} ${nextVotes.length}/${policy.requiredApprovals}`;
      appendDiscussion(entry.run, {
        kind: 'gate',
        stage: entry.run.stage,
        roleId: options.roleId,
        author: role?.label ?? options.roleId,
        text: `角色 skill 发布候选已记录 ${approverId} 的审批票，但尚未达到多审批策略阈值：${nextVotes.length}/${policy.requiredApprovals}。达到阈值后才会发布 approved seed。`,
        artifactIds: [candidate.id, approvalRecordArtifact.id],
        createdAt: nowMs,
      });
      appendEvidence(entry.run, {
        source: 'role_skill_approval_pending',
        summary: `Approval vote recorded for ${definition.skillName}: ${nextVotes.length}/${policy.requiredApprovals}.`,
        artifactId: approvalRecordArtifact.id,
        createdAt: nowMs,
      });
      appendLiveEvent(entry.run, {
        source: 'role_skill',
        kind: 'gate',
        severity: 'warning',
        roleId: options.roleId,
        stage: entry.run.stage,
        title: 'Role skill approval pending',
        detail: `${definition.skillName}: ${nextVotes.length}/${policy.requiredApprovals} approvals`,
        artifactIds: [approvalRecordArtifact.id],
        createdAt: nowMs,
      });
      return ok(await persistAndProject(entry, nowMs));
    }

    const approvedRelativePath = `${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/${definition.skillName}.md`;
    const approvedPath = safeProjectRelativePath(entry.projectRoot, approvedRelativePath);
    let previousApproved: string | null = null;
    try {
      previousApproved = await readFile(approvedPath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (previousApproved && previousApproved !== approvedMarkdown) {
      const revision = await writeRoleSkillRevisionArtifact(
        entry,
        options.roleId,
        definition.skillName,
        previousApproved,
        sha256(previousApproved),
        nowMs,
      );
      upsertArtifact(entry.run, revision);
    }
    await mkdir(dirname(approvedPath), { recursive: true });
    await writeFile(approvedPath, approvedMarkdown, 'utf8');
    const approvedSha256 = sha256(approvedMarkdown);
    const manifest = await readApprovedRoleSkillManifest(entry.projectRoot);
    const manifestEntry: ApprovedRoleSkillManifestEntry = {
      skillName: definition.skillName,
      roleId: options.roleId,
      version: nextApprovedRoleSkillVersion(manifest, definition.skillName),
      sha256: approvedSha256,
      path: approvedRelativePath,
      candidateArtifactId: candidate.id,
      runId: entry.run.runId,
      approvedAt,
      ...(options.approvalMessage?.trim() ? { approvalMessage: options.approvalMessage.trim() } : {}),
      ...(previousApproved ? { previousSha256: sha256(previousApproved) } : {}),
    };
    const nextManifest: ApprovedRoleSkillManifest = {
      version: 1,
      updatedAt: approvedAt,
      entries: [...manifest.entries, manifestEntry],
    };
    await writeApprovedRoleSkillManifest(entry.projectRoot, nextManifest);
    const artifact: EvolutionArtifactRef = {
      id: `role_skill_library:${definition.skillName}:${manifestEntry.version}:${shortSha256(approvedMarkdown)}`,
      kind: 'role_skill_library',
      path: approvedRelativePath,
      title: `Approved library · ${definition.skillName} · v${manifestEntry.version}`,
      preview: markdownPreview(approvedMarkdown),
      roleId: options.roleId,
      stage: entry.run.stage,
      sha256: approvedSha256,
      bytes: Buffer.byteLength(approvedMarkdown),
      createdAt: nowMs,
    };
    const manifestArtifact = approvedRoleSkillManifestArtifact(nextManifest, nowMs, options.roleId);
    upsertArtifact(entry.run, artifact);
    upsertArtifact(entry.run, manifestArtifact);
    const role = entry.run.roles.find((item) => item.roleId === options.roleId);
    if (role) {
      role.currentAction = `Approved shared skill library seed: ${definition.skillName} v${manifestEntry.version}`;
      role.updatedAt = nowMs;
    }
    entry.run.latestMessage = `Approved role skill candidate: ${definition.skillName} v${manifestEntry.version}`;
    appendDiscussion(entry.run, {
      kind: 'gate',
      stage: entry.run.stage,
      roleId: options.roleId,
      author: role?.label ?? options.roleId,
      text: `角色 skill 发布候选已达到审批阈值 ${nextVotes.length}/${policy.requiredApprovals}，并从 War Room 审批为共享模板：${approvedRelativePath}（v${manifestEntry.version}）。${options.approvalMessage ? `审批说明：${options.approvalMessage}` : ''}`,
      artifactIds: [candidate.id, approvalRecordArtifact.id, artifact.id, manifestArtifact.id],
      createdAt: nowMs,
    });
    appendEvidence(entry.run, {
      source: 'role_skill_approval',
      summary: `Approved ${definition.skillName} release candidate into ${approvedRelativePath} as v${manifestEntry.version} with ${nextVotes.length}/${policy.requiredApprovals} approvals.`,
      artifactId: manifestArtifact.id,
      createdAt: nowMs,
    });
    return ok(await persistAndProject(entry, nowMs));
  } catch (error) {
    return fail('role_skill_candidate_approval_failed', describeUnknownError(error), 'candidateArtifactId');
  }
}

const EVOLUTION_STAGE_ORDER: EvolutionStage[] = [
  'detected',
  'intake_normalized',
  'product_discussion',
  'prd_ready',
  'design_lofi',
  'design_hifi',
  'architecture_baseline',
  'tasks_ready',
  'implementation_loop',
  'qa_completion',
  'delivery_ready',
  'deployed_staging',
  'human_release_gate',
  'deployed_production',
];

function targetEvolutionStageForOpenSpec(status: OpenSpecAutoDeliverProjection['status']): EvolutionStage | null {
  switch (status) {
    case 'proposed':
    case 'spec_audit_repair':
    case 'implementation_task_loop':
    case 'commit_push':
      return 'implementation_loop';
    case 'implementation_audit_repair':
      return 'qa_completion';
    case 'passed':
      return 'delivery_ready';
    case 'needs_human':
      return 'needs_human';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return null;
  }
}

function pathToEvolutionStage(from: EvolutionStage, to: EvolutionStage): EvolutionStage[] {
  if (from === to) return [];
  if (canTransitionEvolutionStage(from, to)) return [to];
  const fromIndex = EVOLUTION_STAGE_ORDER.indexOf(from);
  const toIndex = EVOLUTION_STAGE_ORDER.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || toIndex <= fromIndex) return [];
  const path = EVOLUTION_STAGE_ORDER.slice(fromIndex + 1, toIndex + 1);
  let cursor = from;
  for (const step of path) {
    if (!canTransitionEvolutionStage(cursor, step)) return [];
    cursor = step;
  }
  return path;
}

function openSpecProjectionMatchesRun(projection: OpenSpecAutoDeliverProjection, run: EvolutionRun): boolean {
  if (!run.linkedOpenSpecChange || run.linkedOpenSpecChange !== projection.changeName) return false;
  const aliases = new Set([
    projection.owningMainSessionName,
    projection.launchedFromSessionName,
    projection.targetImplementationSessionName,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0));
  return aliases.size === 0 || aliases.has(run.sessionName);
}

function syncOpenSpecScores(run: EvolutionRun, projection: OpenSpecAutoDeliverProjection): void {
  for (const score of projection.moduleScores ?? []) {
    const module = evolutionScoreModuleForOpenSpec(score.module);
    if (!module) continue;
    upsertScore(run, {
      module,
      score: score.score,
      maxScore: 10,
      summary: `OpenSpec Auto Deliver: ${score.summary}`,
    });
  }
}

function syncOpenSpecBlockingQuestion(run: EvolutionRun, projection: OpenSpecAutoDeliverProjection, nowMs: number): void {
  if (projection.status !== 'needs_human') return;
  const id = `openspec-${projection.runId}-needs-human`;
  if (run.blockingQuestions.some((question) => question.id === id)) return;
  run.blockingQuestions.push({
    id,
    stage: 'needs_human',
    roleId: 'loop_supervisor',
    question: projection.terminalReason
      ? `OpenSpec Auto Deliver needs human input: ${projection.terminalReason}`
      : 'OpenSpec Auto Deliver needs human input.',
    createdAt: nowMs,
  });
}

async function writeOpenSpecTestEvidenceArtifact(
  entry: RuntimeEntry,
  projection: OpenSpecAutoDeliverProjection,
  nowMs: number,
): Promise<EvolutionArtifactRef> {
  const artifactPath = 'artifacts/test-evidence.md';
  const paths = getEvolutionRunPaths(entry.projectRoot, entry.run.runId);
  const fullPath = safeRunArtifactPath(paths.runDir, artifactPath);
  const taskStats = projection.taskStats;
  const scoreLines = (projection.moduleScores ?? []).map((score) =>
    `- ${score.module}: ${score.score}/${score.max_score} — ${score.summary}`
  );
  const evidenceLines = (projection.evidence ?? [])
    .filter((item) => item.summary)
    .slice(0, 20)
    .map((item) => `- ${item.source || 'openspec_auto_deliver'}: ${item.summary}${item.command ? ` · command=\`${item.command}\`` : ''}${typeof item.exitCode === 'number' ? ` · exit=${item.exitCode}` : ''}`);
  const content = [
    '# QA Completion Evidence',
    '',
    `- Run: \`${entry.run.runId}\``,
    `- OpenSpec change: \`${projection.changeName}\``,
    `- Auto Deliver run: \`${projection.runId}\``,
    `- Status: \`${projection.status}\``,
    `- Captured at: ${new Date(nowMs).toISOString()}`,
    '',
    '## Task Completion',
    '',
    `- Checked tasks: ${taskStats.checked}/${taskStats.total}`,
    `- Unchecked tasks: ${taskStats.unchecked}`,
    `- Implementation prompts: ${projection.implementationPromptCount}/${projection.materializedLimits.maxImplementationPrompts}`,
    '',
    '## Module Scores',
    '',
    ...(scoreLines.length > 0 ? scoreLines : ['- No module scores were provided by OpenSpec Auto Deliver.']),
    '',
    '## Evidence',
    '',
    ...(evidenceLines.length > 0 ? evidenceLines : ['- No detailed evidence entries were provided by OpenSpec Auto Deliver.']),
    '',
    '## Release Boundary',
    '',
    '- This artifact proves the implementation loop reached the OpenSpec passed state for this Evolution run.',
    '- Staging may run automatically only when `.imc/evolution/delivery.json` explicitly enables staging.',
    '- Production remains behind `human_release_gate`; this evidence does not authorize production execution.',
    '',
  ].join('\n');
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  const artifact: EvolutionArtifactRef = {
    id: 'test_evidence:artifacts/test-evidence.md',
    kind: 'test_evidence',
    path: artifactPath,
    title: 'QA Completion Evidence',
    preview: markdownPreview(content),
    roleId: 'qa_engineer',
    stage: 'qa_completion',
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    createdAt: nowMs,
  };
  upsertArtifact(entry.run, artifact);
  return artifact;
}

function latestOpenSpecEvidenceSummary(projection: OpenSpecAutoDeliverProjection): string {
  const taskStats = projection.taskStats;
  const taskSummary = taskStats
    ? `tasks ${taskStats.checked}/${taskStats.total} checked`
    : 'tasks unknown';
  return `OpenSpec Auto Deliver ${projection.runId} is ${projection.status} (${taskSummary}).`;
}

function openSpecModuleRole(module: string): EvolutionRoleId {
  if (module === 'tests') return 'qa_engineer';
  if (module === 'risk' || module === 'spec' || module === 'tasks') return 'tech_director';
  return 'backend_developer';
}

function taskLabelRole(label: string): EvolutionRoleId {
  const normalized = label.toLowerCase();
  if (/\b(ui|ux|frontend|front-end|react|component|screen|css|style|visual|mobile)\b/.test(normalized)) return 'frontend_developer';
  if (/\b(test|qa|spec|coverage|regression|e2e|unit)\b/.test(normalized)) return 'qa_engineer';
  if (/\b(deploy|release|staging|rollback|ops|env)\b/.test(normalized)) return 'ops_release_manager';
  if (/\b(security|auth|permission|privacy|secret)\b/.test(normalized)) return 'security_reviewer';
  return 'backend_developer';
}

function summarizeTaskLabels(labels: string[], max = 3): string {
  if (labels.length === 0) return 'none';
  const shown = labels.slice(0, max).join('；');
  return labels.length > max ? `${shown}；+${labels.length - max} more` : shown;
}

function appendOpenSpecDetailEvents(run: EvolutionRun, projection: OpenSpecAutoDeliverProjection, nowMs: number): void {
  const taskStats = projection.taskStats;
  const uncheckedItems = taskStats.items.filter((item) => !item.checked);
  const checkedItems = taskStats.items.filter((item) => item.checked);
  const targetStage = targetEvolutionStageForOpenSpec(projection.status) ?? run.stage;
  appendLiveEvent(run, {
    source: 'openspec_auto_deliver',
    kind: 'status',
    severity: projection.status === 'needs_human' || projection.status === 'failed' ? 'warning' : projection.status === 'passed' ? 'success' : 'info',
    roleId: discussionRoleForOpenSpecStatus(projection.status),
    stage: targetStage,
    title: `OpenSpec · ${projection.status}`,
    detail: projection.lastMessage ?? latestOpenSpecEvidenceSummary(projection),
    progress: {
      current: taskStats.checked,
      total: Math.max(1, taskStats.total),
      label: `${taskStats.checked}/${taskStats.total} tasks`,
    },
    createdAt: nowMs,
  });
  appendLiveEvent(run, {
    source: 'openspec_auto_deliver',
    kind: 'task_progress',
    severity: taskStats.unchecked > 0 ? 'info' : 'success',
    roleId: 'tech_director',
    stage: targetStage,
    title: 'OpenSpec task board',
    detail: `checked=${taskStats.checked}; unchecked=${taskStats.unchecked}; prompts=${projection.implementationPromptCount}/${projection.materializedLimits.maxImplementationPrompts}`,
    progress: {
      current: taskStats.checked,
      total: Math.max(1, taskStats.total),
      label: `${taskStats.checked}/${taskStats.total} checked`,
    },
    createdAt: nowMs,
  });
  if (projection.activeOpenSpecPromptId) {
    appendLiveEvent(run, {
      source: 'openspec_auto_deliver',
      kind: 'prompt',
      severity: 'info',
      roleId: projection.status === 'spec_audit_repair' ? 'tech_director' : projection.status === 'implementation_audit_repair' ? 'qa_engineer' : 'backend_developer',
      stage: targetStage,
      title: `Active prompt · ${projection.activeOpenSpecPromptId}`,
      detail: `generation=${projection.generation}; implementationPrompt=${projection.implementationPromptCount}; p2p=${projection.activeP2pRunId ?? 'none'}`,
      createdAt: nowMs,
    });
  }
  appendEvidence(run, {
    source: 'openspec_task_board',
    summary: `Task board ${taskStats.checked}/${taskStats.total} checked; unchecked=${taskStats.unchecked}; implementation prompts=${projection.implementationPromptCount}/${projection.materializedLimits.maxImplementationPrompts}.`,
    createdAt: nowMs,
  });

  if (projection.status === 'implementation_task_loop' || projection.status === 'commit_push') {
    const labelsByRole = new Map<EvolutionRoleId, string[]>();
    for (const item of uncheckedItems.length > 0 ? uncheckedItems : checkedItems) {
      const roleId = taskLabelRole(item.label);
      labelsByRole.set(roleId, [...(labelsByRole.get(roleId) ?? []), item.label]);
    }
    if (labelsByRole.size === 0) labelsByRole.set('backend_developer', []);
    for (const [roleId, labels] of labelsByRole.entries()) {
      appendDiscussion(run, {
        kind: 'role_update',
        stage: 'implementation_loop',
        roleId,
        author: 'OpenSpec Auto Deliver',
        text: `开发 loop 第 ${projection.implementationPromptCount}/${projection.materializedLimits.maxImplementationPrompts} 轮：${taskStats.checked}/${taskStats.total} tasks checked；${uncheckedItems.length > 0 ? '剩余任务' : '最近完成/验证任务'}：${summarizeTaskLabels(labels)}。`,
        createdAt: nowMs,
      });
    }
  }

  if (projection.status === 'spec_audit_repair' || projection.status === 'implementation_audit_repair') {
    const round = projection.status === 'spec_audit_repair'
      ? projection.specAuditRound
      : projection.implementationAuditRound;
    appendDiscussion(run, {
      kind: 'role_update',
      stage: projection.status === 'spec_audit_repair' ? 'architecture_baseline' : 'qa_completion',
      roleId: projection.status === 'spec_audit_repair' ? 'tech_director' : 'qa_engineer',
      author: 'OpenSpec Auto Deliver',
      text: `审查修复轮次 ${round ? `${round.current}/${round.total}` : 'unknown'}；active prompt=${projection.activeOpenSpecPromptId ?? 'n/a'}；latest verdict=${projection.latestVerdict ?? 'pending'}。`,
      createdAt: nowMs,
    });
  }

  if (projection.activeP2pRunId) {
    appendDiscussion(run, {
      kind: 'role_update',
      stage: targetEvolutionStageForOpenSpec(projection.status) ?? run.stage,
      roleId: 'tech_director',
      author: 'OpenSpec Auto Deliver',
      text: `关联 P2P 审查正在运行：${projection.activeP2pRunId}${projection.selectedTeamComboId ? `，team combo=${projection.selectedTeamComboId}` : ''}。`,
      createdAt: nowMs,
    });
  }

  for (const score of projection.moduleScores ?? []) {
    appendLiveEvent(run, {
      source: 'openspec_auto_deliver',
      kind: 'score',
      severity: score.score >= 8 ? 'success' : score.score >= 5 ? 'warning' : 'error',
      roleId: openSpecModuleRole(score.module),
      stage: targetStage,
      title: `Score · ${score.module} ${score.score}/10`,
      detail: score.summary,
      progress: {
        current: score.score,
        total: score.max_score,
        label: `${score.score}/${score.max_score}`,
      },
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: `openspec_score:${score.module}`,
      summary: `${score.module} score ${score.score}/10 — ${score.summary}`,
      createdAt: nowMs,
    });
  }

  if (projection.latestRepairSummary) {
    appendDiscussion(run, {
      kind: 'role_update',
      stage: targetEvolutionStageForOpenSpec(projection.status) ?? run.stage,
      roleId: 'qa_engineer',
      author: 'OpenSpec Auto Deliver',
      text: `最近修复摘要：${projection.latestRepairSummary}`,
      createdAt: nowMs,
    });
  }
}

function discussionRoleForOpenSpecStatus(status: OpenSpecAutoDeliverProjection['status']): EvolutionRoleId {
  if (status === 'implementation_audit_repair' || status === 'passed') return 'qa_engineer';
  if (status === 'needs_human') return 'loop_supervisor';
  if (status === 'failed' || status === 'stopped') return 'tech_director';
  return 'backend_developer';
}

export async function checkEvolutionStagingConfig(
  options: CheckEvolutionStagingConfigOptions,
): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(options.runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const entry = getRuntimeEntry(validRunId.value);
  if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
  const nowMs = options.nowMs ?? Date.now();
  const run = entry.run;
  const result = await checkEvolutionStagingDeliveryConfig({
    projectRoot: entry.projectRoot,
    runId: run.runId,
    nowMs,
  });
  if (result.artifact) upsertArtifact(run, result.artifact);
  run.stagingDelivery = {
    status: result.status,
    configPath: result.configPath,
    ...(result.commandLine ? { command: result.commandLine } : {}),
    ...(result.artifact ? { logArtifactId: result.artifact.id } : {}),
    summary: result.summary,
    startedAt: result.checkedAt,
    completedAt: result.checkedAt,
    ...(result.error ? { lastError: result.error } : {}),
  };
  run.latestMessage = result.summary;

  const blockerPrefix = `staging-config-${run.runId}-`;
  run.blockingQuestions = run.blockingQuestions.filter((question) => !question.id.startsWith(blockerPrefix));
  if (result.status === 'failed') {
    run.blockingQuestions.push({
      id: `${blockerPrefix}blocked`,
      stage: run.stage,
      roleId: 'ops_release_manager',
      question: `Fix .imc/evolution/delivery.json before staging delivery can run: ${result.error ?? result.summary}`,
      createdAt: result.checkedAt,
    });
  }

  appendDiscussion(run, {
    kind: result.status === 'ready' ? 'role_update' : 'gate',
    stage: run.stage,
    roleId: 'ops_release_manager',
    author: '运维/发布经理',
    text: result.status === 'ready'
      ? `staging 配置体检通过，后续 delivery_ready 可执行：${result.commandLine ?? result.summary}`
      : `staging 配置体检结果：${result.summary}`,
    ...(result.artifact ? { artifactIds: [result.artifact.id] } : {}),
    createdAt: result.checkedAt,
  });
  appendEvidence(run, {
    source: 'staging_config_check',
    summary: result.summary,
    ...(result.commandLine ? { command: result.commandLine } : {}),
    ...(result.artifact ? { artifactId: result.artifact.id } : {}),
    createdAt: result.checkedAt,
  });
  appendLiveEvent(run, {
    source: 'staging_delivery',
    kind: 'gate',
    severity: result.status === 'ready' ? 'success' : result.status === 'failed' ? 'error' : 'warning',
    roleId: 'ops_release_manager',
    stage: result.status === 'failed' ? 'needs_human' : 'delivery_ready',
    title: 'Staging config check',
    detail: result.summary,
    ...(result.commandLine ? { command: result.commandLine } : {}),
    ...(result.artifact ? { artifactIds: [result.artifact.id] } : {}),
    createdAt: result.checkedAt,
  });
  upsertScore(run, {
    module: 'delivery',
    score: result.status === 'ready' ? 7 : result.status === 'disabled' ? 6 : result.status === 'not_configured' ? 5 : 3,
    maxScore: 10,
    summary: result.summary,
  });
  return ok(await persistAndProject(entry, result.checkedAt));
}

async function maybeRunStagingDelivery(
  entry: RuntimeEntry,
  serverLink: EvolutionServerLink | null | undefined,
  nowMs: number,
): Promise<EvolutionProjection | null> {
  const run = entry.run;
  if (run.stage !== 'delivery_ready') return null;
  if (run.stagingDelivery?.status === 'passed' || run.stagingDelivery?.status === 'running') return null;

  if (run.budget.maxAutoDeployStage !== 'staging') {
    const summary = 'Staging auto deployment is disabled by this run budget.';
    run.stagingDelivery = {
      status: 'disabled',
      summary,
      completedAt: nowMs,
    };
    run.latestMessage = summary;
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'delivery_ready',
      roleId: 'ops_release_manager',
      author: '运维/发布经理',
      text: 'staging 自动交付被预算策略禁用；保持在 delivery_ready，等待人工处理。',
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'staging_delivery',
      summary,
      createdAt: nowMs,
    });
    return persistAndProject(entry, nowMs);
  }

  run.stagingDelivery = {
    status: 'running',
    configPath: '.imc/evolution/delivery.json',
    summary: 'Starting configured staging delivery command.',
    startedAt: nowMs,
  };
  run.latestMessage = 'Starting staging delivery.';
  appendDiscussion(run, {
    kind: 'role_update',
    stage: 'delivery_ready',
    roleId: 'ops_release_manager',
    author: '运维/发布经理',
    text: 'staging 自动交付开始执行配置命令；完成后会把日志、退出码和生产门禁回流到 War Room。',
    createdAt: nowMs,
  });
  appendEvidence(run, {
    source: 'staging_delivery',
    summary: 'Starting configured staging delivery command.',
    createdAt: nowMs,
  });
  const runningProjection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection: runningProjection });

  const result = await runEvolutionStagingDelivery({
    projectRoot: entry.projectRoot,
    runId: run.runId,
    nowMs,
  });
  const completedAt = result.completedAt || nowMs;
  if (result.artifact) upsertArtifact(run, result.artifact);
  run.stagingDelivery = {
    status: result.status,
    configPath: result.configPath,
    ...(result.commandLine ? { command: result.commandLine } : {}),
    ...(result.artifact ? { logArtifactId: result.artifact.id } : {}),
    ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
    summary: result.summary,
    startedAt: result.startedAt,
    completedAt,
    ...(result.error ? { lastError: result.error } : {}),
  };
  run.latestMessage = result.summary;
  appendEvidence(run, {
    source: 'staging_delivery',
    summary: result.summary,
    ...(result.commandLine ? { command: result.commandLine } : {}),
    ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
    ...(result.artifact ? { artifactId: result.artifact.id } : {}),
    createdAt: completedAt,
  });
  if (result.commandLine) {
    appendLiveEvent(run, {
      source: 'staging_delivery',
      kind: 'command',
      severity: result.status === 'failed' ? 'error' : result.status === 'passed' ? 'success' : 'info',
      roleId: 'ops_release_manager',
      stage: result.status === 'failed' ? 'needs_human' : result.status === 'passed' ? 'deployed_staging' : 'delivery_ready',
      title: 'Staging command',
      detail: `duration=${result.durationMs}ms${result.timedOut ? '; timed out' : ''}`,
      command: result.commandLine,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(result.artifact ? { artifactIds: [result.artifact.id] } : {}),
      createdAt: completedAt,
    });
    appendEvidence(run, {
      source: 'staging_delivery_command',
      summary: `Executed staging command in ${result.durationMs}ms${result.timedOut ? ' (timed out)' : ''}.`,
      command: result.commandLine,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(result.artifact ? { artifactId: result.artifact.id } : {}),
      createdAt: completedAt,
    });
  }
  if (result.stdoutTail) {
    appendLiveEvent(run, {
      source: 'staging_delivery',
      kind: 'stdout',
      severity: 'info',
      roleId: 'ops_release_manager',
      stage: result.status === 'passed' ? 'deployed_staging' : 'delivery_ready',
      title: 'Staging stdout',
      detail: result.stdoutTail,
      ...(result.artifact ? { artifactIds: [result.artifact.id] } : {}),
      createdAt: completedAt,
    });
    appendEvidence(run, {
      source: 'staging_delivery_stdout',
      summary: `stdout: ${result.stdoutTail}`,
      ...(result.artifact ? { artifactId: result.artifact.id } : {}),
      createdAt: completedAt,
    });
  }
  if (result.stderrTail) {
    appendLiveEvent(run, {
      source: 'staging_delivery',
      kind: 'stderr',
      severity: result.status === 'failed' ? 'error' : 'warning',
      roleId: 'ops_release_manager',
      stage: result.status === 'failed' ? 'needs_human' : 'delivery_ready',
      title: 'Staging stderr',
      detail: result.stderrTail,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(result.artifact ? { artifactIds: [result.artifact.id] } : {}),
      createdAt: completedAt,
    });
    appendEvidence(run, {
      source: 'staging_delivery_stderr',
      summary: `stderr: ${result.stderrTail}`,
      ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
      ...(result.artifact ? { artifactId: result.artifact.id } : {}),
      createdAt: completedAt,
    });
  }

  if (result.status === 'passed') {
    for (const step of pathToEvolutionStage(run.stage, 'human_release_gate')) {
      run.stage = step;
      applyRoleStatesForStage(run, step, completedAt);
      if (step === 'deployed_staging') {
        appendDiscussion(run, {
          kind: 'role_update',
          stage: step,
          roleId: 'ops_release_manager',
          author: '运维/发布经理',
          text: `staging 自动交付已通过。${result.artifact ? `日志：${result.artifact.path}` : ''}`,
          createdAt: completedAt,
        });
      }
    }
    delete run.verdict;
    delete run.terminalReason;
    upsertScore(run, {
      module: 'delivery',
      score: 8,
      maxScore: 10,
      summary: 'Staging deployment completed; production is waiting for human release approval.',
    });
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'human_release_gate',
      roleId: 'ops_release_manager',
      author: '运维/发布经理',
      text: '已进入生产发布人工门禁。IM.codes 不会自动执行 production；请在确认 staging、回滚和风险后再批准生产。',
      createdAt: completedAt,
    });
  } else if (result.status === 'failed') {
    run.stage = 'needs_human';
    applyRoleStatesForStage(run, 'needs_human', completedAt);
    run.verdict = 'BLOCKED';
    const questionId = `staging-delivery-${run.runId}-blocked`;
    if (!run.blockingQuestions.some((question) => question.id === questionId)) {
      run.blockingQuestions.push({
        id: questionId,
        stage: 'needs_human',
        roleId: 'ops_release_manager',
        question: `Staging delivery failed: ${result.error ?? result.summary}`,
        createdAt: completedAt,
      });
    }
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'needs_human',
      roleId: 'ops_release_manager',
      author: '运维/发布经理',
      text: `staging 自动交付失败，已暂停进入人工处理：${result.summary}`,
      createdAt: completedAt,
    });
    upsertScore(run, {
      module: 'delivery',
      score: 3,
      maxScore: 10,
      summary: result.summary,
    });
  } else {
    const questionId = `staging-delivery-${run.runId}-${result.status}`;
    if (result.status === 'not_configured' && !run.blockingQuestions.some((question) => question.id === questionId)) {
      run.blockingQuestions.push({
        id: questionId,
        stage: 'delivery_ready',
        roleId: 'ops_release_manager',
        question: 'Add .imc/evolution/delivery.json with a staging command to enable automatic staging delivery.',
        createdAt: completedAt,
      });
    }
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'delivery_ready',
      roleId: 'ops_release_manager',
      author: '运维/发布经理',
      text: result.status === 'not_configured'
        ? '未找到 staging 自动交付配置；保持在 delivery_ready，不会猜测或执行部署命令。'
        : 'staging 自动交付已在配置中禁用；保持在 delivery_ready。',
      createdAt: completedAt,
    });
    upsertScore(run, {
      module: 'delivery',
      score: result.status === 'disabled' ? 6 : 5,
      maxScore: 10,
      summary: result.summary,
    });
  }

  return persistAndProject(entry, completedAt);
}

type PlanningRoundtableGateDecision =
  | { disposition: 'allow'; reason: string }
  | { disposition: 'defer'; reason: string }
  | { disposition: 'block'; reason: string };

function planningRoundtableVerdict(
  summary: string | undefined,
  allowLegacy = false,
): 'pass' | 'rework' | 'unknown' {
  const marker = (summary ?? '').match(/<!--\s*EVOLUTION_VERDICT:\s*(PASS|REWORK|BLOCKED)\s*-->/i)?.[1]?.toUpperCase();
  if (marker === 'PASS') return 'pass';
  if (marker === 'REWORK' || marker === 'BLOCKED') return 'rework';
  if (allowLegacy) {
    const normalized = (summary ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (/^(REWORK|BLOCKED|FAIL|FAILED)\b/.test(normalized) || /\bREWORK\b|\bBLOCKED\b|\bFAILED?\b/.test(normalized)) return 'rework';
    if (/^PASS\b/.test(normalized)) return 'pass';
  }
  return 'unknown';
}

function planningRoundtableGateDecision(run: EvolutionRun): PlanningRoundtableGateDecision {
  const roundtable = (run.roundtables ?? []).find((entry) => entry.id === PLANNING_ROUNDTABLE_ID);
  if (!roundtable) return { disposition: 'allow', reason: 'planning_roundtable_not_started' };
  if (roundtable.status === 'skipped') return { disposition: 'allow', reason: roundtable.error ?? 'planning_roundtable_skipped' };
  if (roundtable.status === 'planned' || roundtable.status === 'running') {
    return { disposition: 'defer', reason: `waiting_for_${PLANNING_ROUNDTABLE_ID}` };
  }
  if (roundtable.status === 'failed') {
    return { disposition: 'block', reason: `planning_roundtable_failed: ${roundtable.error ?? roundtable.summary ?? 'unknown_error'}` };
  }
  const verdict = planningRoundtableVerdict(roundtable.summary, (run.executionPolicy ?? 'draft_preview') !== 'governed');
  if (verdict === 'pass') return { disposition: 'allow', reason: 'planning_roundtable_passed' };
  if (verdict === 'rework') return { disposition: 'block', reason: `planning_roundtable_requires_rework: ${roundtable.summary ?? 'REWORK'}` };
  return { disposition: 'block', reason: `planning_roundtable_missing_pass_verdict: ${roundtable.summary ?? 'missing_summary'}` };
}

function roundtableGateDecision(roundtable: EvolutionRoundtableRef, run?: EvolutionRun): PlanningRoundtableGateDecision {
  if (roundtable.status === 'skipped') return { disposition: 'allow', reason: roundtable.error ?? `${roundtable.id}_skipped` };
  if (roundtable.status === 'planned' || roundtable.status === 'running') {
    return { disposition: 'defer', reason: `waiting_for_${roundtable.id}` };
  }
  if (roundtable.status === 'failed') {
    return { disposition: 'block', reason: `${roundtable.id}_failed: ${roundtable.error ?? roundtable.summary ?? 'unknown_error'}` };
  }
  const verdict = planningRoundtableVerdict(roundtable.summary, (run?.executionPolicy ?? 'draft_preview') !== 'governed');
  if (verdict === 'pass') return { disposition: 'allow', reason: `${roundtable.id}_passed` };
  if (verdict === 'rework') return { disposition: 'block', reason: `${roundtable.id}_requires_rework: ${roundtable.summary ?? 'REWORK'}` };
  return { disposition: 'block', reason: `${roundtable.id}_missing_pass_verdict: ${roundtable.summary ?? 'missing_summary'}` };
}

function isRecoverablePostSummaryRoundtableFailure(roundtable: EvolutionRoundtableRef): boolean {
  if (roundtable.status !== 'failed') return false;
  const reason = `${roundtable.error ?? ''} ${roundtable.summary ?? ''}`.toLowerCase();
  return reason.includes('post_summary_execution_timeout') ||
    reason.includes('post_summary_execution_confirmation_timeout');
}

/**
 * Non-auto-delivery gate specs enforced for this run at this stage: every
 * spec in strict mode, `alwaysGate` specs in every mode.
 */
function enforcedGateSpecsForStage(run: EvolutionRun, stage: EvolutionStage): EvolutionRoundtableSpec[] {
  const strict = (run.roundtableGateMode ?? 'planning') === 'strict';
  return EVOLUTION_ROUNDTABLE_SPECS.filter((spec) => spec.stage === stage && !spec.gatesAutoDelivery && (strict || spec.alwaysGate === true));
}

function strictRoundtableGateDecisionForStage(run: EvolutionRun, stage: EvolutionStage): PlanningRoundtableGateDecision {
  const specs = enforcedGateSpecsForStage(run, stage);
  if (specs.length === 0) return { disposition: 'allow', reason: 'no_enforced_roundtable_for_stage' };
  for (const spec of specs) {
    const roundtable = (run.roundtables ?? []).find((entry) => entry.id === spec.id);
    if (!roundtable) return { disposition: 'allow', reason: `${spec.id}_not_started` };
    const decision = roundtableGateDecision(roundtable, run);
    if (decision.disposition !== 'allow') return decision;
  }
  return { disposition: 'allow', reason: 'enforced_roundtables_passed_or_skipped' };
}

function strictRoundtableGateBlockForStage(
  run: EvolutionRun,
  stage: EvolutionStage,
): { roundtable: EvolutionRoundtableRef; reason: string } | null {
  for (const spec of enforcedGateSpecsForStage(run, stage)) {
    const roundtable = (run.roundtables ?? []).find((entry) => entry.id === spec.id);
    if (!roundtable) continue;
    const decision = roundtableGateDecision(roundtable, run);
    if (decision.disposition === 'block') {
      return { roundtable, reason: decision.reason };
    }
  }
  return null;
}

function shouldPauseForStrictRoundtableGate(run: EvolutionRun): boolean {
  return strictRoundtableGateDecisionForStage(run, run.stage).disposition === 'defer';
}

/**
 * Real foundation verification for greenfield runs at QA completion: run the
 * deterministic capability probes over the isolated target and upgrade
 * foundation evidence ONLY for observed markers. Returns true when the
 * required capabilities (repository, runtime) are verified; otherwise records
 * a blocking question, moves the run to needs_human, and returns false so the
 * caller skips staging delivery — a greenfield run must never complete while
 * its foundation is unproven.
 */
async function verifyGreenfieldFoundationOnPass(entry: RuntimeEntry, nowMs: number): Promise<boolean> {
  const run = entry.run;
  const targetRelativeDir = run.writePolicy?.targetRelativeDir ?? run.developmentTargetRelativeDir;
  const blockWithQuestion = (reason: string): false => {
    run.stage = 'needs_human';
    applyRoleStatesForStage(run, 'needs_human', nowMs);
    run.latestMessage = `Greenfield foundation verification failed: ${reason}`;
    const questionId = `greenfield-foundation-${run.runId}`;
    if (!run.blockingQuestions.some((question) => question.id === questionId)) {
      run.blockingQuestions.push({
        id: questionId,
        stage: 'needs_human',
        roleId: 'tech_director',
        question: `Greenfield foundation is unproven at QA completion: ${reason}. Verify the isolated workspace before completing the run.`,
        createdAt: nowMs,
      });
    }
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'needs_human',
      roleId: 'tech_director',
      author: '技术总监',
      text: run.latestMessage,
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'greenfield_foundation',
      summary: run.latestMessage,
      createdAt: nowMs,
    });
    return false;
  };
  if (!targetRelativeDir) {
    return blockWithQuestion('greenfield target directory is unresolved');
  }
  const probes = await probeFoundationCapabilities({ projectRoot: entry.projectRoot, targetRelativeDir });
  for (const probe of probes) {
    const existing = (run.foundationEvidence ?? []).find((item) => item.capability === probe.capability);
    if (probe.status === 'verified') {
      upsertFoundationEvidenceStatus(
        run,
        probe.capability,
        'verified',
        `${probe.capability} foundation verified in \`${targetRelativeDir}\`: ${probe.proof ?? 'marker observed'}.`,
        nowMs,
      );
    } else if (existing?.status === 'verified') {
      // Honest re-observation: a previously verified marker has disappeared.
      upsertFoundationEvidenceStatus(
        run,
        probe.capability,
        'planned',
        `${probe.capability} foundation marker is no longer observable in \`${targetRelativeDir}\`; downgraded from verified.`,
        nowMs,
      );
    }
  }
  const verified = probes.filter((probe) => probe.status === 'verified');
  const unverified = probes.filter((probe) => probe.status !== 'verified');
  appendEvidence(run, {
    source: 'greenfield_foundation',
    summary: `Foundation probes over ${targetRelativeDir}: verified=[${verified.map((probe) => probe.capability).join(', ') || 'none'}]; planned=[${unverified.map((probe) => probe.capability).join(', ') || 'none'}].`,
    createdAt: nowMs,
  });
  appendLiveEvent(run, {
    source: 'system',
    kind: 'status',
    severity: verified.length >= 2 ? 'success' : 'warning',
    roleId: 'tech_director',
    stage: run.stage,
    title: 'Greenfield foundation probes',
    detail: `verified: ${verified.map((probe) => `${probe.capability} (${probe.proof ?? 'observed'})`).join('; ') || 'none'}`,
    createdAt: nowMs,
  });
  const required: Array<FoundationProbeResult['capability']> = ['repository', 'runtime'];
  const missing = required.filter((capability) => !verified.some((probe) => probe.capability === capability));
  if (missing.length > 0) {
    return blockWithQuestion(`required capabilities not observed: ${missing.join(', ')}`);
  }
  return true;
}

export async function recordEvolutionOpenSpecProjection(options: RecordEvolutionOpenSpecProjectionOptions): Promise<EvolutionProjection[]> {
  const nowMs = options.nowMs ?? Date.now();
  const projection = options.projection;
  const updated: EvolutionProjection[] = [];
  for (const entry of runsById.values()) {
    const run = entry.run;
    if (!openSpecProjectionMatchesRun(projection, run)) continue;
    if (isEvolutionTerminalStage(run.stage)) continue;

    run.linkedAutoDeliverRunId = projection.runId;
    run.latestMessage = latestOpenSpecEvidenceSummary(projection);
    appendDiscussion(run, {
      kind: projection.status === 'needs_human' ? 'gate' : 'role_update',
      stage: targetEvolutionStageForOpenSpec(projection.status) ?? run.stage,
      roleId: discussionRoleForOpenSpecStatus(projection.status),
      author: 'OpenSpec Auto Deliver',
      text: run.latestMessage,
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'openspec_auto_deliver',
      summary: run.latestMessage,
      createdAt: nowMs,
    });
    for (const evidence of projection.evidence ?? []) {
      if (!evidence.summary) continue;
      appendEvidence(run, {
        source: evidence.source || 'openspec_auto_deliver',
        summary: evidence.summary,
        ...(evidence.command ? { command: evidence.command } : {}),
        ...(typeof evidence.exitCode === 'number' ? { exitCode: evidence.exitCode } : {}),
        createdAt: nowMs,
      });
    }
    appendOpenSpecDetailEvents(run, projection, nowMs);
    syncOpenSpecScores(run, projection);
    syncOpenSpecBlockingQuestion(run, projection, nowMs);

    const targetStage = targetEvolutionStageForOpenSpec(projection.status);
    if (targetStage && run.stage !== targetStage) {
      const path = pathToEvolutionStage(run.stage, targetStage);
      for (const step of path) {
        run.stage = step;
        applyRoleStatesForStage(run, step, nowMs);
      }
      if (targetStage === 'failed' || targetStage === 'stopped') {
        run.verdict = targetStage === 'failed' ? 'BLOCKED' : 'REWORK';
        run.terminalReason = projection.terminalReason ?? `openspec_${projection.status}`;
      }
    } else {
      applyRoleStatesForStage(run, run.stage, nowMs);
    }

    if (projection.status === 'passed') {
      const evidenceArtifact = await writeOpenSpecTestEvidenceArtifact(entry, projection, nowMs);
      appendDiscussion(run, {
        kind: 'artifact_summary',
        stage: 'qa_completion',
        roleId: 'qa_engineer',
        author: '测试工程师',
        text: `OpenSpec Auto Deliver 已通过，QA 完成证据包已生成：${evidenceArtifact.path}。`,
        artifactIds: [evidenceArtifact.id],
        createdAt: nowMs,
      });
      appendEvidence(run, {
        source: 'test_evidence',
        summary: `QA completion evidence captured for OpenSpec Auto Deliver run ${projection.runId}.`,
        artifactId: evidenceArtifact.id,
        createdAt: nowMs,
      });
      appendLiveEvent(run, {
        source: 'openspec_auto_deliver',
        kind: 'artifact',
        severity: 'success',
        roleId: 'qa_engineer',
        stage: 'qa_completion',
        title: 'QA completion evidence',
        detail: `OpenSpec passed with ${projection.taskStats.checked}/${projection.taskStats.total} tasks checked.`,
        artifactIds: [evidenceArtifact.id],
        createdAt: nowMs,
      });
    }

    let foundationOk = true;
    if (projection.status === 'passed' && run.developmentMode === 'greenfield_new_system') {
      foundationOk = await verifyGreenfieldFoundationOnPass(entry, nowMs);
    }
    let next = await persistAndProject(entry, nowMs);
    if (projection.status === 'passed' && foundationOk) {
      next = await maybeRunStagingDelivery(entry, options.serverLink, nowMs) ?? next;
    }
    updated.push(next);
    if (options.serverLink) send(options.serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection: next });
  }
  return updated;
}

function roundtableStatusForP2p(status: P2pRunStatus): EvolutionRoundtableRef['status'] {
  if (status === 'completed') return 'complete';
  if (status === 'failed' || status === 'timed_out' || status === 'cancelled' || status === 'interrupted') return 'failed';
  return 'running';
}

function structuredEvolutionVerdictMarker(value: string | undefined): string | undefined {
  const lines = (value ?? '').replace(/\r\n/g, '\n').trim().split('\n');
  const lastLine = lines.at(-1)?.trim();
  return lastLine && /^<!--\s*EVOLUTION_VERDICT:\s*(PASS|REWORK|BLOCKED)\s*-->$/i.test(lastLine)
    ? lastLine
    : undefined;
}

function summarizeP2pRoundtable(run: P2pRunUpdatePayload): string {
  const rawResult = typeof run.result_summary === 'string' ? run.result_summary.trim() : '';
  const marker = structuredEvolutionVerdictMarker(rawResult);
  const summaryText = rawResult
    .replace(/<!--\s*EVOLUTION_VERDICT:\s*(PASS|REWORK|BLOCKED)\s*-->/gi, '')
    .trim();
  const result = rawResult
    ? `${marker ? `${marker} ` : ''}${summaryText.replace(/\s+/g, ' ')}`.trim().slice(0, 500)
    : '';
  if (result) return result;
  if (run.error) return run.error;
  const active = run.current_target_session ? `current target ${run.current_target_session}` : 'no active target';
  return `P2P roundtable ${run.id} is ${run.status} (${active}).`;
}

function extractRoundtableContextSummary(markdown: string, allowLegacy: boolean): string | null {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const markerMatches = [...normalized.matchAll(/^##\s+(Business Summary|Result|Summary|Assistant|Final|结论|讨论结果)\b.*$/gim)];
  const markerIndex = markerMatches.length > 0 ? markerMatches[markerMatches.length - 1]?.index ?? -1 : -1;
  const body = markerIndex >= 0 ? normalized.slice(markerIndex) : normalized.slice(Math.max(0, normalized.length - 8_000));
  const verdict = structuredEvolutionVerdictMarker(body);
  if (!verdict && allowLegacy) {
    const legacy = body.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:(?:结论|Verdict|Decision|Conclusion)\s*[:：]\s*)?(PASS|REWORK|BLOCKED|FAIL(?:ED)?)\b/i);
    if (!legacy || legacy.index === undefined) return null;
    return body.slice(legacy.index).trim().replace(/\s+/g, ' ').slice(0, 500);
  }
  if (!verdict) return null;
  const summary = `${verdict} ${body.replace(/<!--\s*EVOLUTION_VERDICT:\s*(PASS|REWORK|BLOCKED)\s*-->/gi, '').trim()}`
    .replace(/\s+/g, ' ')
    .slice(0, 500);
  return summary.length > 0 ? summary : null;
}

async function readRoundtableContextSummary(entry: RuntimeEntry, roundtable: EvolutionRoundtableRef): Promise<string | null> {
  if (!roundtable.contextPath) return null;
  try {
    const contextPath = safeProjectRelativePath(entry.projectRoot, roundtable.contextPath);
    const markdown = await readFile(contextPath, 'utf8');
    return extractRoundtableContextSummary(
      markdown,
      (entry.run.executionPolicy ?? 'draft_preview') !== 'governed',
    );
  } catch {
    return null;
  }
}

async function reconcileRuntimeRoundtableContextFiles(
  entry: RuntimeEntry,
  nowMs: number,
  serverLink?: EvolutionServerLink | null,
): Promise<EvolutionProjection | null> {
  const run = entry.run;
  if (isEvolutionTerminalStage(run.stage)) return null;
  const changedRoundtableIds = new Set<string>();
  for (const roundtable of [...(run.roundtables ?? [])]) {
    const canReconcileFromContext = roundtable.status === 'running' ||
      roundtable.status === 'planned' ||
      isRecoverablePostSummaryRoundtableFailure(roundtable);
    if (!canReconcileFromContext) continue;
    const summary = await readRoundtableContextSummary(entry, roundtable);
    if (!summary) continue;
    const next: EvolutionRoundtableRef = {
      ...roundtable,
      status: 'complete',
      summary,
      completedAt: roundtable.completedAt ?? new Date(nowMs).toISOString(),
      updatedAt: nowMs,
    };
    delete next.currentTargetSession;
    delete next.error;
    if (next.attemptId) {
      const rawMachineVerdict = planningRoundtableVerdict(summary, (run.executionPolicy ?? 'draft_preview') !== 'governed');
      const finalized = await finalizeRoundtableAttemptOutputs(entry, next, next.attemptId, rawMachineVerdict, summary, nowMs);
      const machineVerdict = finalized.machineVerdict;
      if (finalized.summary !== summary) next.summary = finalized.summary;
      const attempt = await completeEvolutionAttempt({
        projectRoot: entry.projectRoot,
        run,
        attemptId: next.attemptId,
        status: machineVerdict === 'pass' ? 'passed' : 'rework',
        allowRecovery: true,
        ...(finalized.outputRevisionIds.length > 0 ? { outputRevisionIds: finalized.outputRevisionIds } : {}),
        ...(next.p2pRunId ? { p2pRunId: next.p2pRunId } : {}),
        nowMs,
      });
      if (attempt.kind !== 'maker') {
        const verdict = await recordEvolutionVerdict({
          projectRoot: entry.projectRoot,
          run,
          attempt,
          checkerRoleId: attempt.checkerRoleId ?? next.roles[next.roles.length - 1] ?? next.roles[0]!,
          verdict: machineVerdict === 'pass' ? 'PASS' : 'REWORK',
          machineReadable: /<!--\s*EVOLUTION_VERDICT:/i.test(finalized.summary),
          summary: finalized.summary,
          approvedRevisionIds: machineVerdict === 'pass' ? attempt.inputRevisionIds : [],
          ...(next.p2pRunId ? { p2pRunId: next.p2pRunId } : {}),
          nowMs,
        });
        next.verdictId = verdict.id;
      }
    }
    upsertRoundtable(run, next);
    const staleBlockerIds = new Set([`strict-roundtable-${run.runId}-${roundtable.id}-blocked`]);
    if (roundtable.id === PLANNING_ROUNDTABLE_ID) {
      staleBlockerIds.add(`planning-roundtable-${run.runId}-blocked`);
    }
    run.blockingQuestions = run.blockingQuestions.filter((question) => !staleBlockerIds.has(question.id));
    changedRoundtableIds.add(roundtable.id);
    run.latestMessage = `P2P roundtable ${roundtable.topic} completed from discussion context.`;
    appendDiscussion(run, {
      kind: 'role_update',
      stage: roundtable.stage,
      roleId: roundtablePrimaryRoleByRoles(roundtable.roles),
      author: `P2P ${roundtable.topic}`,
      text: `圆桌已从讨论文件同步完成：${summary}`,
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'p2p_roundtable_context',
      summary: `${roundtable.topic}: ${summary}`,
      createdAt: nowMs,
    });
  }
  if (changedRoundtableIds.size === 0) {
    const planningGateContext = `${run.autoDelivery?.lastError ?? ''} ${run.latestMessage ?? ''}`;
    const planningQuestionId = `planning-roundtable-${run.runId}-blocked`;
    if (
      run.stage === 'needs_human' &&
      planningGateContext.includes('planning_roundtable') &&
      !run.blockingQuestions.some((question) => question.id === planningQuestionId)
    ) {
      const gate = planningRoundtableGateDecision(run);
      if (gate.disposition === 'block') {
        return markPlanningRoundtableGateBlocked(entry, gate.reason, nowMs, serverLink);
      }
    }
    return null;
  }

  let projection = await persistAndProject(entry, nowMs);
  if (changedRoundtableIds.has(PLANNING_ROUNDTABLE_ID)) {
    const gate = planningRoundtableGateDecision(run);
    if (gate.disposition === 'block') {
      projection = await markPlanningRoundtableGateBlocked(entry, gate.reason, nowMs, serverLink);
    } else if (gate.disposition === 'allow' && run.stage === 'tasks_ready' && run.autoDelivery?.enabled && !run.linkedAutoDeliverRunId) {
      projection = await maybeStartAutoDelivery(entry, serverLink ?? null, nowMs) ?? projection;
    }
  }
  if ((run.roundtableGateMode ?? 'planning') === 'strict') {
    for (const roundtableId of changedRoundtableIds) {
      if (roundtableId === PLANNING_ROUNDTABLE_ID) continue;
      const roundtable = (run.roundtables ?? []).find((item) => item.id === roundtableId);
      if (!roundtable) continue;
      const gate = roundtableGateDecision(roundtable, run);
      if (gate.disposition === 'block') {
        projection = await markStrictRoundtableGateBlocked(entry, roundtable, gate.reason, nowMs, serverLink);
        break;
      }
    }
  }
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

// ── C7: visual-fidelity maker/checker retry loop ─────────────────────────────
//
// On a REWORK verdict from the fidelity checker, re-run the maker (the taste
// generation) with the checker's specific feedback, bounded by
// `run.budget.maxImplementationAttempts` — instead of escalating straight to
// needs_human on the first REWORK.
//
// Two load-bearing constraints (discussion round 9/桑桑):
// 1. The regeneration is a DIRECT function call — never a stage transition.
//    `EVOLUTION_STAGE_TRANSITIONS` has no design_hifi → design_lofi edge;
//    attempting one throws on the very first retry, every time.
// 2. The checker's REWORK reasoning is appended into taste-hifi-prompt.md
//    BEFORE re-calling generation (the script reads that exact file), so each
//    attempt actually refines rather than re-running against stale input.

const DESIGN_HIFI_FIDELITY_ATTEMPT_EVIDENCE_SOURCE = 'design_hifi_fidelity_attempt';
const FIDELITY_FEEDBACK_SECTION_PREFIX = '## 第 ';
const FIDELITY_FEEDBACK_SECTION_SUFFIX = ' 轮视觉保真复核反馈（必须修正后重新生成）';
const FIDELITY_FEEDBACK_SECTION_RE = /^## 第 \d+ 轮视觉保真复核反馈/gm;

function fidelityPromptPath(projectRoot: string, runId: string): string {
  const { runDir } = getEvolutionRunPaths(projectRoot, runId);
  return join(runDir, 'design/taste-hifi-prompt.md');
}

/**
 * Attempt count = max(evidence tags, feedback sections already written into
 * taste-hifi-prompt.md). The prompt file is the durable source of truth —
 * `run.evidence` is a capped rolling buffer, and long roundtable activity
 * between attempts could evict older attempt tags, which would undercount
 * and un-bound the retry loop.
 */
async function countFidelityAttempts(projectRoot: string, run: EvolutionRun): Promise<number> {
  const evidenceCount = run.evidence.filter((entry) => entry.source === DESIGN_HIFI_FIDELITY_ATTEMPT_EVIDENCE_SOURCE).length;
  let sectionCount = 0;
  try {
    const prompt = await readFile(fidelityPromptPath(projectRoot, run.runId), 'utf8');
    sectionCount = prompt.match(FIDELITY_FEEDBACK_SECTION_RE)?.length ?? 0;
  } catch { /* prompt file missing — evidence count is the best available */ }
  return Math.max(evidenceCount, sectionCount);
}

async function appendFidelityFeedbackToTastePrompt(projectRoot: string, runId: string, attempt: number, feedback: string): Promise<boolean> {
  try {
    const promptPath = fidelityPromptPath(projectRoot, runId);
    const existing = await readFile(promptPath, 'utf8');
    const section = [
      '',
      `${FIDELITY_FEEDBACK_SECTION_PREFIX}${attempt}${FIDELITY_FEEDBACK_SECTION_SUFFIX}`,
      '',
      feedback.trim(),
      '',
    ].join('\n');
    await writeFile(promptPath, `${existing}${section}`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a projection when a retry was dispatched (caller should not
 * hard-block), or null when the loop is exhausted / not applicable (caller
 * proceeds with the normal enforced-gate block to needs_human).
 */
async function runVisualFidelityMakerRetry(
  entry: RuntimeEntry,
  roundtable: EvolutionRoundtableRef,
  nowMs: number,
  serverLink: EvolutionServerLink | null | undefined,
): Promise<EvolutionProjection | null> {
  const run = entry.run;
  if (run.stage !== 'design_hifi') return null;
  const maxAttempts = Math.max(1, run.budget.maxImplementationAttempts);
  const priorAttempts = await countFidelityAttempts(entry.projectRoot, run);
  if (priorAttempts >= maxAttempts) {
    // Exhausted: leave a distinct trail (different from the single-failure
    // message) and let the caller escalate to needs_human.
    run.latestMessage = `视觉保真复核连续 ${maxAttempts} 轮未通过（REWORK），已停止自动重试并转入人工处理。`;
    appendEvidence(run, {
      source: 'roundtable_hard_gate',
      summary: `Visual fidelity gate still REWORK after ${maxAttempts} maker/checker attempts; escalating to human.`,
      createdAt: nowMs,
    });
    return null;
  }
  const attempt = priorAttempts + 1;
  // Prefer the checker's structured visual report (score + actionable
  // errors) over raw prose — the maker's next attempt gets data, not vibes.
  const structuredReport = parseUiVisualReportMarker(roundtable.summary);
  const feedback = structuredReport
    ? renderUiVisualReportFeedback(structuredReport)
    : roundtable.summary ?? 'REWORK（复核未提供具体反馈）';

  appendEvidence(run, {
    source: DESIGN_HIFI_FIDELITY_ATTEMPT_EVIDENCE_SOURCE,
    summary: `Fidelity maker/checker attempt ${attempt}/${maxAttempts} dispatched after REWORK.`,
    createdAt: nowMs,
  });
  appendLiveEvent(run, {
    source: 'taste_skill',
    kind: 'task_progress',
    severity: 'info',
    roleId: 'visual_designer',
    stage: 'design_hifi',
    title: `Fidelity retry ${attempt}/${maxAttempts} · regeneration`,
    detail: `Checker returned REWORK; regenerating with feedback. ${feedback.slice(0, 400)}`,
    progress: { current: attempt, total: maxAttempts, label: `attempt ${attempt}/${maxAttempts}` },
    createdAt: nowMs,
  });
  appendDiscussion(run, {
    kind: 'role_update',
    stage: 'design_hifi',
    roleId: 'visual_designer',
    author: '视觉设计师',
    text: `保真复核 REWORK（第 ${attempt}/${maxAttempts} 轮）：已把复核反馈写入 taste-hifi 提示词并重新生成高保真产物。`,
    createdAt: nowMs,
  });

  // (2) feedback into the prompt file BEFORE regeneration.
  await appendFidelityFeedbackToTastePrompt(entry.projectRoot, run.runId, attempt, feedback);
  // (1) direct function call — never transition().
  const tasteResult = await runEvolutionTasteHifiGeneration({ projectRoot: entry.projectRoot, runId: run.runId, nowMs });
  const regenArtifacts: Array<{ kind: EvolutionArtifactKind; path?: string; title: string }> = [
    { kind: 'taste_hifi_output', path: tasteResult.outputRelativePath, title: 'taste-skill High-Fidelity Output' },
    { kind: 'taste_hifi_reference', path: tasteResult.referenceRelativePath, title: 'taste-skill High-Fidelity Reference' },
    { kind: 'project_style_audit', path: tasteResult.styleAuditRelativePath, title: 'Existing Project Style Audit' },
    { kind: 'taste_hifi_log', path: tasteResult.logRelativePath, title: 'taste-skill High-Fidelity Generation Log' },
  ];
  for (const artifact of regenArtifacts) {
    if (!artifact.path) continue;
    upsertArtifact(run, {
      id: `${artifact.kind}:${artifact.path}`,
      kind: artifact.kind,
      path: artifact.path,
      title: artifact.title,
      roleId: 'visual_designer',
      stage: 'design_hifi',
      createdAt: tasteResult.completedAt,
    });
  }
  appendLiveEvent(run, {
    source: 'taste_skill',
    kind: 'status',
    severity: tasteResult.status === 'passed' ? 'success' : tasteResult.status === 'failed' ? 'error' : 'info',
    roleId: 'visual_designer',
    stage: 'design_hifi',
    title: `Fidelity retry ${attempt}/${maxAttempts} · generation ${tasteResult.status}`,
    detail: tasteResult.summary,
    progress: { current: attempt, total: maxAttempts, label: `attempt ${attempt}/${maxAttempts}` },
    createdAt: tasteResult.completedAt,
  });

  // Reset the checker roundtable so maybeStartRoundtable dispatches a fresh
  // review of the regenerated output (it skips ids that already exist). The
  // prior round's verdict stays in evidence/discussion for the audit trail.
  run.roundtables = (run.roundtables ?? []).filter((item) => item.id !== roundtable.id);
  run.latestMessage = `视觉保真第 ${attempt}/${maxAttempts} 轮重生成完成，正在重新启动保真复核。`;
  await persistAndProject(entry, nowMs);
  const projections = await maybeStartRoundtablesForStage(entry, serverLink, nowMs, 'design_hifi');
  const projection = projections[projections.length - 1] ?? await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

type RoundtableMachineVerdict = 'pass' | 'rework' | 'unknown';

/**
 * UI Evolution Engine — post-verdict output handling shared by both
 * roundtable completion paths (live P2P projection and context reconcile).
 *
 * - Design Maker PASS additionally requires promotion of its real outputs
 *   (schema-valid ui-spec.json + preview.html). A PASS claim without valid
 *   files downgrades to REWORK — a verdict token alone never promotes.
 * - Visual fidelity completions persist the structured UI_VISUAL_REPORT
 *   marker (score + actionable errors) as a governed artifact so the retry
 *   loop and War Room consume data, not prose.
 */
async function finalizeRoundtableAttemptOutputs(
  entry: RuntimeEntry,
  roundtable: EvolutionRoundtableRef,
  attemptId: string,
  machineVerdict: RoundtableMachineVerdict,
  summary: string,
  nowMs: number,
): Promise<{ machineVerdict: RoundtableMachineVerdict; summary: string; outputRevisionIds: string[] }> {
  const run = entry.run;
  let effectiveVerdict = machineVerdict;
  let effectiveSummary = summary;
  const outputRevisionIds: string[] = [];

  const isMakerRoundtable = roundtable.id === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID
    || roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID;
  if (isMakerRoundtable && machineVerdict === 'pass') {
    const promotion = roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID
      ? await registerProductMakerOutputArtifacts({
          projectRoot: entry.projectRoot,
          run,
          producerAttemptId: attemptId,
          nowMs,
        })
      : await registerDesignMakerOutputArtifacts({
      projectRoot: entry.projectRoot,
      run,
      producerAttemptId: attemptId,
      nowMs,
    });
    if (promotion.ok) {
      outputRevisionIds.push(...promotion.revisionIds);
      const makerLabel = roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID ? 'Product Maker' : 'Design Maker';
      const makerRoleId = roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID ? 'product_manager' as const : 'visual_designer' as const;
      appendEvidence(run, {
        source: 'maker_promotion',
        summary: `${makerLabel} outputs promoted (${promotion.revisionIds.length} revision(s)).`,
        createdAt: nowMs,
      });
      appendLiveEvent(run, {
        source: 'p2p_roundtable',
        kind: 'artifact',
        severity: 'success',
        roleId: makerRoleId,
        stage: roundtable.stage,
        title: `${makerLabel} · outputs promoted`,
        detail: roundtable.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID
          ? `agent-authored PRD promoted as agent_attested candidate (${promotion.revisionIds.length} revision(s)).`
          : `ui-spec + preview promoted as agent_attested candidates (${promotion.uiSpec?.screens.length ?? 0} screen(s)).`,
        createdAt: nowMs,
      });
    } else {
      effectiveVerdict = 'rework';
      // Rewrite the machine marker too — downstream gate decisions parse the
      // tail marker, so prepended prose alone would leave a live PASS claim.
      const neutralized = summary.replace(/<!--\s*EVOLUTION_VERDICT:\s*PASS\s*-->/gi, '<!-- EVOLUTION_VERDICT: REWORK -->');
      effectiveSummary = `REWORK: maker outputs failed promotion — ${promotion.reason ?? 'unknown'}\n${neutralized}`;
      appendEvidence(run, {
        source: 'maker_promotion',
        summary: `Maker PASS claim rejected: ${promotion.reason ?? 'unknown'}.`,
        createdAt: nowMs,
      });
    }
  }

  if (roundtable.id === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID && machineVerdict !== 'unknown') {
    const report = parseUiVisualReportMarker(summary);
    if (report) {
      await registerVisualReportArtifact({
        projectRoot: entry.projectRoot,
        run,
        report,
        producerAttemptId: attemptId,
        nowMs,
      });
      appendLiveEvent(run, {
        source: 'p2p_roundtable',
        kind: 'score',
        severity: report.score >= UI_VISUAL_REPORT_PASS_THRESHOLD ? 'success' : 'warning',
        roleId: 'visual_fidelity_checker',
        stage: roundtable.stage,
        title: `Visual QA · ${report.score}/100`,
        detail: `${report.errors.length} issue(s), basis: ${report.basis}.`,
        progress: { current: Math.round(report.score), total: 100, label: `${report.score}/100` },
        createdAt: nowMs,
      });
    }
  }

  return { machineVerdict: effectiveVerdict, summary: effectiveSummary, outputRevisionIds };
}

export async function recordEvolutionP2pRunProjection(options: RecordEvolutionP2pRunProjectionOptions): Promise<EvolutionProjection[]> {
  const nowMs = options.nowMs ?? Date.now();
  const p2pRun = options.run;
  const updated: EvolutionProjection[] = [];
  for (const entry of runsById.values()) {
    const run = entry.run;
    if (isEvolutionTerminalStage(run.stage)) continue;
    const roundtables = run.roundtables ?? [];
    const roundtable = roundtables.find((item) => item.p2pRunId === p2pRun.id);
    if (!roundtable) continue;

    const previousStatus = roundtable.status;
    const nextStatus = roundtableStatusForP2p(p2pRun.status);
    const summary = summarizeP2pRoundtable(p2pRun);
    if (previousStatus === 'complete' || previousStatus === 'failed') {
      appendEvidence(run, {
        source: 'p2p_roundtable_late_callback_ignored',
        summary: `Ignored late ${nextStatus} callback for terminal ${roundtable.id}; existing status=${previousStatus}, p2pRunId=${p2pRun.id}. Terminal summaries and verdicts are immutable.`,
        createdAt: nowMs,
      });
      const projection = await persistAndProject(entry, nowMs);
      updated.push(projection);
      if (options.serverLink) send(options.serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
      continue;
    }
    const next: EvolutionRoundtableRef = {
      ...roundtable,
      status: nextStatus,
      ...(typeof p2pRun.discussion_id === 'string' ? { discussionId: p2pRun.discussion_id } : {}),
      ...(typeof p2pRun.current_target_session === 'string' && p2pRun.current_target_session ? { currentTargetSession: p2pRun.current_target_session } : {}),
      ...(summary ? { summary } : {}),
      ...(p2pRun.error ? { error: p2pRun.error } : {}),
      ...(p2pRun.completed_at ? { completedAt: p2pRun.completed_at } : {}),
      updatedAt: nowMs,
    };
    if (p2pRun.current_target_session === null || nextStatus !== 'running') delete next.currentTargetSession;
    if (!p2pRun.error && nextStatus === 'complete') delete next.error;
    upsertRoundtable(run, next);
    run.latestMessage = `P2P roundtable ${roundtable.topic} is ${next.status}.`;
    // This handler fires on the ~200ms pushState cadence for any active
    // Evolution-launched roundtable (including C3/C5/C7 dispatches). Both
    // evidence and liveEvents are CAPPED buffers — append only on meaningful
    // change (status flip, summary/hop progress, terminal) so identical ticks
    // don't churn them. For evidence this is load-bearing, not cosmetic: the
    // C7 attempt counter derives from evidence tags, and per-tick appends
    // could evict attempt entries within a single multi-minute review round.
    const meaningfulChange = previousStatus !== nextStatus
      || roundtable.summary !== summary;
    if (meaningfulChange) appendEvidence(run, {
      source: 'p2p_roundtable',
      summary: run.latestMessage,
      createdAt: nowMs,
    });
    if (meaningfulChange) appendLiveEvent(run, {
      source: 'p2p_roundtable',
      kind: 'status',
      severity: nextStatus === 'failed' ? 'error' : nextStatus === 'complete' ? 'success' : 'info',
      roleId: 'loop_supervisor',
      stage: roundtable.stage,
      title: `Roundtable · ${roundtable.topic}`,
      detail: summary ?? `round ${p2pRun.current_round}/${p2pRun.total_rounds} · ${next.status}`,
      progress: {
        current: Math.max(0, Math.min(p2pRun.current_round, p2pRun.total_rounds)),
        total: Math.max(1, p2pRun.total_rounds),
        label: `round ${p2pRun.current_round}/${p2pRun.total_rounds}`,
      },
      createdAt: nowMs,
    });
    if (previousStatus !== nextStatus) {
      appendDiscussion(run, {
        kind: nextStatus === 'failed' ? 'gate' : 'role_update',
        stage: roundtable.stage,
        roleId: nextStatus === 'failed' ? 'loop_supervisor' : 'tech_director',
        author: `P2P ${roundtable.topic}`,
        text: nextStatus === 'complete'
          ? `圆桌已完成：${summary}`
          : nextStatus === 'failed'
            ? `圆桌失败/中断：${summary}`
            : `圆桌进行中：${summary}`,
        createdAt: nowMs,
      });
    }
    if ((nextStatus === 'complete' || nextStatus === 'failed') && next.attemptId) {
      const rawMachineVerdict = nextStatus === 'complete'
        ? planningRoundtableVerdict(summary, (run.executionPolicy ?? 'draft_preview') !== 'governed')
        : 'unknown';
      const finalized = nextStatus === 'complete'
        ? await finalizeRoundtableAttemptOutputs(entry, next, next.attemptId, rawMachineVerdict, summary ?? '', nowMs)
        : { machineVerdict: rawMachineVerdict, summary: summary ?? '', outputRevisionIds: [] };
      const machineVerdict = finalized.machineVerdict;
      const finalSummary = finalized.summary;
      if (finalSummary !== (summary ?? '')) {
        next.summary = finalSummary;
      }
      const attemptStatus = nextStatus === 'failed'
        ? 'failed'
        : machineVerdict === 'pass'
          ? 'passed'
          : machineVerdict === 'rework'
            ? 'rework'
            : 'blocked';
      const attempt = await completeEvolutionAttempt({
        projectRoot: entry.projectRoot,
        run,
        attemptId: next.attemptId,
        status: attemptStatus,
        p2pRunId: p2pRun.id,
        ...(finalized.outputRevisionIds.length > 0 ? { outputRevisionIds: finalized.outputRevisionIds } : {}),
        ...(machineVerdict === 'unknown' ? { error: 'machine_readable_evolution_verdict_missing' } : {}),
        nowMs,
      });
      // Maker attempts record no self-verdict: their durable record is the
      // attempt itself plus the validated output promotion; the independent
      // check happens downstream (visual-fidelity review of the outputs).
      if (machineVerdict !== 'unknown' && attempt.kind !== 'maker') {
        const checkerRoleId = attempt.checkerRoleId ?? next.roles[next.roles.length - 1] ?? next.roles[0]!;
        const verdict = await recordEvolutionVerdict({
          projectRoot: entry.projectRoot,
          run,
          attempt,
          checkerRoleId,
          verdict: machineVerdict === 'pass' ? 'PASS' : 'REWORK',
          machineReadable: /<!--\s*EVOLUTION_VERDICT:/i.test(finalSummary),
          summary: finalSummary,
          approvedRevisionIds: machineVerdict === 'pass' ? attempt.inputRevisionIds : [],
          p2pRunId: p2pRun.id,
          nowMs,
        });
        next.verdictId = verdict.id;
        upsertRoundtable(run, next);
      }
    }
    let projection = await persistAndProject(entry, nowMs);
    if (roundtable.id === PLANNING_ROUNDTABLE_ID && (nextStatus === 'complete' || nextStatus === 'failed')) {
      const gate = planningRoundtableGateDecision(run);
      if (gate.disposition === 'block') {
        projection = await markPlanningRoundtableGateBlocked(entry, gate.reason, nowMs, options.serverLink);
      } else if (gate.disposition === 'allow' && nextStatus === 'complete' && run.autoDelivery?.enabled && !run.linkedAutoDeliverRunId) {
        projection = await maybeStartAutoDelivery(entry, options.serverLink, nowMs) ?? projection;
      }
    } else if (nextStatus === 'complete' || nextStatus === 'failed') {
      // Enforced gate specs: every non-auto-delivery spec in strict mode,
      // `alwaysGate` specs in every mode.
      const spec = enforcedGateSpecsForStage(run, roundtable.stage).find((item) => item.id === roundtable.id);
      if (spec) {
        const gate = roundtableGateDecision(next, run);
        if (gate.disposition === 'block') {
          // C7: a completed fidelity review that returned REWORK first goes
          // through the bounded maker/checker retry loop; only exhaustion
          // (or a launch failure, which never enters the loop) hard-blocks.
          const retried = spec.id === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID && nextStatus === 'complete'
            ? await runVisualFidelityMakerRetry(entry, next, nowMs, options.serverLink)
            : null;
          projection = retried ?? await markStrictRoundtableGateBlocked(entry, next, gate.reason, nowMs, options.serverLink);
        } else if (gate.disposition === 'allow' && nextStatus === 'complete' && run.stage === spec.stage) {
          appendDiscussion(run, {
            kind: 'role_update',
            stage: run.stage,
            roleId: 'loop_supervisor',
            author: 'Loop Supervisor / 总控',
            text: `${next.topic} 已 PASS，严格圆桌门禁解除，自动恢复后续自我进化阶段。`,
            createdAt: nowMs,
          });
          const resumed = await runEvolutionAutopilot(run.runId, options.serverLink, { nowMs });
          if (resumed.ok) projection = resumed.value;
        }
      }
    }
    updated.push(projection);
    if (options.serverLink) send(options.serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  }
  return updated;
}

async function markAutoDeliveryLaunchBlocked(
  entry: RuntimeEntry,
  reason: string,
  nowMs: number,
  serverLink?: EvolutionServerLink | null,
): Promise<EvolutionProjection> {
  const run = entry.run;
  run.stage = 'needs_human';
  applyRoleStatesForStage(run, 'needs_human', nowMs);
  run.verdict = 'BLOCKED';
  run.latestMessage = `Auto delivery launch blocked: ${reason}`;
  if (run.autoDelivery) run.autoDelivery.lastError = reason;
  appendDiscussion(run, {
    kind: 'gate',
    stage: 'needs_human',
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: run.latestMessage,
    createdAt: nowMs,
  });
  const questionId = `auto-delivery-${run.runId}-blocked`;
  if (!run.blockingQuestions.some((question) => question.id === questionId)) {
    run.blockingQuestions.push({
      id: questionId,
      stage: 'needs_human',
      roleId: 'loop_supervisor',
      question: `Auto delivery could not start: ${reason}`,
      createdAt: nowMs,
    });
  }
  appendEvidence(run, {
    source: 'evolution_loop',
    summary: run.latestMessage,
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

async function deferAutoDeliveryForPlanningGate(
  entry: RuntimeEntry,
  reason: string,
  nowMs: number,
  serverLink?: EvolutionServerLink | null,
): Promise<EvolutionProjection> {
  const run = entry.run;
  const alreadyWaiting = run.autoDelivery?.lastError === reason;
  run.latestMessage = `Auto delivery waiting for planning roundtable gate: ${reason}`;
  if (run.autoDelivery) run.autoDelivery.lastError = reason;
  if (!alreadyWaiting) {
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'tasks_ready',
      roleId: 'loop_supervisor',
      author: 'Loop Supervisor / 总控',
      text: '开发 Loop 已暂停：等待 IM.codes P2P 规划复核圆桌给出明确 PASS 后再启动 OpenSpec Auto Deliver。',
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'evolution_loop',
      summary: run.latestMessage,
      createdAt: nowMs,
    });
  }
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

async function deferAutoDeliveryForServerLink(
  entry: RuntimeEntry,
  nowMs: number,
): Promise<EvolutionProjection> {
  const run = entry.run;
  const reason = 'missing_server_link';
  const alreadyWaiting = run.autoDelivery?.lastError === reason;
  run.latestMessage = 'Auto delivery waiting for daemon/server link before launching OpenSpec Auto Deliver.';
  if (run.autoDelivery) run.autoDelivery.lastError = reason;
  if (!alreadyWaiting) {
    appendDiscussion(run, {
      kind: 'gate',
      stage: 'tasks_ready',
      roleId: 'loop_supervisor',
      author: 'Loop Supervisor / 总控',
      text: '开发 Loop 暂未启动：daemon/server link 当前不可用；保持在 tasks_ready，连接恢复后会自动重试 OpenSpec Auto Deliver。',
      createdAt: nowMs,
    });
    appendEvidence(run, {
      source: 'evolution_loop',
      summary: run.latestMessage,
      createdAt: nowMs,
    });
    appendLiveEvent(run, {
      source: 'system',
      kind: 'gate',
      severity: 'warning',
      roleId: 'loop_supervisor',
      stage: 'tasks_ready',
      title: 'Auto delivery waiting for server link',
      detail: run.latestMessage,
      createdAt: nowMs,
    });
  }
  return persistAndProject(entry, nowMs);
}

async function markPlanningRoundtableGateBlocked(
  entry: RuntimeEntry,
  reason: string,
  nowMs: number,
  serverLink?: EvolutionServerLink | null,
): Promise<EvolutionProjection> {
  const run = entry.run;
  if (run.stage !== 'needs_human') {
    run.stage = 'needs_human';
    applyRoleStatesForStage(run, 'needs_human', nowMs);
  }
  run.verdict = 'BLOCKED';
  run.latestMessage = `Planning roundtable gate blocked auto delivery: ${reason}`;
  if (run.autoDelivery) run.autoDelivery.lastError = reason;
  appendDiscussion(run, {
    kind: 'gate',
    stage: 'needs_human',
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: `开发 Loop 已被 P2P 规划复核门禁拦截：${reason}`,
    createdAt: nowMs,
  });
  const questionId = `planning-roundtable-${run.runId}-blocked`;
  if (!run.blockingQuestions.some((question) => question.id === questionId)) {
    run.blockingQuestions.push({
      id: questionId,
      stage: 'needs_human',
      roleId: 'loop_supervisor',
      question: `Resolve planning roundtable gate before implementation: ${reason}`,
      createdAt: nowMs,
    });
  }
  appendEvidence(run, {
    source: 'p2p_roundtable_gate',
    summary: run.latestMessage,
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

async function markStrictRoundtableGateBlocked(
  entry: RuntimeEntry,
  roundtable: EvolutionRoundtableRef,
  reason: string,
  nowMs: number,
  serverLink?: EvolutionServerLink | null,
): Promise<EvolutionProjection> {
  const run = entry.run;
  if (run.stage !== 'needs_human') {
    run.stage = 'needs_human';
    applyRoleStatesForStage(run, 'needs_human', nowMs);
  }
  run.verdict = 'BLOCKED';
  run.latestMessage = `Strict roundtable gate blocked planning: ${roundtable.topic}: ${reason}`;
  appendDiscussion(run, {
    kind: 'gate',
    stage: 'needs_human',
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: `严格圆桌门禁已暂停自我进化：${roundtable.topic} 需要处理：${reason}`,
    createdAt: nowMs,
  });
  const questionId = `strict-roundtable-${run.runId}-${roundtable.id}-blocked`;
  if (!run.blockingQuestions.some((question) => question.id === questionId)) {
    run.blockingQuestions.push({
      id: questionId,
      stage: 'needs_human',
      roleId: 'loop_supervisor',
      question: `Resolve strict roundtable gate ${roundtable.topic}: ${reason}`,
      createdAt: nowMs,
    });
  }
  appendEvidence(run, {
    source: 'p2p_roundtable_gate',
    summary: run.latestMessage,
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

function renderProductRoundtablePrompt(run: EvolutionRun): string {
  return [
    `请以 IM.codes Evolution Factory 产品圆桌方式复核 run ${run.runId}。`,
    '',
    '目标：在 PRD 生成前复核需求标准化与产品讨论，找出用户、目标、非目标、验收标准、风险假设中的遗漏。',
    '',
    '角色视角：',
    '- 产品经理：MVP 边界、用户故事、验收标准。',
    '- 产品审查：矛盾、不可测需求、边界和高风险假设。',
    '- Loop Supervisor：是否需要人工澄清，是否可以继续 PRD。',
    '',
    '输出要求：先给 PASS / REWORK，再列出最多 8 个必须处理的问题；本轮只讨论，不修改代码。',
  ].join('\n');
}

function renderDesignRoundtablePrompt(run: EvolutionRun): string {
  return [
    `请以 IM.codes Evolution Factory 设计圆桌方式复核 run ${run.runId}。`,
    '',
    '目标：基于 PRD、UX flow、低保真线框、高保真说明、SVG mockup 和 taste-skill 提示词，找出体验、视觉、组件状态、前端实现风险。',
    '',
    '角色视角：',
    '- UX：主流程、异常/空/加载状态、信息架构。',
    '- 视觉：高保真方向、token、组件层级、动效。',
    '- 前端：是否可实现、响应式/可访问性风险。',
    '- 产品：设计是否仍满足 PRD 验收标准。',
    '',
    '输出要求：先给 PASS / REWORK，再列出设计修正建议和需要 taste-skill/image generation 增强的部分；Figma 仅作为可选导出。',
  ].join('\n');
}

function renderArchitectureRoundtablePrompt(run: EvolutionRun): string {
  return [
    `请以 IM.codes Evolution Factory 架构圆桌方式复核 run ${run.runId}。`,
    '',
    '目标：基于 PRD、设计稿、架构基线和 ADR，找出技术边界、依赖、安全、测试、部署和任务拆分风险。',
    '',
    '角色视角：',
    '- 技术总监：架构边界、ADR、依赖和任务可拆分性。',
    '- 后端/前端：实现面、接口契约、状态同步风险。',
    '- QA：可测性、回归范围、验收命令。',
    '- 安全：鉴权、隐私、支付、密钥、迁移和供应链。',
    '',
    '输出要求：先给 PASS / REWORK，再列出进入 OpenSpec 任务前必须修正的架构问题。',
  ].join('\n');
}

function renderPlanningRoundtablePrompt(run: EvolutionRun): string {
  return [
    `请以 IM.codes Evolution Factory 多角色圆桌方式复核 run ${run.runId}。`,
    '',
    '目标：基于已生成 PRD、低保真/高保真设计稿、架构、OpenSpec 任务、多 agent 分派矩阵、测试计划、详细测试用例和部署计划，找出实现前必须修正的矛盾、遗漏、风险和测试缺口。',
    '',
    '请按以下角色视角输出：',
    '- 产品经理：MVP 范围、用户故事、验收标准是否清晰。',
    '- 产品审查：矛盾、遗漏、不可测需求、边界问题。',
    '- UX/视觉：流程、高保真规格、组件状态是否足够开发。',
    '- 技术总监：架构基线、ADR、任务拆分、agent ownership、依赖风险。',
    '- QA/安全/运维：测试用例完整性、风险、staging/production gate。',
    '',
    '输出要求：',
    '1. 先给 PASS / REWORK 建议。',
    '2. 列出最多 10 个必须处理的问题。',
    '3. 给出是否允许进入 OpenSpec Auto Deliver 开发 loop。',
    '4. 不要执行代码修改；本轮只做复核讨论。',
  ].join('\n');
}

function renderVisualFidelityRoundtablePrompt(run: EvolutionRun): string {
  const runDirRelative = `${EVOLUTION_RUN_ROOT_DIR}/${run.runId}`;
  const referenceImagePaths = run.artifacts
    .filter((artifact) => artifact.kind === 'design_reference_image')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  const generatedOutputPaths = run.artifacts
    .filter((artifact) => artifact.kind === 'hifi_mockup' || artifact.kind === 'taste_hifi_output' || artifact.kind === 'taste_hifi_reference')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  const makerOutputPaths = run.artifacts
    .filter((artifact) => artifact.kind === 'ui_spec' || artifact.kind === 'hifi_preview_html' || artifact.kind === 'design_system_tokens')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  const screenshotPaths = run.artifacts
    .filter((artifact) => artifact.kind === 'ui_preview_screenshot')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  const reportBasis = screenshotPaths.length > 0 ? 'rendered_screenshot' : makerOutputPaths.length > 0 ? 'preview_source' : 'spec_only';
  return [
    `请以 IM.codes Evolution Factory 视觉保真复核方式审查 run ${run.runId}。这是硬性质量门禁：结论必须基于对参考图像素的真实查看，不允许仅凭文字描述推断。`,
    '',
    '## 第一步（必须执行）：用 Read 工具真实查看参考图',
    '以下路径相对于项目根目录，请逐个用你的 Read 工具打开查看：',
    ...(referenceImagePaths.length > 0
      ? referenceImagePaths.map((path) => `- ${path}`)
      : ['- （未登记参考图产物 — 如确实没有参考图，请在结论中说明无法执行保真对比，并给出 REWORK）']),
    '',
    '## 第二步：查看生成的高保真产物',
    ...(makerOutputPaths.length > 0
      ? ['Design Maker 真实产出（优先审查这些）：', ...makerOutputPaths.map((path) => `- ${path}`)]
      : []),
    ...(screenshotPaths.length > 0
      ? ['渲染截图（与参考图逐张对比）：', ...screenshotPaths.map((path) => `- ${path}`)]
      : []),
    ...(generatedOutputPaths.length > 0
      ? generatedOutputPaths.map((path) => `- ${path}`)
      : ['- （未找到生成产物 — 请给出 REWORK 并说明缺失）']),
    '',
    '## 第三步：逐项对比并输出结论',
    '- 布局/信息层级：生成产物与参考图的结构是否可追溯对应。',
    '- 配色：主色/辅色/背景是否来自参考图（列出具体色值差异）。',
    '- 字体与间距：字号层级、留白节奏是否一致。',
    '- 组件：参考图中的关键组件是否全部出现且状态完整。',
    '',
    '输出要求：第一行必须是 PASS 或 REWORK；REWORK 时逐条列出具体的、可执行的修改点（供下一轮重生成使用）。',
    '同时必须在结论末尾输出一行结构化视觉报告（0-100 分 + 具体问题，JSON 单行）：',
    `<!-- UI_VISUAL_REPORT: {"score":<0-100>,"basis":"${reportBasis}","errors":[{"type":"layout|color|typography|spacing|component|content|interaction","issue":"...","fix":"...","screen":"..."}],"summary":"..."} -->`,
    `score >= ${UI_VISUAL_REPORT_PASS_THRESHOLD} 才应给 PASS；分数必须与你实际观察到的差异一致，不允许无依据打高分。`,
  ].join('\n');
}

function renderProductMakerPrompt(run: EvolutionRun): string {
  const runDirRelative = `${EVOLUTION_RUN_ROOT_DIR}/${run.runId}`;
  const referenceImagePaths = run.artifacts
    .filter((artifact) => artifact.kind === 'design_reference_image')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  const normalizedPath = run.artifacts.find((artifact) => artifact.kind === 'normalized_requirement')?.path;
  return [
    `你是本次自我进化 run ${run.runId} 的产品经理 Maker。你的任务不是讨论，而是真实撰写可交付的 PRD 文档。`,
    '',
    '## 第一步：真实阅读输入',
    `- 原始需求：\`${run.source.relativePath}\`（用 Read 工具打开）`,
    ...(normalizedPath ? [`- 标准化需求：\`${runDirRelative}/${normalizedPath}\``] : []),
    ...(referenceImagePaths.length > 0
      ? ['- 参考图（必须逐张用 Read 工具真实查看）：', ...referenceImagePaths.map((path) => `  - ${path}`)]
      : []),
    '',
    '## 第二步：写出以下文件（路径相对项目根目录）',
    `1. \`${runDirRelative}/${PRODUCT_MAKER_PRD_RELATIVE_PATH}\`（必需）— 完整 PRD：业务目标、目标用户与分层、范围/非目标、用户故事、可度量的成功指标、显式假设与开放问题、验收标准。必须基于真实输入，不得输出通用模板。`,
    `2. \`${runDirRelative}/${PRODUCT_MAKER_USER_STORIES_RELATIVE_PATH}\`（可选）— 展开的用户故事清单。`,
    `3. \`${runDirRelative}/${PRODUCT_MAKER_ACCEPTANCE_RELATIVE_PATH}\`（可选）— 可测试的验收标准清单。`,
    '',
    '## 输出要求',
    '完成写入后，最后一条消息列出写入的文件与关键产品决策/假设，并以下面一行结束：',
    '<!-- EVOLUTION_VERDICT: PASS -->',
    '如因输入缺失无法完成，说明缺什么并以 <!-- EVOLUTION_VERDICT: BLOCKED --> 结束；绝不允许在未写文件的情况下输出 PASS。',
  ].join('\n');
}

function renderDesignMakerPrompt(run: EvolutionRun): string {
  const runDirRelative = `${EVOLUTION_RUN_ROOT_DIR}/${run.runId}`;
  const referenceImagePaths = run.artifacts
    .filter((artifact) => artifact.kind === 'design_reference_image')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  const sourceDir = dirname(run.source.relativePath);
  const inputPaths = run.artifacts
    .filter((artifact) => artifact.kind === 'prd' || artifact.kind === 'normalized_requirement' || artifact.kind === 'ux_flow')
    .map((artifact) => `${runDirRelative}/${artifact.path}`);
  return [
    `你是本次自我进化 run ${run.runId} 的高保真设计 Maker（视觉设计师）。你的任务不是讨论，而是真实产出可交付的设计文件。`,
    '',
    '## 第一步：真实查看输入',
    '- 需求与 PRD（用 Read 工具打开）：',
    ...(inputPaths.length > 0 ? inputPaths.map((path) => `  - ${path}`) : [`  - ${run.source.relativePath}`]),
    referenceImagePaths.length > 0
      ? '- 参考图（必须逐张用 Read 工具真实查看像素，设计必须与其可追溯对应）：'
      : `- 参考图：先在 \`${sourceDir}\` 与 \`${runDirRelative}/design/reference-images/\` 下查找图片文件，找到则必须逐张真实查看。`,
    ...referenceImagePaths.map((path) => `  - ${path}`),
    '',
    '## 第二步：写出以下三个文件（路径相对项目根目录）',
    `1. \`${runDirRelative}/${UI_SPEC_RELATIVE_PATH}\` — UI Spec（JSON），必须符合此结构：`,
    '   `{"version":1,"page":{"name":"…","type":"…"},"design":{"style":"…","tokensRef":"design/design-system/tokens.json"},"layout":{…},"screens":[{"name":"…","viewport":{"width":1440,"height":900},"path":"#screen-1","components":[{"type":"…","title":"…","props":{…},"children":[…]}]}]}`',
    '   screens 至少 1 个；每个 screen 的 viewport 为整数像素；components 描述真实信息层级，不要占位。',
    `2. \`${runDirRelative}/${UI_PREVIEW_HTML_RELATIVE_PATH}\` — 自包含单文件 HTML+CSS 高保真预览：`,
    '   - 不引用任何外部资源（无外链 CSS/JS/字体/图片；图标用内联 SVG）。',
    '   - 每个 screen 一个 `<section id="screen-N">`，与 ui-spec 的 screens 一一对应。',
    '   - 布局、配色、字体、间距必须与参考图可追溯对应；不得输出通用模板。',
    `3. \`${runDirRelative}/${DESIGN_SYSTEM_TOKENS_RELATIVE_PATH}\` — 设计 token JSON（colors/typography/spacing/radius/shadow），色值必须来自参考图或现有项目风格审计。`,
    '',
    '## 输出要求',
    '完成写入后，最后一条消息必须：列出你写入的文件清单与每个文件的核心设计决策，并以下面一行结束：',
    '<!-- EVOLUTION_VERDICT: PASS -->',
    '如果因输入缺失无法完成，说明缺什么并以 <!-- EVOLUTION_VERDICT: BLOCKED --> 结束；绝不允许在未写文件的情况下输出 PASS。',
  ].join('\n');
}

const EVOLUTION_ROUNDTABLE_SPECS: EvolutionRoundtableSpec[] = [
  {
    id: EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
    stage: 'intake_normalized',
    topic: '产品 PRD Maker',
    roles: ['product_manager'],
    artifactKinds: ['normalized_requirement', 'requirement_classification', 'design_reference_manifest', 'role_skill'],
    prompt: renderProductMakerPrompt,
    alwaysGate: true,
    attemptKind: 'maker',
    shouldRun: (run) => (run.executionPolicy ?? 'draft_preview') === 'governed',
  },
  {
    id: 'product-review',
    stage: 'product_discussion',
    topic: '产品需求圆桌',
    roles: ['product_manager', 'product_critic', 'loop_supervisor'],
    artifactKinds: ['normalized_requirement', 'discussion', 'prd', 'prd_review', 'role_skill'],
    prompt: renderProductRoundtablePrompt,
  },
  {
    id: EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID,
    stage: 'design_lofi',
    topic: '高保真设计 Maker',
    roles: ['visual_designer'],
    artifactKinds: ['prd', 'normalized_requirement', 'ux_flow', 'design_reference_manifest', 'project_style_audit', 'role_skill'],
    prompt: renderDesignMakerPrompt,
    alwaysGate: true,
    attemptKind: 'maker',
    // A real production dispatch only makes sense under the governed policy;
    // draft_preview keeps the fast deterministic templates, honestly labeled.
    shouldRun: (run) => (run.executionPolicy ?? 'draft_preview') === 'governed',
  },
  {
    id: 'design-review',
    stage: 'design_hifi',
    topic: '设计复核圆桌',
    roles: ['ux_designer', 'visual_designer', 'frontend_developer', 'product_manager'],
    artifactKinds: ['prd', 'prd_review', 'ux_flow', 'wireframe', 'lofi_mockup', 'hifi_spec', 'hifi_mockup', 'taste_hifi_prompt', 'taste_hifi_output', 'design_handoff', 'role_skill'],
    prompt: renderDesignRoundtablePrompt,
  },
  {
    id: EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID,
    stage: 'design_hifi',
    topic: '视觉保真复核圆桌',
    roles: ['visual_fidelity_checker', 'visual_designer'],
    artifactKinds: ['design_reference_manifest', 'hifi_spec', 'hifi_mockup', 'taste_hifi_output', 'taste_hifi_reference', 'design_handoff', 'ui_spec', 'hifi_preview_html', 'design_system_tokens', 'ui_preview_screenshot', 'visual_report', 'role_skill'],
    prompt: renderVisualFidelityRoundtablePrompt,
    alwaysGate: true,
    // Fidelity-vs-reference is undefined without reference images — skip
    // entirely for text-only requirements instead of gating on nothing.
    shouldRun: (run) => run.artifacts.some((artifact) => artifact.kind === 'design_reference_image'),
  },
  {
    id: 'architecture-review',
    stage: 'architecture_baseline',
    topic: '架构基线圆桌',
    roles: ['tech_director', 'backend_developer', 'frontend_developer', 'qa_engineer', 'security_reviewer'],
    artifactKinds: ['prd', 'hifi_spec', 'hifi_mockup', 'taste_hifi_prompt', 'taste_hifi_output', 'architecture_baseline', 'adr', 'role_skill'],
    prompt: renderArchitectureRoundtablePrompt,
  },
  {
    id: PLANNING_ROUNDTABLE_ID,
    stage: 'tasks_ready',
    topic: '规划复核圆桌',
    roles: ['product_manager', 'product_critic', 'ux_designer', 'visual_designer', 'tech_director', 'qa_engineer', 'security_reviewer', 'ops_release_manager'],
    artifactKinds: ['prd', 'prd_review', 'hifi_spec', 'lofi_mockup', 'hifi_mockup', 'taste_hifi_prompt', 'taste_hifi_output', 'design_handoff', 'architecture_baseline', 'openspec_tasks', 'implementation_task_matrix', 'test_plan', 'test_cases', 'deployment_plan', 'role_skill'],
    prompt: renderPlanningRoundtablePrompt,
    gatesAutoDelivery: true,
  },
];

function roundtableArtifactPaths(run: EvolutionRun, spec: EvolutionRoundtableSpec): string[] {
  const wanted = new Set<EvolutionArtifactKind>(spec.artifactKinds);
  return run.artifacts
    .filter((artifact) => wanted.has(artifact.kind))
    .map((artifact) => artifact.path);
}

async function roundtableRoleInstructions(
  projectRoot: string,
  run: EvolutionRun,
  roles: readonly EvolutionRoleId[],
): Promise<EvolutionRoundtableRoleInstruction[]> {
  return Promise.all(roles.map(async (roleId) => {
    const role = run.roles.find((entry) => entry.roleId === roleId);
    const snapshot = [...(run.skillSnapshots ?? [])].reverse().find((entry) => entry.roleId === roleId);
    let skillContent: string | undefined;
    if (snapshot) {
      try {
        skillContent = await readFile(
          join(getEvolutionRunPaths(projectRoot, run.runId).skillSnapshotsDir, `${snapshot.id}.md`),
          'utf8',
        );
      } catch {
        skillContent = undefined;
      }
    }
    return {
      roleId,
      label: role?.label ?? roleId,
      ...(role?.skillName ? { skillName: role.skillName } : {}),
      ...(role?.skillSummary ? { skillSummary: role.skillSummary } : {}),
      responsibilities: role?.responsibilities ? [...role.responsibilities] : [],
      ...(role?.currentAction ? { currentAction: role.currentAction } : {}),
      ...(snapshot ? { skillSnapshotId: snapshot.id, skillSha256: snapshot.sha256 } : {}),
      ...(skillContent ? { skillContent } : {}),
    };
  }));
}

function lightModeRoundtableFallbackReason(run: EvolutionRun, spec: EvolutionRoundtableSpec): string | null {
  // An alwaysGate spec is an evidence-checkable hard bar — it must run for
  // real in every mode, never as a deterministic local review.
  if (spec.alwaysGate) return null;
  if ((run.executionPolicy ?? 'draft_preview') === 'governed') return null;
  if ((run.roundtableGateMode ?? 'planning') === 'strict') return null;
  if (spec.gatesAutoDelivery) {
    return run.autoDelivery?.enabled ? null : 'planning_roundtable_not_needed_without_auto_delivery';
  }
  return 'planning_light_mode_non_gate_roundtable';
}

/**
 * C5 hard-block half: an `alwaysGate` roundtable that cannot actually run
 * (no launcher, no capable helper, clone failed) must never be synthesized
 * into a local text-only PASS — that would be a fabricated verdict for a
 * check that is inherently about pixels the fallback never looked at. Record
 * the roundtable as failed instead; the enforced-gate machinery then blocks
 * the stage to `needs_human` with an explicit reason.
 */
async function failRoundtableWithoutFallback(
  entry: RuntimeEntry,
  serverLink: EvolutionServerLink | null | undefined,
  nowMs: number,
  spec: EvolutionRoundtableSpec,
  base: EvolutionRoundtableRef,
  reason: string,
): Promise<EvolutionProjection> {
  const run = entry.run;
  upsertRoundtable(run, { ...base, status: 'failed', error: reason, updatedAt: nowMs });
  run.latestMessage = `${spec.topic}无法真实执行（${reason}），已按硬门禁拦截，不使用本地兜底评审。`;
  appendDiscussion(run, {
    kind: 'gate',
    stage: spec.stage,
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: run.latestMessage,
    createdAt: nowMs,
  });
  appendEvidence(run, {
    source: 'roundtable_hard_gate',
    summary: `${spec.id} could not run (${reason}); hard-blocked instead of local fallback.`,
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

async function completeRoundtableWithLocalFallback(
  entry: RuntimeEntry,
  serverLink: EvolutionServerLink | null | undefined,
  nowMs: number,
  spec: EvolutionRoundtableSpec,
  base: EvolutionRoundtableRef,
  reason: string,
  discussionText: string,
): Promise<EvolutionProjection> {
  const run = entry.run;
  const summary = `PASS: local deterministic ${spec.topic} fallback completed because ${reason}; no blocking issues were found in the available stage artifacts.`;
  const artifact = await writeLocalRoundtableReviewArtifact(entry, spec, summary, reason, nowMs);
  const completed = {
    ...base,
    status: 'complete' as const,
    summary,
    contextPath: artifact.path,
    completedAt: new Date(nowMs).toISOString(),
  };
  upsertRoundtable(run, completed);
  appendDiscussion(run, {
    kind: 'role_update',
    stage: spec.stage,
    roleId: roundtablePrimaryRole(spec),
    author: `Local ${spec.topic}`,
    text: discussionText,
    artifactIds: [artifact.id],
    createdAt: nowMs,
  });
  appendEvidence(run, {
    source: 'local_roundtable_review',
    summary,
    artifactId: artifact.id,
    createdAt: nowMs,
  });
  appendLiveEvent(run, {
    source: 'p2p_roundtable',
    kind: 'artifact',
    severity: 'success',
    roleId: roundtablePrimaryRole(spec),
    stage: spec.stage,
    title: `${spec.topic} local fallback PASS`,
    detail: summary,
    artifactIds: [artifact.id],
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

async function maybeStartRoundtable(
  entry: RuntimeEntry,
  serverLink: EvolutionServerLink | null | undefined,
  nowMs: number,
  spec: EvolutionRoundtableSpec,
): Promise<EvolutionProjection | null> {
  const run = entry.run;
  if (run.stage !== spec.stage) return null;
  if (spec.shouldRun && !spec.shouldRun(run)) return null;
  const roundtableId = spec.id;
  if ((run.roundtables ?? []).some((roundtable) => roundtable.id === roundtableId)) return null;

  const requiresLiveRoundtable = (run.executionPolicy ?? 'draft_preview') === 'governed'
    || spec.alwaysGate
    || (run.roundtableGateMode ?? 'planning') === 'strict';
  const artifactPaths = roundtableArtifactPaths(run, spec);
  const inputRevisionIds = artifactPaths
    .map((path) => run.artifacts.find((artifact) => artifact.path === path)?.revisionId)
    .filter((value): value is string => typeof value === 'string');
  const skillSnapshotIds = (run.skillSnapshots ?? [])
    .filter((snapshot) => spec.roles.includes(snapshot.roleId))
    .map((snapshot) => snapshot.id);
  const primaryRoleId = roundtablePrimaryRole(spec);
  const checkerRoleId = spec.roles.find((roleId) => roleId !== primaryRoleId && (
    roleId === 'product_critic'
    || roleId === 'visual_fidelity_checker'
    || roleId === 'security_reviewer'
    || roleId === 'qa_engineer'
  )) ?? [...spec.roles].reverse().find((roleId) => roleId !== primaryRoleId) ?? spec.roles[0]!;
  const attempt = requiresLiveRoundtable
    ? await createEvolutionAttempt({
        projectRoot: entry.projectRoot,
        run,
        kind: spec.attemptKind ?? 'checker',
        stage: spec.stage,
        roleId: primaryRoleId,
        checkerRoleId,
        inputRevisionIds,
        skillSnapshotIds,
        nowMs,
      })
    : undefined;
  const base: EvolutionRoundtableRef = {
    id: roundtableId,
    stage: spec.stage,
    topic: spec.topic,
    roles: spec.roles,
    status: 'planned',
    ...(attempt ? { attemptId: attempt.id, dispatchToken: attempt.dispatchToken } : {}),
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  const lightModeReason = lightModeRoundtableFallbackReason(run, spec);
  if (lightModeReason) {
    return completeRoundtableWithLocalFallback(
      entry,
      serverLink,
      nowMs,
      spec,
      base,
      lightModeReason,
      `${spec.topic}已按低负载模式用本地多角色复核完成：无需启动额外 P2P agent；${lightModeReason}。`,
    );
  }

  if (!roundtableLauncher) {
    const reason = 'roundtable_launcher_unavailable';
    if (requiresLiveRoundtable) {
      if (attempt) await completeEvolutionAttempt({
        projectRoot: entry.projectRoot,
        run,
        attemptId: attempt.id,
        status: 'failed',
        error: reason,
        nowMs,
      });
      return failRoundtableWithoutFallback(entry, serverLink, nowMs, spec, base, reason);
    }
    return completeRoundtableWithLocalFallback(
      entry,
      serverLink,
      nowMs,
      spec,
      base,
      reason,
      `${spec.topic}已用本地多角色兜底复核完成：PASS: local deterministic ${spec.topic} fallback completed because ${reason}; no blocking issues were found in the available stage artifacts.`,
    );
  }

  const result = await roundtableLauncher({
    requestId: `evolution-roundtable-${run.runId}-${roundtableId}`,
    runId: run.runId,
    sessionName: run.sessionName,
    projectRoot: entry.projectRoot,
    stage: spec.stage,
    topic: base.topic,
    roles: spec.roles,
    roleInstructions: await roundtableRoleInstructions(entry.projectRoot, run, spec.roles),
    prompt: spec.prompt(run),
    artifactPaths,
    roundtableSpecId: spec.id,
  }, serverLink ?? null);

  if (!result.ok && result.skippedReason) {
    const reason = result.skippedReason;
    if (requiresLiveRoundtable) {
      if (attempt) await completeEvolutionAttempt({
        projectRoot: entry.projectRoot,
        run,
        attemptId: attempt.id,
        status: 'failed',
        error: reason,
        nowMs,
      });
      return failRoundtableWithoutFallback(entry, serverLink, nowMs, spec, base, reason);
    }
    return completeRoundtableWithLocalFallback(
      entry,
      serverLink,
      nowMs,
      spec,
      base,
      reason,
      `${spec.topic}未找到可用 P2P helper，已改用本地多角色兜底复核：PASS: local deterministic ${spec.topic} fallback completed because ${reason}; no blocking issues were found in the available stage artifacts.`,
    );
  }

  const next: EvolutionRoundtableRef = result.ok
    ? {
        ...base,
        status: 'running',
        ...(result.p2pRunId ? { p2pRunId: result.p2pRunId } : {}),
        ...(result.discussionId ? { discussionId: result.discussionId } : {}),
        ...(result.contextPath ? { contextPath: result.contextPath } : {}),
      }
    : {
        ...base,
        status: result.skippedReason ? 'skipped' : 'failed',
        error: result.skippedReason ?? result.error ?? 'roundtable_launch_failed',
      };
  if (attempt && result.p2pRunId) attempt.p2pRunId = result.p2pRunId;
  if (attempt && !result.ok) {
    await completeEvolutionAttempt({
      projectRoot: entry.projectRoot,
      run,
      attemptId: attempt.id,
      status: 'failed',
      error: next.error ?? 'roundtable_launch_failed',
      nowMs,
    });
  }
  upsertRoundtable(run, next);
  appendDiscussion(run, {
    kind: result.ok ? 'role_update' : 'gate',
    stage: spec.stage,
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: result.ok
      ? `已启动 IM.codes P2P ${spec.topic}：p2pRun=${result.p2pRunId ?? 'unknown'}，discussion=${result.discussionId ?? 'unknown'}。`
      : `${spec.topic}未启动：${next.error}。`,
    createdAt: nowMs,
  });
  const projection = await persistAndProject(entry, nowMs);
  if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
  return projection;
}

async function maybeStartRoundtablesForStage(
  entry: RuntimeEntry,
  serverLink: EvolutionServerLink | null | undefined,
  nowMs: number,
  stage: EvolutionStage,
): Promise<EvolutionProjection[]> {
  const projections: EvolutionProjection[] = [];
  for (const spec of EVOLUTION_ROUNDTABLE_SPECS.filter((item) => item.stage === stage)) {
    const projection = await maybeStartRoundtable(entry, serverLink, nowMs, spec);
    if (projection) projections.push(projection);
  }
  return projections;
}

/**
 * Record a foundation capability observation on the run. Verified status is
 * only ever written here with a concrete proof string; a re-observation that
 * no longer finds the marker keeps the record honest by downgrading the
 * summary while the caller decides whether that is a hard block.
 */
function upsertFoundationEvidenceStatus(
  run: EvolutionRun,
  capability: FoundationProbeResult['capability'],
  status: 'planned' | 'verified',
  summary: string,
  nowMs: number,
): void {
  run.foundationEvidence ??= [];
  const existing = run.foundationEvidence.find((item) => item.capability === capability);
  if (existing) {
    existing.status = status;
    existing.summary = summary;
    return;
  }
  run.foundationEvidence.push({
    id: `foundation:${run.runId}:${capability}`,
    capability,
    status,
    ownerRoleId: capability === 'ci' || capability === 'deployment' || capability === 'observability'
      ? 'ops_release_manager'
      : 'tech_director',
    artifactRevisionIds: [],
    externalActionClass: 'sandbox_write',
    summary,
    createdAt: nowMs,
  });
}

async function maybeStartAutoDelivery(
  entry: RuntimeEntry,
  serverLink: EvolutionServerLink | null | undefined,
  nowMs: number,
): Promise<EvolutionProjection | null> {
  const run = entry.run;
  if (!run.autoDelivery?.enabled) return null;
  if (run.linkedAutoDeliverRunId) return null;
  if (run.stage !== 'tasks_ready') return null;
  const roundtableGate = planningRoundtableGateDecision(run);
  if (roundtableGate.disposition === 'defer') {
    return deferAutoDeliveryForPlanningGate(entry, roundtableGate.reason, nowMs, serverLink);
  }
  if (roundtableGate.disposition === 'block') {
    return markPlanningRoundtableGateBlocked(entry, roundtableGate.reason, nowMs, serverLink);
  }
  if (!run.linkedOpenSpecChange) {
    return markAutoDeliveryLaunchBlocked(entry, 'missing_linked_openspec_change', nowMs, serverLink);
  }
  if (run.developmentMode === 'greenfield_new_system') {
    const targetRelativeDir = run.writePolicy?.targetRelativeDir ?? run.developmentTargetRelativeDir;
    const expectedInventorySha256 = run.writePolicy?.targetInventorySha256;
    if (!targetRelativeDir || !expectedInventorySha256) {
      return markAutoDeliveryLaunchBlocked(entry, 'greenfield_write_policy_inventory_missing', nowMs, serverLink);
    }
    const repositoryEvidence = (run.foundationEvidence ?? []).find((item) => item.capability === 'repository');
    if (repositoryEvidence?.status === 'verified') {
      // A prior launch attempt already bootstrapped the isolated workspace, so
      // the target is intentionally non-empty. Re-verify the repository is
      // still intact instead of demanding emptiness; fail closed otherwise.
      const probes = await probeFoundationCapabilities({ projectRoot: entry.projectRoot, targetRelativeDir });
      if (probes.find((probe) => probe.capability === 'repository')?.status !== 'verified') {
        return markAutoDeliveryLaunchBlocked(entry, 'greenfield_foundation_repository_missing', nowMs, serverLink);
      }
    } else {
      const inspection = await inspectGreenfieldTarget(entry.projectRoot, targetRelativeDir);
      if (!inspection.ok) {
        return markAutoDeliveryLaunchBlocked(entry, `${inspection.code}: ${inspection.message}`, nowMs, serverLink);
      }
      if (inspection.inventorySha256 !== expectedInventorySha256) {
        return markAutoDeliveryLaunchBlocked(entry, 'greenfield_target_inventory_changed', nowMs, serverLink);
      }
      const bootstrap = await bootstrapGreenfieldFoundation({
        projectRoot: entry.projectRoot,
        targetRelativeDir,
        runId: run.runId,
        topology: run.greenfieldTopology,
        nowMs,
      });
      if (!bootstrap.ok || !bootstrap.headSha) {
        return markAutoDeliveryLaunchBlocked(entry, `greenfield_foundation_bootstrap_failed: ${bootstrap.reason ?? 'unknown'}`, nowMs, serverLink);
      }
      upsertFoundationEvidenceStatus(
        run,
        'repository',
        'verified',
        `Isolated git repository initialized at \`${targetRelativeDir}\`; observed HEAD ${bootstrap.headSha.slice(0, 12)} via git rev-parse.`,
        nowMs,
      );
      appendEvidence(run, {
        source: 'greenfield_foundation',
        summary: `Greenfield foundation bootstrap: isolated git repository with initial commit ${bootstrap.headSha.slice(0, 12)} in ${targetRelativeDir}.`,
        command: 'git init && git add -A && git commit && git rev-parse HEAD',
        exitCode: 0,
        createdAt: nowMs,
      });
      appendLiveEvent(run, {
        source: 'system',
        kind: 'command',
        severity: 'success',
        roleId: 'tech_director',
        stage: 'tasks_ready',
        title: 'Greenfield foundation bootstrapped',
        detail: `Isolated repository at ${targetRelativeDir}; HEAD ${bootstrap.headSha.slice(0, 12)}.`,
        command: 'git init && git commit',
        exitCode: 0,
        createdAt: nowMs,
      });
    }
  }
  if ((run.executionPolicy ?? 'draft_preview') === 'governed') {
    try {
      requireAuthorizedEvolutionRevision(run, `openspec/changes/${run.linkedOpenSpecChange}/tasks.md`);
      requireAuthorizedEvolutionRevision(run, 'implementation/agent-task-matrix.md');
    } catch (error) {
      return markAutoDeliveryLaunchBlocked(entry, describeUnknownError(error), nowMs, serverLink);
    }
  }
  if (!serverLink) {
    return deferAutoDeliveryForServerLink(entry, nowMs);
  }
  if (!autoDeliverLauncher) {
    return markAutoDeliveryLaunchBlocked(entry, 'openspec_auto_deliver_launcher_unavailable', nowMs, serverLink);
  }

  run.autoDelivery.launchedAt = nowMs;
  delete run.autoDelivery.lastError;
  run.latestMessage = `Auto-starting OpenSpec Auto Deliver for ${run.linkedOpenSpecChange}.`;
  appendDiscussion(run, {
    kind: 'role_update',
    stage: 'tasks_ready',
    roleId: 'loop_supervisor',
    author: 'Loop Supervisor / 总控',
    text: `已按策略自动启动 OpenSpec Auto Deliver：${run.linkedOpenSpecChange}，preset=${run.autoDelivery.presetId}，autoCommitPush=${run.autoDelivery.autoCommitPush ? 'on' : 'off'}。`,
    createdAt: nowMs,
  });
  appendEvidence(run, {
    source: 'evolution_loop',
    summary: run.latestMessage,
    createdAt: nowMs,
  });
  const before = await persistAndProject(entry, nowMs);
  send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection: before });

  const result = await autoDeliverLauncher({
    requestId: `evolution-auto-${run.runId}`,
    sessionName: run.sessionName,
    ...(run.projectName ? { projectName: run.projectName } : {}),
    changeName: run.linkedOpenSpecChange,
    presetId: run.autoDelivery.presetId,
    autoCommitPush: run.autoDelivery.autoCommitPush,
  }, serverLink);

  if (!result.ok) {
    return markAutoDeliveryLaunchBlocked(entry, result.error ?? 'openspec_auto_deliver_launch_failed', nowMs, serverLink);
  }
  if (result.projection) {
    const updates = await recordEvolutionOpenSpecProjection({ projection: result.projection, serverLink, nowMs });
    return updates.find((projection) => projection.runId === run.runId) ?? null;
  }
  return buildEvolutionProjection(run, nowMs);
}

export async function resumePendingEvolutionAutoDeliveries(
  serverLink: EvolutionServerLink,
  nowMs: number = Date.now(),
): Promise<EvolutionProjection[]> {
  const projections: EvolutionProjection[] = [];
  for (const entry of runsById.values()) {
    const run = entry.run;
    if (!run.autoDelivery?.enabled) continue;
    if (run.stage !== 'tasks_ready') continue;
    if (run.linkedAutoDeliverRunId) continue;
    if (run.autoDelivery.lastError !== 'missing_server_link') continue;
    const projection = await maybeStartAutoDelivery(entry, serverLink, nowMs);
    if (projection) projections.push(projection);
  }
  return projections;
}

export async function runEvolutionAutopilot(
  runId: string,
  serverLink?: EvolutionServerLink | null,
  options: { nowMs?: number } = {},
): Promise<EvolutionOrchestratorResult<EvolutionProjection>> {
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) return validRunId as EvolutionOrchestratorResult<EvolutionProjection>;
  const existing = activeAutopilotRuns.get(validRunId.value);
  if (existing) return existing;

  const task = (async (): Promise<EvolutionOrchestratorResult<EvolutionProjection>> => {
    const entry = getRuntimeEntry(validRunId.value);
    if (!entry) return fail('evolution_run_not_found', `Evolution run not found: ${validRunId.value}`, 'runId');
    try {
      // A resumed/hydrated run can already be sitting on a governed stage.
      // Re-evaluate that stage's gate before the stage runner writes any
      // downstream artifact; transition callbacks alone do not cover resumes.
      const entryStage = entry.run.stage;
      await maybeStartRoundtablesForStage(entry, serverLink, options.nowMs ?? Date.now(), entryStage);
      const entryBlocked = strictRoundtableGateBlockForStage(entry.run, entryStage);
      if (entryBlocked) {
        const projection = await markStrictRoundtableGateBlocked(
          entry,
          entryBlocked.roundtable,
          entryBlocked.reason,
          options.nowMs ?? Date.now(),
          serverLink,
        );
        return ok(projection);
      }
      if (shouldPauseForStrictRoundtableGate(entry.run)) {
        const nowMs = options.nowMs ?? Date.now();
        const gate = strictRoundtableGateDecisionForStage(entry.run, entryStage);
        const pauseMessage = `Evolution planning paused at ${entryStage}: ${gate.reason}.`;
        if (entry.run.latestMessage !== pauseMessage) {
          entry.run.latestMessage = pauseMessage;
          appendEvidence(entry.run, {
            source: 'p2p_roundtable_gate',
            summary: pauseMessage,
            createdAt: nowMs,
          });
        }
        const projection = await persistAndProject(entry, nowMs);
        if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
        return ok(projection);
      }
      await runEvolutionPlanningStages({
        projectRoot: entry.projectRoot,
        run: entry.run,
        ...(typeof options.nowMs === 'number' ? { nowMs: options.nowMs } : {}),
        onStage: async (run) => {
          const nowMs = options.nowMs ?? Date.now();
          const stage = run.stage;
          const projection = buildEvolutionProjection(run, nowMs);
          if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
          await maybeStartRoundtablesForStage(entry, serverLink, nowMs, stage);
          const blocked = strictRoundtableGateBlockForStage(entry.run, stage);
          if (blocked) {
            await markStrictRoundtableGateBlocked(entry, blocked.roundtable, blocked.reason, nowMs, serverLink);
            throw new EvolutionPlanningPausedError(stage);
          }
        },
        shouldPauseAfterStage: shouldPauseForStrictRoundtableGate,
      });
      await maybeStartRoundtablesForStage(entry, serverLink, options.nowMs ?? Date.now(), entry.run.stage);
      const autoDeliveryProjection = await maybeStartAutoDelivery(entry, serverLink, options.nowMs ?? Date.now());
      if (autoDeliveryProjection) return ok(autoDeliveryProjection);
      const projection = await persistAndProject(entry, options.nowMs ?? Date.now());
      if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
      return ok(projection);
    } catch (error) {
      const nowMs = options.nowMs ?? Date.now();
      if (error instanceof EvolutionPlanningPausedError) {
        const gate = strictRoundtableGateDecisionForStage(entry.run, error.pausedAtStage);
        if (gate.disposition === 'defer') {
          const pauseMessage = `Evolution planning paused at ${error.pausedAtStage}: ${gate.reason}.`;
          if (entry.run.latestMessage !== pauseMessage) {
            entry.run.latestMessage = pauseMessage;
            appendEvidence(entry.run, {
              source: 'p2p_roundtable_gate',
              summary: pauseMessage,
              createdAt: nowMs,
            });
          }
        }
        const projection = await persistAndProject(entry, nowMs);
        if (serverLink) send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
        return ok(projection);
      }
      if (isEvolutionTerminalStage(entry.run.stage)) {
        // Run already reached a terminal stage (e.g. 'stopped' via a concurrent
        // stopEvolutionRun call) while this task was still in flight — don't
        // clobber that terminal state with 'failed'.
        const projection = await persistAndProject(entry, nowMs);
        if (serverLink) {
          send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
          send(serverLink, { type: EVOLUTION_PIPELINE_MSG.TERMINAL, projection: { ...projection, terminal: true } });
        }
        return ok(projection);
      }
      entry.run.stage = 'failed';
      applyRoleStatesForStage(entry.run, 'failed', nowMs);
      entry.run.verdict = 'BLOCKED';
      entry.run.latestMessage = describeUnknownError(error);
      entry.run.terminalReason = 'evolution_autopilot_failed';
      appendEvidence(entry.run, {
        source: 'evolution_loop',
        summary: `Autopilot failed: ${entry.run.latestMessage}`,
        createdAt: nowMs,
      });
      const projection = await persistAndProject(entry, nowMs);
      if (serverLink) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection });
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.TERMINAL, projection: { ...projection, terminal: true } });
      }
      return ok(projection);
    } finally {
      activeAutopilotRuns.delete(validRunId.value);
    }
  })();
  activeAutopilotRuns.set(validRunId.value, task);
  return task;
}

function send(serverLink: EvolutionServerLink, message: Record<string, unknown>): void {
  try { serverLink.send(message); } catch { /* connection may be closing */ }
}

function sendResult(serverLink: EvolutionServerLink, type: string, result: EvolutionOrchestratorResult<EvolutionProjection>, extra: Record<string, unknown> = {}): void {
  if (result.ok) {
    send(serverLink, { type, projection: result.value, ...extra });
  } else {
    send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: result.issues, ...extra });
  }
}

export async function handleEvolutionPipelineCommand(cmd: Record<string, unknown>, serverLink: EvolutionServerLink): Promise<void> {
  switch (cmd.type) {
    case EVOLUTION_PIPELINE_MSG.LAUNCH: {
      const request = cmd.request && typeof cmd.request === 'object'
        ? cmd.request as EvolutionLaunchRequest
        : cmd as unknown as EvolutionLaunchRequest;
      const projectRoot = resolveProjectRootFromCommand({ ...cmd, sessionName: request.sessionName ?? cmd.sessionName });
      if (!projectRoot) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_project_root', 'A session with projectDir or explicit projectRoot is required.')] });
        return;
      }
      const result = await launchEvolutionRun({ projectRoot, request });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.LAUNCH_ACK, result, { requestId: request.requestId });
      if (result.ok) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection: result.value });
        if (request.autoStart === true) {
          void runEvolutionAutopilot(result.value.runId, serverLink);
        }
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO: {
      const requestId = typeof cmd.requestId === 'string' && cmd.requestId.length > 0
        ? cmd.requestId
        : `evolution-demo-${Date.now()}`;
      const sessionName = typeof cmd.sessionName === 'string' ? cmd.sessionName : '';
      const projectRoot = resolveProjectRootFromCommand({ ...cmd, sessionName });
      if (!projectRoot) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_project_root', 'A session with projectDir or explicit projectRoot is required.')], requestId });
        return;
      }
      const autoDeliverPresetId = typeof cmd.autoDeliverPresetId === 'string' && (EVOLUTION_AUTO_DELIVER_PRESET_IDS as readonly string[]).includes(cmd.autoDeliverPresetId)
        ? cmd.autoDeliverPresetId as EvolutionAutoDeliverPresetId
        : undefined;
      const roundtableGateMode = typeof cmd.roundtableGateMode === 'string' && (EVOLUTION_ROUNDTABLE_GATE_MODES as readonly string[]).includes(cmd.roundtableGateMode)
        ? cmd.roundtableGateMode as EvolutionRoundtableGateMode
        : undefined;
      const designTargetSurface = typeof cmd.designTargetSurface === 'string' && (EVOLUTION_DESIGN_TARGET_SURFACES as readonly string[]).includes(cmd.designTargetSurface)
        ? cmd.designTargetSurface as EvolutionDesignTargetSurface
        : undefined;
      const developmentMode = typeof cmd.developmentMode === 'string' && (EVOLUTION_DEVELOPMENT_MODES as readonly string[]).includes(cmd.developmentMode)
        ? cmd.developmentMode as EvolutionDevelopmentMode
        : undefined;
      const greenfieldTopology = typeof cmd.greenfieldTopology === 'string' && (EVOLUTION_GREENFIELD_TOPOLOGIES as readonly string[]).includes(cmd.greenfieldTopology)
        ? cmd.greenfieldTopology as EvolutionGreenfieldTopology
        : undefined;
      const executionPolicy = typeof cmd.executionPolicy === 'string' && (EVOLUTION_EXECUTION_POLICIES as readonly string[]).includes(cmd.executionPolicy)
        ? cmd.executionPolicy as EvolutionExecutionPolicy
        : undefined;
      const result = await launchEvolutionDemoRun({
        projectRoot,
        requestId,
        ...(typeof cmd.serverId === 'string' ? { serverId: cmd.serverId } : {}),
        sessionName,
        ...(typeof cmd.projectName === 'string' ? { projectName: cmd.projectName } : {}),
        ...(typeof cmd.locale === 'string' ? { locale: cmd.locale } : {}),
        autoStart: cmd.autoStart !== false,
        autoStartImplementation: cmd.autoStartImplementation !== false,
        ...(autoDeliverPresetId ? { autoDeliverPresetId } : {}),
        autoCommitPush: cmd.autoCommitPush === true,
        ...(roundtableGateMode ? { roundtableGateMode } : {}),
        ...(designTargetSurface ? { designTargetSurface } : {}),
        ...(developmentMode ? { developmentMode } : {}),
        ...(executionPolicy ? { executionPolicy } : {}),
        ...(typeof cmd.developmentTargetRelativeDir === 'string' ? { developmentTargetRelativeDir: cmd.developmentTargetRelativeDir } : {}),
        ...(greenfieldTopology ? { greenfieldTopology } : {}),
        requireHifiHumanApproval: cmd.requireHifiHumanApproval === true,
      });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO_ACK, result, { requestId });
      if (result.ok) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection: result.value });
        if (cmd.autoStart !== false) {
          void runEvolutionAutopilot(result.value.runId, serverLink);
        }
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.STATUS_REQUEST: {
      const { listEvolutionInboxWatchers } = await import('./evolution-inbox-watch-manager.js');
      const watchers = listEvolutionInboxWatchers();
      const nowMs = Date.now();
      const projectRoot = resolveProjectRootFromCommand(cmd);
      const sessionName = typeof cmd.sessionName === 'string' ? cmd.sessionName : undefined;
      if (projectRoot) await hydrateRuntimeRunsForProject(projectRoot, sessionName);
      if (typeof cmd.runId === 'string') {
        const validRunId = validateEvolutionRunId(cmd.runId);
        const entry = validRunId.ok ? getRuntimeEntry(validRunId.value) : null;
        if (entry) await reconcileRuntimeRoundtableContextFiles(entry, nowMs, serverLink);
        const result = getEvolutionRun(cmd.runId, nowMs);
        sendResult(serverLink, EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION, result, { requestId: cmd.requestId, watchers });
      } else {
        const entries = [...runsById.values()].filter((entry) => {
          if (projectRoot && safeProjectRoot(entry.projectRoot) !== projectRoot) return false;
          if (sessionName && entry.run.sessionName !== sessionName) return false;
          return true;
        });
        for (const entry of entries) await reconcileRuntimeRoundtableContextFiles(entry, nowMs, serverLink);
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION, projections: listEvolutionRuns(nowMs), watchers, requestId: cmd.requestId });
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.SCAN_INBOX: {
      const { scanEvolutionInboxWatchers } = await import('./evolution-inbox-watch-manager.js');
      const result = await scanEvolutionInboxWatchers({
        ...(typeof cmd.sessionName === 'string' ? { sessionName: cmd.sessionName } : {}),
        ...(typeof cmd.projectRoot === 'string' ? { projectRoot: cmd.projectRoot } : {}),
        serverLink,
      });
      send(serverLink, {
        type: EVOLUTION_PIPELINE_MSG.SCAN_INBOX_ACK,
        requestId: cmd.requestId,
        scanned: result.scanned,
        candidates: result.candidates,
        watchers: result.watchers,
      });
      return;
    }
    case EVOLUTION_PIPELINE_MSG.SET_INBOX_DIRECTORY: {
      const requestId = typeof cmd.requestId === 'string' ? cmd.requestId : undefined;
      const sessionName = typeof cmd.sessionName === 'string' ? cmd.sessionName : '';
      const projectRoot = resolveProjectRootFromCommand(cmd);
      const directoryPath = typeof cmd.directoryPath === 'string' ? cmd.directoryPath : '';
      if (!sessionName || !projectRoot || !directoryPath) {
        send(serverLink, {
          type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR,
          requestId,
          issues: [issue('invalid_inbox_directory_request', 'sessionName, projectRoot, and directoryPath are required.')],
        });
        return;
      }
      try {
        const { configureEvolutionInboxWatcherDirectory } = await import('./evolution-inbox-watch-manager.js');
        const result = await configureEvolutionInboxWatcherDirectory({
          sessionName,
          projectRoot,
          directoryPath,
          ...(typeof cmd.projectName === 'string' ? { projectName: cmd.projectName } : {}),
          serverLink,
        });
        send(serverLink, {
          type: EVOLUTION_PIPELINE_MSG.SET_INBOX_DIRECTORY_ACK,
          requestId,
          directoryPath,
          watchers: result.watchers,
        });
      } catch (error) {
        send(serverLink, {
          type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR,
          requestId,
          issues: [issue('evolution_inbox_directory_failed', describeUnknownError(error), 'directoryPath')],
        });
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES: {
      const requestId = typeof cmd.requestId === 'string' && cmd.requestId.length > 0
        ? cmd.requestId
        : `evolution-import-references-${Date.now()}`;
      const sessionName = typeof cmd.sessionName === 'string' ? cmd.sessionName : '';
      const projectRoot = resolveProjectRootFromCommand({ ...cmd, sessionName });
      if (!projectRoot) {
        send(serverLink, {
          type: EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES_ACK,
          requestId,
          ok: false,
          issues: [issue('missing_project_root', 'A session with projectDir or explicit projectRoot is required.')],
          error: 'A session with projectDir or explicit projectRoot is required.',
        });
        return;
      }
      const rawAttachments = Array.isArray(cmd.attachments) ? cmd.attachments : [];
      const attachments = rawAttachments
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          attachmentId: typeof item.attachmentId === 'string' ? item.attachmentId : '',
          ...(typeof item.originalName === 'string' ? { originalName: item.originalName } : {}),
          ...(typeof item.mime === 'string' ? { mime: item.mime } : {}),
          ...(typeof item.size === 'number' ? { size: item.size } : {}),
        }));
      const result = await importEvolutionReferenceBrief({
        projectRoot,
        requestId,
        ...(typeof cmd.serverId === 'string' ? { serverId: cmd.serverId } : {}),
        sessionName,
        ...(typeof cmd.projectName === 'string' ? { projectName: cmd.projectName } : {}),
        ...(typeof cmd.taskName === 'string' ? { taskName: cmd.taskName } : {}),
        ...(typeof cmd.note === 'string' ? { note: cmd.note } : {}),
        attachments,
      });
      if (result.ok) {
        send(serverLink, {
          type: EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES_ACK,
          requestId,
          ok: true,
          result: result.value,
        });
      } else {
        send(serverLink, {
          type: EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES_ACK,
          requestId,
          ok: false,
          issues: result.issues,
          error: result.issues[0]?.message ?? 'Reference import failed.',
        });
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.CHECK_STAGING: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      const result = await checkEvolutionStagingConfig({ runId: cmd.runId });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.CHECK_STAGING_ACK, result, { requestId: cmd.requestId });
      return;
    }
    case EVOLUTION_PIPELINE_MSG.STOP: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      const reason = typeof cmd.reason === 'string' ? cmd.reason : undefined;
      const result = isWarRoomPauseReason(reason)
        ? await pauseEvolutionRun({ runId: cmd.runId, reason })
        : await stopEvolutionRun({ runId: cmd.runId, reason });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.STOP_ACK, result, { requestId: cmd.requestId });
      return;
    }
    case EVOLUTION_PIPELINE_MSG.CONTINUE: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      const targetStage = isEvolutionStage(cmd.targetStage) ? cmd.targetStage : undefined;
      const result = await continueEvolutionRun({
        runId: cmd.runId,
        ...(targetStage ? { targetStage } : {}),
        ...(typeof cmd.message === 'string' ? { message: cmd.message } : {}),
      });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.CONTINUE_ACK, result, { requestId: cmd.requestId });
      if (result.ok && !isEvolutionTerminalStage(result.value.stage)) {
        void runEvolutionAutopilot(result.value.runId, serverLink);
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.GATE_ACTION: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      if (typeof cmd.action !== 'string' || !(EVOLUTION_GATE_ACTIONS as readonly string[]).includes(cmd.action)) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('invalid_gate_action', 'action must be approve, request_changes, or waive.', 'action')], requestId: cmd.requestId });
        return;
      }
      const result = await applyEvolutionGateAction({
        runId: cmd.runId,
        gateId: typeof cmd.gateId === 'string' ? cmd.gateId : '',
        action: cmd.action as EvolutionGateAction,
        mutationId: typeof cmd.mutationId === 'string' ? cmd.mutationId : '',
        expectedRunRevision: typeof cmd.expectedRunRevision === 'number' ? cmd.expectedRunRevision : -1,
        ...(typeof cmd.feedback === 'string' ? { feedback: cmd.feedback } : {}),
      });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.GATE_ACTION_ACK, result, { requestId: cmd.requestId });
      if (result.ok && !isEvolutionTerminalStage(result.value.stage)) {
        void runEvolutionAutopilot(result.value.runId, serverLink);
      }
      return;
    }
    case EVOLUTION_PIPELINE_MSG.ROLE_CATALOG_REQUEST: {
      send(serverLink, {
        type: EVOLUTION_PIPELINE_MSG.ROLE_CATALOG,
        requestId: cmd.requestId,
        roles: EVOLUTION_ROLE_SKILL_DEFINITIONS.map((definition) => ({
          id: `role-profile:${definition.roleId}:1`,
          roleId: definition.roleId,
          label: definition.label,
          summary: definition.skillSummary,
          responsibilities: [...definition.responsibilities],
          skillName: definition.skillName,
          roleSource: 'project',
          version: 1,
        })),
      });
      return;
    }
    case EVOLUTION_PIPELINE_MSG.USER_MESSAGE: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      const roleId = typeof cmd.roleId === 'string' && (EVOLUTION_ROLE_IDS as readonly string[]).includes(cmd.roleId)
        ? cmd.roleId as EvolutionRoleId
        : undefined;
      const result = await recordEvolutionUserMessage({
        runId: cmd.runId,
        ...(roleId ? { roleId } : {}),
        text: typeof cmd.text === 'string' ? cmd.text : '',
      });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.PROJECTION, result, { requestId: cmd.requestId });
      return;
    }
    case EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      if (typeof cmd.roleId !== 'string' || !(EVOLUTION_ROLE_IDS as readonly string[]).includes(cmd.roleId)) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('invalid_role_id', 'roleId is required.', 'roleId')], requestId: cmd.requestId });
        return;
      }
      const result = await updateEvolutionRoleSkill({
        runId: cmd.runId,
        roleId: cmd.roleId as EvolutionRoleId,
        markdown: typeof cmd.markdown === 'string' ? cmd.markdown : '',
      });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL_ACK, result, { requestId: cmd.requestId });
      return;
    }
    case EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE: {
      if (typeof cmd.runId !== 'string') {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('missing_run_id', 'runId is required.', 'runId')], requestId: cmd.requestId });
        return;
      }
      if (typeof cmd.roleId !== 'string' || !(EVOLUTION_ROLE_IDS as readonly string[]).includes(cmd.roleId)) {
        send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('invalid_role_id', 'roleId is required.', 'roleId')], requestId: cmd.requestId });
        return;
      }
      const result = await approveEvolutionRoleSkillCandidate({
        runId: cmd.runId,
        roleId: cmd.roleId as EvolutionRoleId,
        candidateArtifactId: typeof cmd.candidateArtifactId === 'string' ? cmd.candidateArtifactId : '',
        ...(typeof cmd.approvalMessage === 'string' ? { approvalMessage: cmd.approvalMessage } : {}),
        ...(typeof cmd.approverId === 'string' ? { approverId: cmd.approverId } : {}),
      });
      sendResult(serverLink, EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE_ACK, result, { requestId: cmd.requestId });
      return;
    }
    default:
      send(serverLink, { type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR, issues: [issue('unknown_evolution_command', `Unknown Evolution command: ${String(cmd.type)}`)] });
  }
}

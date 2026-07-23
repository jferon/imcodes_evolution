import {
  EVOLUTION_ARTIFACT_PATH_MAX_BYTES,
  EVOLUTION_ARTIFACT_KINDS,
  EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS,
  EVOLUTION_ARTIFACT_PREVIEW_TYPES,
  EVOLUTION_BLOCKING_QUESTIONS_MAX,
  EVOLUTION_DISCUSSION_ITEMS_MAX,
  EVOLUTION_DISCUSSION_MESSAGE_KINDS,
  EVOLUTION_EVIDENCE_ITEMS_MAX,
  EVOLUTION_ARTIFACTS_MAX,
  EVOLUTION_AUTO_DELIVER_PRESET_IDS,
  EVOLUTION_DESIGN_TARGET_SURFACES,
  EVOLUTION_REQUIREMENT_FILE_EXTENSIONS,
  EVOLUTION_REQUIREMENT_IMAGE_EXTENSIONS,
  EVOLUTION_REQUIREMENT_FILE_MAX_BYTES,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  EVOLUTION_REQUEST_ID_MAX_BYTES,
  EVOLUTION_ROLE_IDS,
  EVOLUTION_ROLE_STATUSES,
  EVOLUTION_ROUNDTABLE_GATE_MODES,
  EVOLUTION_ROUNDTABLE_STATUSES,
  EVOLUTION_RUN_ID_MAX_BYTES,
  EVOLUTION_SCORE_MAX,
  EVOLUTION_SCORE_MODULE_IDS,
  EVOLUTION_SOURCE_PATH_MAX_BYTES,
  EVOLUTION_STAGING_DELIVERY_STATUSES,
  EVOLUTION_STAGES,
  EVOLUTION_VERDICTS,
  canTransitionEvolutionStage,
  isEvolutionStage,
  type EvolutionArtifactKind,
  type EvolutionArtifactPreviewType,
  type EvolutionAutoDeliverPresetId,
  type EvolutionDesignTargetSurface,
  type EvolutionRoleId,
  type EvolutionRoleStatus,
  type EvolutionRoundtableGateMode,
  type EvolutionScoreModuleId,
  type EvolutionStage,
  type EvolutionStagingDeliveryStatus,
  type EvolutionVerdict,
} from './evolution-pipeline-constants.js';
import type {
  EvolutionArtifactRef,
  EvolutionArtifactPreview,
  EvolutionAutoDeliveryPolicy,
  EvolutionBlockingQuestion,
  EvolutionDiscussionMessage,
  EvolutionEvidence,
  EvolutionExecutionTimelineItem,
  EvolutionLaunchRequest,
  EvolutionLiveEvent,
  EvolutionLiveEventKind,
  EvolutionLiveEventSeverity,
  EvolutionLiveEventSource,
  EvolutionLoopControl,
  EvolutionLoopControlMode,
  EvolutionLoopControlSignal,
  EvolutionLoopControlSignalStatus,
  EvolutionLoopControlUsage,
  EvolutionProjection,
  EvolutionRequestedBy,
  EvolutionRoleState,
  EvolutionRoundtableRef,
  EvolutionScore,
  EvolutionStagingDeliveryState,
  EvolutionValidationIssue,
  EvolutionValidationResult,
} from './evolution-pipeline-types.js';

const VISIBLE_ASCII_RE = /^[\x21-\x7e]+$/;
const SAFE_SEGMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SHA256_RE = /^[a-fA-F0-9]{64}$/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/;
const REQUESTED_BY_VALUES = ['user', 'watcher', 'api', 'cron', 'demo'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function issue(code: string, message: string, path?: string): EvolutionValidationIssue {
  return { code, message, path, severity: 'error' };
}

function isOneOf<T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function fileNameFromRelativePath(value: string): string {
  const segments = value.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] ?? value : value;
}

function extensionOf(value: string): string {
  const fileName = fileNameFromRelativePath(value).toLowerCase();
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot) : '';
}

export function validateEvolutionRequestId(value: unknown): EvolutionValidationResult<string> {
  if (
    typeof value !== 'string'
    || value.length === 0
    || byteLength(value) > EVOLUTION_REQUEST_ID_MAX_BYTES
    || !VISIBLE_ASCII_RE.test(value)
  ) {
    return { ok: false, issues: [issue('invalid_request_id', 'Request id must be visible ASCII and within the byte limit.')] };
  }
  return { ok: true, value, issues: [] };
}

export function validateEvolutionRunId(value: unknown): EvolutionValidationResult<string> {
  if (
    typeof value !== 'string'
    || value.length === 0
    || byteLength(value) > EVOLUTION_RUN_ID_MAX_BYTES
    || !SAFE_SEGMENT_ID_RE.test(value)
    || value.includes('..')
  ) {
    return { ok: false, issues: [issue('invalid_run_id', 'Run id must be a safe path segment within the byte limit.')] };
  }
  return { ok: true, value, issues: [] };
}

export function isEvolutionSafeRelativePath(value: string): boolean {
  if (value === '' || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\')) return false;
  if (WINDOWS_DRIVE_RE.test(value) || WINDOWS_UNC_RE.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function validateEvolutionRequirementSourcePath(
  value: unknown,
  options: { allowImages?: boolean } = {},
): EvolutionValidationResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, issues: [issue('invalid_source_path', 'Requirement source path must be a string.')] };
  }
  const issues: EvolutionValidationIssue[] = [];
  const sourcePath = value.trim();
  if (sourcePath !== value) issues.push(issue('source_path_whitespace', 'Requirement source path must not have surrounding whitespace.'));
  if (byteLength(sourcePath) > EVOLUTION_SOURCE_PATH_MAX_BYTES) issues.push(issue('source_path_too_large', 'Requirement source path exceeds the byte limit.'));
  if (!isEvolutionSafeRelativePath(sourcePath)) issues.push(issue('unsafe_source_path', 'Requirement source path must be project-relative without traversal, home expansion, or absolute prefixes.'));
  const inboxPrefix = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/`;
  if (!sourcePath.startsWith(inboxPrefix)) {
    issues.push(issue('source_path_outside_inbox', `Requirement source path must live under ${EVOLUTION_REQUIREMENT_INBOX_DIR}/.`));
  }
  const ext = extensionOf(sourcePath);
  // `allowImages` widens acceptance for the passive inbox *watcher* only — a
  // run's actual source document (the launch path) stays text-only; an
  // images-only drop gets a synthesized text brief as its source instead.
  const allowedExtension = isOneOf(ext, EVOLUTION_REQUIREMENT_FILE_EXTENSIONS)
    || (options.allowImages === true && isOneOf(ext, EVOLUTION_REQUIREMENT_IMAGE_EXTENSIONS));
  if (!allowedExtension) {
    issues.push(issue('unsupported_requirement_extension', `Requirement source file must use one of: ${EVOLUTION_REQUIREMENT_FILE_EXTENSIONS.join(', ')}.`));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: sourcePath, issues: [] };
}

export function isEvolutionRequirementImagePath(value: string): boolean {
  return isOneOf(extensionOf(value), EVOLUTION_REQUIREMENT_IMAGE_EXTENSIONS);
}

export function validateEvolutionArtifactRelativePath(value: unknown, path = 'artifact.path'): EvolutionValidationResult<string> {
  if (typeof value !== 'string') {
    return { ok: false, issues: [issue('invalid_artifact_path', 'Artifact path must be a string.', path)] };
  }
  if (byteLength(value) > EVOLUTION_ARTIFACT_PATH_MAX_BYTES || !isEvolutionSafeRelativePath(value)) {
    return { ok: false, issues: [issue('unsafe_artifact_path', 'Artifact path must be relative, bounded, and traversal-free.', path)] };
  }
  return { ok: true, value, issues: [] };
}

export function validateEvolutionStageTransition(from: EvolutionStage, to: EvolutionStage): EvolutionValidationResult<{ from: EvolutionStage; to: EvolutionStage }> {
  if (!canTransitionEvolutionStage(from, to)) {
    return { ok: false, issues: [issue('invalid_stage_transition', `Cannot transition Evolution stage from ${from} to ${to}.`)] };
  }
  return { ok: true, value: { from, to }, issues: [] };
}

export function validateEvolutionLaunchRequest(input: unknown): EvolutionValidationResult<EvolutionLaunchRequest> {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('invalid_launch_request', 'Evolution launch request must be an object.')] };
  }

  const issues: EvolutionValidationIssue[] = [];
  const requestId = validateEvolutionRequestId(input.requestId);
  if (!requestId.ok) issues.push(...requestId.issues.map((entry) => ({ ...entry, path: 'requestId' })));
  if (input.serverId !== undefined && (typeof input.serverId !== 'string' || input.serverId.length === 0)) {
    issues.push(issue('invalid_server_id', 'serverId must be a non-empty string when provided.', 'serverId'));
  }
  if (typeof input.sessionName !== 'string' || input.sessionName.length === 0) {
    issues.push(issue('invalid_session_name', 'sessionName is required.', 'sessionName'));
  }
  if (input.projectName !== undefined && typeof input.projectName !== 'string') {
    issues.push(issue('invalid_project_name', 'projectName must be a string when provided.', 'projectName'));
  }
  const sourcePath = validateEvolutionRequirementSourcePath(input.sourceRelativePath);
  if (!sourcePath.ok) issues.push(...sourcePath.issues.map((entry) => ({ ...entry, path: entry.path ?? 'sourceRelativePath' })));
  if (input.sourceSizeBytes !== undefined && (
    typeof input.sourceSizeBytes !== 'number'
    || !Number.isInteger(input.sourceSizeBytes)
    || input.sourceSizeBytes < 0
    || input.sourceSizeBytes > EVOLUTION_REQUIREMENT_FILE_MAX_BYTES
  )) {
    issues.push(issue('invalid_source_size', 'sourceSizeBytes must be an integer within the requirement file size limit.', 'sourceSizeBytes'));
  }
  if (input.sourceSha256 !== undefined && (typeof input.sourceSha256 !== 'string' || !SHA256_RE.test(input.sourceSha256))) {
    issues.push(issue('invalid_source_sha256', 'sourceSha256 must be a 64-character hex SHA-256 digest.', 'sourceSha256'));
  }
  if (input.locale !== undefined && (typeof input.locale !== 'string' || input.locale.trim().length === 0)) {
    issues.push(issue('invalid_locale', 'locale must be a non-empty string when provided.', 'locale'));
  }
  if (input.requestedBy !== undefined && !isOneOf(input.requestedBy, REQUESTED_BY_VALUES)) {
    issues.push(issue('invalid_requested_by', 'requestedBy must be user, watcher, api, cron, or demo.', 'requestedBy'));
  }
  if (input.autoStart !== undefined && typeof input.autoStart !== 'boolean') {
    issues.push(issue('invalid_auto_start', 'autoStart must be a boolean when provided.', 'autoStart'));
  }
  if (input.autoStartImplementation !== undefined && typeof input.autoStartImplementation !== 'boolean') {
    issues.push(issue('invalid_auto_start_implementation', 'autoStartImplementation must be a boolean when provided.', 'autoStartImplementation'));
  }
  if (input.autoDeliverPresetId !== undefined && !isOneOf(input.autoDeliverPresetId, EVOLUTION_AUTO_DELIVER_PRESET_IDS)) {
    issues.push(issue('invalid_auto_deliver_preset_id', 'autoDeliverPresetId is invalid.', 'autoDeliverPresetId'));
  }
  if (input.autoCommitPush !== undefined && typeof input.autoCommitPush !== 'boolean') {
    issues.push(issue('invalid_auto_commit_push', 'autoCommitPush must be a boolean when provided.', 'autoCommitPush'));
  }
  if (input.roundtableGateMode !== undefined && !isOneOf(input.roundtableGateMode, EVOLUTION_ROUNDTABLE_GATE_MODES)) {
    issues.push(issue('invalid_roundtable_gate_mode', 'roundtableGateMode must be planning or strict.', 'roundtableGateMode'));
  }
  if (input.designTargetSurface !== undefined && !isOneOf(input.designTargetSurface, EVOLUTION_DESIGN_TARGET_SURFACES)) {
    issues.push(issue('invalid_design_target_surface', 'designTargetSurface must be auto, mobile, pc, or both.', 'designTargetSurface'));
  }
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      requestId: requestId.ok ? requestId.value : '',
      ...(typeof input.serverId === 'string' ? { serverId: input.serverId } : {}),
      sessionName: input.sessionName as string,
      ...(typeof input.projectName === 'string' ? { projectName: input.projectName } : {}),
      sourceRelativePath: sourcePath.ok ? sourcePath.value : '',
      ...(typeof input.sourceSizeBytes === 'number' ? { sourceSizeBytes: input.sourceSizeBytes } : {}),
      ...(typeof input.sourceSha256 === 'string' ? { sourceSha256: input.sourceSha256.toLowerCase() } : {}),
      ...(typeof input.locale === 'string' ? { locale: input.locale.trim() } : {}),
      requestedBy: (isOneOf(input.requestedBy, REQUESTED_BY_VALUES) ? input.requestedBy : 'user') as EvolutionRequestedBy,
      autoStart: input.autoStart === true,
      autoStartImplementation: input.autoStartImplementation === true,
      autoDeliverPresetId: isOneOf(input.autoDeliverPresetId, EVOLUTION_AUTO_DELIVER_PRESET_IDS)
        ? input.autoDeliverPresetId
        : 'standard',
      autoCommitPush: input.autoCommitPush === true,
      roundtableGateMode: isOneOf(input.roundtableGateMode, EVOLUTION_ROUNDTABLE_GATE_MODES)
        ? input.roundtableGateMode
        : 'planning',
      designTargetSurface: isOneOf(input.designTargetSurface, EVOLUTION_DESIGN_TARGET_SURFACES)
        ? input.designTargetSurface
        : 'auto',
    },
    issues: [],
  };
}

function validateAutoDeliveryPolicy(input: unknown, path: string): EvolutionValidationIssue[] {
  if (input === undefined) return [];
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_auto_delivery_policy', 'autoDelivery must be an object.', path)];
  if (typeof input.enabled !== 'boolean') issues.push(issue('invalid_auto_delivery_enabled', 'autoDelivery.enabled must be a boolean.', `${path}.enabled`));
  if (!isOneOf(input.presetId, EVOLUTION_AUTO_DELIVER_PRESET_IDS)) issues.push(issue('invalid_auto_delivery_preset', 'autoDelivery.presetId is invalid.', `${path}.presetId`));
  if (typeof input.autoCommitPush !== 'boolean') issues.push(issue('invalid_auto_delivery_auto_commit_push', 'autoDelivery.autoCommitPush must be a boolean.', `${path}.autoCommitPush`));
  if (input.requestedBy !== undefined && !isOneOf(input.requestedBy, REQUESTED_BY_VALUES)) issues.push(issue('invalid_auto_delivery_requested_by', 'autoDelivery.requestedBy is invalid.', `${path}.requestedBy`));
  if (input.launchedAt !== undefined && (typeof input.launchedAt !== 'number' || !Number.isFinite(input.launchedAt))) issues.push(issue('invalid_auto_delivery_launched_at', 'autoDelivery.launchedAt must be a finite number.', `${path}.launchedAt`));
  if (input.lastError !== undefined && typeof input.lastError !== 'string') issues.push(issue('invalid_auto_delivery_last_error', 'autoDelivery.lastError must be a string.', `${path}.lastError`));
  return issues;
}

function normalizeAutoDeliveryPolicy(input: Record<string, unknown>): EvolutionAutoDeliveryPolicy {
  return {
    enabled: input.enabled === true,
    presetId: input.presetId as EvolutionAutoDeliverPresetId,
    autoCommitPush: input.autoCommitPush === true,
    ...(isOneOf(input.requestedBy, REQUESTED_BY_VALUES) ? { requestedBy: input.requestedBy } : {}),
    ...(typeof input.launchedAt === 'number' ? { launchedAt: input.launchedAt } : {}),
    ...(typeof input.lastError === 'string' ? { lastError: input.lastError } : {}),
  };
}

function validateStagingDeliveryState(input: unknown, path: string): EvolutionValidationIssue[] {
  if (input === undefined) return [];
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_staging_delivery_state', 'stagingDelivery must be an object.', path)];
  if (!isOneOf(input.status, EVOLUTION_STAGING_DELIVERY_STATUSES)) {
    issues.push(issue('invalid_staging_delivery_status', 'stagingDelivery.status is invalid.', `${path}.status`));
  }
  if (input.configPath !== undefined) {
    const configPath = validateEvolutionArtifactRelativePath(input.configPath, `${path}.configPath`);
    if (!configPath.ok) issues.push(...configPath.issues);
  }
  if (input.command !== undefined && typeof input.command !== 'string') {
    issues.push(issue('invalid_staging_delivery_command', 'stagingDelivery.command must be a string.', `${path}.command`));
  }
  if (input.logArtifactId !== undefined && typeof input.logArtifactId !== 'string') {
    issues.push(issue('invalid_staging_delivery_log_artifact', 'stagingDelivery.logArtifactId must be a string.', `${path}.logArtifactId`));
  }
  if (input.exitCode !== undefined && (typeof input.exitCode !== 'number' || !Number.isInteger(input.exitCode))) {
    issues.push(issue('invalid_staging_delivery_exit_code', 'stagingDelivery.exitCode must be an integer.', `${path}.exitCode`));
  }
  if (input.summary !== undefined && typeof input.summary !== 'string') {
    issues.push(issue('invalid_staging_delivery_summary', 'stagingDelivery.summary must be a string.', `${path}.summary`));
  }
  if (input.startedAt !== undefined && (typeof input.startedAt !== 'number' || !Number.isFinite(input.startedAt))) {
    issues.push(issue('invalid_staging_delivery_started_at', 'stagingDelivery.startedAt must be a finite number.', `${path}.startedAt`));
  }
  if (input.completedAt !== undefined && (typeof input.completedAt !== 'number' || !Number.isFinite(input.completedAt))) {
    issues.push(issue('invalid_staging_delivery_completed_at', 'stagingDelivery.completedAt must be a finite number.', `${path}.completedAt`));
  }
  if (input.lastError !== undefined && typeof input.lastError !== 'string') {
    issues.push(issue('invalid_staging_delivery_last_error', 'stagingDelivery.lastError must be a string.', `${path}.lastError`));
  }
  return issues;
}

function normalizeStagingDeliveryState(input: Record<string, unknown>): EvolutionStagingDeliveryState {
  return {
    status: input.status as EvolutionStagingDeliveryStatus,
    ...(typeof input.configPath === 'string' ? { configPath: input.configPath } : {}),
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(typeof input.logArtifactId === 'string' ? { logArtifactId: input.logArtifactId } : {}),
    ...(typeof input.exitCode === 'number' ? { exitCode: input.exitCode } : {}),
    ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
    ...(typeof input.startedAt === 'number' ? { startedAt: input.startedAt } : {}),
    ...(typeof input.completedAt === 'number' ? { completedAt: input.completedAt } : {}),
    ...(typeof input.lastError === 'string' ? { lastError: input.lastError } : {}),
  };
}

function validateRoleState(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_role_state', 'Role state must be an object.', path)];
  if (!isOneOf(input.roleId, EVOLUTION_ROLE_IDS)) issues.push(issue('invalid_role_id', 'Role id is not canonical.', `${path}.roleId`));
  if (!isOneOf(input.status, EVOLUTION_ROLE_STATUSES)) issues.push(issue('invalid_role_status', 'Role status is not canonical.', `${path}.status`));
  if (input.label !== undefined && typeof input.label !== 'string') issues.push(issue('invalid_role_label', 'Role label must be a string.', `${path}.label`));
  if (input.skillName !== undefined && typeof input.skillName !== 'string') issues.push(issue('invalid_role_skill_name', 'Role skillName must be a string.', `${path}.skillName`));
  if (input.skillSummary !== undefined && typeof input.skillSummary !== 'string') issues.push(issue('invalid_role_skill_summary', 'Role skillSummary must be a string.', `${path}.skillSummary`));
  if (input.responsibilities !== undefined && (!Array.isArray(input.responsibilities) || input.responsibilities.some((entry) => typeof entry !== 'string'))) {
    issues.push(issue('invalid_role_responsibilities', 'Role responsibilities must be a string array.', `${path}.responsibilities`));
  }
  if (input.stage !== undefined && !isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_role_stage', 'Role stage is not canonical.', `${path}.stage`));
  if (input.currentAction !== undefined && typeof input.currentAction !== 'string') issues.push(issue('invalid_role_current_action', 'Role currentAction must be a string.', `${path}.currentAction`));
  if (input.sessionName !== undefined && typeof input.sessionName !== 'string') issues.push(issue('invalid_role_session_name', 'Role sessionName must be a string.', `${path}.sessionName`));
  if (input.updatedAt !== undefined && (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt))) {
    issues.push(issue('invalid_role_updated_at', 'Role updatedAt must be a finite number.', `${path}.updatedAt`));
  }
  return issues;
}

function normalizeRoleState(input: Record<string, unknown>): EvolutionRoleState {
  return {
    roleId: input.roleId as EvolutionRoleId,
    ...(typeof input.label === 'string' ? { label: input.label } : {}),
    ...(typeof input.skillName === 'string' ? { skillName: input.skillName } : {}),
    ...(typeof input.skillSummary === 'string' ? { skillSummary: input.skillSummary } : {}),
    ...(Array.isArray(input.responsibilities) ? { responsibilities: input.responsibilities.filter((entry): entry is string => typeof entry === 'string') } : {}),
    status: input.status as EvolutionRoleStatus,
    ...(isEvolutionStage(input.stage) ? { stage: input.stage } : {}),
    ...(typeof input.currentAction === 'string' ? { currentAction: input.currentAction } : {}),
    ...(typeof input.sessionName === 'string' ? { sessionName: input.sessionName } : {}),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : Date.now(),
  };
}

function validateArtifactRef(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_artifact_ref', 'Artifact ref must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push(issue('invalid_artifact_id', 'Artifact id is required.', `${path}.id`));
  if (!isOneOf(input.kind, EVOLUTION_ARTIFACT_KINDS)) issues.push(issue('invalid_artifact_kind', 'Artifact kind is not canonical.', `${path}.kind`));
  if (input.preview !== undefined) issues.push(...validateArtifactPreview(input.preview, `${path}.preview`));
  const artifactPath = validateEvolutionArtifactRelativePath(input.path, `${path}.path`);
  if (!artifactPath.ok) issues.push(...artifactPath.issues);
  if (input.roleId !== undefined && !isOneOf(input.roleId, EVOLUTION_ROLE_IDS)) issues.push(issue('invalid_artifact_role_id', 'Artifact role id is not canonical.', `${path}.roleId`));
  if (input.stage !== undefined && !isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_artifact_stage', 'Artifact stage is not canonical.', `${path}.stage`));
  if (input.sha256 !== undefined && (typeof input.sha256 !== 'string' || !SHA256_RE.test(input.sha256))) issues.push(issue('invalid_artifact_sha256', 'Artifact sha256 must be a 64-character hex digest.', `${path}.sha256`));
  if (input.bytes !== undefined && (typeof input.bytes !== 'number' || !Number.isInteger(input.bytes) || input.bytes < 0)) issues.push(issue('invalid_artifact_bytes', 'Artifact bytes must be a non-negative integer.', `${path}.bytes`));
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_artifact_created_at', 'Artifact createdAt must be a finite number.', `${path}.createdAt`));
  return issues;
}

function validateArtifactPreview(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_artifact_preview', 'Artifact preview must be an object.', path)];
  if (!isOneOf(input.previewType, EVOLUTION_ARTIFACT_PREVIEW_TYPES)) {
    issues.push(issue('invalid_artifact_preview_type', 'Artifact previewType is not canonical.', `${path}.previewType`));
  }
  if (typeof input.content !== 'string') {
    issues.push(issue('invalid_artifact_preview_content', 'Artifact preview content must be a string.', `${path}.content`));
  } else if (input.content.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) {
    issues.push(issue('artifact_preview_too_large', 'Artifact preview content exceeds the character limit.', `${path}.content`));
  }
  if (input.language !== undefined && typeof input.language !== 'string') {
    issues.push(issue('invalid_artifact_preview_language', 'Artifact preview language must be a string.', `${path}.language`));
  }
  if (input.truncated !== undefined && typeof input.truncated !== 'boolean') {
    issues.push(issue('invalid_artifact_preview_truncated', 'Artifact preview truncated must be a boolean.', `${path}.truncated`));
  }
  return issues;
}

function normalizeArtifactPreview(input: Record<string, unknown>): EvolutionArtifactPreview {
  return {
    previewType: input.previewType as EvolutionArtifactPreviewType,
    content: input.content as string,
    ...(typeof input.language === 'string' ? { language: input.language } : {}),
    ...(typeof input.truncated === 'boolean' ? { truncated: input.truncated } : {}),
  };
}

function normalizeArtifactRef(input: Record<string, unknown>): EvolutionArtifactRef {
  return {
    id: input.id as string,
    kind: input.kind as EvolutionArtifactKind,
    path: input.path as string,
    ...(typeof input.title === 'string' ? { title: input.title } : {}),
    ...(isRecord(input.preview) ? { preview: normalizeArtifactPreview(input.preview) } : {}),
    ...(isOneOf(input.roleId, EVOLUTION_ROLE_IDS) ? { roleId: input.roleId as EvolutionRoleId } : {}),
    ...(isEvolutionStage(input.stage) ? { stage: input.stage } : {}),
    ...(typeof input.sha256 === 'string' ? { sha256: input.sha256.toLowerCase() } : {}),
    ...(typeof input.bytes === 'number' ? { bytes: input.bytes } : {}),
    createdAt: input.createdAt as number,
  };
}

function validateScore(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_score', 'Score must be an object.', path)];
  if (!isOneOf(input.module, EVOLUTION_SCORE_MODULE_IDS)) issues.push(issue('invalid_score_module', 'Score module is not canonical.', `${path}.module`));
  if (typeof input.score !== 'number' || !Number.isFinite(input.score) || input.score < 0 || input.score > EVOLUTION_SCORE_MAX) issues.push(issue('invalid_score_value', 'Score must be 0 through 10.', `${path}.score`));
  if (input.maxScore !== EVOLUTION_SCORE_MAX) issues.push(issue('invalid_score_max', 'maxScore must equal 10.', `${path}.maxScore`));
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) issues.push(issue('invalid_score_summary', 'Score summary is required.', `${path}.summary`));
  return issues;
}

function normalizeScore(input: Record<string, unknown>): EvolutionScore {
  return {
    module: input.module as EvolutionScoreModuleId,
    score: input.score as number,
    maxScore: 10,
    summary: input.summary as string,
  };
}

function validateBlockingQuestion(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_blocking_question', 'Blocking question must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push(issue('invalid_blocking_question_id', 'Blocking question id is required.', `${path}.id`));
  if (!isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_blocking_question_stage', 'Blocking question stage is not canonical.', `${path}.stage`));
  if (input.roleId !== undefined && !isOneOf(input.roleId, EVOLUTION_ROLE_IDS)) issues.push(issue('invalid_blocking_question_role_id', 'Blocking question role id is not canonical.', `${path}.roleId`));
  if (typeof input.question !== 'string' || input.question.trim().length === 0) issues.push(issue('invalid_blocking_question_text', 'Blocking question text is required.', `${path}.question`));
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_blocking_question_created_at', 'Blocking question createdAt must be a finite number.', `${path}.createdAt`));
  return issues;
}

function normalizeBlockingQuestion(input: Record<string, unknown>): EvolutionBlockingQuestion {
  return {
    id: input.id as string,
    stage: input.stage as EvolutionStage,
    ...(isOneOf(input.roleId, EVOLUTION_ROLE_IDS) ? { roleId: input.roleId as EvolutionRoleId } : {}),
    question: input.question as string,
    createdAt: input.createdAt as number,
  };
}

function validateDiscussionMessage(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_discussion_message', 'Discussion message must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push(issue('invalid_discussion_id', 'Discussion id is required.', `${path}.id`));
  if (!isOneOf(input.kind, EVOLUTION_DISCUSSION_MESSAGE_KINDS)) issues.push(issue('invalid_discussion_kind', 'Discussion kind is not canonical.', `${path}.kind`));
  if (!isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_discussion_stage', 'Discussion stage is not canonical.', `${path}.stage`));
  if (input.roleId !== undefined && !isOneOf(input.roleId, EVOLUTION_ROLE_IDS)) issues.push(issue('invalid_discussion_role_id', 'Discussion role id is not canonical.', `${path}.roleId`));
  if (typeof input.author !== 'string' || input.author.trim().length === 0) issues.push(issue('invalid_discussion_author', 'Discussion author is required.', `${path}.author`));
  if (typeof input.text !== 'string' || input.text.trim().length === 0) issues.push(issue('invalid_discussion_text', 'Discussion text is required.', `${path}.text`));
  if (input.artifactIds !== undefined && (!Array.isArray(input.artifactIds) || input.artifactIds.some((entry) => typeof entry !== 'string'))) {
    issues.push(issue('invalid_discussion_artifact_ids', 'Discussion artifactIds must be a string array.', `${path}.artifactIds`));
  }
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_discussion_created_at', 'Discussion createdAt must be a finite number.', `${path}.createdAt`));
  return issues;
}

function normalizeDiscussionMessage(input: Record<string, unknown>): EvolutionDiscussionMessage {
  return {
    id: input.id as string,
    kind: input.kind as EvolutionDiscussionMessage['kind'],
    stage: input.stage as EvolutionStage,
    ...(isOneOf(input.roleId, EVOLUTION_ROLE_IDS) ? { roleId: input.roleId as EvolutionRoleId } : {}),
    author: input.author as string,
    text: input.text as string,
    ...(Array.isArray(input.artifactIds) ? { artifactIds: input.artifactIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
    createdAt: input.createdAt as number,
  };
}

function validateRoundtableRef(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_roundtable', 'Roundtable must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push(issue('invalid_roundtable_id', 'Roundtable id is required.', `${path}.id`));
  if (!isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_roundtable_stage', 'Roundtable stage is not canonical.', `${path}.stage`));
  if (typeof input.topic !== 'string' || input.topic.trim().length === 0) issues.push(issue('invalid_roundtable_topic', 'Roundtable topic is required.', `${path}.topic`));
  if (!Array.isArray(input.roles) || input.roles.some((entry) => !isOneOf(entry, EVOLUTION_ROLE_IDS))) {
    issues.push(issue('invalid_roundtable_roles', 'Roundtable roles must be canonical role ids.', `${path}.roles`));
  }
  if (!isOneOf(input.status, EVOLUTION_ROUNDTABLE_STATUSES)) issues.push(issue('invalid_roundtable_status', 'Roundtable status is not canonical.', `${path}.status`));
  if (input.p2pRunId !== undefined && typeof input.p2pRunId !== 'string') issues.push(issue('invalid_roundtable_p2p_run_id', 'Roundtable p2pRunId must be a string.', `${path}.p2pRunId`));
  if (input.discussionId !== undefined && typeof input.discussionId !== 'string') issues.push(issue('invalid_roundtable_discussion_id', 'Roundtable discussionId must be a string.', `${path}.discussionId`));
  if (input.contextPath !== undefined) {
    const contextPath = validateEvolutionArtifactRelativePath(input.contextPath, `${path}.contextPath`);
    if (!contextPath.ok) issues.push(...contextPath.issues);
  }
  if (input.currentTargetSession !== undefined && typeof input.currentTargetSession !== 'string') issues.push(issue('invalid_roundtable_current_target', 'Roundtable currentTargetSession must be a string.', `${path}.currentTargetSession`));
  if (input.summary !== undefined && typeof input.summary !== 'string') issues.push(issue('invalid_roundtable_summary', 'Roundtable summary must be a string.', `${path}.summary`));
  if (input.error !== undefined && typeof input.error !== 'string') issues.push(issue('invalid_roundtable_error', 'Roundtable error must be a string.', `${path}.error`));
  if (input.completedAt !== undefined && typeof input.completedAt !== 'string') issues.push(issue('invalid_roundtable_completed_at', 'Roundtable completedAt must be a string.', `${path}.completedAt`));
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_roundtable_created_at', 'Roundtable createdAt must be a finite number.', `${path}.createdAt`));
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) issues.push(issue('invalid_roundtable_updated_at', 'Roundtable updatedAt must be a finite number.', `${path}.updatedAt`));
  return issues;
}

function normalizeRoundtableRef(input: Record<string, unknown>): EvolutionRoundtableRef {
  return {
    id: input.id as string,
    stage: input.stage as EvolutionStage,
    topic: input.topic as string,
    roles: Array.isArray(input.roles) ? input.roles.filter((entry): entry is EvolutionRoleId => isOneOf(entry, EVOLUTION_ROLE_IDS)) : [],
    status: input.status as EvolutionRoundtableRef['status'],
    ...(typeof input.p2pRunId === 'string' ? { p2pRunId: input.p2pRunId } : {}),
    ...(typeof input.discussionId === 'string' ? { discussionId: input.discussionId } : {}),
    ...(typeof input.contextPath === 'string' ? { contextPath: input.contextPath } : {}),
    ...(typeof input.currentTargetSession === 'string' ? { currentTargetSession: input.currentTargetSession } : {}),
    ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
    ...(typeof input.error === 'string' ? { error: input.error } : {}),
    ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
    createdAt: input.createdAt as number,
    updatedAt: input.updatedAt as number,
  };
}

function validateEvidence(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_evidence', 'Evidence must be an object.', path)];
  if (typeof input.source !== 'string' || input.source.trim().length === 0) issues.push(issue('invalid_evidence_source', 'Evidence source is required.', `${path}.source`));
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) issues.push(issue('invalid_evidence_summary', 'Evidence summary is required.', `${path}.summary`));
  if (input.exitCode !== undefined && (typeof input.exitCode !== 'number' || !Number.isInteger(input.exitCode))) issues.push(issue('invalid_evidence_exit_code', 'Evidence exitCode must be an integer.', `${path}.exitCode`));
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_evidence_created_at', 'Evidence createdAt must be a finite number.', `${path}.createdAt`));
  return issues;
}

function normalizeEvidence(input: Record<string, unknown>): EvolutionEvidence {
  return {
    source: input.source as string,
    summary: input.summary as string,
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(typeof input.exitCode === 'number' ? { exitCode: input.exitCode } : {}),
    ...(typeof input.artifactId === 'string' ? { artifactId: input.artifactId } : {}),
    createdAt: input.createdAt as number,
  };
}

const EXECUTION_TIMELINE_SOURCES = ['role', 'discussion', 'artifact', 'evidence', 'roundtable'] as const;
const LIVE_EVENT_SOURCES = ['system', 'war_room', 'p2p_roundtable', 'openspec_auto_deliver', 'staging_delivery', 'taste_skill', 'role_skill'] as const;
const LIVE_EVENT_KINDS = ['status', 'message', 'task_progress', 'prompt', 'score', 'command', 'stdout', 'stderr', 'artifact', 'gate'] as const;
const LIVE_EVENT_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
const LOOP_CONTROL_MODES = ['planning_only', 'auto_implementation', 'human_gate', 'terminal'] as const;
const LOOP_CONTROL_SIGNAL_STATUSES = ['missing', 'ready', 'running', 'blocked', 'complete'] as const;

function validateExecutionTimelineItem(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_execution_timeline_item', 'Execution timeline item must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push(issue('invalid_execution_timeline_id', 'Execution timeline id is required.', `${path}.id`));
  if (!isOneOf(input.roleId, EVOLUTION_ROLE_IDS)) issues.push(issue('invalid_execution_timeline_role_id', 'Execution timeline role id is not canonical.', `${path}.roleId`));
  if (!isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_execution_timeline_stage', 'Execution timeline stage is not canonical.', `${path}.stage`));
  if (!isOneOf(input.status, EVOLUTION_ROLE_STATUSES)) issues.push(issue('invalid_execution_timeline_status', 'Execution timeline status is not canonical.', `${path}.status`));
  if (typeof input.title !== 'string' || input.title.trim().length === 0) issues.push(issue('invalid_execution_timeline_title', 'Execution timeline title is required.', `${path}.title`));
  if (typeof input.detail !== 'string' || input.detail.trim().length === 0) issues.push(issue('invalid_execution_timeline_detail', 'Execution timeline detail is required.', `${path}.detail`));
  if (input.artifactIds !== undefined && (!Array.isArray(input.artifactIds) || input.artifactIds.some((entry) => typeof entry !== 'string'))) {
    issues.push(issue('invalid_execution_timeline_artifact_ids', 'Execution timeline artifactIds must be a string array.', `${path}.artifactIds`));
  }
  if (!isOneOf(input.source, EXECUTION_TIMELINE_SOURCES)) issues.push(issue('invalid_execution_timeline_source', 'Execution timeline source is invalid.', `${path}.source`));
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_execution_timeline_created_at', 'Execution timeline createdAt must be a finite number.', `${path}.createdAt`));
  return issues;
}

function normalizeExecutionTimelineItem(input: Record<string, unknown>): EvolutionExecutionTimelineItem {
  return {
    id: input.id as string,
    roleId: input.roleId as EvolutionRoleId,
    stage: input.stage as EvolutionStage,
    status: input.status as EvolutionRoleStatus,
    title: input.title as string,
    detail: input.detail as string,
    ...(Array.isArray(input.artifactIds) ? { artifactIds: input.artifactIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
    source: input.source as EvolutionExecutionTimelineItem['source'],
    createdAt: input.createdAt as number,
  };
}

function validateLiveEventProgress(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_live_event_progress', 'Live event progress must be an object.', path)];
  for (const key of ['current', 'total'] as const) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0) {
      issues.push(issue('invalid_live_event_progress_value', `${key} must be a non-negative finite number.`, `${path}.${key}`));
    }
  }
  if (typeof input.current === 'number' && typeof input.total === 'number' && input.current > input.total) {
    issues.push(issue('invalid_live_event_progress_bounds', 'current must not exceed total.', path));
  }
  if (input.label !== undefined && typeof input.label !== 'string') {
    issues.push(issue('invalid_live_event_progress_label', 'progress.label must be a string.', `${path}.label`));
  }
  return issues;
}

function validateLiveEvent(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_live_event', 'Live event must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push(issue('invalid_live_event_id', 'Live event id is required.', `${path}.id`));
  if (!isOneOf(input.source, LIVE_EVENT_SOURCES)) issues.push(issue('invalid_live_event_source', 'Live event source is invalid.', `${path}.source`));
  if (!isOneOf(input.kind, LIVE_EVENT_KINDS)) issues.push(issue('invalid_live_event_kind', 'Live event kind is invalid.', `${path}.kind`));
  if (!isOneOf(input.severity, LIVE_EVENT_SEVERITIES)) issues.push(issue('invalid_live_event_severity', 'Live event severity is invalid.', `${path}.severity`));
  if (input.roleId !== undefined && !isOneOf(input.roleId, EVOLUTION_ROLE_IDS)) issues.push(issue('invalid_live_event_role_id', 'Live event role id is invalid.', `${path}.roleId`));
  if (!isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_live_event_stage', 'Live event stage is invalid.', `${path}.stage`));
  if (typeof input.title !== 'string' || input.title.trim().length === 0) issues.push(issue('invalid_live_event_title', 'Live event title is required.', `${path}.title`));
  if (typeof input.detail !== 'string' || input.detail.trim().length === 0) issues.push(issue('invalid_live_event_detail', 'Live event detail is required.', `${path}.detail`));
  if (input.progress !== undefined) issues.push(...validateLiveEventProgress(input.progress, `${path}.progress`));
  if (input.command !== undefined && typeof input.command !== 'string') issues.push(issue('invalid_live_event_command', 'Live event command must be a string.', `${path}.command`));
  if (input.exitCode !== undefined && (typeof input.exitCode !== 'number' || !Number.isInteger(input.exitCode))) issues.push(issue('invalid_live_event_exit_code', 'Live event exitCode must be an integer.', `${path}.exitCode`));
  if (input.artifactIds !== undefined && (!Array.isArray(input.artifactIds) || input.artifactIds.some((entry) => typeof entry !== 'string'))) {
    issues.push(issue('invalid_live_event_artifact_ids', 'Live event artifactIds must be a string array.', `${path}.artifactIds`));
  }
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_live_event_created_at', 'Live event createdAt must be a finite number.', `${path}.createdAt`));
  return issues;
}

function normalizeLiveEvent(input: Record<string, unknown>): EvolutionLiveEvent {
  return {
    id: input.id as string,
    source: input.source as EvolutionLiveEventSource,
    kind: input.kind as EvolutionLiveEventKind,
    severity: input.severity as EvolutionLiveEventSeverity,
    ...(isOneOf(input.roleId, EVOLUTION_ROLE_IDS) ? { roleId: input.roleId as EvolutionRoleId } : {}),
    stage: input.stage as EvolutionStage,
    title: input.title as string,
    detail: input.detail as string,
    ...(isRecord(input.progress) ? {
      progress: {
        current: input.progress.current as number,
        total: input.progress.total as number,
        ...(typeof input.progress.label === 'string' ? { label: input.progress.label } : {}),
      },
    } : {}),
    ...(typeof input.command === 'string' ? { command: input.command } : {}),
    ...(typeof input.exitCode === 'number' ? { exitCode: input.exitCode } : {}),
    ...(Array.isArray(input.artifactIds) ? { artifactIds: input.artifactIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
    createdAt: input.createdAt as number,
  };
}

function validateBudget(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_budget', 'Budget must be an object.', path)];
  for (const key of ['maxRoleTurns', 'maxElapsedMinutes', 'maxImplementationAttempts'] as const) {
    if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || input[key] < 0) {
      issues.push(issue('invalid_budget_value', `${key} must be a non-negative integer.`, `${path}.${key}`));
    }
  }
  if (input.maxAutoDeployStage !== 'none' && input.maxAutoDeployStage !== 'staging') {
    issues.push(issue('invalid_budget_auto_deploy_stage', 'maxAutoDeployStage must be none or staging.', `${path}.maxAutoDeployStage`));
  }
  return issues;
}

function normalizeBudget(input: Record<string, unknown>): EvolutionLoopControl['budget'] {
  return {
    maxRoleTurns: input.maxRoleTurns as number,
    maxElapsedMinutes: input.maxElapsedMinutes as number,
    maxImplementationAttempts: input.maxImplementationAttempts as number,
    maxAutoDeployStage: input.maxAutoDeployStage as EvolutionLoopControl['budget']['maxAutoDeployStage'],
  };
}

function validateLoopControlUsage(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_loop_control_usage', 'Loop control usage must be an object.', path)];
  for (const key of ['elapsedMinutes', 'roleTurns', 'implementationAttempts', 'artifactCount', 'evidenceCount', 'discussionCount'] as const) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0) {
      issues.push(issue('invalid_loop_control_usage_value', `${key} must be a non-negative finite number.`, `${path}.${key}`));
    }
  }
  return issues;
}

function normalizeLoopControlUsage(input: Record<string, unknown>): EvolutionLoopControlUsage {
  return {
    elapsedMinutes: input.elapsedMinutes as number,
    roleTurns: input.roleTurns as number,
    implementationAttempts: input.implementationAttempts as number,
    artifactCount: input.artifactCount as number,
    evidenceCount: input.evidenceCount as number,
    discussionCount: input.discussionCount as number,
  };
}

function validateLoopControlSignal(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_loop_control_signal', 'Loop control signal must be an object.', path)];
  if (typeof input.id !== 'string' || input.id.trim().length === 0) issues.push(issue('invalid_loop_control_signal_id', 'Signal id is required.', `${path}.id`));
  if (typeof input.label !== 'string' || input.label.trim().length === 0) issues.push(issue('invalid_loop_control_signal_label', 'Signal label is required.', `${path}.label`));
  if (!isOneOf(input.status, LOOP_CONTROL_SIGNAL_STATUSES)) issues.push(issue('invalid_loop_control_signal_status', 'Signal status is invalid.', `${path}.status`));
  if (typeof input.detail !== 'string' || input.detail.trim().length === 0) issues.push(issue('invalid_loop_control_signal_detail', 'Signal detail is required.', `${path}.detail`));
  if (input.artifactIds !== undefined && (!Array.isArray(input.artifactIds) || input.artifactIds.some((entry) => typeof entry !== 'string'))) {
    issues.push(issue('invalid_loop_control_signal_artifact_ids', 'Signal artifactIds must be a string array.', `${path}.artifactIds`));
  }
  return issues;
}

function normalizeLoopControlSignal(input: Record<string, unknown>): EvolutionLoopControlSignal {
  return {
    id: input.id as string,
    label: input.label as string,
    status: input.status as EvolutionLoopControlSignalStatus,
    detail: input.detail as string,
    ...(Array.isArray(input.artifactIds) ? { artifactIds: input.artifactIds.filter((entry): entry is string => typeof entry === 'string') } : {}),
  };
}

function validateLoopControl(input: unknown, path: string): EvolutionValidationIssue[] {
  const issues: EvolutionValidationIssue[] = [];
  if (!isRecord(input)) return [issue('invalid_loop_control', 'loopControl must be an object.', path)];
  if (input.source !== 'loop_engineering') issues.push(issue('invalid_loop_control_source', 'loopControl.source must be loop_engineering.', `${path}.source`));
  if (!isOneOf(input.mode, LOOP_CONTROL_MODES)) issues.push(issue('invalid_loop_control_mode', 'loopControl.mode is invalid.', `${path}.mode`));
  if (typeof input.readinessScore !== 'number' || !Number.isFinite(input.readinessScore) || input.readinessScore < 0 || input.readinessScore > 100) {
    issues.push(issue('invalid_loop_control_readiness', 'readinessScore must be 0 through 100.', `${path}.readinessScore`));
  }
  if (typeof input.canAutonomouslyContinue !== 'boolean') {
    issues.push(issue('invalid_loop_control_can_continue', 'canAutonomouslyContinue must be boolean.', `${path}.canAutonomouslyContinue`));
  }
  if (typeof input.currentGate !== 'string' || input.currentGate.trim().length === 0) {
    issues.push(issue('invalid_loop_control_gate', 'currentGate is required.', `${path}.currentGate`));
  }
  issues.push(...validateBudget(input.budget, `${path}.budget`));
  issues.push(...validateLoopControlUsage(input.usage, `${path}.usage`));
  const signals = Array.isArray(input.signals) ? input.signals : [];
  if (!Array.isArray(input.signals)) issues.push(issue('invalid_loop_control_signals', 'signals must be an array.', `${path}.signals`));
  signals.forEach((signal, index) => issues.push(...validateLoopControlSignal(signal, `${path}.signals[${index}]`)));
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) {
    issues.push(issue('invalid_loop_control_updated_at', 'loopControl.updatedAt must be a finite number.', `${path}.updatedAt`));
  }
  return issues;
}

function normalizeLoopControl(input: Record<string, unknown>): EvolutionLoopControl {
  return {
    source: 'loop_engineering',
    mode: input.mode as EvolutionLoopControlMode,
    readinessScore: input.readinessScore as number,
    canAutonomouslyContinue: input.canAutonomouslyContinue as boolean,
    currentGate: input.currentGate as string,
    budget: normalizeBudget(input.budget as Record<string, unknown>),
    usage: normalizeLoopControlUsage(input.usage as Record<string, unknown>),
    signals: Array.isArray(input.signals)
      ? input.signals.map((signal) => normalizeLoopControlSignal(signal as Record<string, unknown>))
      : [],
    updatedAt: input.updatedAt as number,
  };
}

export function validateEvolutionProjection(input: unknown): EvolutionValidationResult<EvolutionProjection> {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('invalid_projection', 'Evolution projection must be an object.')] };
  }
  const issues: EvolutionValidationIssue[] = [];
  if (input.projectionVersion !== 1) issues.push(issue('invalid_projection_version', 'projectionVersion must equal 1.', 'projectionVersion'));
  const runId = validateEvolutionRunId(input.runId);
  if (!runId.ok) issues.push(...runId.issues.map((entry) => ({ ...entry, path: 'runId' })));
  const requestId = validateEvolutionRequestId(input.requestId);
  if (!requestId.ok) issues.push(...requestId.issues.map((entry) => ({ ...entry, path: 'requestId' })));
  if (!isOneOf(input.stage, EVOLUTION_STAGES)) issues.push(issue('invalid_stage', 'Stage is not canonical.', 'stage'));
  if (input.verdict !== undefined && !isOneOf(input.verdict, EVOLUTION_VERDICTS)) issues.push(issue('invalid_verdict', 'Verdict is not canonical.', 'verdict'));
  if (typeof input.sessionName !== 'string' || input.sessionName.length === 0) issues.push(issue('invalid_session_name', 'sessionName is required.', 'sessionName'));

  const source = isRecord(input.source) ? input.source : null;
  if (!source) {
    issues.push(issue('invalid_source', 'Projection source must be an object.', 'source'));
  } else {
    const sourcePath = validateEvolutionRequirementSourcePath(source.relativePath);
    if (!sourcePath.ok) issues.push(...sourcePath.issues.map((entry) => ({ ...entry, path: `source.${entry.path ?? 'relativePath'}` })));
    if (typeof source.fileName !== 'string' || source.fileName.length === 0) issues.push(issue('invalid_source_file_name', 'source.fileName is required.', 'source.fileName'));
    if (source.requestedBy !== undefined && !isOneOf(source.requestedBy, REQUESTED_BY_VALUES)) {
      issues.push(issue('invalid_source_requested_by', 'source.requestedBy must be user, watcher, api, cron, or demo.', 'source.requestedBy'));
    }
    if (source.sizeBytes !== undefined && (typeof source.sizeBytes !== 'number' || !Number.isInteger(source.sizeBytes) || source.sizeBytes < 0)) issues.push(issue('invalid_source_size', 'source.sizeBytes must be a non-negative integer.', 'source.sizeBytes'));
    if (source.sha256 !== undefined && (typeof source.sha256 !== 'string' || !SHA256_RE.test(source.sha256))) issues.push(issue('invalid_source_sha256', 'source.sha256 must be a 64-character hex digest.', 'source.sha256'));
    if (typeof source.ingestedAt !== 'number' || !Number.isFinite(source.ingestedAt)) issues.push(issue('invalid_source_ingested_at', 'source.ingestedAt must be a finite number.', 'source.ingestedAt'));
  }

  const roles = Array.isArray(input.roles) ? input.roles : [];
  if (!Array.isArray(input.roles)) issues.push(issue('invalid_roles', 'roles must be an array.', 'roles'));
  roles.forEach((entry, index) => issues.push(...validateRoleState(entry, `roles[${index}]`)));

  const artifacts = Array.isArray(input.artifacts) ? input.artifacts : [];
  if (!Array.isArray(input.artifacts)) issues.push(issue('invalid_artifacts', 'artifacts must be an array.', 'artifacts'));
  if (artifacts.length > EVOLUTION_ARTIFACTS_MAX) issues.push(issue('too_many_artifacts', 'Too many artifacts in projection.', 'artifacts'));
  artifacts.forEach((entry, index) => issues.push(...validateArtifactRef(entry, `artifacts[${index}]`)));

  const scores = Array.isArray(input.scores) ? input.scores : [];
  if (!Array.isArray(input.scores)) issues.push(issue('invalid_scores', 'scores must be an array.', 'scores'));
  scores.forEach((entry, index) => issues.push(...validateScore(entry, `scores[${index}]`)));

  const blockingQuestions = Array.isArray(input.blockingQuestions) ? input.blockingQuestions : [];
  if (!Array.isArray(input.blockingQuestions)) issues.push(issue('invalid_blocking_questions', 'blockingQuestions must be an array.', 'blockingQuestions'));
  if (blockingQuestions.length > EVOLUTION_BLOCKING_QUESTIONS_MAX) issues.push(issue('too_many_blocking_questions', 'Too many blocking questions.', 'blockingQuestions'));
  blockingQuestions.forEach((entry, index) => issues.push(...validateBlockingQuestion(entry, `blockingQuestions[${index}]`)));

  const discussion = Array.isArray(input.discussion) ? input.discussion : [];
  if (!Array.isArray(input.discussion)) issues.push(issue('invalid_discussion_list', 'discussion must be an array.', 'discussion'));
  if (discussion.length > EVOLUTION_DISCUSSION_ITEMS_MAX) issues.push(issue('too_many_discussion_items', 'Too many discussion messages.', 'discussion'));
  discussion.forEach((entry, index) => issues.push(...validateDiscussionMessage(entry, `discussion[${index}]`)));

  const roundtables = Array.isArray(input.roundtables) ? input.roundtables : [];
  if (!Array.isArray(input.roundtables)) issues.push(issue('invalid_roundtables_list', 'roundtables must be an array.', 'roundtables'));
  roundtables.forEach((entry, index) => issues.push(...validateRoundtableRef(entry, `roundtables[${index}]`)));
  if (!isOneOf(input.roundtableGateMode, EVOLUTION_ROUNDTABLE_GATE_MODES)) {
    issues.push(issue('invalid_roundtable_gate_mode', 'roundtableGateMode must be planning or strict.', 'roundtableGateMode'));
  }
  if (input.designTargetSurface !== undefined && !isOneOf(input.designTargetSurface, EVOLUTION_DESIGN_TARGET_SURFACES)) {
    issues.push(issue('invalid_design_target_surface', 'designTargetSurface must be auto, mobile, pc, or both.', 'designTargetSurface'));
  }

  const evidence = Array.isArray(input.evidence) ? input.evidence : [];
  if (!Array.isArray(input.evidence)) issues.push(issue('invalid_evidence_list', 'evidence must be an array.', 'evidence'));
  if (evidence.length > EVOLUTION_EVIDENCE_ITEMS_MAX) issues.push(issue('too_many_evidence_items', 'Too many evidence items.', 'evidence'));
  evidence.forEach((entry, index) => issues.push(...validateEvidence(entry, `evidence[${index}]`)));

  const executionTimeline = Array.isArray(input.executionTimeline) ? input.executionTimeline : [];
  if (!Array.isArray(input.executionTimeline)) issues.push(issue('invalid_execution_timeline', 'executionTimeline must be an array.', 'executionTimeline'));
  executionTimeline.forEach((entry, index) => issues.push(...validateExecutionTimelineItem(entry, `executionTimeline[${index}]`)));

  const liveEvents = Array.isArray(input.liveEvents) ? input.liveEvents : [];
  if (!Array.isArray(input.liveEvents)) issues.push(issue('invalid_live_events', 'liveEvents must be an array.', 'liveEvents'));
  liveEvents.forEach((entry, index) => issues.push(...validateLiveEvent(entry, `liveEvents[${index}]`)));

  issues.push(...validateLoopControl(input.loopControl, 'loopControl'));
  issues.push(...validateAutoDeliveryPolicy(input.autoDelivery, 'autoDelivery'));
  issues.push(...validateStagingDeliveryState(input.stagingDelivery, 'stagingDelivery'));

  if (typeof input.elapsedMs !== 'number' || !Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) issues.push(issue('invalid_elapsed_ms', 'elapsedMs must be a non-negative finite number.', 'elapsedMs'));
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) issues.push(issue('invalid_updated_at', 'updatedAt must be a finite number.', 'updatedAt'));

  if (issues.length > 0) return { ok: false, issues };
  const normalizedSource = source as Record<string, unknown>;
  return {
    ok: true,
    value: {
      projectionVersion: 1,
      runId: runId.ok ? runId.value : '',
      requestId: requestId.ok ? requestId.value : '',
      stage: input.stage as EvolutionStage,
      ...(isOneOf(input.verdict, EVOLUTION_VERDICTS) ? { verdict: input.verdict as EvolutionVerdict } : {}),
      sessionName: input.sessionName as string,
      ...(typeof input.projectName === 'string' ? { projectName: input.projectName } : {}),
      source: {
        relativePath: normalizedSource.relativePath as string,
        fileName: normalizedSource.fileName as string,
        ...(isOneOf(normalizedSource.requestedBy, REQUESTED_BY_VALUES) ? { requestedBy: normalizedSource.requestedBy as EvolutionRequestedBy } : {}),
        ...(typeof normalizedSource.sizeBytes === 'number' ? { sizeBytes: normalizedSource.sizeBytes } : {}),
        ...(typeof normalizedSource.sha256 === 'string' ? { sha256: normalizedSource.sha256.toLowerCase() } : {}),
        ingestedAt: normalizedSource.ingestedAt as number,
      },
      roles: roles.map((entry) => normalizeRoleState(entry as Record<string, unknown>)),
      artifacts: artifacts.map((entry) => normalizeArtifactRef(entry as Record<string, unknown>)),
      scores: scores.map((entry) => normalizeScore(entry as Record<string, unknown>)),
      blockingQuestions: blockingQuestions.map((entry) => normalizeBlockingQuestion(entry as Record<string, unknown>)),
      discussion: discussion.map((entry) => normalizeDiscussionMessage(entry as Record<string, unknown>)),
      roundtables: roundtables.map((entry) => normalizeRoundtableRef(entry as Record<string, unknown>)),
      roundtableGateMode: input.roundtableGateMode as EvolutionRoundtableGateMode,
      ...(isOneOf(input.designTargetSurface, EVOLUTION_DESIGN_TARGET_SURFACES) ? { designTargetSurface: input.designTargetSurface as EvolutionDesignTargetSurface } : {}),
      evidence: evidence.map((entry) => normalizeEvidence(entry as Record<string, unknown>)),
      executionTimeline: executionTimeline.map((entry) => normalizeExecutionTimelineItem(entry as Record<string, unknown>)),
      liveEvents: liveEvents.map((entry) => normalizeLiveEvent(entry as Record<string, unknown>)),
      loopControl: normalizeLoopControl(input.loopControl as Record<string, unknown>),
      ...(isRecord(input.autoDelivery) ? { autoDelivery: normalizeAutoDeliveryPolicy(input.autoDelivery) } : {}),
      ...(isRecord(input.stagingDelivery) ? { stagingDelivery: normalizeStagingDeliveryState(input.stagingDelivery) } : {}),
      ...(typeof input.linkedOpenSpecChange === 'string' ? { linkedOpenSpecChange: input.linkedOpenSpecChange } : {}),
      ...(typeof input.linkedAutoDeliverRunId === 'string' ? { linkedAutoDeliverRunId: input.linkedAutoDeliverRunId } : {}),
      ...(typeof input.latestMessage === 'string' ? { latestMessage: input.latestMessage } : {}),
      ...(typeof input.terminalReason === 'string' ? { terminalReason: input.terminalReason } : {}),
      elapsedMs: input.elapsedMs as number,
      updatedAt: input.updatedAt as number,
    },
    issues: [],
  };
}

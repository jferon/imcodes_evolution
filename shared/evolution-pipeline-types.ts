import type {
  EvolutionArtifactKind,
  EvolutionArtifactPreviewType,
  EvolutionAutoDeliverPresetId,
  EvolutionDesignTargetSurface,
  EvolutionDiscussionMessageKind,
  EvolutionRoleId,
  EvolutionRoleStatus,
  EvolutionRoundtableGateMode,
  EvolutionRoundtableStatus,
  EvolutionScoreModuleId,
  EvolutionStage,
  EvolutionStagingDeliveryStatus,
  EvolutionVerdict,
} from './evolution-pipeline-constants.js';

export type EvolutionRequestedBy = 'user' | 'watcher' | 'api' | 'cron' | 'demo';

export interface EvolutionLaunchRequest {
  requestId: string;
  serverId?: string;
  sessionName: string;
  projectName?: string;
  /**
   * Project-root-relative path under `.imcodes/inbox/requirements/`.
   * Absolute paths, traversal, home expansion, and unsupported extensions are
   * rejected by the validator before any daemon file read.
   */
  sourceRelativePath: string;
  sourceSizeBytes?: number;
  sourceSha256?: string;
  locale?: string;
  requestedBy?: EvolutionRequestedBy;
  autoStart?: boolean;
  /**
   * When true, the daemon may launch OpenSpec Auto Deliver automatically after
   * the planning pipeline reaches `tasks_ready`. Production remains gated by
   * `EvolutionBudget.maxAutoDeployStage`.
   */
  autoStartImplementation?: boolean;
  autoDeliverPresetId?: EvolutionAutoDeliverPresetId;
  autoCommitPush?: boolean;
  /**
   * `planning` gates only the final planning-review roundtable before
   * implementation. `strict` also pauses after product/design/architecture
   * review roundtables until they return a PASS verdict.
   */
  roundtableGateMode?: EvolutionRoundtableGateMode;
  /**
   * Controls which product surface the design stages must prioritize. `auto`
   * derives from the source MD; `mobile`, `pc`, or `both` override the high-
   * fidelity screen pack and taste-skill prompt.
   */
  designTargetSurface?: EvolutionDesignTargetSurface;
}

export interface EvolutionSourceDocument {
  relativePath: string;
  fileName: string;
  requestedBy?: EvolutionRequestedBy;
  sizeBytes?: number;
  sha256?: string;
  ingestedAt: number;
}

export interface EvolutionInboxWatcherStatus {
  key: string;
  sessionName: string;
  projectRoot: string;
  projectName?: string;
  inboxRelativePath: string;
  inboxAbsolutePath: string;
  intervalMs: number;
  stableMs: number;
  active: boolean;
  startedAt: number;
}

export interface EvolutionReferenceAttachmentInput {
  attachmentId: string;
  originalName?: string;
  mime?: string;
  size?: number;
}

export interface EvolutionReferenceImageImportResult {
  attachmentId: string;
  originalName?: string;
  relativePath: string;
  mime?: string;
  size?: number;
}

export interface EvolutionReferenceBriefImportResult {
  requestId: string;
  sourceRelativePath: string;
  taskRelativeDir: string;
  referencesRelativeDir: string;
  imageCount: number;
  copiedImages: EvolutionReferenceImageImportResult[];
  createdAt: number;
}

export interface EvolutionRoleState {
  roleId: EvolutionRoleId;
  label?: string;
  skillName?: string;
  skillSummary?: string;
  responsibilities?: string[];
  status: EvolutionRoleStatus;
  stage?: EvolutionStage;
  currentAction?: string;
  sessionName?: string;
  updatedAt: number;
}

export interface EvolutionArtifactPreview {
  previewType: EvolutionArtifactPreviewType;
  content: string;
  language?: string;
  truncated?: boolean;
}

export interface EvolutionArtifactRef {
  id: string;
  kind: EvolutionArtifactKind;
  path: string;
  title?: string;
  preview?: EvolutionArtifactPreview;
  roleId?: EvolutionRoleId;
  stage?: EvolutionStage;
  sha256?: string;
  bytes?: number;
  createdAt: number;
}

export interface EvolutionScore {
  module: EvolutionScoreModuleId;
  score: number;
  maxScore: 10;
  summary: string;
}

export interface EvolutionBlockingQuestion {
  id: string;
  stage: EvolutionStage;
  roleId?: EvolutionRoleId;
  question: string;
  createdAt: number;
}

export interface EvolutionEvidence {
  source: string;
  summary: string;
  command?: string;
  exitCode?: number;
  artifactId?: string;
  createdAt: number;
}

export interface EvolutionDiscussionMessage {
  id: string;
  kind: EvolutionDiscussionMessageKind;
  stage: EvolutionStage;
  roleId?: EvolutionRoleId;
  author: string;
  text: string;
  artifactIds?: string[];
  createdAt: number;
}

export interface EvolutionRoundtableRef {
  id: string;
  stage: EvolutionStage;
  topic: string;
  roles: EvolutionRoleId[];
  status: EvolutionRoundtableStatus;
  p2pRunId?: string;
  discussionId?: string;
  contextPath?: string;
  currentTargetSession?: string;
  summary?: string;
  error?: string;
  completedAt?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EvolutionBudget {
  maxRoleTurns: number;
  maxElapsedMinutes: number;
  maxImplementationAttempts: number;
  maxAutoDeployStage: 'none' | 'staging';
}

export type EvolutionLoopControlMode = 'planning_only' | 'auto_implementation' | 'human_gate' | 'terminal';
export type EvolutionLoopControlSignalStatus = 'missing' | 'ready' | 'running' | 'blocked' | 'complete';

export interface EvolutionLoopControlUsage {
  elapsedMinutes: number;
  roleTurns: number;
  implementationAttempts: number;
  artifactCount: number;
  evidenceCount: number;
  discussionCount: number;
}

export interface EvolutionLoopControlSignal {
  id: string;
  label: string;
  status: EvolutionLoopControlSignalStatus;
  detail: string;
  artifactIds?: string[];
}

export interface EvolutionLoopControl {
  source: 'loop_engineering';
  mode: EvolutionLoopControlMode;
  readinessScore: number;
  canAutonomouslyContinue: boolean;
  currentGate: string;
  budget: EvolutionBudget;
  usage: EvolutionLoopControlUsage;
  signals: EvolutionLoopControlSignal[];
  updatedAt: number;
}

export interface EvolutionAutoDeliveryPolicy {
  enabled: boolean;
  presetId: EvolutionAutoDeliverPresetId;
  autoCommitPush: boolean;
  requestedBy?: EvolutionRequestedBy;
  launchedAt?: number;
  lastError?: string;
}

export interface EvolutionStagingDeliveryState {
  status: EvolutionStagingDeliveryStatus;
  configPath?: string;
  command?: string;
  logArtifactId?: string;
  exitCode?: number;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
  lastError?: string;
}

export interface EvolutionExecutionTimelineItem {
  id: string;
  roleId: EvolutionRoleId;
  stage: EvolutionStage;
  status: EvolutionRoleStatus;
  title: string;
  detail: string;
  artifactIds?: string[];
  source: 'role' | 'discussion' | 'artifact' | 'evidence' | 'roundtable';
  createdAt: number;
}

export type EvolutionLiveEventSource =
  | 'system'
  | 'war_room'
  | 'p2p_roundtable'
  | 'openspec_auto_deliver'
  | 'staging_delivery'
  | 'taste_skill'
  | 'role_skill';

export type EvolutionLiveEventKind =
  | 'status'
  | 'message'
  | 'task_progress'
  | 'prompt'
  | 'score'
  | 'command'
  | 'stdout'
  | 'stderr'
  | 'artifact'
  | 'gate';

export type EvolutionLiveEventSeverity = 'info' | 'success' | 'warning' | 'error';

export interface EvolutionLiveEventProgress {
  current: number;
  total: number;
  label?: string;
}

export interface EvolutionLiveEvent {
  id: string;
  source: EvolutionLiveEventSource;
  kind: EvolutionLiveEventKind;
  severity: EvolutionLiveEventSeverity;
  roleId?: EvolutionRoleId;
  stage: EvolutionStage;
  title: string;
  detail: string;
  progress?: EvolutionLiveEventProgress;
  command?: string;
  exitCode?: number;
  artifactIds?: string[];
  createdAt: number;
}

export interface EvolutionRun {
  runId: string;
  requestId: string;
  stage: EvolutionStage;
  verdict?: EvolutionVerdict;
  serverId?: string;
  sessionName: string;
  projectName?: string;
  projectRoot?: string;
  source: EvolutionSourceDocument;
  roles: EvolutionRoleState[];
  artifacts: EvolutionArtifactRef[];
  scores: EvolutionScore[];
  blockingQuestions: EvolutionBlockingQuestion[];
  discussion: EvolutionDiscussionMessage[];
  roundtables: EvolutionRoundtableRef[];
  roundtableGateMode: EvolutionRoundtableGateMode;
  designTargetSurface?: EvolutionDesignTargetSurface;
  evidence: EvolutionEvidence[];
  executionTimeline?: EvolutionExecutionTimelineItem[];
  liveEvents?: EvolutionLiveEvent[];
  budget: EvolutionBudget;
  autoDelivery?: EvolutionAutoDeliveryPolicy;
  stagingDelivery?: EvolutionStagingDeliveryState;
  linkedOpenSpecChange?: string;
  linkedAutoDeliverRunId?: string;
  latestMessage?: string;
  terminalReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EvolutionProjection {
  projectionVersion: 1;
  runId: string;
  requestId: string;
  stage: EvolutionStage;
  verdict?: EvolutionVerdict;
  sessionName: string;
  projectName?: string;
  source: EvolutionSourceDocument;
  roles: EvolutionRoleState[];
  artifacts: EvolutionArtifactRef[];
  scores: EvolutionScore[];
  blockingQuestions: EvolutionBlockingQuestion[];
  discussion: EvolutionDiscussionMessage[];
  roundtables: EvolutionRoundtableRef[];
  roundtableGateMode: EvolutionRoundtableGateMode;
  designTargetSurface?: EvolutionDesignTargetSurface;
  evidence: EvolutionEvidence[];
  executionTimeline: EvolutionExecutionTimelineItem[];
  liveEvents: EvolutionLiveEvent[];
  loopControl: EvolutionLoopControl;
  autoDelivery?: EvolutionAutoDeliveryPolicy;
  stagingDelivery?: EvolutionStagingDeliveryState;
  linkedOpenSpecChange?: string;
  linkedAutoDeliverRunId?: string;
  latestMessage?: string;
  terminalReason?: string;
  elapsedMs: number;
  updatedAt: number;
}

export type EvolutionValidationSeverity = 'error' | 'warning';

export interface EvolutionValidationIssue {
  code: string;
  message: string;
  path?: string;
  severity: EvolutionValidationSeverity;
}

export type EvolutionValidationResult<T> =
  | { ok: true; value: T; issues: EvolutionValidationIssue[] }
  | { ok: false; issues: EvolutionValidationIssue[] };

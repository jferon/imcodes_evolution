import type {
  EvolutionArtifactKind,
  EvolutionArtifactPreviewType,
  EvolutionArtifactStatus,
  EvolutionAssuranceLevel,
  EvolutionAttemptKind,
  EvolutionAttemptStatus,
  EvolutionAutoDeliverPresetId,
  EvolutionDevelopmentMode,
  EvolutionDesignTargetSurface,
  EvolutionDiscussionMessageKind,
  EvolutionExecutionPolicy,
  EvolutionExternalActionClass,
  EvolutionGateAction,
  EvolutionGateKind,
  EvolutionGateStatus,
  EvolutionGreenfieldTopology,
  EvolutionRoleId,
  EvolutionRoleSource,
  EvolutionRoleStatus,
  EvolutionRoundtableGateMode,
  EvolutionRoundtableStatus,
  EvolutionScoreModuleId,
  EvolutionScoreSource,
  EvolutionStage,
  EvolutionStagingDeliveryStatus,
  EvolutionVerdict,
} from './evolution-pipeline-constants.js';
import type { EvolutionRolePerformanceRecord } from './evolution-role-performance.js';
import type { EvolutionPinnedVerification, EvolutionVerificationState } from './evolution-verification.js';

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
  /**
   * Explicitly selects whether implementation extends the current system or
   * creates a new system inside a dedicated project-relative target.
   */
  developmentMode?: EvolutionDevelopmentMode;
  developmentTargetRelativeDir?: string;
  executionPolicy?: EvolutionExecutionPolicy;
  greenfieldTopology?: EvolutionGreenfieldTopology;
  requireHifiHumanApproval?: boolean;
}

/**
 * Versioned per-project policy for unattended (watcher/API) launches. Every
 * field is optional — an absent field keeps the safe default. The policy can
 * relax OR pre-authorize behavior explicitly, but never silently: the run
 * records which values came from policy.
 */
export interface EvolutionProjectPolicy {
  version: 1;
  executionPolicy?: EvolutionExecutionPolicy;
  roundtableGateMode?: EvolutionRoundtableGateMode;
  developmentMode?: EvolutionDevelopmentMode;
  developmentTargetRelativeDir?: string;
  autoStartImplementation?: boolean;
  requireHifiHumanApproval?: boolean;
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
  roleProfileId?: string;
  activeAttemptId?: string;
  updatedAt: number;
}

export interface EvolutionRoleProfile {
  id: string;
  roleId: EvolutionRoleId;
  label: string;
  summary: string;
  responsibilities: string[];
  skillName: string;
  roleSource: EvolutionRoleSource;
  version: number;
}

export interface EvolutionSkillSnapshot {
  id: string;
  roleId: EvolutionRoleId;
  skillName: string;
  sourcePath: string;
  source: EvolutionRoleSource;
  sha256: string;
  bytes: number;
  capturedAt: number;
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
  revisionId?: string;
  status?: EvolutionArtifactStatus;
  assurance?: EvolutionAssuranceLevel;
  producerAttemptId?: string;
  authorizedByVerdictId?: string;
  supersedesRevisionId?: string;
  createdAt: number;
}

export interface EvolutionArtifactRevision {
  id: string;
  artifactId: string;
  kind: EvolutionArtifactKind;
  logicalPath: string;
  immutablePath: string;
  sha256: string;
  bytes: number;
  stage: EvolutionStage;
  roleId?: EvolutionRoleId;
  status: EvolutionArtifactStatus;
  assurance: EvolutionAssuranceLevel;
  producerAttemptId?: string;
  authorizedByVerdictId?: string;
  supersedesRevisionId?: string;
  createdAt: number;
}

export interface EvolutionScore {
  module: EvolutionScoreModuleId;
  score: number;
  maxScore: 10;
  summary: string;
  source?: EvolutionScoreSource;
  attemptId?: string;
}

export interface EvolutionAttemptRecord {
  id: string;
  kind: EvolutionAttemptKind;
  stage: EvolutionStage;
  roleId: EvolutionRoleId;
  checkerRoleId?: EvolutionRoleId;
  status: EvolutionAttemptStatus;
  dispatchToken: string;
  p2pRunId?: string;
  inputRevisionIds: string[];
  skillSnapshotIds: string[];
  outputRevisionIds: string[];
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface EvolutionVerdictRecord {
  id: string;
  attemptId: string;
  stage: EvolutionStage;
  checkerRoleId: EvolutionRoleId;
  verdict: EvolutionVerdict;
  machineReadable: boolean;
  summary: string;
  inputRevisionIds: string[];
  approvedRevisionIds: string[];
  p2pRunId?: string;
  createdAt: number;
}

export interface EvolutionGateDecision {
  id: string;
  action: EvolutionGateAction;
  actor: 'human' | 'system';
  /** Optional stable identity of the deciding actor (user id, agent id). */
  actorId?: string;
  expectedRunRevision: number;
  feedback?: string;
  createdAt: number;
}

export interface EvolutionGateRecord {
  id: string;
  kind: EvolutionGateKind;
  stage: EvolutionStage;
  status: EvolutionGateStatus;
  candidateRevisionIds: string[];
  reviewSetId?: string;
  requiredAssurance: EvolutionAssuranceLevel;
  openedAt: number;
  resolvedAt?: number;
  decision?: EvolutionGateDecision;
}

export interface EvolutionDesignReviewSet {
  id: string;
  attemptId?: string;
  revisionIds: string[];
  immutableManifestPath: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  createdAt: number;
  decidedAt?: number;
  feedback?: string;
}

export interface EvolutionWritePolicy {
  allowedRoots: string[];
  deniedRoots: string[];
  protectedRoots: string[];
  requireIsolatedWorktree: boolean;
  targetRelativeDir?: string;
  targetInventorySha256?: string;
  inventoryCapturedAt?: number;
}

export interface EvolutionFoundationEvidence {
  id: string;
  capability: 'repository' | 'runtime' | 'database' | 'auth' | 'observability' | 'ci' | 'deployment';
  status: 'planned' | 'verified' | 'blocked' | 'not_applicable';
  ownerRoleId: EvolutionRoleId;
  artifactRevisionIds: string[];
  externalActionClass: EvolutionExternalActionClass;
  summary: string;
  createdAt: number;
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
  attemptId?: string;
  dispatchToken?: string;
  verdictId?: string;
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
  controlVersion?: 2;
  runRevision?: number;
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
  developmentMode?: EvolutionDevelopmentMode;
  developmentTargetRelativeDir?: string;
  executionPolicy?: EvolutionExecutionPolicy;
  greenfieldTopology?: EvolutionGreenfieldTopology;
  writePolicy?: EvolutionWritePolicy;
  requireHifiHumanApproval?: boolean;
  roleProfiles?: EvolutionRoleProfile[];
  skillSnapshots?: EvolutionSkillSnapshot[];
  artifactRevisions?: EvolutionArtifactRevision[];
  attempts?: EvolutionAttemptRecord[];
  verdictRecords?: EvolutionVerdictRecord[];
  gates?: EvolutionGateRecord[];
  designReviewSets?: EvolutionDesignReviewSet[];
  authorizedRevisions?: Record<string, string>;
  foundationEvidence?: EvolutionFoundationEvidence[];
  /** Verification policy copied into the run at launch (temporal integrity). */
  pinnedVerification?: EvolutionPinnedVerification;
  /** sha256 (or 'absent') per governance source file, captured at launch. */
  governanceSourceDigests?: Record<string, string>;
  /** Daemon-observed verification results; cleared by new implementation activity. */
  verificationState?: EvolutionVerificationState;
  processedMutationIds?: string[];
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
  controlVersion?: 2;
  runRevision?: number;
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
  developmentMode?: EvolutionDevelopmentMode;
  developmentTargetRelativeDir?: string;
  executionPolicy?: EvolutionExecutionPolicy;
  greenfieldTopology?: EvolutionGreenfieldTopology;
  writePolicy?: EvolutionWritePolicy;
  requireHifiHumanApproval?: boolean;
  roleProfiles?: EvolutionRoleProfile[];
  skillSnapshots?: EvolutionSkillSnapshot[];
  artifactRevisions?: EvolutionArtifactRevision[];
  attempts?: EvolutionAttemptRecord[];
  verdictRecords?: EvolutionVerdictRecord[];
  gates?: EvolutionGateRecord[];
  designReviewSets?: EvolutionDesignReviewSet[];
  authorizedRevisions?: Record<string, string>;
  foundationEvidence?: EvolutionFoundationEvidence[];
  rolePerformance?: EvolutionRolePerformanceRecord[];
  pinnedVerification?: EvolutionPinnedVerification;
  verificationState?: EvolutionVerificationState;
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
  /**
   * Present only while a user-initiated pause is in effect. `pausing` means
   * the pause was requested but in-flight stage work is still running until
   * its next checkpoint; `paused` means nothing is executing anymore. Lets
   * the UI avoid implying an instantaneous stop that hasn't happened yet.
   */
  userPauseState?: 'pausing' | 'paused';
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

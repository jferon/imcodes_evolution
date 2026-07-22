import {
  EVOLUTION_PIPELINE_MSG,
  EVOLUTION_ROLE_IDS,
  EVOLUTION_STAGES,
  EVOLUTION_TERMINAL_STAGES,
  type EvolutionAutoDeliverPresetId,
  type EvolutionDesignTargetSurface,
  type EvolutionRoleId,
  type EvolutionRoundtableGateMode,
  type EvolutionStage,
} from '@shared/evolution-pipeline-constants.js';
import type {
  EvolutionLaunchRequest,
  EvolutionProjection,
  EvolutionReferenceAttachmentInput,
  EvolutionReferenceBriefImportResult,
} from '@shared/evolution-pipeline-types.js';

export { EVOLUTION_PIPELINE_MSG, EVOLUTION_ROLE_IDS, EVOLUTION_STAGES, EVOLUTION_TERMINAL_STAGES };
export type { EvolutionDesignTargetSurface, EvolutionRoleId, EvolutionRoundtableGateMode, EvolutionStage } from '@shared/evolution-pipeline-constants.js';
export type {
  EvolutionArtifactRef,
  EvolutionEvidence,
  EvolutionInboxWatcherStatus,
  EvolutionLaunchRequest,
  EvolutionProjection,
  EvolutionReferenceAttachmentInput,
  EvolutionReferenceBriefImportResult,
  EvolutionRoleState,
} from '@shared/evolution-pipeline-types.js';

export type EvolutionPipelineMessageType = typeof EVOLUTION_PIPELINE_MSG[keyof typeof EVOLUTION_PIPELINE_MSG];

export interface EvolutionLaunchPayload extends EvolutionLaunchRequest {
  type: typeof EVOLUTION_PIPELINE_MSG.LAUNCH;
  projectRoot?: string;
}

export interface EvolutionLaunchDemoPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO;
  requestId: string;
  serverId?: string;
  sessionName: string;
  projectRoot?: string;
  projectName?: string;
  locale?: string;
  autoStart?: boolean;
  autoStartImplementation?: boolean;
  autoDeliverPresetId?: EvolutionAutoDeliverPresetId;
  autoCommitPush?: boolean;
  roundtableGateMode?: EvolutionRoundtableGateMode;
  designTargetSurface?: EvolutionDesignTargetSurface;
}

export interface EvolutionStatusPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.STATUS_REQUEST;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  projectRoot?: string;
  runId?: string;
}

export interface EvolutionScanInboxPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.SCAN_INBOX;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  projectRoot?: string;
}

export interface EvolutionImportReferencesPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  projectRoot?: string;
  projectName?: string;
  taskName?: string;
  note?: string;
  attachments: EvolutionReferenceAttachmentInput[];
}

export interface EvolutionImportReferencesAck {
  type: typeof EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES_ACK;
  requestId: string;
  ok: boolean;
  result?: EvolutionReferenceBriefImportResult;
  error?: string;
  issues?: Array<{ code?: string; message?: string; path?: string; severity?: string }>;
}

export interface EvolutionCheckStagingPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.CHECK_STAGING;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  runId: string;
}

export interface EvolutionStopPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.STOP;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  runId: string;
  reason?: string;
}

export interface EvolutionContinuePayload {
  type: typeof EVOLUTION_PIPELINE_MSG.CONTINUE;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  runId: string;
  targetStage?: EvolutionStage;
  message?: string;
}

export interface EvolutionUserMessagePayload {
  type: typeof EVOLUTION_PIPELINE_MSG.USER_MESSAGE;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  runId: string;
  roleId?: EvolutionRoleId;
  text: string;
}

export interface EvolutionUpdateRoleSkillPayload {
  type: typeof EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  runId: string;
  roleId: EvolutionRoleId;
  markdown: string;
}

export interface EvolutionApproveRoleSkillCandidatePayload {
  type: typeof EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE;
  requestId: string;
  serverId?: string;
  sessionName?: string;
  runId: string;
  roleId: EvolutionRoleId;
  candidateArtifactId: string;
  approvalMessage?: string;
  approverId?: string;
}

export function isEvolutionTerminalProjection(projection: EvolutionProjection | null | undefined): boolean {
  return !!projection && (EVOLUTION_TERMINAL_STAGES as readonly string[]).includes(projection.stage);
}

export function isEvolutionActiveProjection(projection: EvolutionProjection | null | undefined): boolean {
  return !!projection && !isEvolutionTerminalProjection(projection);
}

export function isEvolutionRoleId(value: unknown): value is EvolutionRoleId {
  return typeof value === 'string' && (EVOLUTION_ROLE_IDS as readonly string[]).includes(value);
}

export function isEvolutionProjection(value: unknown): value is EvolutionProjection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.projectionVersion === 1
    && typeof record.runId === 'string'
    && typeof record.requestId === 'string'
    && typeof record.sessionName === 'string'
    && typeof record.updatedAt === 'number'
    && (EVOLUTION_STAGES as readonly string[]).includes(String(record.stage));
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MSG_DAEMON_OFFLINE } from '@shared/ack-protocol.js';
import { DAEMON_MSG } from '@shared/daemon-events.js';
import {
  EVOLUTION_PIPELINE_MSG,
  isEvolutionProjection,
  isEvolutionRoleId,
  isEvolutionTerminalProjection,
  type EvolutionApproveRoleSkillCandidatePayload,
  type EvolutionCheckStagingPayload,
  type EvolutionContinuePayload,
  type EvolutionInboxWatcherStatus,
  type EvolutionImportReferencesPayload,
  type EvolutionLaunchDemoPayload,
  type EvolutionLaunchPayload,
  type EvolutionProjection,
  type EvolutionReferenceAttachmentInput,
  type EvolutionReferenceBriefImportResult,
  type EvolutionDesignTargetSurface,
  type EvolutionRoundtableGateMode,
  type EvolutionRoleId,
  type EvolutionScanInboxPayload,
  type EvolutionStatusPayload,
  type EvolutionStopPayload,
  type EvolutionUpdateRoleSkillPayload,
  type EvolutionUserMessagePayload,
} from '../evolution-pipeline.js';

const EVOLUTION_LAUNCH_TIMEOUT_MS = 30_000;
const EVOLUTION_SCAN_TIMEOUT_MS = 15_000;
const EVOLUTION_STAGING_CHECK_TIMEOUT_MS = 15_000;
const EVOLUTION_STOP_TIMEOUT_MS = 15_000;
const EVOLUTION_CONTINUE_TIMEOUT_MS = 30_000;
const EVOLUTION_SKILL_UPDATE_TIMEOUT_MS = 15_000;
const EVOLUTION_REFERENCE_IMPORT_TIMEOUT_MS = 30_000;

interface EvolutionWsClient {
  send(message: object): void;
  onMessage(handler: (message: unknown) => void): () => void;
}

interface Options {
  ws: EvolutionWsClient | null;
  serverId?: string;
  sessionName?: string | null;
  projectRoot?: string | null;
}

interface LaunchOptions {
  sourceRelativePath: string;
  projectName?: string;
  locale?: string;
  autoStart?: boolean;
  autoStartImplementation?: boolean;
  autoDeliverPresetId?: 'fast' | 'standard' | 'strict' | 'deep';
  autoCommitPush?: boolean;
  roundtableGateMode?: EvolutionRoundtableGateMode;
  designTargetSurface?: EvolutionDesignTargetSurface;
}

interface LaunchDemoOptions {
  projectName?: string;
  locale?: string;
  autoStart?: boolean;
  autoStartImplementation?: boolean;
  autoDeliverPresetId?: 'fast' | 'standard' | 'strict' | 'deep';
  autoCommitPush?: boolean;
  roundtableGateMode?: EvolutionRoundtableGateMode;
  designTargetSurface?: EvolutionDesignTargetSurface;
}

interface CreateReferenceBriefOptions {
  attachments: EvolutionReferenceAttachmentInput[];
  note?: string;
  taskName?: string;
  projectName?: string;
}

interface State {
  projection: EvolutionProjection | null;
  watchers: EvolutionInboxWatcherStatus[];
  launchPending: boolean;
  scanPending: boolean;
  stagingCheckPending: boolean;
  skillUpdatePending: boolean;
  stopPending: boolean;
  continuePending: boolean;
  referenceBriefPending: boolean;
  lastReferenceBrief: EvolutionReferenceBriefImportResult | null;
  lastError: string | null;
  launch: (options: LaunchOptions) => string | null;
  launchDemo: (options?: LaunchDemoOptions) => string | null;
  createReferenceBrief: (options: CreateReferenceBriefOptions) => string | null;
  scanInbox: () => string | null;
  checkStaging: (runId?: string) => string | null;
  stop: (runId?: string) => string | null;
  continueRun: (runId?: string, message?: string) => string | null;
  sendUserMessage: (text: string, roleId?: EvolutionRoleId, runId?: string) => string | null;
  updateRoleSkill: (roleId: EvolutionRoleId, markdown: string, runId?: string) => string | null;
  approveRoleSkillCandidate: (roleId: EvolutionRoleId, candidateArtifactId: string, approvalMessage?: string, runId?: string, approverId?: string) => string | null;
  requestStatus: (runId?: string) => string | null;
  clearError: () => void;
}

function makeRequestId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ? `${prefix}-${random}` : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function issueText(raw: Record<string, unknown>): string {
  if (typeof raw.error === 'string' && raw.error.trim()) return raw.error.trim();
  const issues = Array.isArray(raw.issues) ? raw.issues : [];
  const first = issues.find((item): item is { code?: unknown; message?: unknown } => !!item && typeof item === 'object');
  if (typeof first?.message === 'string' && first.message.trim()) return first.message.trim();
  if (typeof first?.code === 'string' && first.code.trim()) return first.code.trim();
  return 'Evolution request failed.';
}

function extractProjections(msg: Record<string, unknown>): EvolutionProjection[] {
  const raw = msg as Record<string, unknown>;
  if (
    raw.type !== EVOLUTION_PIPELINE_MSG.PROJECTION
    && raw.type !== EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION
    && raw.type !== EVOLUTION_PIPELINE_MSG.SCAN_INBOX_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.CHECK_STAGING_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.LAUNCH_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.STOP_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.CONTINUE_ACK
    && raw.type !== EVOLUTION_PIPELINE_MSG.TERMINAL
  ) {
    return [];
  }
  const one = isEvolutionProjection(raw.projection) ? [raw.projection] : [];
  const many = Array.isArray(raw.projections) ? raw.projections.filter(isEvolutionProjection) : [];
  return [...one, ...many];
}

function isEvolutionInboxWatcherStatus(value: unknown): value is EvolutionInboxWatcherStatus {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === 'string'
    && typeof record.sessionName === 'string'
    && typeof record.projectRoot === 'string'
    && typeof record.inboxRelativePath === 'string'
    && typeof record.inboxAbsolutePath === 'string'
    && typeof record.intervalMs === 'number'
    && typeof record.stableMs === 'number'
    && typeof record.active === 'boolean'
    && typeof record.startedAt === 'number';
}

function isEvolutionReferenceBriefImportResult(value: unknown): value is EvolutionReferenceBriefImportResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.requestId === 'string'
    && typeof record.sourceRelativePath === 'string'
    && typeof record.taskRelativeDir === 'string'
    && typeof record.referencesRelativeDir === 'string'
    && typeof record.imageCount === 'number'
    && Array.isArray(record.copiedImages)
    && typeof record.createdAt === 'number';
}

function extractWatchers(msg: Record<string, unknown>): EvolutionInboxWatcherStatus[] | null {
  if (msg.type !== EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION && msg.type !== EVOLUTION_PIPELINE_MSG.SCAN_INBOX_ACK) return null;
  if (!Array.isArray(msg.watchers)) return [];
  return msg.watchers.filter(isEvolutionInboxWatcherStatus);
}

function projectionMatchesSession(projection: EvolutionProjection, sessionName: string | null | undefined): boolean {
  if (!sessionName) return true;
  return projection.sessionName === sessionName;
}

function watcherMatchesSession(watcher: EvolutionInboxWatcherStatus, sessionName: string | null | undefined): boolean {
  if (!sessionName) return true;
  return watcher.sessionName === sessionName;
}

export function useEvolutionPipeline({ ws, serverId, sessionName, projectRoot }: Options): State {
  const [projection, setProjection] = useState<EvolutionProjection | null>(null);
  const [watchers, setWatchers] = useState<EvolutionInboxWatcherStatus[]>([]);
  const [launchPending, setLaunchPending] = useState(false);
  const [scanPending, setScanPending] = useState(false);
  const [stagingCheckPending, setStagingCheckPending] = useState(false);
  const [skillUpdatePending, setSkillUpdatePending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [continuePending, setContinuePending] = useState(false);
  const [referenceBriefPending, setReferenceBriefPending] = useState(false);
  const [lastReferenceBrief, setLastReferenceBrief] = useState<EvolutionReferenceBriefImportResult | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const latestProjectionRef = useRef<EvolutionProjection | null>(null);
  const projectionCacheRef = useRef<Map<string, EvolutionProjection>>(new Map());
  const launchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stagingCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skillUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const continueTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const referenceBriefTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeLaunchRequestIdRef = useRef<string | null>(null);
  const activeScanRequestIdRef = useRef<string | null>(null);
  const activeStagingCheckRequestIdRef = useRef<string | null>(null);
  const activeSkillUpdateRequestIdRef = useRef<string | null>(null);
  const activeStopRequestIdRef = useRef<string | null>(null);
  const activeContinueRequestIdRef = useRef<string | null>(null);
  const activeReferenceBriefRequestIdRef = useRef<string | null>(null);

  const clearLaunchTimeout = useCallback(() => {
    if (launchTimeoutRef.current) clearTimeout(launchTimeoutRef.current);
    launchTimeoutRef.current = null;
    activeLaunchRequestIdRef.current = null;
  }, []);

  const clearStopTimeout = useCallback(() => {
    if (stopTimeoutRef.current) clearTimeout(stopTimeoutRef.current);
    stopTimeoutRef.current = null;
    activeStopRequestIdRef.current = null;
  }, []);

  const clearScanTimeout = useCallback(() => {
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = null;
    activeScanRequestIdRef.current = null;
  }, []);

  const clearStagingCheckTimeout = useCallback(() => {
    if (stagingCheckTimeoutRef.current) clearTimeout(stagingCheckTimeoutRef.current);
    stagingCheckTimeoutRef.current = null;
    activeStagingCheckRequestIdRef.current = null;
  }, []);

  const clearSkillUpdateTimeout = useCallback(() => {
    if (skillUpdateTimeoutRef.current) clearTimeout(skillUpdateTimeoutRef.current);
    skillUpdateTimeoutRef.current = null;
    activeSkillUpdateRequestIdRef.current = null;
  }, []);

  const clearContinueTimeout = useCallback(() => {
    if (continueTimeoutRef.current) clearTimeout(continueTimeoutRef.current);
    continueTimeoutRef.current = null;
    activeContinueRequestIdRef.current = null;
  }, []);

  const clearReferenceBriefTimeout = useCallback(() => {
    if (referenceBriefTimeoutRef.current) clearTimeout(referenceBriefTimeoutRef.current);
    referenceBriefTimeoutRef.current = null;
    activeReferenceBriefRequestIdRef.current = null;
  }, []);

  const applyProjection = useCallback((next: EvolutionProjection) => {
    if (!projectionMatchesSession(next, sessionName)) return;
    const current = latestProjectionRef.current;
    if (current && current.runId === next.runId && next.updatedAt < current.updatedAt) return;
    latestProjectionRef.current = next;
    projectionCacheRef.current.set(next.sessionName, next);
    setProjection(next);
    clearLaunchTimeout();
    setLaunchPending(false);
    clearScanTimeout();
    setScanPending(false);
    clearStagingCheckTimeout();
    setStagingCheckPending(false);
    clearSkillUpdateTimeout();
    setSkillUpdatePending(false);
    clearStopTimeout();
    setStopPending(false);
    clearContinueTimeout();
    setContinuePending(false);
  }, [clearContinueTimeout, clearLaunchTimeout, clearScanTimeout, clearSkillUpdateTimeout, clearStagingCheckTimeout, clearStopTimeout, sessionName]);

  const requestStatus = useCallback((runId?: string) => {
    if (!ws || !sessionName) return null;
    const requestId = makeRequestId('evolution-status');
    const payload: EvolutionStatusPayload = {
      type: EVOLUTION_PIPELINE_MSG.STATUS_REQUEST,
      requestId,
      serverId,
      sessionName,
      ...(projectRoot ? { projectRoot } : {}),
      ...(runId ? { runId } : {}),
    };
    ws.send(payload);
    return requestId;
  }, [projectRoot, serverId, sessionName, ws]);

  const scanInbox = useCallback(() => {
    if (!ws || !sessionName) return null;
    const requestId = makeRequestId('evolution-scan-inbox');
    const payload: EvolutionScanInboxPayload = {
      type: EVOLUTION_PIPELINE_MSG.SCAN_INBOX,
      requestId,
      serverId,
      sessionName,
      ...(projectRoot ? { projectRoot } : {}),
    };
    clearScanTimeout();
    activeScanRequestIdRef.current = requestId;
    setScanPending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearScanTimeout();
      setScanPending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    scanTimeoutRef.current = setTimeout(() => {
      if (activeScanRequestIdRef.current !== requestId) return;
      clearScanTimeout();
      setScanPending(false);
      setLastError('Evolution inbox scan timed out.');
    }, EVOLUTION_SCAN_TIMEOUT_MS);
    return requestId;
  }, [clearScanTimeout, projectRoot, serverId, sessionName, ws]);

  const createReferenceBrief = useCallback(({ attachments, note, taskName, projectName }: CreateReferenceBriefOptions) => {
    const cleanAttachments = attachments.filter((attachment) => attachment.attachmentId.trim());
    if (!ws || !sessionName || !projectRoot) {
      setLastError('A project session is required before importing reference images.');
      return null;
    }
    if (cleanAttachments.length === 0) {
      setLastError('At least one reference image is required.');
      return null;
    }
    const requestId = makeRequestId('evolution-import-references');
    const payload: EvolutionImportReferencesPayload = {
      type: EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES,
      requestId,
      serverId,
      sessionName,
      projectRoot,
      ...(projectName ? { projectName } : {}),
      ...(taskName?.trim() ? { taskName: taskName.trim() } : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
      attachments: cleanAttachments,
    };
    clearReferenceBriefTimeout();
    activeReferenceBriefRequestIdRef.current = requestId;
    setReferenceBriefPending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearReferenceBriefTimeout();
      setReferenceBriefPending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    referenceBriefTimeoutRef.current = setTimeout(() => {
      if (activeReferenceBriefRequestIdRef.current !== requestId) return;
      clearReferenceBriefTimeout();
      setReferenceBriefPending(false);
      setLastError('Reference image brief generation timed out.');
    }, EVOLUTION_REFERENCE_IMPORT_TIMEOUT_MS);
    return requestId;
  }, [clearReferenceBriefTimeout, projectRoot, serverId, sessionName, ws]);

  const checkStaging = useCallback((runId = projection?.runId) => {
    if (!ws || !sessionName || !runId) return null;
    const requestId = makeRequestId('evolution-check-staging');
    const payload: EvolutionCheckStagingPayload = {
      type: EVOLUTION_PIPELINE_MSG.CHECK_STAGING,
      requestId,
      serverId,
      sessionName,
      runId,
    };
    clearStagingCheckTimeout();
    activeStagingCheckRequestIdRef.current = requestId;
    setStagingCheckPending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearStagingCheckTimeout();
      setStagingCheckPending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    stagingCheckTimeoutRef.current = setTimeout(() => {
      if (activeStagingCheckRequestIdRef.current !== requestId) return;
      clearStagingCheckTimeout();
      setStagingCheckPending(false);
      setLastError('Evolution staging config check timed out.');
    }, EVOLUTION_STAGING_CHECK_TIMEOUT_MS);
    return requestId;
  }, [clearStagingCheckTimeout, projection?.runId, serverId, sessionName, ws]);

  const launch = useCallback(({
    sourceRelativePath,
    projectName,
    locale,
    autoStart = true,
    autoStartImplementation = false,
    autoDeliverPresetId = 'standard',
    autoCommitPush = false,
    roundtableGateMode = 'planning',
    designTargetSurface = 'auto',
  }: LaunchOptions) => {
    const trimmedSource = sourceRelativePath.trim();
    if (!ws || !sessionName || !trimmedSource) {
      setLastError('Requirement inbox path is required.');
      return null;
    }
    const requestId = makeRequestId('evolution-launch');
    const payload: EvolutionLaunchPayload = {
      type: EVOLUTION_PIPELINE_MSG.LAUNCH,
      requestId,
      serverId,
      sessionName,
      ...(projectRoot ? { projectRoot } : {}),
      ...(projectName ? { projectName } : {}),
      sourceRelativePath: trimmedSource,
      ...(locale ? { locale } : {}),
      requestedBy: 'user',
      autoStart,
      autoStartImplementation,
      autoDeliverPresetId,
      autoCommitPush,
      roundtableGateMode,
      designTargetSurface,
    };
    clearLaunchTimeout();
    activeLaunchRequestIdRef.current = requestId;
    setLaunchPending(true);
    setLastError(null);
    launchTimeoutRef.current = setTimeout(() => {
      if (activeLaunchRequestIdRef.current !== requestId) return;
      clearLaunchTimeout();
      setLaunchPending(false);
      setLastError('Evolution launch timed out.');
    }, EVOLUTION_LAUNCH_TIMEOUT_MS);
    try {
      ws.send(payload);
    } catch (error) {
      clearLaunchTimeout();
      setLaunchPending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    return requestId;
  }, [clearLaunchTimeout, projectRoot, serverId, sessionName, ws]);

  const launchDemo = useCallback(({
    projectName,
    locale,
    autoStart = true,
    autoStartImplementation = true,
    autoDeliverPresetId = 'standard',
    autoCommitPush = false,
    roundtableGateMode = 'planning',
    designTargetSurface = 'auto',
  }: LaunchDemoOptions = {}) => {
    if (!ws || !sessionName) {
      setLastError('An active session is required to start the Evolution demo.');
      return null;
    }
    const requestId = makeRequestId('evolution-demo');
    const payload: EvolutionLaunchDemoPayload = {
      type: EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO,
      requestId,
      serverId,
      sessionName,
      ...(projectRoot ? { projectRoot } : {}),
      ...(projectName ? { projectName } : {}),
      ...(locale ? { locale } : {}),
      autoStart,
      autoStartImplementation,
      autoDeliverPresetId,
      autoCommitPush,
      roundtableGateMode,
      designTargetSurface,
    };
    clearLaunchTimeout();
    activeLaunchRequestIdRef.current = requestId;
    setLaunchPending(true);
    setLastError(null);
    launchTimeoutRef.current = setTimeout(() => {
      if (activeLaunchRequestIdRef.current !== requestId) return;
      clearLaunchTimeout();
      setLaunchPending(false);
      setLastError('Evolution demo launch timed out.');
    }, EVOLUTION_LAUNCH_TIMEOUT_MS);
    try {
      ws.send(payload);
    } catch (error) {
      clearLaunchTimeout();
      setLaunchPending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    return requestId;
  }, [clearLaunchTimeout, projectRoot, serverId, sessionName, ws]);

  const stop = useCallback((runId = projection?.runId) => {
    if (!ws || !sessionName || !runId || isEvolutionTerminalProjection(projection)) return null;
    const requestId = makeRequestId('evolution-stop');
    const payload: EvolutionStopPayload = {
      type: EVOLUTION_PIPELINE_MSG.STOP,
      requestId,
      serverId,
      sessionName,
      runId,
      reason: 'Paused from Evolution War Room.',
    };
    clearStopTimeout();
    activeStopRequestIdRef.current = requestId;
    setStopPending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearStopTimeout();
      setStopPending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    stopTimeoutRef.current = setTimeout(() => {
      if (activeStopRequestIdRef.current !== requestId) return;
      clearStopTimeout();
      setStopPending(false);
      setLastError('Evolution pause timed out.');
    }, EVOLUTION_STOP_TIMEOUT_MS);
    return requestId;
  }, [clearStopTimeout, projection, serverId, sessionName, ws]);

  const continueRun = useCallback((runId = projection?.runId, message?: string) => {
    if (!ws || !sessionName || !runId || isEvolutionTerminalProjection(projection)) return null;
    const requestId = makeRequestId('evolution-continue');
    const payload: EvolutionContinuePayload = {
      type: EVOLUTION_PIPELINE_MSG.CONTINUE,
      requestId,
      serverId,
      sessionName,
      runId,
      ...(message?.trim() ? { message: message.trim() } : {}),
    };
    clearContinueTimeout();
    activeContinueRequestIdRef.current = requestId;
    setContinuePending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearContinueTimeout();
      setContinuePending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    continueTimeoutRef.current = setTimeout(() => {
      if (activeContinueRequestIdRef.current !== requestId) return;
      clearContinueTimeout();
      setContinuePending(false);
      setLastError('Evolution continue timed out.');
    }, EVOLUTION_CONTINUE_TIMEOUT_MS);
    return requestId;
  }, [clearContinueTimeout, projection, serverId, sessionName, ws]);

  const sendUserMessage = useCallback((text: string, roleId?: EvolutionRoleId, runId = projection?.runId) => {
    const trimmed = text.trim();
    if (!ws || !sessionName || !runId || !trimmed) return null;
    const requestId = makeRequestId('evolution-message');
    const payload: EvolutionUserMessagePayload = {
      type: EVOLUTION_PIPELINE_MSG.USER_MESSAGE,
      requestId,
      serverId,
      sessionName,
      runId,
      ...(isEvolutionRoleId(roleId) ? { roleId } : {}),
      text: trimmed,
    };
    try {
      ws.send(payload);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    return requestId;
  }, [projection?.runId, serverId, sessionName, ws]);

  const updateRoleSkill = useCallback((roleId: EvolutionRoleId, markdown: string, runId = projection?.runId) => {
    const trimmed = markdown.trim();
    if (!ws || !sessionName || !runId || !isEvolutionRoleId(roleId) || !trimmed) return null;
    const requestId = makeRequestId('evolution-update-skill');
    const payload: EvolutionUpdateRoleSkillPayload = {
      type: EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL,
      requestId,
      serverId,
      sessionName,
      runId,
      roleId,
      markdown,
    };
    clearSkillUpdateTimeout();
    activeSkillUpdateRequestIdRef.current = requestId;
    setSkillUpdatePending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearSkillUpdateTimeout();
      setSkillUpdatePending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    skillUpdateTimeoutRef.current = setTimeout(() => {
      if (activeSkillUpdateRequestIdRef.current !== requestId) return;
      clearSkillUpdateTimeout();
      setSkillUpdatePending(false);
      setLastError('Evolution role skill update timed out.');
    }, EVOLUTION_SKILL_UPDATE_TIMEOUT_MS);
    return requestId;
  }, [clearSkillUpdateTimeout, projection?.runId, serverId, sessionName, ws]);

  const approveRoleSkillCandidate = useCallback((roleId: EvolutionRoleId, candidateArtifactId: string, approvalMessage?: string, runId = projection?.runId, approverId?: string) => {
    if (!ws || !sessionName || !runId || !isEvolutionRoleId(roleId) || !candidateArtifactId.trim()) return null;
    const requestId = makeRequestId('evolution-approve-skill');
    const payload: EvolutionApproveRoleSkillCandidatePayload = {
      type: EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE,
      requestId,
      serverId,
      sessionName,
      runId,
      roleId,
      candidateArtifactId,
      ...(approvalMessage && approvalMessage.trim() ? { approvalMessage: approvalMessage.trim() } : {}),
      ...(approverId && approverId.trim() ? { approverId: approverId.trim() } : {}),
    };
    clearSkillUpdateTimeout();
    activeSkillUpdateRequestIdRef.current = requestId;
    setSkillUpdatePending(true);
    setLastError(null);
    try {
      ws.send(payload);
    } catch (error) {
      clearSkillUpdateTimeout();
      setSkillUpdatePending(false);
      setLastError(error instanceof Error ? error.message : String(error));
      return null;
    }
    skillUpdateTimeoutRef.current = setTimeout(() => {
      if (activeSkillUpdateRequestIdRef.current !== requestId) return;
      clearSkillUpdateTimeout();
      setSkillUpdatePending(false);
      setLastError('Evolution role skill approval timed out.');
    }, EVOLUTION_SKILL_UPDATE_TIMEOUT_MS);
    return requestId;
  }, [clearSkillUpdateTimeout, projection?.runId, serverId, sessionName, ws]);

  useEffect(() => {
    if (!ws) return;
    return ws.onMessage((msg) => {
      const raw = msg as Record<string, unknown>;
      const nextWatchers = extractWatchers(raw);
      if (nextWatchers) {
        setWatchers(nextWatchers.filter((watcher) => watcherMatchesSession(watcher, sessionName)));
        if (raw.type === EVOLUTION_PIPELINE_MSG.SCAN_INBOX_ACK) {
          clearScanTimeout();
          setScanPending(false);
        }
      }
      const projections = extractProjections(raw);
      if (projections.length > 0) {
        for (const next of projections) applyProjection(next);
        return;
      }
      if (raw.type === EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES_ACK) {
        if (typeof raw.requestId !== 'string' || activeReferenceBriefRequestIdRef.current !== raw.requestId) return;
        clearReferenceBriefTimeout();
        setReferenceBriefPending(false);
        if (raw.ok === true && isEvolutionReferenceBriefImportResult(raw.result)) {
          setLastReferenceBrief(raw.result);
          setLastError(null);
        } else {
          setLastError(issueText(raw));
        }
        return;
      }
      if (raw.type === EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR) {
        clearLaunchTimeout();
        clearScanTimeout();
        clearStagingCheckTimeout();
        clearSkillUpdateTimeout();
        clearReferenceBriefTimeout();
        setLaunchPending(false);
        setScanPending(false);
        setStagingCheckPending(false);
        setSkillUpdatePending(false);
        setReferenceBriefPending(false);
        setLastError(issueText(raw));
        return;
      }
      if (raw.type === MSG_DAEMON_OFFLINE || raw.type === DAEMON_MSG.DISCONNECTED) {
        clearStopTimeout();
        clearContinueTimeout();
        clearScanTimeout();
        clearStagingCheckTimeout();
        clearSkillUpdateTimeout();
        clearReferenceBriefTimeout();
        setStopPending(false);
        setContinuePending(false);
        setScanPending(false);
        setStagingCheckPending(false);
        setSkillUpdatePending(false);
        setReferenceBriefPending(false);
      }
    });
  }, [applyProjection, clearContinueTimeout, clearLaunchTimeout, clearReferenceBriefTimeout, clearScanTimeout, clearSkillUpdateTimeout, clearStagingCheckTimeout, clearStopTimeout, sessionName, ws]);

  useEffect(() => {
    const cached = sessionName ? projectionCacheRef.current.get(sessionName) ?? null : null;
    latestProjectionRef.current = cached;
    setProjection(cached);
    setWatchers([]);
    setLastError(null);
    setLaunchPending(false);
    clearReferenceBriefTimeout();
    setReferenceBriefPending(false);
    clearSkillUpdateTimeout();
    setScanPending(false);
    clearStagingCheckTimeout();
    setStagingCheckPending(false);
    setSkillUpdatePending(false);
    setStopPending(false);
    setContinuePending(false);
    requestStatus();
  }, [clearReferenceBriefTimeout, clearSkillUpdateTimeout, clearStagingCheckTimeout, requestStatus, sessionName]);

  useEffect(() => () => {
    clearLaunchTimeout();
    clearScanTimeout();
    clearStagingCheckTimeout();
    clearSkillUpdateTimeout();
    clearStopTimeout();
    clearContinueTimeout();
    clearReferenceBriefTimeout();
  }, [clearContinueTimeout, clearLaunchTimeout, clearReferenceBriefTimeout, clearScanTimeout, clearSkillUpdateTimeout, clearStagingCheckTimeout, clearStopTimeout]);

  return useMemo(() => ({
    projection,
    watchers,
    launchPending,
    scanPending,
    stagingCheckPending,
    skillUpdatePending,
    stopPending,
    continuePending,
    referenceBriefPending,
    lastReferenceBrief,
    lastError,
    launch,
    launchDemo,
    createReferenceBrief,
    scanInbox,
    checkStaging,
    stop,
    continueRun,
    sendUserMessage,
    updateRoleSkill,
    approveRoleSkillCandidate,
    requestStatus,
    clearError: () => setLastError(null),
  }), [approveRoleSkillCandidate, checkStaging, continuePending, continueRun, createReferenceBrief, lastError, lastReferenceBrief, launch, launchDemo, launchPending, projection, referenceBriefPending, requestStatus, scanInbox, scanPending, sendUserMessage, skillUpdatePending, stagingCheckPending, stop, stopPending, updateRoleSkill, watchers]);
}

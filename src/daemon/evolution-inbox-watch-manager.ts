import type { EvolutionInboxWatcherStatus, EvolutionValidationIssue } from '../../shared/evolution-pipeline-types.js';
import { EVOLUTION_PIPELINE_MSG, EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import { EvolutionInboxPoller, type EvolutionInboxCandidate } from './evolution-inbox-watcher.js';
import {
  launchEvolutionRunFromInboxCandidate,
  launchEvolutionRunFromInboxCandidateGroup,
  resumePendingEvolutionAutoDeliveries,
  runEvolutionAutopilot,
  type EvolutionServerLink,
} from './evolution-orchestrator.js';

const EVOLUTION_INBOX_WATCH_INTERVAL_MS = 15_000;
const EVOLUTION_INBOX_WATCH_STABLE_MS = 2_000;

export interface EvolutionWatchSession {
  name: string;
  projectName?: string;
  projectDir?: string;
  state?: string;
}

interface WatchEntry {
  key: string;
  sessionName: string;
  projectRoot: string;
  projectName?: string;
  intervalMs: number;
  stableMs: number;
  startedAt: number;
  poller: EvolutionInboxPoller;
}

const watchers = new Map<string, WatchEntry>();
let currentServerLink: EvolutionServerLink | null = null;

function watchKey(sessionName: string, projectRoot: string): string {
  return `${sessionName}\0${projectRoot}`;
}

function isWatchableSession(session: EvolutionWatchSession): boolean {
  if (!session.name || session.name.startsWith('deck_sub_')) return false;
  if (!session.projectDir) return false;
  return session.state !== 'stopped';
}

function sendIssues(serverLink: EvolutionServerLink | null, issues: EvolutionValidationIssue[], candidate: EvolutionInboxCandidate, sessionName: string): void {
  if (!serverLink) return;
  try {
    serverLink.send({
      type: EVOLUTION_PIPELINE_MSG.LAUNCH_ERROR,
      issues,
      sessionName,
      sourceRelativePath: candidate.sourceRelativePath,
    });
  } catch { /* connection may be closing */ }
}

function sendProjection(serverLink: EvolutionServerLink | null, projection: unknown): void {
  if (!serverLink) return;
  try { serverLink.send({ type: EVOLUTION_PIPELINE_MSG.PROJECTION, projection }); } catch { /* connection may be closing */ }
}

function createWatchEntry(session: EvolutionWatchSession): WatchEntry | null {
  if (!session.projectDir) return null;
  const key = watchKey(session.name, session.projectDir);
  const intervalMs = EVOLUTION_INBOX_WATCH_INTERVAL_MS;
  const stableMs = EVOLUTION_INBOX_WATCH_STABLE_MS;
  const poller = new EvolutionInboxPoller({
    projectRoot: session.projectDir,
    intervalMs,
    stableMs,
    async onCandidate(candidate) {
      const result = await launchEvolutionRunFromInboxCandidate({
        projectRoot: session.projectDir!,
        sessionName: session.name,
        ...(session.projectName ? { projectName: session.projectName } : {}),
        candidate,
      });
      if (result.ok) {
        sendProjection(currentServerLink, result.value);
        void runEvolutionAutopilot(result.value.runId, currentServerLink);
      } else {
        sendIssues(currentServerLink, result.issues, candidate, session.name);
      }
    },
    async onCandidateGroup(group) {
      const result = await launchEvolutionRunFromInboxCandidateGroup({
        projectRoot: session.projectDir!,
        sessionName: session.name,
        ...(session.projectName ? { projectName: session.projectName } : {}),
        group,
      });
      if (result.ok) {
        sendProjection(currentServerLink, result.value);
        void runEvolutionAutopilot(result.value.runId, currentServerLink);
      } else {
        const primary = group.files[0];
        sendIssues(currentServerLink, result.issues, primary ? {
          sourceRelativePath: primary.relativePath,
          sizeBytes: primary.sizeBytes,
          mtimeMs: primary.mtimeMs,
        } : { sourceRelativePath: group.groupRelativeDir, sizeBytes: 0, mtimeMs: 0 }, session.name);
      }
    },
  });
  return {
    key,
    sessionName: session.name,
    projectRoot: session.projectDir,
    ...(session.projectName ? { projectName: session.projectName } : {}),
    intervalMs,
    stableMs,
    startedAt: Date.now(),
    poller,
  };
}

function watchEntryStatus(entry: WatchEntry): EvolutionInboxWatcherStatus {
  return {
    key: entry.key,
    sessionName: entry.sessionName,
    projectRoot: entry.projectRoot,
    ...(entry.projectName ? { projectName: entry.projectName } : {}),
    inboxRelativePath: EVOLUTION_REQUIREMENT_INBOX_DIR,
    inboxAbsolutePath: `${entry.projectRoot.replace(/\/+$/, '')}/${EVOLUTION_REQUIREMENT_INBOX_DIR}`,
    intervalMs: entry.intervalMs,
    stableMs: entry.stableMs,
    active: true,
    startedAt: entry.startedAt,
  };
}

export function syncEvolutionInboxWatchers(serverLink: EvolutionServerLink | null, sessions: readonly EvolutionWatchSession[]): void {
  currentServerLink = serverLink;
  if (serverLink) {
    void resumePendingEvolutionAutoDeliveries(serverLink).catch(() => { /* best-effort reconnect recovery */ });
  }
  const desired = new Set<string>();
  for (const session of sessions) {
    if (!isWatchableSession(session)) continue;
    const key = watchKey(session.name, session.projectDir!);
    desired.add(key);
    if (watchers.has(key)) continue;
    const entry = createWatchEntry(session);
    if (!entry) continue;
    watchers.set(key, entry);
    entry.poller.start();
  }

  for (const [key, entry] of watchers.entries()) {
    if (desired.has(key)) continue;
    entry.poller.stop();
    watchers.delete(key);
  }
}

export function stopAllEvolutionInboxWatchers(): void {
  for (const entry of watchers.values()) entry.poller.stop();
  watchers.clear();
  currentServerLink = null;
}

export function listEvolutionInboxWatchers(): EvolutionInboxWatcherStatus[] {
  return [...watchers.values()].map(watchEntryStatus);
}

export async function scanEvolutionInboxWatchers(options: {
  sessionName?: string;
  projectRoot?: string;
  serverLink?: EvolutionServerLink | null;
} = {}): Promise<{ scanned: number; candidates: number; watchers: EvolutionInboxWatcherStatus[] }> {
  if (options.serverLink !== undefined) currentServerLink = options.serverLink;
  const entries = [...watchers.values()].filter((entry) => (
    (!options.sessionName || entry.sessionName === options.sessionName)
    && (!options.projectRoot || entry.projectRoot === options.projectRoot)
  ));
  let candidates = 0;
  for (const entry of entries) {
    const fresh = await entry.poller.scanOnce();
    candidates += fresh.length;
  }
  return {
    scanned: entries.length,
    candidates,
    watchers: entries.map(watchEntryStatus),
  };
}

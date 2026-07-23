import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EvolutionInboxWatcherStatus, EvolutionValidationIssue } from '../../shared/evolution-pipeline-types.js';
import {
  EVOLUTION_PIPELINE_MSG,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  EVOLUTION_RUN_ROOT_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import { EvolutionInboxPoller, type EvolutionInboxCandidate } from './evolution-inbox-watcher.js';
import {
  launchEvolutionRunFromInboxCandidate,
  launchEvolutionRunFromInboxCandidateGroup,
  resumePendingEvolutionAutoDeliveries,
  runEvolutionAutopilot,
  type EvolutionServerLink,
} from './evolution-orchestrator.js';
import logger from '../util/logger.js';

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
  directoryPath: string;
  intervalMs: number;
  stableMs: number;
  startedAt: number;
  poller: EvolutionInboxPoller;
}

interface EvolutionInboxWatchConfig {
  version: 1;
  directories: Record<string, string>;
}

const watchers = new Map<string, WatchEntry>();
const configuredDirectories = new Map<string, string>();
const knownSessions = new Map<string, EvolutionWatchSession>();
const loadedProjectConfigs = new Set<string>();
const loadingProjectConfigs = new Map<string, Promise<void>>();
let currentServerLink: EvolutionServerLink | null = null;
let stateGeneration = 0;

const EVOLUTION_INBOX_WATCH_CONFIG_RELATIVE_PATH = `${EVOLUTION_RUN_ROOT_DIR}/inbox-watchers.json` as const;

function watchKey(sessionName: string, projectRoot: string): string {
  return `${sessionName}\0${projectRoot}`;
}

function defaultInboxDirectory(projectRoot: string): string {
  return join(projectRoot, EVOLUTION_REQUIREMENT_INBOX_DIR);
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

function safeImportedFileName(sourceAbsolutePath: string): string {
  const candidate = basename(sourceAbsolutePath).replace(/[\\/\0]/g, '_');
  return candidate && candidate !== '.' && candidate !== '..' ? candidate : 'requirement.md';
}

async function stageExternalCandidate(
  projectRoot: string,
  candidate: EvolutionInboxCandidate,
): Promise<EvolutionInboxCandidate> {
  if (!candidate.sourceAbsolutePath) return candidate;
  const sourceKey = createHash('sha256').update(candidate.sourceAbsolutePath).digest('hex').slice(0, 16);
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/imported/${sourceKey}/${safeImportedFileName(candidate.sourceAbsolutePath)}`;
  const targetPath = join(projectRoot, sourceRelativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(candidate.sourceAbsolutePath, targetPath);
  return {
    sourceRelativePath,
    sizeBytes: candidate.sizeBytes,
    mtimeMs: candidate.mtimeMs,
  };
}

function createWatchEntry(session: EvolutionWatchSession, directoryPath?: string): WatchEntry | null {
  if (!session.projectDir) return null;
  const projectRoot = resolve(session.projectDir);
  const key = watchKey(session.name, projectRoot);
  const selectedDirectory = resolve(directoryPath ?? defaultInboxDirectory(projectRoot));
  const usingDefaultDirectory = selectedDirectory === resolve(defaultInboxDirectory(projectRoot));
  const intervalMs = EVOLUTION_INBOX_WATCH_INTERVAL_MS;
  const stableMs = EVOLUTION_INBOX_WATCH_STABLE_MS;
  const poller = new EvolutionInboxPoller({
    projectRoot,
    ...(!usingDefaultDirectory ? { directoryPath: selectedDirectory } : {}),
    intervalMs,
    stableMs,
    async onCandidate(candidate) {
      const launchCandidate = await stageExternalCandidate(projectRoot, candidate);
      const result = await launchEvolutionRunFromInboxCandidate({
        projectRoot,
        sessionName: session.name,
        ...(session.projectName ? { projectName: session.projectName } : {}),
        candidate: launchCandidate,
      });
      if (result.ok) {
        sendProjection(currentServerLink, result.value);
        void runEvolutionAutopilot(result.value.runId, currentServerLink);
      } else {
        sendIssues(currentServerLink, result.issues, launchCandidate, session.name);
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
    projectRoot,
    ...(session.projectName ? { projectName: session.projectName } : {}),
    directoryPath: selectedDirectory,
    intervalMs,
    stableMs,
    startedAt: Date.now(),
    poller,
  };
}

function watchEntryStatus(entry: WatchEntry): EvolutionInboxWatcherStatus {
  const relativePath = relative(entry.projectRoot, entry.directoryPath).split('\\').join('/');
  return {
    key: entry.key,
    sessionName: entry.sessionName,
    projectRoot: entry.projectRoot,
    ...(entry.projectName ? { projectName: entry.projectName } : {}),
    inboxRelativePath: relativePath || '.',
    inboxAbsolutePath: entry.directoryPath,
    intervalMs: entry.intervalMs,
    stableMs: entry.stableMs,
    active: true,
    startedAt: entry.startedAt,
  };
}

function reconcileEvolutionInboxWatchers(sessions: readonly EvolutionWatchSession[]): void {
  const desired = new Set<string>();
  for (const session of sessions) {
    if (!isWatchableSession(session)) continue;
    const projectRoot = resolve(session.projectDir!);
    const normalizedSession = { ...session, projectDir: projectRoot };
    const key = watchKey(session.name, projectRoot);
    desired.add(key);
    knownSessions.set(key, normalizedSession);
    const directoryPath = configuredDirectories.get(key) ?? defaultInboxDirectory(projectRoot);
    const existing = watchers.get(key);
    if (existing?.directoryPath === resolve(directoryPath)) continue;
    if (existing) {
      existing.poller.stop();
      watchers.delete(key);
    }
    const entry = createWatchEntry(normalizedSession, directoryPath);
    if (!entry) continue;
    watchers.set(key, entry);
    entry.poller.start();
  }

  for (const [key, entry] of watchers.entries()) {
    if (desired.has(key)) continue;
    entry.poller.stop();
    watchers.delete(key);
    knownSessions.delete(key);
  }
}

async function readProjectWatchConfig(projectRoot: string): Promise<EvolutionInboxWatchConfig> {
  try {
    const raw = await readFile(join(projectRoot, EVOLUTION_INBOX_WATCH_CONFIG_RELATIVE_PATH), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EvolutionInboxWatchConfig>;
    if (parsed.version !== 1 || !parsed.directories || typeof parsed.directories !== 'object') {
      return { version: 1, directories: {} };
    }
    const directories: Record<string, string> = {};
    for (const [sessionName, directoryPath] of Object.entries(parsed.directories)) {
      if (!sessionName || typeof directoryPath !== 'string' || !isAbsolute(directoryPath)) continue;
      directories[sessionName] = resolve(directoryPath);
    }
    return { version: 1, directories };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, directories: {} };
    throw error;
  }
}

async function ensureProjectWatchConfigLoaded(projectRoot: string): Promise<void> {
  const normalizedRoot = resolve(projectRoot);
  if (loadedProjectConfigs.has(normalizedRoot)) return;
  const activeLoad = loadingProjectConfigs.get(normalizedRoot);
  if (activeLoad) return activeLoad;
  const generation = stateGeneration;
  const load = (async () => {
    const config = await readProjectWatchConfig(normalizedRoot);
    if (generation !== stateGeneration) return;
    for (const [sessionName, directoryPath] of Object.entries(config.directories)) {
      configuredDirectories.set(watchKey(sessionName, normalizedRoot), directoryPath);
    }
    loadedProjectConfigs.add(normalizedRoot);
    reconcileEvolutionInboxWatchers([...knownSessions.values()]);
  })().finally(() => {
    loadingProjectConfigs.delete(normalizedRoot);
  });
  loadingProjectConfigs.set(normalizedRoot, load);
  return load;
}

async function writeProjectWatchConfig(projectRoot: string): Promise<void> {
  const normalizedRoot = resolve(projectRoot);
  const directories: Record<string, string> = {};
  const keySuffix = `\0${normalizedRoot}`;
  for (const [key, directoryPath] of configuredDirectories.entries()) {
    if (!key.endsWith(keySuffix)) continue;
    directories[key.slice(0, -keySuffix.length)] = directoryPath;
  }
  const configPath = join(normalizedRoot, EVOLUTION_INBOX_WATCH_CONFIG_RELATIVE_PATH);
  await mkdir(dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify({ version: 1, directories }, null, 2)}\n`, 'utf8');
  await rename(tempPath, configPath);
}

export function syncEvolutionInboxWatchers(serverLink: EvolutionServerLink | null, sessions: readonly EvolutionWatchSession[]): void {
  currentServerLink = serverLink;
  if (serverLink) {
    void resumePendingEvolutionAutoDeliveries(serverLink).catch(() => { /* best-effort reconnect recovery */ });
  }
  knownSessions.clear();
  reconcileEvolutionInboxWatchers(sessions);
  const projectRoots = new Set(
    sessions
      .filter(isWatchableSession)
      .map((session) => resolve(session.projectDir!)),
  );
  for (const projectRoot of projectRoots) {
    void ensureProjectWatchConfigLoaded(projectRoot).catch(() => { /* default watcher remains active */ });
  }
}

export async function configureEvolutionInboxWatcherDirectory(options: {
  sessionName: string;
  projectRoot: string;
  directoryPath: string;
  projectName?: string;
  serverLink?: EvolutionServerLink | null;
}): Promise<{ watchers: EvolutionInboxWatcherStatus[] }> {
  if (!options.sessionName) throw new Error('evolution_inbox_session_required');
  const projectRoot = resolve(options.projectRoot);
  const rawDirectoryPath = options.directoryPath.trim();
  if (!rawDirectoryPath || !isAbsolute(rawDirectoryPath)) {
    throw new Error('evolution_inbox_directory_must_be_absolute');
  }
  const directoryPath = resolve(rawDirectoryPath);
  const directoryStat = await stat(directoryPath);
  if (!directoryStat.isDirectory()) throw new Error('evolution_inbox_path_not_directory');
  if (options.serverLink !== undefined) currentServerLink = options.serverLink;

  await ensureProjectWatchConfigLoaded(projectRoot);
  const key = watchKey(options.sessionName, projectRoot);
  configuredDirectories.set(key, directoryPath);
  knownSessions.set(key, {
    name: options.sessionName,
    ...(options.projectName ? { projectName: options.projectName } : {}),
    projectDir: projectRoot,
    state: 'running',
  });
  await writeProjectWatchConfig(projectRoot);
  reconcileEvolutionInboxWatchers([...knownSessions.values()]);
  logger.info({
    sessionName: options.sessionName,
    projectRoot,
    directoryPath,
  }, 'Evolution inbox watcher directory configured');
  return {
    watchers: listEvolutionInboxWatchers().filter((watcher) => (
      watcher.sessionName === options.sessionName && watcher.projectRoot === projectRoot
    )),
  };
}

export function stopAllEvolutionInboxWatchers(): void {
  for (const entry of watchers.values()) entry.poller.stop();
  watchers.clear();
  configuredDirectories.clear();
  knownSessions.clear();
  loadedProjectConfigs.clear();
  loadingProjectConfigs.clear();
  stateGeneration += 1;
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

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import {
  EVOLUTION_REQUIREMENT_FILE_MAX_BYTES,
  EVOLUTION_REQUIREMENT_IMAGE_MAX_BYTES,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  EVOLUTION_RUN_ROOT_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import {
  isEvolutionRequirementImagePath,
  validateEvolutionRequirementSourcePath,
} from '../../shared/evolution-pipeline-validators.js';

export interface EvolutionInboxCandidate {
  sourceRelativePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export type EvolutionInboxCandidateFileKind = 'text' | 'image';

export interface EvolutionInboxCandidateFile {
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  kind: EvolutionInboxCandidateFileKind;
}

/**
 * One requirement = one inbox subdirectory. A multi-file drop (e.g. several
 * manuscript photos plus an optional brief) inside a single depth-1
 * subdirectory becomes ONE grouped candidate instead of N independent runs —
 * matching the deliberate War Room upload flow's own `reference-<stamp>-…/`
 * directory convention.
 */
export interface EvolutionInboxCandidateGroup {
  groupRelativeDir: string;
  files: EvolutionInboxCandidateFile[];
}

export interface EvolutionInboxGroupedScanResult {
  /** Files sitting directly at the inbox root — today's 1:1 behavior. */
  singles: EvolutionInboxCandidateFile[];
  /** Depth-1 subdirectory clusters, each stable as a whole group. */
  groups: EvolutionInboxCandidateGroup[];
}

interface EvolutionInboxLedger {
  version: 1;
  seen: string[];
}

export interface ScanEvolutionInboxOptions {
  nowMs?: number;
  stableMs?: number;
  maxDepth?: number;
}

function fileByteLimit(relativePath: string): number {
  return isEvolutionRequirementImagePath(relativePath)
    ? EVOLUTION_REQUIREMENT_IMAGE_MAX_BYTES
    : EVOLUTION_REQUIREMENT_FILE_MAX_BYTES;
}

async function walkRequirementFiles(
  projectRoot: string,
  dirRelativePath: string,
  depth: number,
  maxDepth: number,
  out: EvolutionInboxCandidateFile[],
  allowImages: boolean,
): Promise<void> {
  if (depth > maxDepth) return;
  const dirPath = join(projectRoot, dirRelativePath);
  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const childRelativePath = `${dirRelativePath}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkRequirementFiles(projectRoot, childRelativePath, depth + 1, maxDepth, out, allowImages);
      continue;
    }
    if (!entry.isFile()) continue;
    const validated = validateEvolutionRequirementSourcePath(childRelativePath, { allowImages });
    if (!validated.ok) continue;
    const fullPath = join(projectRoot, validated.value);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) continue;
    if (fileStat.size > fileByteLimit(validated.value)) continue;
    out.push({
      relativePath: validated.value,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      kind: isEvolutionRequirementImagePath(validated.value) ? 'image' : 'text',
    });
  }
}

/**
 * Legacy flat scan — text documents only, per-file stability, no grouping.
 * Preserved for existing callers/tests; the poller uses the grouped scan.
 */
export async function scanEvolutionRequirementInbox(
  projectRoot: string,
  options: ScanEvolutionInboxOptions = {},
): Promise<EvolutionInboxCandidate[]> {
  const nowMs = options.nowMs ?? Date.now();
  const stableMs = options.stableMs ?? 2_000;
  const maxDepth = options.maxDepth ?? 4;
  const files: EvolutionInboxCandidateFile[] = [];
  await walkRequirementFiles(projectRoot, EVOLUTION_REQUIREMENT_INBOX_DIR, 0, maxDepth, files, false);
  return files
    .filter((file) => nowMs - file.mtimeMs >= stableMs)
    .map((file) => ({ sourceRelativePath: file.relativePath, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs }))
    .sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath));
}

function depth1Segment(relativePath: string): string | null {
  const prefix = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const rest = relativePath.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? null : rest.slice(0, slash);
}

/**
 * Grouped scan: root-level files stay singletons (1:1, today's semantics);
 * files inside a depth-1 subdirectory cluster into one group keyed by that
 * subdirectory. Stability is evaluated per GROUP (max mtime across every file
 * in the subtree) so a still-copying sibling holds back the whole group, not
 * just itself.
 */
export async function scanEvolutionRequirementInboxGrouped(
  projectRoot: string,
  options: ScanEvolutionInboxOptions = {},
): Promise<EvolutionInboxGroupedScanResult> {
  const nowMs = options.nowMs ?? Date.now();
  const stableMs = options.stableMs ?? 2_000;
  const maxDepth = options.maxDepth ?? 4;
  const files: EvolutionInboxCandidateFile[] = [];
  await walkRequirementFiles(projectRoot, EVOLUTION_REQUIREMENT_INBOX_DIR, 0, maxDepth, files, true);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const singles: EvolutionInboxCandidateFile[] = [];
  const groupsBySegment = new Map<string, EvolutionInboxCandidateFile[]>();
  for (const file of files) {
    const segment = depth1Segment(file.relativePath);
    if (segment === null) {
      if (nowMs - file.mtimeMs >= stableMs) singles.push(file);
      continue;
    }
    const bucket = groupsBySegment.get(segment) ?? [];
    bucket.push(file);
    groupsBySegment.set(segment, bucket);
  }

  const groups: EvolutionInboxCandidateGroup[] = [];
  for (const [segment, groupFiles] of [...groupsBySegment.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const maxMtime = Math.max(...groupFiles.map((file) => file.mtimeMs));
    if (nowMs - maxMtime < stableMs) continue; // whole group still settling
    groups.push({
      groupRelativeDir: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${segment}`,
      files: groupFiles,
    });
  }
  return { singles, groups };
}

export interface EvolutionInboxPollerOptions extends ScanEvolutionInboxOptions {
  projectRoot: string;
  intervalMs?: number;
  /**
   * Persist processed file identities under `.imc/evolution/inbox-ledger.json`
   * so daemon restarts do not re-trigger old requirement files. Enabled by
   * default; tests may disable it for pure in-memory polling.
   */
  persistSeen?: boolean;
  onCandidate(candidate: EvolutionInboxCandidate): Promise<void> | void;
  /**
   * Grouped (multi-file / image) candidates. When omitted, the poller falls
   * back to legacy behavior: per-file `onCandidate` for text members and
   * images ignored — existing callers see no behavior change.
   */
  onCandidateGroup?(group: EvolutionInboxCandidateGroup): Promise<void> | void;
}

const EVOLUTION_INBOX_LEDGER_RELATIVE_PATH = `${EVOLUTION_RUN_ROOT_DIR}/inbox-ledger.json` as const;

function fileIdentity(relativePath: string, sizeBytes: number, mtimeMs: number): string {
  return `${relativePath}:${sizeBytes}:${mtimeMs}`;
}

function candidateIdentity(candidate: EvolutionInboxCandidate): string {
  return fileIdentity(candidate.sourceRelativePath, candidate.sizeBytes, candidate.mtimeMs);
}

async function readInboxLedger(projectRoot: string): Promise<EvolutionInboxLedger> {
  try {
    const raw = await readFile(join(projectRoot, EVOLUTION_INBOX_LEDGER_RELATIVE_PATH), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EvolutionInboxLedger>;
    if (parsed.version !== 1 || !Array.isArray(parsed.seen)) return { version: 1, seen: [] };
    return {
      version: 1,
      seen: parsed.seen.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { version: 1, seen: [] };
    throw err;
  }
}

async function writeInboxLedger(projectRoot: string, ledger: EvolutionInboxLedger): Promise<void> {
  const ledgerPath = join(projectRoot, EVOLUTION_INBOX_LEDGER_RELATIVE_PATH);
  await mkdir(join(projectRoot, EVOLUTION_RUN_ROOT_DIR), { recursive: true });
  const tmpPath = `${ledgerPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(tmpPath, ledgerPath);
}

/**
 * A3 — pre-seed the inbox ledger with identities for files another flow just
 * wrote into the watched tree (the deliberate War Room upload's brief.md and
 * copied reference images, or a watcher-synthesized brief). Without this, the
 * passive watcher would treat those files as brand-new requirement drops and
 * auto-launch a duplicate run for a task the user already started explicitly.
 * Paths are project-root-relative; each is stat'ed so the recorded identity
 * matches exactly what the watcher would compute (`path:size:mtime`).
 */
export async function recordEvolutionInboxSeenFiles(projectRoot: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;
  const identities: string[] = [];
  for (const relativePath of relativePaths) {
    try {
      const fileStat = await stat(join(projectRoot, relativePath));
      if (!fileStat.isFile()) continue;
      identities.push(fileIdentity(relativePath, fileStat.size, fileStat.mtimeMs));
    } catch { /* file missing — nothing to pre-seed */ }
  }
  if (identities.length === 0) return;
  const ledger = await readInboxLedger(projectRoot);
  const seen = new Set(ledger.seen);
  for (const identity of identities) seen.add(identity);
  await writeInboxLedger(projectRoot, { version: 1, seen: [...seen].sort() });
}

export class EvolutionInboxPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private running = false;

  constructor(private readonly options: EvolutionInboxPollerOptions) {}

  start(): void {
    if (this.timer) return;
    void this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, this.options.intervalMs ?? 10_000);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async scanOnce(): Promise<EvolutionInboxCandidate[]> {
    if (this.running) return [];
    this.running = true;
    try {
      // Merge (not load-once): other flows pre-seed the ledger while this
      // poller is live — e.g. the deliberate upload flow recording its own
      // brief/images so they are never treated as new passive drops.
      await this.mergePersistedSeen();
      const { singles, groups } = await scanEvolutionRequirementInboxGrouped(this.options.projectRoot, this.options);
      const fresh: EvolutionInboxCandidate[] = [];

      for (const file of singles) {
        if (file.kind === 'image') {
          // A root-level image is a group-of-one manuscript drop.
          if (!this.options.onCandidateGroup) continue; // legacy: images invisible
          const identity = fileIdentity(file.relativePath, file.sizeBytes, file.mtimeMs);
          if (this.seen.has(identity)) continue;
          this.seen.add(identity);
          await this.persistSeenIfEnabled();
          await this.options.onCandidateGroup({
            groupRelativeDir: EVOLUTION_REQUIREMENT_INBOX_DIR,
            files: [file],
          });
          continue;
        }
        const candidate: EvolutionInboxCandidate = {
          sourceRelativePath: file.relativePath,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
        };
        const identity = candidateIdentity(candidate);
        if (this.seen.has(identity)) continue;
        this.seen.add(identity);
        await this.persistSeenIfEnabled();
        fresh.push(candidate);
        await this.options.onCandidate(candidate);
      }

      for (const group of groups) {
        const unseenFiles = group.files.filter((file) => !this.seen.has(fileIdentity(file.relativePath, file.sizeBytes, file.mtimeMs)));
        if (unseenFiles.length === 0) continue;
        if (!this.options.onCandidateGroup) {
          // Legacy fallback: per-file dispatch for text members only —
          // exactly the pre-grouping behavior existing callers rely on.
          for (const file of unseenFiles) {
            if (file.kind !== 'text') continue;
            const candidate: EvolutionInboxCandidate = {
              sourceRelativePath: file.relativePath,
              sizeBytes: file.sizeBytes,
              mtimeMs: file.mtimeMs,
            };
            this.seen.add(candidateIdentity(candidate));
            await this.persistSeenIfEnabled();
            fresh.push(candidate);
            await this.options.onCandidate(candidate);
          }
          continue;
        }
        for (const file of group.files) {
          this.seen.add(fileIdentity(file.relativePath, file.sizeBytes, file.mtimeMs));
        }
        await this.persistSeenIfEnabled();
        await this.options.onCandidateGroup({ ...group, files: unseenFiles });
      }
      return fresh;
    } finally {
      this.running = false;
    }
  }

  resetSeen(): void {
    this.seen.clear();
  }

  private async mergePersistedSeen(): Promise<void> {
    if (this.options.persistSeen === false) return;
    const ledger = await readInboxLedger(this.options.projectRoot);
    for (const identity of ledger.seen) this.seen.add(identity);
  }

  private async persistSeenIfEnabled(): Promise<void> {
    if (this.options.persistSeen === false) return;
    await writeInboxLedger(this.options.projectRoot, {
      version: 1,
      seen: [...this.seen].sort(),
    });
  }
}

export function relativeInboxPath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).split('\\').join('/');
}

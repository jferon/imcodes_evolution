import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import {
  EVOLUTION_REQUIREMENT_FILE_MAX_BYTES,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  EVOLUTION_RUN_ROOT_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import {
  validateEvolutionRequirementSourcePath,
} from '../../shared/evolution-pipeline-validators.js';

export interface EvolutionInboxCandidate {
  sourceRelativePath: string;
  sizeBytes: number;
  mtimeMs: number;
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

async function walkRequirementInbox(
  projectRoot: string,
  dirRelativePath: string,
  depth: number,
  maxDepth: number,
  out: EvolutionInboxCandidate[],
  nowMs: number,
  stableMs: number,
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
      await walkRequirementInbox(projectRoot, childRelativePath, depth + 1, maxDepth, out, nowMs, stableMs);
      continue;
    }
    if (!entry.isFile()) continue;
    const validated = validateEvolutionRequirementSourcePath(childRelativePath);
    if (!validated.ok) continue;
    const fullPath = join(projectRoot, validated.value);
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) continue;
    if (fileStat.size > EVOLUTION_REQUIREMENT_FILE_MAX_BYTES) continue;
    if (nowMs - fileStat.mtimeMs < stableMs) continue;
    out.push({
      sourceRelativePath: validated.value,
      sizeBytes: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    });
  }
}

export async function scanEvolutionRequirementInbox(
  projectRoot: string,
  options: ScanEvolutionInboxOptions = {},
): Promise<EvolutionInboxCandidate[]> {
  const nowMs = options.nowMs ?? Date.now();
  const stableMs = options.stableMs ?? 2_000;
  const maxDepth = options.maxDepth ?? 4;
  const out: EvolutionInboxCandidate[] = [];
  await walkRequirementInbox(projectRoot, EVOLUTION_REQUIREMENT_INBOX_DIR, 0, maxDepth, out, nowMs, stableMs);
  return out.sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath));
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
}

const EVOLUTION_INBOX_LEDGER_RELATIVE_PATH = `${EVOLUTION_RUN_ROOT_DIR}/inbox-ledger.json` as const;

function candidateIdentity(candidate: EvolutionInboxCandidate): string {
  return `${candidate.sourceRelativePath}:${candidate.sizeBytes}:${candidate.mtimeMs}`;
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

export class EvolutionInboxPoller {
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private persistedSeenLoaded = false;
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
      await this.loadPersistedSeenOnce();
      const candidates = await scanEvolutionRequirementInbox(this.options.projectRoot, this.options);
      const fresh: EvolutionInboxCandidate[] = [];
      for (const candidate of candidates) {
        const identity = candidateIdentity(candidate);
        if (this.seen.has(identity)) continue;
        this.seen.add(identity);
        await this.persistSeenIfEnabled();
        fresh.push(candidate);
        await this.options.onCandidate(candidate);
      }
      return fresh;
    } finally {
      this.running = false;
    }
  }

  resetSeen(): void {
    this.seen.clear();
    this.persistedSeenLoaded = false;
  }

  private async loadPersistedSeenOnce(): Promise<void> {
    if (this.persistedSeenLoaded || this.options.persistSeen === false) return;
    const ledger = await readInboxLedger(this.options.projectRoot);
    for (const identity of ledger.seen) this.seen.add(identity);
    this.persistedSeenLoaded = true;
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

/**
 * Daemon-observed delivery verification runner (repair checklist #12).
 *
 * Executes ONLY commands pinned into the run at launch (see
 * `shared/evolution-verification.ts` for the trust model). Discipline matches
 * the screenshot/foundation runners: execFile, no shell, validated cwd,
 * timeout, bounded output, honest failure statuses — never a fabricated pass.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  EVOLUTION_GOVERNANCE_SOURCE_ABSENT,
  EVOLUTION_GOVERNANCE_SOURCE_PATHS,
  EVOLUTION_VERIFICATION_TIMEOUT_MAX_MS,
  EVOLUTION_VERIFICATION_TIMEOUT_MIN_MS,
  type EvolutionVerificationCommand,
  type EvolutionVerificationPolicy,
  type EvolutionVerificationResult,
} from '../../shared/evolution-verification.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_CHARS = 600;

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeCwd(projectRoot: string, cwd: string | undefined): string {
  const root = resolve(projectRoot);
  if (!cwd) return root;
  const resolved = resolve(root, cwd);
  const rel = relative(root, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`verification_cwd_outside_project:${cwd}`);
  return resolved;
}

/**
 * Digest every governance source file (sha256 of bytes, or 'absent'). Used at
 * launch to pin and at the delivery gate to detect mid-run mutation.
 */
export async function computeGovernanceSourceDigests(projectRoot: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const relativePath of EVOLUTION_GOVERNANCE_SOURCE_PATHS) {
    try {
      digests[relativePath] = sha256Hex(await readFile(join(projectRoot, relativePath)));
    } catch {
      digests[relativePath] = EVOLUTION_GOVERNANCE_SOURCE_ABSENT;
    }
  }
  return digests;
}

/** Paths whose pinned digest no longer matches the current file bytes. */
export function diffGovernanceSourceDigests(
  pinned: Record<string, string>,
  current: Record<string, string>,
): string[] {
  const mutated: string[] = [];
  for (const path of EVOLUTION_GOVERNANCE_SOURCE_PATHS) {
    if ((pinned[path] ?? EVOLUTION_GOVERNANCE_SOURCE_ABSENT) !== (current[path] ?? EVOLUTION_GOVERNANCE_SOURCE_ABSENT)) {
      mutated.push(path);
    }
  }
  return mutated;
}

/**
 * Digest of the workspace state verification results bind to. Git-based when
 * available (HEAD + status + diff); otherwise an honest sentinel — never a
 * fabricated stable value.
 */
export async function computeWorkspaceDigest(projectRoot: string): Promise<string> {
  const git = (args: string[]) => new Promise<string | null>((resolvePromise) => {
    execFile('git', args, { cwd: projectRoot, timeout: 30_000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
      resolvePromise(error ? null : String(stdout ?? ''));
    });
  });
  const head = await git(['rev-parse', 'HEAD']);
  if (head === null) return 'no_git_workspace';
  const status = await git(['status', '--porcelain']) ?? '';
  const diff = await git(['diff']) ?? '';
  return sha256Hex(`${head.trim()}\n${status}\n${sha256Hex(diff)}`);
}

async function runOneCommand(projectRoot: string, command: EvolutionVerificationCommand): Promise<EvolutionVerificationResult> {
  const startedAt = Date.now();
  let cwd: string;
  try {
    cwd = safeCwd(projectRoot, command.cwd);
  } catch (error) {
    return {
      id: command.id,
      command: command.command,
      exitCode: null,
      durationMs: 0,
      stdoutSha256: sha256Hex(''),
      stderrTail: error instanceof Error ? error.message : String(error),
      status: 'crashed',
      tier: command.tier,
    };
  }
  const timeoutMs = Math.min(
    EVOLUTION_VERIFICATION_TIMEOUT_MAX_MS,
    Math.max(EVOLUTION_VERIFICATION_TIMEOUT_MIN_MS, command.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  );
  return new Promise((resolvePromise) => {
    execFile(command.command, command.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string; signal?: NodeJS.Signals; killed?: boolean }) | null;
      const timedOut = err?.killed === true && err.signal === 'SIGTERM';
      const exitCode = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolvePromise({
        id: command.id,
        command: command.command,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdoutSha256: sha256Hex(String(stdout ?? '')),
        stderrTail: String(stderr ?? '').slice(-STDERR_TAIL_CHARS),
        status: timedOut ? 'timeout' : err ? (exitCode === null ? 'crashed' : 'failed') : 'passed',
        tier: command.tier,
      });
    });
  });
}

export interface PinnedVerificationRunOutcome {
  results: EvolutionVerificationResult[];
  allRequiredPassed: boolean;
  failedRequiredIds: string[];
}

/**
 * Run every pinned command sequentially (deterministic order, no interleaved
 * output). A crash/timeout of one command is recorded honestly and does not
 * reject the batch.
 */
export async function runPinnedVerificationCommands(
  projectRoot: string,
  policy: EvolutionVerificationPolicy,
): Promise<PinnedVerificationRunOutcome> {
  const results: EvolutionVerificationResult[] = [];
  for (const command of policy.commands) {
    results.push(await runOneCommand(projectRoot, command));
  }
  const failedRequiredIds = results
    .filter((result) => result.tier === 'required' && result.status !== 'passed')
    .map((result) => result.id);
  return { results, allRequiredPassed: failedRequiredIds.length === 0, failedRequiredIds };
}

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import {
  EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS,
  EVOLUTION_RUN_ROOT_DIR,
  type EvolutionArtifactKind,
} from '../../shared/evolution-pipeline-constants.js';
import type { EvolutionArtifactPreview, EvolutionArtifactRef } from '../../shared/evolution-pipeline-types.js';

export const EVOLUTION_DELIVERY_CONFIG_RELATIVE_PATH = '.imc/evolution/delivery.json' as const;

const DEFAULT_STAGING_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STAGING_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PRODUCTION_TOKEN_RE = /(^|[^a-z0-9])(prod|production)([^a-z0-9]|$)/i;
const BLOCKED_COMMAND_BASENAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'sudo']);

interface StagingDeliveryConfig {
  enabled: boolean;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface EvolutionStagingDeliveryResult {
  status: 'not_configured' | 'disabled' | 'passed' | 'failed';
  configPath: string;
  commandLine?: string;
  exitCode?: number;
  summary: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  artifact?: EvolutionArtifactRef;
  stdoutTail?: string;
  stderrTail?: string;
  timedOut?: boolean;
  error?: string;
}

export interface EvolutionStagingDeliveryConfigCheckResult {
  status: 'not_configured' | 'disabled' | 'ready' | 'failed';
  configPath: string;
  commandLine?: string;
  cwd?: string;
  timeoutMs?: number;
  summary: string;
  checkedAt: number;
  artifact?: EvolutionArtifactRef;
  error?: string;
}

interface ExecOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal?: NodeJS.Signals;
  errorMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes('\0') || value.startsWith('~') || value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function safeJoin(root: string, relativePath: string): string {
  if (!safeRelativePath(relativePath)) throw new Error('unsafe_relative_path');
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path_outside_project');
  return resolvedPath;
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(displayArg).join(' ');
}

function hasProductionToken(parts: string[]): boolean {
  return parts.some((part) => PRODUCTION_TOKEN_RE.test(part));
}

function normalizeTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_STAGING_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_STAGING_TIMEOUT_MS) {
    throw new Error(`staging.timeoutMs must be an integer between 1 and ${MAX_STAGING_TIMEOUT_MS}`);
  }
  return value;
}

function resolveCommand(projectRoot: string, command: string): string {
  if (!command || command.includes('\0') || command.length > 512) throw new Error('staging.command is invalid');
  const base = basename(command).toLowerCase();
  if (BLOCKED_COMMAND_BASENAMES.has(base)) {
    throw new Error(`staging.command must not invoke an interactive shell or privileged wrapper: ${base}`);
  }
  if (!isAbsolute(command) && command.includes('/')) return safeJoin(projectRoot, command.replace(/^\.\//, ''));
  return command;
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('staging.args must be an array of strings');
  if (value.length > 64) throw new Error('staging.args is too large');
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > 2048) {
      throw new Error(`staging.args[${index}] is invalid`);
    }
    return entry;
  });
}

function normalizeCwd(projectRoot: string, value: unknown): string {
  if (value === undefined) return resolve(projectRoot);
  if (typeof value !== 'string') throw new Error('staging.cwd must be a relative string');
  const normalized = value === '.' ? '' : value.replace(/^\.\//, '');
  return normalized === '' ? resolve(projectRoot) : safeJoin(projectRoot, normalized);
}

function parseStagingDeliveryConfig(projectRoot: string, raw: unknown): StagingDeliveryConfig {
  if (!isRecord(raw)) throw new Error('delivery config must be an object');
  const staging = raw.staging;
  if (!isRecord(staging)) throw new Error('delivery config must contain a staging object');
  if (staging.enabled !== true) {
    return {
      enabled: false,
      command: '',
      args: [],
      cwd: resolve(projectRoot),
      timeoutMs: DEFAULT_STAGING_TIMEOUT_MS,
    };
  }
  if (typeof staging.command !== 'string') throw new Error('staging.command is required');
  const args = normalizeArgs(staging.args);
  if (hasProductionToken([staging.command, ...args])) {
    throw new Error('staging delivery command must not target production; production stays behind the human release gate');
  }
  return {
    enabled: true,
    command: resolveCommand(projectRoot, staging.command),
    args,
    cwd: normalizeCwd(projectRoot, staging.cwd),
    timeoutMs: normalizeTimeoutMs(staging.timeoutMs),
  };
}

async function readConfig(projectRoot: string): Promise<{ raw: unknown; path: string } | null> {
  const path = safeJoin(projectRoot, EVOLUTION_DELIVERY_CONFIG_RELATIVE_PATH);
  try {
    const content = await readFile(path, 'utf8');
    return { raw: JSON.parse(content), path };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function runExecFile(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolveOutcome) => {
    execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: number | string; signal?: NodeJS.Signals; killed?: boolean }) | null;
      const numericCode = typeof err?.code === 'number' ? err.code : 0;
      resolveOutcome({
        exitCode: err ? numericCode || 1 : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: err?.killed === true && err?.signal === 'SIGTERM',
        ...(err?.signal ? { signal: err.signal } : {}),
        ...(err?.message ? { errorMessage: err.message } : {}),
      });
    });
  });
}

function tail(value: string, max = 12000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function markdownPreview(content: string): EvolutionArtifactPreview {
  const truncated = content.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS;
  return {
    previewType: 'markdown',
    content: truncated ? content.slice(0, EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) : content,
    language: 'markdown',
    ...(truncated ? { truncated: true } : {}),
  };
}

async function writeDeliveryLog(options: {
  projectRoot: string;
  runId: string;
  nowMs: number;
  commandLine: string;
  cwd: string;
  timeoutMs: number;
  outcome: ExecOutcome;
  durationMs: number;
}): Promise<EvolutionArtifactRef> {
  const runDeliveryDir = `${EVOLUTION_RUN_ROOT_DIR}/${options.runId}/delivery`;
  const absoluteDir = safeJoin(options.projectRoot, runDeliveryDir);
  await mkdir(absoluteDir, { recursive: true });
  const fileName = `staging-${new Date(options.nowMs).toISOString().replace(/[-:.]/g, '')}.log`;
  const relativePath = `${runDeliveryDir}/${fileName}`;
  const content = [
    '# IM.codes Evolution Staging Delivery Log',
    '',
    `command: ${options.commandLine}`,
    `cwd: ${options.cwd}`,
    `timeoutMs: ${options.timeoutMs}`,
    `exitCode: ${options.outcome.exitCode}`,
    `timedOut: ${options.outcome.timedOut ? 'true' : 'false'}`,
    options.outcome.signal ? `signal: ${options.outcome.signal}` : '',
    `durationMs: ${options.durationMs}`,
    '',
    '## stdout',
    '```',
    tail(options.outcome.stdout),
    '```',
    '',
    '## stderr',
    '```',
    tail(options.outcome.stderr || options.outcome.errorMessage || ''),
    '```',
    '',
  ].filter((line) => line !== '').join('\n');
  await writeFile(safeJoin(options.projectRoot, relativePath), content, 'utf8');
  const file = await stat(safeJoin(options.projectRoot, relativePath));
  const kind: EvolutionArtifactKind = 'staging_deploy_log';
  return {
    id: `${kind}:${relativePath}`,
    kind,
    path: relativePath,
    title: 'Staging delivery log',
    preview: markdownPreview(content),
    roleId: 'ops_release_manager',
    stage: options.outcome.exitCode === 0 && !options.outcome.timedOut ? 'deployed_staging' : 'needs_human',
    sha256: sha256(content),
    bytes: file.size,
    createdAt: options.nowMs,
  };
}

async function writeDeliveryConfigCheck(options: {
  projectRoot: string;
  runId: string;
  checkedAt: number;
  status: EvolutionStagingDeliveryConfigCheckResult['status'];
  configPath: string;
  summary: string;
  commandLine?: string;
  cwd?: string;
  timeoutMs?: number;
  error?: string;
}): Promise<EvolutionArtifactRef> {
  const runDeliveryDir = `${EVOLUTION_RUN_ROOT_DIR}/${options.runId}/delivery`;
  const absoluteDir = safeJoin(options.projectRoot, runDeliveryDir);
  await mkdir(absoluteDir, { recursive: true });
  const fileName = `staging-config-check-${new Date(options.checkedAt).toISOString().replace(/[-:.]/g, '')}.md`;
  const relativePath = `${runDeliveryDir}/${fileName}`;
  const content = [
    '# IM.codes Evolution Staging Config Check',
    '',
    `status: ${options.status}`,
    `configPath: ${options.configPath}`,
    `checkedAt: ${new Date(options.checkedAt).toISOString()}`,
    options.commandLine ? `command: ${options.commandLine}` : '',
    options.cwd ? `cwd: ${options.cwd}` : '',
    typeof options.timeoutMs === 'number' ? `timeoutMs: ${options.timeoutMs}` : '',
    '',
    '## Result',
    '',
    options.summary,
    '',
    options.error ? '## Error' : '',
    options.error ?? '',
    options.error ? '' : '',
    '## Safety Contract',
    '',
    '- This check does not execute the staging command.',
    '- The command must not route to production; production remains behind the War Room human release gate.',
    '- Shell wrappers and privileged wrappers are rejected; staging runs through `execFile` with `shell: false`.',
    '- Secrets should come from the deployment environment, never from committed config.',
    '',
    '## Next Steps',
    '',
    options.status === 'ready'
      ? '- Let OpenSpec Auto Deliver finish; staging will run automatically at `delivery_ready` if the run budget allows staging.'
      : options.status === 'not_configured'
        ? '- Copy the run artifact `delivery/delivery.example.json` to project root `.imc/evolution/delivery.json`, then edit it for staging only.'
        : options.status === 'disabled'
          ? '- Set `staging.enabled` to `true` only when you have a real staging command and rollback path.'
          : '- Fix `.imc/evolution/delivery.json`, then re-run the War Room staging check.',
    '',
  ].filter((line) => line !== '').join('\n');
  await writeFile(safeJoin(options.projectRoot, relativePath), content, 'utf8');
  const file = await stat(safeJoin(options.projectRoot, relativePath));
  const kind: EvolutionArtifactKind = 'staging_config_check';
  return {
    id: `${kind}:${relativePath}`,
    kind,
    path: relativePath,
    title: 'Staging config check',
    preview: markdownPreview(content),
    roleId: 'ops_release_manager',
    stage: options.status === 'failed' ? 'needs_human' : 'delivery_ready',
    sha256: sha256(content),
    bytes: file.size,
    createdAt: options.checkedAt,
  };
}

export async function checkEvolutionStagingDeliveryConfig(options: {
  projectRoot: string;
  runId: string;
  nowMs?: number;
}): Promise<EvolutionStagingDeliveryConfigCheckResult> {
  const checkedAt = options.nowMs ?? Date.now();
  const configPath = EVOLUTION_DELIVERY_CONFIG_RELATIVE_PATH;
  const finalize = async (
    result: Omit<EvolutionStagingDeliveryConfigCheckResult, 'configPath' | 'checkedAt' | 'artifact'>,
  ): Promise<EvolutionStagingDeliveryConfigCheckResult> => {
    const artifact = await writeDeliveryConfigCheck({
      projectRoot: options.projectRoot,
      runId: options.runId,
      checkedAt,
      configPath,
      ...result,
    });
    return {
      configPath,
      checkedAt,
      ...result,
      artifact,
    };
  };

  let config: { raw: unknown; path: string } | null;
  try {
    config = await readConfig(options.projectRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finalize({
      status: 'failed',
      summary: `Could not read staging delivery config: ${message}`,
      error: message,
    });
  }
  if (!config) {
    return finalize({
      status: 'not_configured',
      summary: `No staging delivery config found at ${configPath}.`,
    });
  }

  let parsed: StagingDeliveryConfig;
  try {
    parsed = parseStagingDeliveryConfig(options.projectRoot, config.raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finalize({
      status: 'failed',
      summary: `Invalid staging delivery config: ${message}`,
      error: message,
    });
  }

  if (!parsed.enabled) {
    return finalize({
      status: 'disabled',
      summary: 'Staging delivery is disabled in delivery.json.',
    });
  }

  try {
    const cwdStat = await stat(parsed.cwd);
    if (!cwdStat.isDirectory()) throw new Error('staging.cwd must resolve to a directory');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finalize({
      status: 'failed',
      commandLine: commandLine(parsed.command, parsed.args),
      cwd: parsed.cwd,
      timeoutMs: parsed.timeoutMs,
      summary: `Invalid staging delivery cwd: ${message}`,
      error: message,
    });
  }

  const display = commandLine(parsed.command, parsed.args);
  return finalize({
    status: 'ready',
    commandLine: display,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeoutMs,
    summary: `Staging delivery config is ready: ${display}`,
  });
}

export async function runEvolutionStagingDelivery(options: {
  projectRoot: string;
  runId: string;
  nowMs?: number;
}): Promise<EvolutionStagingDeliveryResult> {
  const startedAt = options.nowMs ?? Date.now();
  const configPath = EVOLUTION_DELIVERY_CONFIG_RELATIVE_PATH;
  let config: { raw: unknown; path: string } | null;
  try {
    config = await readConfig(options.projectRoot);
  } catch (error) {
    const completedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      configPath,
      summary: `Could not read staging delivery config: ${message}`,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      error: message,
    };
  }
  if (!config) {
    return {
      status: 'not_configured',
      configPath,
      summary: `No staging delivery config found at ${configPath}.`,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
    };
  }

  let parsed: StagingDeliveryConfig;
  try {
    parsed = parseStagingDeliveryConfig(options.projectRoot, config.raw);
  } catch (error) {
    const completedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      configPath,
      summary: `Invalid staging delivery config: ${message}`,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      error: message,
    };
  }

  if (!parsed.enabled) {
    return {
      status: 'disabled',
      configPath,
      summary: 'Staging delivery is disabled in delivery.json.',
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
    };
  }

  const display = commandLine(parsed.command, parsed.args);
  const outcome = await runExecFile(parsed.command, parsed.args, parsed.cwd, parsed.timeoutMs);
  const completedAt = Date.now();
  const durationMs = Math.max(0, completedAt - startedAt);
  const artifact = await writeDeliveryLog({
    projectRoot: options.projectRoot,
    runId: options.runId,
    nowMs: completedAt,
    commandLine: display,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeoutMs,
    outcome,
    durationMs,
  });
  const success = outcome.exitCode === 0 && !outcome.timedOut;
  const stdoutTail = tail(outcome.stdout, 2000).trim();
  const stderrTail = tail(outcome.stderr || outcome.errorMessage || '', 2000).trim();
  return {
    status: success ? 'passed' : 'failed',
    configPath,
    commandLine: display,
    exitCode: outcome.exitCode,
    summary: success
      ? `Staging delivery passed: ${display}`
      : `Staging delivery failed with exit code ${outcome.exitCode}: ${display}`,
    startedAt,
    completedAt,
    durationMs,
    artifact,
    ...(stdoutTail ? { stdoutTail } : {}),
    ...(stderrTail ? { stderrTail } : {}),
    timedOut: outcome.timedOut,
    ...(success ? {} : { error: outcome.errorMessage ?? (outcome.timedOut ? 'staging delivery timed out' : 'staging delivery failed') }),
  };
}

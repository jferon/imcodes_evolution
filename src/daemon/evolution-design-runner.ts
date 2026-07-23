import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export const EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH = '.imc/evolution/design.json' as const;

const DEFAULT_TASTE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TASTE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TASTE_OUTPUT_RELATIVE_PATH = 'design/taste-hifi-output.md';
const DEFAULT_TASTE_REFERENCE_RELATIVE_PATH = 'design/taste-hifi-reference.svg';
const DEFAULT_STYLE_AUDIT_RELATIVE_PATH = 'design/project-style-audit.md';
const BLOCKED_COMMAND_BASENAMES = new Set(['sh', 'bash', 'zsh', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'sudo']);
const SUPPORTED_REFERENCE_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp'] as const;

interface TasteSkillGenerationConfig {
  enabled: boolean;
  required: boolean;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  outputRelativePath: string;
  referenceRelativePath: string;
  styleAuditRelativePath: string;
}

export interface EvolutionTasteHifiGenerationResult {
  status: 'not_configured' | 'disabled' | 'passed' | 'failed';
  required: boolean;
  configPath: string;
  commandLine?: string;
  outputRelativePath?: string;
  outputContent?: string;
  referenceRelativePath?: string;
  referenceContent?: string;
  styleAuditRelativePath?: string;
  styleAuditContent?: string;
  logRelativePath?: string;
  logContent?: string;
  exitCode?: number;
  summary: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
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

interface TasteSkillPlaceholders {
  projectRoot: string;
  runDir: string;
  promptPath: string;
  designHandoffPath: string;
  outputPath: string;
  referencePath: string;
  styleAuditOutputPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path_outside_root');
  return resolvedPath;
}

function displayArg(value: string): string {
  return /^[A-Za-z0-9_./:=@{}+-]+$/.test(value) ? value : JSON.stringify(value);
}

function commandLine(command: string, args: string[]): string {
  return [command, ...args].map(displayArg).join(' ');
}

function normalizeTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_TASTE_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_TASTE_TIMEOUT_MS) {
    throw new Error(`tasteSkill.timeoutMs must be an integer between 1 and ${MAX_TASTE_TIMEOUT_MS}`);
  }
  return value;
}

function resolveCommand(projectRoot: string, command: string): string {
  if (!command || command.includes('\0') || command.length > 512) throw new Error('tasteSkill.command is invalid');
  const base = basename(command).toLowerCase();
  if (BLOCKED_COMMAND_BASENAMES.has(base)) {
    throw new Error(`tasteSkill.command must not invoke an interactive shell or privileged wrapper: ${base}`);
  }
  if (!isAbsolute(command) && command.includes('/')) return safeJoin(projectRoot, command.replace(/^\.\//, ''));
  return command;
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('tasteSkill.args must be an array of strings');
  if (value.length > 96) throw new Error('tasteSkill.args is too large');
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > 4096) {
      throw new Error(`tasteSkill.args[${index}] is invalid`);
    }
    return entry;
  });
}

function normalizeCwd(projectRoot: string, value: unknown): string {
  if (value === undefined) return resolve(projectRoot);
  if (typeof value !== 'string') throw new Error('tasteSkill.cwd must be a relative string');
  return safeJoin(projectRoot, value.replace(/^\.\//, ''));
}

function normalizeOutputRelativePath(value: unknown): string {
  if (value === undefined) return DEFAULT_TASTE_OUTPUT_RELATIVE_PATH;
  if (typeof value !== 'string') throw new Error('tasteSkill.outputRelativePath must be a relative string');
  const trimmed = value.trim();
  if (!safeRelativePath(trimmed)) throw new Error('tasteSkill.outputRelativePath must stay inside the run directory');
  return trimmed;
}

function normalizeReferenceRelativePath(value: unknown): string {
  if (value === undefined) return DEFAULT_TASTE_REFERENCE_RELATIVE_PATH;
  if (typeof value !== 'string') throw new Error('tasteSkill.referenceRelativePath must be a relative string');
  const trimmed = value.trim();
  if (!safeRelativePath(trimmed)) throw new Error('tasteSkill.referenceRelativePath must stay inside the run directory');
  const lower = trimmed.toLowerCase();
  if (!SUPPORTED_REFERENCE_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    throw new Error(`tasteSkill.referenceRelativePath must end with ${SUPPORTED_REFERENCE_EXTENSIONS.join(', ')}`);
  }
  return trimmed;
}

function normalizeStyleAuditRelativePath(value: unknown): string {
  if (value === undefined) return DEFAULT_STYLE_AUDIT_RELATIVE_PATH;
  if (typeof value !== 'string') throw new Error('tasteSkill.styleAuditRelativePath must be a relative string');
  const trimmed = value.trim();
  if (!safeRelativePath(trimmed)) throw new Error('tasteSkill.styleAuditRelativePath must stay inside the run directory');
  if (!trimmed.toLowerCase().endsWith('.md')) throw new Error('tasteSkill.styleAuditRelativePath must end with .md');
  return trimmed;
}

function parseTasteSkillGenerationConfig(projectRoot: string, raw: unknown): TasteSkillGenerationConfig {
  if (!isRecord(raw)) throw new Error('design config must be an object');
  const tasteSkill = raw.tasteSkill;
  if (!isRecord(tasteSkill)) throw new Error('design config must contain a tasteSkill object');
  if (tasteSkill.enabled !== true) {
    return {
      enabled: false,
      required: false,
      command: '',
      args: [],
      cwd: resolve(projectRoot),
      timeoutMs: DEFAULT_TASTE_TIMEOUT_MS,
      outputRelativePath: DEFAULT_TASTE_OUTPUT_RELATIVE_PATH,
      referenceRelativePath: DEFAULT_TASTE_REFERENCE_RELATIVE_PATH,
      styleAuditRelativePath: DEFAULT_STYLE_AUDIT_RELATIVE_PATH,
    };
  }
  if (typeof tasteSkill.command !== 'string') throw new Error('tasteSkill.command is required');
  return {
    enabled: true,
    required: tasteSkill.required === true,
    command: resolveCommand(projectRoot, tasteSkill.command),
    args: normalizeArgs(tasteSkill.args),
    cwd: normalizeCwd(projectRoot, tasteSkill.cwd),
    timeoutMs: normalizeTimeoutMs(tasteSkill.timeoutMs),
    outputRelativePath: normalizeOutputRelativePath(tasteSkill.outputRelativePath),
    referenceRelativePath: normalizeReferenceRelativePath(tasteSkill.referenceRelativePath),
    styleAuditRelativePath: normalizeStyleAuditRelativePath(tasteSkill.styleAuditRelativePath),
  };
}

async function readConfig(projectRoot: string): Promise<{ raw: unknown; path: string } | null> {
  const path = safeJoin(projectRoot, EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH);
  try {
    const content = await readFile(path, 'utf8');
    return { raw: JSON.parse(content), path };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function expandPlaceholders(value: string, placeholders: TasteSkillPlaceholders): string {
  return value
    .replaceAll('{projectRoot}', placeholders.projectRoot)
    .replaceAll('{runDir}', placeholders.runDir)
    .replaceAll('{promptPath}', placeholders.promptPath)
    .replaceAll('{designHandoffPath}', placeholders.designHandoffPath)
    .replaceAll('{outputPath}', placeholders.outputPath)
    .replaceAll('{referencePath}', placeholders.referencePath)
    .replaceAll('{styleAuditOutputPath}', placeholders.styleAuditOutputPath);
}

function runExecFile(command: string, args: string[], cwd: string, timeoutMs: number, placeholders: TasteSkillPlaceholders): Promise<ExecOutcome> {
  return new Promise((resolveOutcome) => {
    execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        IMCODES_EVOLUTION_PROJECT_ROOT: placeholders.projectRoot,
        IMCODES_EVOLUTION_RUN_DIR: placeholders.runDir,
        IMCODES_EVOLUTION_TASTE_PROMPT: placeholders.promptPath,
        IMCODES_EVOLUTION_TASTE_OUTPUT: placeholders.outputPath,
        IMCODES_EVOLUTION_TASTE_REFERENCE: placeholders.referencePath,
        IMCODES_EVOLUTION_STYLE_AUDIT_OUTPUT: placeholders.styleAuditOutputPath,
        IMCODES_EVOLUTION_DESIGN_HANDOFF: placeholders.designHandoffPath,
      },
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

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalBuffer(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function tail(value: string, max = 12000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function buildLogContent(options: {
  commandLine: string;
  cwd: string;
  timeoutMs: number;
  outputRelativePath: string;
  outputPath: string;
  referenceRelativePath: string;
  referencePath: string;
  styleAuditRelativePath: string;
  styleAuditPath: string;
  outcome: ExecOutcome;
  durationMs: number;
}): string {
  return [
    '# IM.codes Evolution taste-skill High-Fidelity Generation Log',
    '',
    `command: ${options.commandLine}`,
    `cwd: ${options.cwd}`,
    `timeoutMs: ${options.timeoutMs}`,
    `outputRelativePath: ${options.outputRelativePath}`,
    `outputPath: ${options.outputPath}`,
    `referenceRelativePath: ${options.referenceRelativePath}`,
    `referencePath: ${options.referencePath}`,
    `styleAuditRelativePath: ${options.styleAuditRelativePath}`,
    `styleAuditPath: ${options.styleAuditPath}`,
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
}

export async function runEvolutionTasteHifiGeneration(options: {
  projectRoot: string;
  runId: string;
  nowMs?: number;
}): Promise<EvolutionTasteHifiGenerationResult> {
  const startedAt = options.nowMs ?? Date.now();
  const configPath = EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH;
  let config: { raw: unknown; path: string } | null;
  try {
    config = await readConfig(options.projectRoot);
  } catch (error) {
    const completedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      required: false,
      configPath,
      summary: `Could not read design generation config: ${message}`,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      error: message,
    };
  }
  if (!config) {
    return {
      status: 'not_configured',
      required: false,
      configPath,
      summary: `No taste-skill design generation config found at ${configPath}.`,
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
    };
  }

  let parsed: TasteSkillGenerationConfig;
  try {
    parsed = parseTasteSkillGenerationConfig(options.projectRoot, config.raw);
  } catch (error) {
    const completedAt = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'failed',
      required: false,
      configPath,
      summary: `Invalid taste-skill design generation config: ${message}`,
      startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - startedAt),
      error: message,
    };
  }

  if (!parsed.enabled) {
    return {
      status: 'disabled',
      required: parsed.required,
      configPath,
      summary: 'taste-skill high-fidelity generation is disabled in design.json.',
      startedAt,
      completedAt: startedAt,
      durationMs: 0,
    };
  }

  const runDir = safeJoin(options.projectRoot, `.imc/evolution/${options.runId}`);
  const outputPath = safeJoin(runDir, parsed.outputRelativePath);
  const referencePath = safeJoin(runDir, parsed.referenceRelativePath);
  const styleAuditPath = safeJoin(runDir, parsed.styleAuditRelativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(referencePath), { recursive: true });
  await mkdir(dirname(styleAuditPath), { recursive: true });
  const placeholders: TasteSkillPlaceholders = {
    projectRoot: resolve(options.projectRoot),
    runDir,
    promptPath: safeJoin(runDir, 'design/taste-hifi-prompt.md'),
    designHandoffPath: safeJoin(runDir, 'design/design-handoff.json'),
    outputPath,
    referencePath,
    styleAuditOutputPath: styleAuditPath,
  };
  const expandedArgs = parsed.args.map((arg) => expandPlaceholders(arg, placeholders));
  const display = commandLine(parsed.command, expandedArgs);
  const outcome = await runExecFile(parsed.command, expandedArgs, parsed.cwd, parsed.timeoutMs, placeholders);
  const completedAt = Date.now();
  const durationMs = Math.max(0, completedAt - startedAt);
  const fileOutput = await readOptionalFile(outputPath);
  const styleAuditOutput = await readOptionalFile(styleAuditPath);
  const referenceBuffer = await readOptionalBuffer(referencePath);
  const referenceContent = referenceBuffer && parsed.referenceRelativePath.toLowerCase().endsWith('.svg')
    ? referenceBuffer.toString('utf8')
    : null;
  const stdoutOutput = outcome.stdout.trim().length > 0 ? outcome.stdout : null;
  const outputContent = fileOutput?.trim().length ? fileOutput : stdoutOutput;
  const logRelativePath = `design/taste-hifi-${new Date(completedAt).toISOString().replace(/[-:.]/g, '')}.log`;
  const logContent = buildLogContent({
    commandLine: display,
    cwd: parsed.cwd,
    timeoutMs: parsed.timeoutMs,
    outputRelativePath: parsed.outputRelativePath,
    outputPath,
    referenceRelativePath: parsed.referenceRelativePath,
    referencePath,
    styleAuditRelativePath: parsed.styleAuditRelativePath,
    styleAuditPath,
    outcome,
    durationMs,
  });
  const success = outcome.exitCode === 0 && !outcome.timedOut && !!outputContent?.trim();
  return {
    status: success ? 'passed' : 'failed',
    required: parsed.required,
    configPath,
    commandLine: display,
    outputRelativePath: parsed.outputRelativePath,
    ...(outputContent ? { outputContent } : {}),
    ...(styleAuditOutput?.trim() ? {
      styleAuditRelativePath: parsed.styleAuditRelativePath,
      styleAuditContent: styleAuditOutput,
    } : {}),
    ...(referenceBuffer?.byteLength ? {
      referenceRelativePath: parsed.referenceRelativePath,
      ...(referenceContent?.trim() ? { referenceContent } : {}),
    } : {}),
    logRelativePath,
    logContent,
    exitCode: outcome.exitCode,
    summary: success
      ? `taste-skill high-fidelity generation passed: ${display}`
      : `taste-skill high-fidelity generation failed or produced no output: ${display}`,
    startedAt,
    completedAt,
    durationMs,
    ...(success ? {} : { error: outcome.errorMessage ?? (outcome.timedOut ? 'taste-skill generation timed out' : 'taste-skill generation produced no output or failed') }),
  };
}

// ── UI Evolution Engine — opt-in preview screenshot runner ───────────────────
//
// Renders the Design Maker's self-contained `design/preview.html` to one PNG
// per ui-spec screen via a USER-CONFIGURED command in design.json (typically a
// small Playwright/Chromium script the project provides). Playwright is never
// bundled with the imcodes CLI — this mirrors the tasteSkill opt-in contract.
// When unconfigured, callers get an honest `not_configured` result and the
// Visual QA basis stays `preview_source`; it is never silently faked.

const DEFAULT_SCREENSHOT_TIMEOUT_MS = 60 * 1000;
const MAX_SCREENSHOT_SCREENS = 24;

export interface EvolutionUiScreenshotShot {
  screenName: string;
  relativePath: string;
}

export interface EvolutionUiScreenshotResult {
  status: 'not_configured' | 'disabled' | 'passed' | 'failed';
  summary: string;
  shots: EvolutionUiScreenshotShot[];
  commandLine?: string;
  error?: string;
  startedAt: number;
  completedAt: number;
}

interface ScreenshotConfig {
  enabled: boolean;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

function parseScreenshotConfig(projectRoot: string, raw: unknown): ScreenshotConfig | null {
  if (!isRecord(raw)) return null;
  const screenshot = raw.screenshot;
  if (!isRecord(screenshot)) return null;
  if (screenshot.enabled !== true) return { enabled: false, command: '', args: [], cwd: resolve(projectRoot), timeoutMs: DEFAULT_SCREENSHOT_TIMEOUT_MS };
  if (typeof screenshot.command !== 'string') throw new Error('screenshot.command is required when screenshot.enabled is true');
  return {
    enabled: true,
    command: resolveCommand(projectRoot, screenshot.command),
    args: normalizeArgs(screenshot.args),
    cwd: normalizeCwd(projectRoot, screenshot.cwd),
    timeoutMs: screenshot.timeoutMs === undefined ? DEFAULT_SCREENSHOT_TIMEOUT_MS : normalizeTimeoutMs(screenshot.timeoutMs),
  };
}

function expandScreenshotPlaceholders(value: string, replacements: Record<string, string>): string {
  let expanded = value;
  for (const [key, replacement] of Object.entries(replacements)) {
    expanded = expanded.replaceAll(`{${key}}`, replacement);
  }
  return expanded;
}

export async function runEvolutionUiScreenshots(options: {
  projectRoot: string;
  runId: string;
  previewRelativePath: string;
  screens: Array<{ name: string; width: number; height: number; anchor?: string }>;
  nowMs?: number;
}): Promise<EvolutionUiScreenshotResult> {
  const startedAt = options.nowMs ?? Date.now();
  const projectRoot = resolve(options.projectRoot);
  const config = await readConfig(projectRoot);
  const base = { shots: [] as EvolutionUiScreenshotShot[], startedAt };
  if (!config) {
    return { ...base, status: 'not_configured', summary: 'No design.json — preview screenshots skipped; Visual QA reviews the HTML source instead.', completedAt: startedAt };
  }
  let parsed: ScreenshotConfig | null;
  try {
    parsed = parseScreenshotConfig(projectRoot, config.raw);
  } catch (error) {
    return { ...base, status: 'failed', summary: 'screenshot config is invalid.', error: error instanceof Error ? error.message : String(error), completedAt: startedAt };
  }
  if (!parsed) {
    return { ...base, status: 'not_configured', summary: 'design.json has no screenshot config — preview screenshots skipped.', completedAt: startedAt };
  }
  if (!parsed.enabled) {
    return { ...base, status: 'disabled', summary: 'screenshot.enabled is false — preview screenshots skipped.', completedAt: startedAt };
  }

  const runDir = safeJoin(projectRoot, `.imc/evolution/${options.runId}`);
  const previewPath = safeJoin(runDir, options.previewRelativePath);
  const screens = options.screens.slice(0, MAX_SCREENSHOT_SCREENS);
  const shots: EvolutionUiScreenshotShot[] = [];
  let display = '';
  for (const [index, screen] of screens.entries()) {
    const relativePath = `design/screenshots/screen-${String(index + 1).padStart(2, '0')}.png`;
    const outputPath = safeJoin(runDir, relativePath);
    await mkdir(dirname(outputPath), { recursive: true });
    const replacements: Record<string, string> = {
      projectRoot,
      runDir,
      previewPath,
      outputPath,
      width: String(screen.width),
      height: String(screen.height),
      screenAnchor: screen.anchor ?? `#screen-${index + 1}`,
      screenName: screen.name,
    };
    const args = parsed.args.map((arg) => expandScreenshotPlaceholders(arg, replacements));
    display = commandLine(parsed.command, args);
    const outcome = await new Promise<ExecOutcome>((resolveOutcome) => {
      execFile(parsed!.command, args, {
        cwd: parsed!.cwd,
        timeout: parsed!.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          IMCODES_EVOLUTION_PROJECT_ROOT: projectRoot,
          IMCODES_EVOLUTION_RUN_DIR: runDir,
          IMCODES_EVOLUTION_PREVIEW_PATH: previewPath,
          IMCODES_EVOLUTION_SCREENSHOT_OUTPUT: outputPath,
        },
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
    const produced = outcome.exitCode === 0 && !outcome.timedOut && (await readOptionalBuffer(outputPath))?.byteLength;
    if (!produced) {
      return {
        ...base,
        shots,
        status: 'failed',
        commandLine: display,
        summary: `screenshot command failed for screen "${screen.name}" (${shots.length}/${screens.length} captured).`,
        error: outcome.errorMessage ?? (outcome.timedOut ? 'screenshot command timed out' : `exit=${outcome.exitCode}; no output file produced`),
        completedAt: Date.now(),
      };
    }
    shots.push({ screenName: screen.name, relativePath });
  }
  return {
    ...base,
    shots,
    status: 'passed',
    commandLine: display,
    summary: `captured ${shots.length}/${screens.length} preview screenshot(s).`,
    completedAt: Date.now(),
  };
}

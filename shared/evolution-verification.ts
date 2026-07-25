/**
 * Launch-pinned, daemon-observed delivery verification for the Evolution
 * pipeline (discussion 30f25d75-67c, repair checklist #11/#12).
 *
 * Trust model:
 * - Commands come ONLY from `.imc/evolution/verification.json`, validated and
 *   COPIED INTO THE RUN AT LAUNCH (temporal integrity). Nothing re-reads the
 *   mutable file for a running run, so a workspace agent editing it mid-run
 *   cannot inject commands into daemon-privileged execution.
 * - The digests of every project-writable command/authority source are also
 *   pinned at launch; a mutated source blocks the delivery gate before any
 *   command executes.
 * - Results are recorded as daemon-observed (`observed` assurance); agent
 *   claims about test runs never satisfy the gate.
 */
import type { EvolutionValidationIssue, EvolutionValidationResult } from './evolution-pipeline-types.js';

export const EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH = '.imc/evolution/verification.json';
export const EVOLUTION_VERIFICATION_POLICY_VERSION = 1;

/**
 * Every project-writable file whose content can steer daemon-privileged
 * command execution or approval authority. Digested at launch; mutation
 * during a governed run fail-closes delivery.
 */
export const EVOLUTION_GOVERNANCE_SOURCE_PATHS = [
  '.imc/evolution/design.json',
  '.imc/evolution/policy.json',
  '.imc/evolution/delivery.json',
  EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH,
] as const;

export const EVOLUTION_GOVERNANCE_SOURCE_ABSENT = 'absent';

export interface EvolutionVerificationCommand {
  /** Canonical slug, e.g. 'typecheck' | 'unit' | 'build'. */
  id: string;
  /** Bare executable — never a shell string. */
  command: string;
  /** Literal args. No placeholder expansion by design (injection surface). */
  args: string[];
  /** Project-relative working directory; validated safe. */
  cwd?: string;
  timeoutMs?: number;
  tier: 'required' | 'optional';
}

export interface EvolutionVerificationPolicy {
  version: typeof EVOLUTION_VERIFICATION_POLICY_VERSION;
  commands: EvolutionVerificationCommand[];
}

export interface EvolutionPinnedVerification {
  policy: EvolutionVerificationPolicy;
  policySha256: string;
  pinnedAt: number;
}

export interface EvolutionVerificationResult {
  id: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  stdoutSha256: string;
  stderrTail: string;
  status: 'passed' | 'failed' | 'timeout' | 'crashed';
  tier: 'required' | 'optional';
}

export interface EvolutionVerificationState {
  results: EvolutionVerificationResult[];
  /** Digest of the workspace the results were observed against. */
  workspaceDigest: string;
  allRequiredPassed: boolean;
  completedAt: number;
}

const COMMAND_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_COMMANDS = 16;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 512;
const MAX_COMMAND_LENGTH = 256;
export const EVOLUTION_VERIFICATION_TIMEOUT_MIN_MS = 10_000;
export const EVOLUTION_VERIFICATION_TIMEOUT_MAX_MS = 900_000;

function issue(code: string, message: string, path?: string): EvolutionValidationIssue {
  return { code, message, severity: 'error', ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 300 || hasNul(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) return false;
  const segments = value.split(/[\\/]/);
  return segments.every((segment) => segment.length > 0 && segment !== '..' && segment !== '~');
}

export function validateEvolutionVerificationPolicy(input: unknown): EvolutionValidationResult<EvolutionVerificationPolicy> {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('invalid_verification_policy', 'Verification policy must be an object.')] };
  }
  const issues: EvolutionValidationIssue[] = [];
  if (input.version !== EVOLUTION_VERIFICATION_POLICY_VERSION) {
    issues.push(issue('invalid_verification_policy_version', `version must equal ${EVOLUTION_VERIFICATION_POLICY_VERSION}.`, 'version'));
  }
  const rawCommands = input.commands;
  if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.length > MAX_COMMANDS) {
    issues.push(issue('invalid_verification_commands', `commands must be a non-empty array of at most ${MAX_COMMANDS}.`, 'commands'));
    return { ok: false, issues };
  }
  const commands: EvolutionVerificationCommand[] = [];
  const seenIds = new Set<string>();
  rawCommands.forEach((raw, index) => {
    const path = `commands[${index}]`;
    if (!isRecord(raw)) {
      issues.push(issue('invalid_verification_command', 'Command must be an object.', path));
      return;
    }
    const id = raw.id;
    if (typeof id !== 'string' || !COMMAND_ID_RE.test(id)) {
      issues.push(issue('invalid_verification_command_id', 'id must be a lowercase slug (max 40 chars).', `${path}.id`));
      return;
    }
    if (seenIds.has(id)) {
      issues.push(issue('duplicate_verification_command_id', `Duplicate command id: ${id}`, `${path}.id`));
      return;
    }
    const command = raw.command;
    if (typeof command !== 'string' || command.length === 0 || command.length > MAX_COMMAND_LENGTH || hasNul(command)) {
      issues.push(issue('invalid_verification_command_executable', 'command must be a non-empty executable string.', `${path}.command`));
      return;
    }
    const args = raw.args;
    if (!Array.isArray(args) || args.length > MAX_ARGS || args.some((arg) => typeof arg !== 'string' || arg.length > MAX_ARG_LENGTH || hasNul(arg))) {
      issues.push(issue('invalid_verification_command_args', `args must be an array of at most ${MAX_ARGS} strings.`, `${path}.args`));
      return;
    }
    if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !isSafeRelativePath(raw.cwd))) {
      issues.push(issue('invalid_verification_command_cwd', 'cwd must be a safe project-relative path.', `${path}.cwd`));
      return;
    }
    if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs)
      || raw.timeoutMs < EVOLUTION_VERIFICATION_TIMEOUT_MIN_MS || raw.timeoutMs > EVOLUTION_VERIFICATION_TIMEOUT_MAX_MS)) {
      issues.push(issue('invalid_verification_command_timeout', `timeoutMs must be an integer within [${EVOLUTION_VERIFICATION_TIMEOUT_MIN_MS}, ${EVOLUTION_VERIFICATION_TIMEOUT_MAX_MS}].`, `${path}.timeoutMs`));
      return;
    }
    if (raw.tier !== 'required' && raw.tier !== 'optional') {
      issues.push(issue('invalid_verification_command_tier', "tier must be 'required' or 'optional'.", `${path}.tier`));
      return;
    }
    seenIds.add(id);
    commands.push({
      id,
      command,
      args: [...(args as string[])],
      ...(raw.cwd !== undefined ? { cwd: raw.cwd as string } : {}),
      ...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs as number } : {}),
      tier: raw.tier,
    });
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { version: EVOLUTION_VERIFICATION_POLICY_VERSION, commands }, issues: [] };
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  EvolutionArtifactRef,
  EvolutionArtifactRevision,
  EvolutionAttemptRecord,
  EvolutionDesignReviewSet,
  EvolutionGateRecord,
  EvolutionRun,
  EvolutionSkillSnapshot,
  EvolutionVerdictRecord,
} from '../../shared/evolution-pipeline-types.js';
import type {
  EvolutionArtifactStatus,
  EvolutionAssuranceLevel,
  EvolutionAttemptKind,
  EvolutionRoleId,
  EvolutionRoleSource,
  EvolutionStage,
} from '../../shared/evolution-pipeline-constants.js';
import { EVOLUTION_RUN_ROOT_DIR } from '../../shared/evolution-pipeline-constants.js';
import { validateEvolutionRunId } from '../../shared/evolution-pipeline-validators.js';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordId(prefix: string, seed: string): string {
  return `${prefix}-${sha256(seed).slice(0, 20)}`;
}

function controlPaths(projectRoot: string, runId: string) {
  const valid = validateEvolutionRunId(runId);
  if (!valid.ok) throw new Error('invalid_evolution_run_id');
  const runDir = join(projectRoot, EVOLUTION_RUN_ROOT_DIR, runId);
  return {
    runDir,
    attemptsDir: join(runDir, 'attempts'),
    revisionsDir: join(runDir, 'revisions'),
    verdictsDir: join(runDir, 'verdicts'),
    gatesDir: join(runDir, 'gates'),
    reviewSetsDir: join(runDir, 'review-sets'),
    skillSnapshotsDir: join(runDir, 'skill-snapshots'),
  };
}

async function writeImmutable(filePath: string, content: Buffer | string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const existing = await readFile(filePath);
    const next = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (!existing.equals(next)) throw new Error(`immutable_evolution_record_conflict:${basename(filePath)}`);
  }
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  await writeImmutable(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function initializeEvolutionControlState(run: EvolutionRun): void {
  run.controlVersion = 2;
  run.runRevision ??= 0;
  run.executionPolicy ??= 'draft_preview';
  run.skillSnapshots ??= [];
  run.artifactRevisions ??= [];
  run.attempts ??= [];
  run.verdictRecords ??= [];
  run.gates ??= [];
  run.designReviewSets ??= [];
  run.authorizedRevisions ??= {};
  run.foundationEvidence ??= [];
  run.processedMutationIds ??= [];
}

export function nextEvolutionRunRevision(run: EvolutionRun): number {
  initializeEvolutionControlState(run);
  run.runRevision = (run.runRevision ?? 0) + 1;
  return run.runRevision;
}

export async function registerEvolutionArtifactRevision(options: {
  projectRoot: string;
  run: EvolutionRun;
  artifact: EvolutionArtifactRef;
  content: Buffer | string;
  status?: EvolutionArtifactStatus;
  assurance?: EvolutionAssuranceLevel;
  producerAttemptId?: string;
  supersedesRevisionId?: string;
}): Promise<EvolutionArtifactRevision> {
  initializeEvolutionControlState(options.run);
  const bytes = Buffer.isBuffer(options.content) ? options.content : Buffer.from(options.content);
  const digest = sha256(bytes);
  const id = recordId('revision', `${options.artifact.kind}:${options.artifact.path}:${digest}`);
  const paths = controlPaths(options.projectRoot, options.run.runId);
  const extension = basename(options.artifact.path).includes('.')
    ? `.${basename(options.artifact.path).split('.').pop()}`
    : '.bin';
  const immutablePath = `revisions/blobs/${id}${extension}`;
  const revision: EvolutionArtifactRevision = {
    id,
    artifactId: options.artifact.id,
    kind: options.artifact.kind,
    logicalPath: options.artifact.path,
    immutablePath,
    sha256: digest,
    bytes: bytes.byteLength,
    stage: options.artifact.stage ?? options.run.stage,
    ...(options.artifact.roleId ? { roleId: options.artifact.roleId } : {}),
    status: options.status ?? 'draft',
    assurance: options.assurance ?? 'pipeline_draft',
    ...(options.producerAttemptId ? { producerAttemptId: options.producerAttemptId } : {}),
    ...(options.supersedesRevisionId ? { supersedesRevisionId: options.supersedesRevisionId } : {}),
    createdAt: options.artifact.createdAt,
  };
  const existingIndex = options.run.artifactRevisions!.findIndex((entry) => entry.id === id);
  const effectiveRevision = existingIndex >= 0 ? options.run.artifactRevisions![existingIndex]! : revision;
  await writeImmutable(join(paths.runDir, effectiveRevision.immutablePath), bytes);
  if (existingIndex < 0) {
    await writeImmutableJson(join(paths.revisionsDir, `${id}.json`), revision);
    options.run.artifactRevisions!.push(revision);
  }
  Object.assign(options.artifact, {
    sha256: digest,
    bytes: bytes.byteLength,
    revisionId: id,
    status: effectiveRevision.status,
    assurance: effectiveRevision.assurance,
    ...(effectiveRevision.producerAttemptId ? { producerAttemptId: effectiveRevision.producerAttemptId } : {}),
    ...(effectiveRevision.authorizedByVerdictId ? { authorizedByVerdictId: effectiveRevision.authorizedByVerdictId } : {}),
    ...(effectiveRevision.supersedesRevisionId ? { supersedesRevisionId: effectiveRevision.supersedesRevisionId } : {}),
  });
  return effectiveRevision;
}

export async function captureEvolutionSkillSnapshot(options: {
  projectRoot: string;
  run: EvolutionRun;
  roleId: EvolutionRoleId;
  skillName: string;
  sourcePath: string;
  source: EvolutionRoleSource;
  content: string;
  nowMs: number;
}): Promise<EvolutionSkillSnapshot> {
  initializeEvolutionControlState(options.run);
  const bytes = Buffer.from(options.content);
  const digest = sha256(bytes);
  const id = recordId('skill', `${options.roleId}:${options.skillName}:${digest}`);
  const snapshot: EvolutionSkillSnapshot = {
    id,
    roleId: options.roleId,
    skillName: options.skillName,
    sourcePath: options.sourcePath,
    source: options.source,
    sha256: digest,
    bytes: bytes.byteLength,
    capturedAt: options.nowMs,
  };
  const paths = controlPaths(options.projectRoot, options.run.runId);
  await writeImmutable(join(paths.skillSnapshotsDir, `${id}.md`), bytes);
  await writeImmutableJson(join(paths.skillSnapshotsDir, `${id}.json`), snapshot);
  if (!options.run.skillSnapshots!.some((entry) => entry.id === id)) options.run.skillSnapshots!.push(snapshot);
  return snapshot;
}

export async function createEvolutionAttempt(options: {
  projectRoot: string;
  run: EvolutionRun;
  kind: EvolutionAttemptKind;
  stage: EvolutionStage;
  roleId: EvolutionRoleId;
  checkerRoleId?: EvolutionRoleId;
  inputRevisionIds: string[];
  skillSnapshotIds: string[];
  nowMs: number;
}): Promise<EvolutionAttemptRecord> {
  initializeEvolutionControlState(options.run);
  const ordinal = options.run.attempts!.filter((attempt) =>
    attempt.stage === options.stage && attempt.kind === options.kind && attempt.roleId === options.roleId).length + 1;
  const id = recordId('attempt', `${options.run.runId}:${options.stage}:${options.kind}:${options.roleId}:${ordinal}`);
  const attempt: EvolutionAttemptRecord = {
    id,
    kind: options.kind,
    stage: options.stage,
    roleId: options.roleId,
    ...(options.checkerRoleId ? { checkerRoleId: options.checkerRoleId } : {}),
    status: 'running',
    dispatchToken: randomUUID(),
    inputRevisionIds: [...new Set(options.inputRevisionIds)],
    skillSnapshotIds: [...new Set(options.skillSnapshotIds)],
    outputRevisionIds: [],
    startedAt: options.nowMs,
  };
  options.run.attempts!.push(attempt);
  const paths = controlPaths(options.projectRoot, options.run.runId);
  await writeImmutableJson(join(paths.attemptsDir, `${id}.started.json`), attempt);
  return attempt;
}

export async function completeEvolutionAttempt(options: {
  projectRoot: string;
  run: EvolutionRun;
  attemptId: string;
  status: EvolutionAttemptRecord['status'];
  outputRevisionIds?: string[];
  p2pRunId?: string;
  error?: string;
  allowRecovery?: boolean;
  nowMs: number;
}): Promise<EvolutionAttemptRecord> {
  initializeEvolutionControlState(options.run);
  const attempt = options.run.attempts!.find((entry) => entry.id === options.attemptId);
  if (!attempt) throw new Error(`evolution_attempt_not_found:${options.attemptId}`);
  if (attempt.status !== 'running' && attempt.status !== 'planned') {
    if (attempt.status === options.status) return attempt;
    if (!(options.allowRecovery === true && attempt.status === 'failed' && ['passed', 'rework', 'blocked'].includes(options.status))) {
      throw new Error(`evolution_attempt_already_terminal:${options.attemptId}`);
    }
  }
  attempt.status = options.status;
  attempt.completedAt = options.nowMs;
  attempt.outputRevisionIds = [...new Set(options.outputRevisionIds ?? attempt.outputRevisionIds)];
  if (options.p2pRunId) attempt.p2pRunId = options.p2pRunId;
  if (options.error) attempt.error = options.error;
  const paths = controlPaths(options.projectRoot, options.run.runId);
  await writeImmutableJson(join(paths.attemptsDir, `${attempt.id}.${attempt.status}.json`), attempt);
  return attempt;
}

export async function recordEvolutionVerdict(options: {
  projectRoot: string;
  run: EvolutionRun;
  attempt: EvolutionAttemptRecord;
  checkerRoleId: EvolutionRoleId;
  verdict: EvolutionVerdictRecord['verdict'];
  machineReadable?: boolean;
  summary: string;
  approvedRevisionIds?: string[];
  p2pRunId?: string;
  nowMs: number;
}): Promise<EvolutionVerdictRecord> {
  initializeEvolutionControlState(options.run);
  if (options.checkerRoleId === options.attempt.roleId) {
    throw new Error(`evolution_maker_checker_role_conflict:${options.attempt.id}`);
  }
  const approvedRevisionIds = [...new Set(options.approvedRevisionIds ?? options.attempt.inputRevisionIds)];
  const boundRevisionIds = new Set([
    ...options.attempt.inputRevisionIds,
    ...options.attempt.outputRevisionIds,
  ]);
  const unboundRevisionId = approvedRevisionIds.find((revisionId) => !boundRevisionIds.has(revisionId));
  if (unboundRevisionId) {
    throw new Error(`evolution_verdict_revision_not_bound:${unboundRevisionId}`);
  }
  const id = recordId('verdict', `${options.attempt.id}:${options.p2pRunId ?? 'local'}:${options.verdict}`);
  const verdict: EvolutionVerdictRecord = {
    id,
    attemptId: options.attempt.id,
    stage: options.attempt.stage,
    checkerRoleId: options.checkerRoleId,
    verdict: options.verdict,
    machineReadable: options.machineReadable !== false,
    summary: options.summary,
    inputRevisionIds: [...options.attempt.inputRevisionIds],
    approvedRevisionIds: options.verdict === 'PASS' && options.machineReadable !== false
      ? approvedRevisionIds
      : [],
    ...(options.p2pRunId ? { p2pRunId: options.p2pRunId } : {}),
    createdAt: options.nowMs,
  };
  if (!options.run.verdictRecords!.some((entry) => entry.id === id)) options.run.verdictRecords!.push(verdict);
  if (verdict.verdict === 'PASS' && verdict.machineReadable) {
    for (const revisionId of verdict.approvedRevisionIds) {
      const revision = options.run.artifactRevisions!.find((entry) => entry.id === revisionId);
      if (!revision) continue;
      revision.status = 'approved';
      revision.assurance = 'checker_verified';
      revision.authorizedByVerdictId = verdict.id;
      options.run.authorizedRevisions![revision.logicalPath] = revision.id;
      const artifact = options.run.artifacts.find((entry) => entry.revisionId === revision.id);
      if (artifact) Object.assign(artifact, {
        status: revision.status,
        assurance: revision.assurance,
        authorizedByVerdictId: verdict.id,
      });
    }
  }
  const paths = controlPaths(options.projectRoot, options.run.runId);
  await writeImmutableJson(join(paths.verdictsDir, `${id}.json`), verdict);
  return verdict;
}

export async function persistEvolutionGate(projectRoot: string, run: EvolutionRun, gate: EvolutionGateRecord): Promise<void> {
  initializeEvolutionControlState(run);
  const paths = controlPaths(projectRoot, run.runId);
  await writeImmutableJson(join(paths.gatesDir, `${gate.id}.${gate.status}.json`), gate);
}

export async function persistEvolutionReviewSet(
  projectRoot: string,
  run: EvolutionRun,
  reviewSet: EvolutionDesignReviewSet,
): Promise<void> {
  initializeEvolutionControlState(run);
  const paths = controlPaths(projectRoot, run.runId);
  await writeImmutableJson(join(paths.reviewSetsDir, `${reviewSet.id}.${reviewSet.status}.json`), reviewSet);
}

export function requireAuthorizedEvolutionRevision(run: EvolutionRun, logicalPath: string): EvolutionArtifactRevision {
  initializeEvolutionControlState(run);
  const revisionId = run.authorizedRevisions![logicalPath];
  const revision = revisionId ? run.artifactRevisions!.find((entry) => entry.id === revisionId) : undefined;
  if (!revision || revision.status !== 'approved' || !['checker_verified', 'human_approved'].includes(revision.assurance)) {
    throw new Error(`evolution_authorized_revision_required:${logicalPath}`);
  }
  return revision;
}

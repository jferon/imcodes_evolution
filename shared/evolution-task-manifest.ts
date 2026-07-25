/**
 * Opaque task identity + assignment manifest for OpenSpec delivery tasks
 * (discussion 30f25d75-67c, repair checklist #16 core).
 *
 * Identity model (per the round-6 correction of the ordinal-hash proposal):
 * - Each generated checkbox carries a trailing HTML-comment annotation
 *   `<!-- task:<opaque-id> -->`. The ID is generated ONCE at generation time
 *   and persisted in BOTH the annotation and the typed manifest.
 * - The MANIFEST is canonical intent; annotations are a best-effort sync
 *   mirror maintained by the (agent-edited) tasks.md file. Divergence is
 *   DETECTED and reported — never silently relinked.
 * - Labels and line numbers are display/reconciliation evidence, never
 *   identity.
 * - Legacy tasks without annotations remain label/line-based and explicitly
 *   unattributed.
 *
 * This module is imported by web code — keep it browser-safe (no node:*).
 */
import type { EvolutionRoleId } from './evolution-pipeline-constants.js';
import type { EvolutionValidationIssue, EvolutionValidationResult } from './evolution-pipeline-types.js';

export const EVOLUTION_TASK_ASSIGNMENT_MANIFEST_RELATIVE_PATH = 'implementation/task-assignments.json';
export const EVOLUTION_TASK_ASSIGNMENT_MANIFEST_VERSION = 1;

const TASK_ID_RE = /^t-[a-f0-9]{16}$/;
/** Trailing annotation on a checkbox label. */
const TASK_ANNOTATION_TAIL_RE = /\s*<!--\s*task:(t-[a-f0-9]{16})\s*-->\s*$/;

export function formatEvolutionTaskAnnotation(taskId: string): string {
  return `<!-- task:${taskId} -->`;
}

export function isEvolutionTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_RE.test(value);
}

/** Split a raw checkbox label into its display label and optional task id. */
export function splitEvolutionTaskLabel(rawLabel: string): { label: string; taskId?: string } {
  const match = rawLabel.match(TASK_ANNOTATION_TAIL_RE);
  if (!match) return { label: rawLabel.trim() };
  return { label: rawLabel.slice(0, match.index).trim(), taskId: match[1]! };
}

export interface EvolutionTaskAssignment {
  taskId: string;
  /** Display label at generation time — reconciliation evidence, not identity. */
  label: string;
  ordinal: number;
  makerRoleId: EvolutionRoleId;
  checkerRoleId?: EvolutionRoleId;
  /**
   * How the assignment was produced. `heuristic_label_classification` is
   * honest about being a keyword heuristic, not an agent/checker decision.
   */
  assignmentSource: 'heuristic_label_classification' | 'agent_attested' | 'checker_verified';
}

export interface EvolutionTaskAssignmentManifest {
  version: typeof EVOLUTION_TASK_ASSIGNMENT_MANIFEST_VERSION;
  runId: string;
  changeSlug: string;
  /** Bumped on every regeneration; repairs must create a new revision. */
  revision: number;
  assignments: EvolutionTaskAssignment[];
  createdAt: number;
}

function issue(code: string, message: string, path?: string): EvolutionValidationIssue {
  return { code, message, severity: 'error', ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateEvolutionTaskAssignmentManifest(input: unknown): EvolutionValidationResult<EvolutionTaskAssignmentManifest> {
  if (!isRecord(input)) return { ok: false, issues: [issue('invalid_task_manifest', 'Manifest must be an object.')] };
  const issues: EvolutionValidationIssue[] = [];
  if (input.version !== EVOLUTION_TASK_ASSIGNMENT_MANIFEST_VERSION) issues.push(issue('invalid_task_manifest_version', 'version must equal 1.', 'version'));
  if (typeof input.runId !== 'string' || input.runId.length === 0) issues.push(issue('invalid_task_manifest_run', 'runId is required.', 'runId'));
  if (typeof input.changeSlug !== 'string' || input.changeSlug.length === 0) issues.push(issue('invalid_task_manifest_change', 'changeSlug is required.', 'changeSlug'));
  if (typeof input.revision !== 'number' || !Number.isInteger(input.revision) || input.revision < 1) issues.push(issue('invalid_task_manifest_revision', 'revision must be a positive integer.', 'revision'));
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) issues.push(issue('invalid_task_manifest_created', 'createdAt must be a finite number.', 'createdAt'));
  const rawAssignments = input.assignments;
  if (!Array.isArray(rawAssignments) || rawAssignments.length === 0 || rawAssignments.length > 200) {
    issues.push(issue('invalid_task_manifest_assignments', 'assignments must be a non-empty array (max 200).', 'assignments'));
    return { ok: false, issues };
  }
  const seen = new Set<string>();
  const assignments: EvolutionTaskAssignment[] = [];
  rawAssignments.forEach((raw, index) => {
    const path = `assignments[${index}]`;
    if (!isRecord(raw)) { issues.push(issue('invalid_task_assignment', 'Assignment must be an object.', path)); return; }
    if (!isEvolutionTaskId(raw.taskId)) { issues.push(issue('invalid_task_assignment_id', 'taskId must match t-<16 hex>.', `${path}.taskId`)); return; }
    if (seen.has(raw.taskId)) { issues.push(issue('duplicate_task_assignment_id', `Duplicate taskId: ${raw.taskId}`, `${path}.taskId`)); return; }
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0 || raw.label.length > 500) { issues.push(issue('invalid_task_assignment_label', 'label is required (max 500 chars).', `${path}.label`)); return; }
    if (typeof raw.ordinal !== 'number' || !Number.isInteger(raw.ordinal) || raw.ordinal < 0) { issues.push(issue('invalid_task_assignment_ordinal', 'ordinal must be a non-negative integer.', `${path}.ordinal`)); return; }
    if (typeof raw.makerRoleId !== 'string' || raw.makerRoleId.length === 0) { issues.push(issue('invalid_task_assignment_maker', 'makerRoleId is required.', `${path}.makerRoleId`)); return; }
    if (raw.assignmentSource !== 'heuristic_label_classification' && raw.assignmentSource !== 'agent_attested' && raw.assignmentSource !== 'checker_verified') {
      issues.push(issue('invalid_task_assignment_source', 'assignmentSource is not canonical.', `${path}.assignmentSource`));
      return;
    }
    seen.add(raw.taskId);
    assignments.push({
      taskId: raw.taskId,
      label: raw.label.trim(),
      ordinal: raw.ordinal,
      makerRoleId: raw.makerRoleId as EvolutionRoleId,
      ...(typeof raw.checkerRoleId === 'string' && raw.checkerRoleId.length > 0 ? { checkerRoleId: raw.checkerRoleId as EvolutionRoleId } : {}),
      assignmentSource: raw.assignmentSource,
    });
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: EVOLUTION_TASK_ASSIGNMENT_MANIFEST_VERSION,
      runId: input.runId as string,
      changeSlug: input.changeSlug as string,
      revision: input.revision as number,
      assignments,
      createdAt: input.createdAt as number,
    },
    issues: [],
  };
}

export interface EvolutionTaskManifestDiff {
  /** Manifest task ids with NO surviving annotation in tasks.md. */
  annotationLostTaskIds: string[];
  /** Annotations present in tasks.md that the manifest does not know. */
  unknownAnnotationTaskIds: string[];
  annotatedItemCount: number;
  unannotatedItemCount: number;
}

/**
 * Detection only (never silent relinking): compare the annotations surviving
 * in the parsed tasks.md items against the canonical manifest.
 */
export function diffTaskAnnotationsAgainstManifest(
  items: Array<{ taskId?: string }>,
  manifest: EvolutionTaskAssignmentManifest,
): EvolutionTaskManifestDiff {
  const manifestIds = new Set(manifest.assignments.map((assignment) => assignment.taskId));
  const presentIds = new Set(items.map((item) => item.taskId).filter((taskId): taskId is string => typeof taskId === 'string'));
  return {
    annotationLostTaskIds: [...manifestIds].filter((taskId) => !presentIds.has(taskId)),
    unknownAnnotationTaskIds: [...presentIds].filter((taskId) => !manifestIds.has(taskId)),
    annotatedItemCount: presentIds.size,
    unannotatedItemCount: items.length - items.filter((item) => typeof item.taskId === 'string').length,
  };
}

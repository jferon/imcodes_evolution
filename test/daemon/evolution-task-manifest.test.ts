import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  EVOLUTION_TASK_ASSIGNMENT_MANIFEST_RELATIVE_PATH,
  diffTaskAnnotationsAgainstManifest,
  formatEvolutionTaskAnnotation,
  splitEvolutionTaskLabel,
  validateEvolutionTaskAssignmentManifest,
} from '../../shared/evolution-task-manifest.js';
import { parseOpenSpecTasksMarkdown } from '../../shared/openspec-auto-deliver-validators.js';
import { annotateOpenSpecTasksMarkdown } from '../../src/daemon/evolution-stage-runner.js';
import {
  launchEvolutionRun,
  recordEvolutionOpenSpecProjection,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-taskman-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

const SAMPLE_TASKS = [
  '# Tasks',
  '',
  '- [ ] Map domain objects to data/API contracts; document migrations.',
  '- [ ] Implement or update UI screen "订单总览" with states default / empty.',
  '- [ ] Add or update automated tests for success and error paths.',
  '- [ ] Prepare staging deployment notes and rollback plan.',
  '',
  '```',
  '- [ ] this checkbox is inside a fence and must be ignored',
  '```',
].join('\n');

describe('annotation round-trip (#16)', () => {
  it('annotates every checkbox, produces a valid manifest, and the parser strips annotations into taskId', () => {
    const { markdown, manifest } = annotateOpenSpecTasksMarkdown(SAMPLE_TASKS, 'evo-task-1', 'change-x', 1_000);
    const validated = validateEvolutionTaskAssignmentManifest(manifest);
    expect(validated.ok).toBe(true);
    expect(manifest.assignments).toHaveLength(4);
    expect(new Set(manifest.assignments.map((assignment) => assignment.taskId)).size).toBe(4);
    for (const assignment of manifest.assignments) {
      expect(assignment.taskId).toMatch(/^t-[a-f0-9]{16}$/);
      expect(markdown).toContain(formatEvolutionTaskAnnotation(assignment.taskId));
      expect(assignment.assignmentSource).toBe('heuristic_label_classification');
    }
    // Fenced pseudo-checkbox untouched.
    expect(markdown).toContain('- [ ] this checkbox is inside a fence and must be ignored');

    const stats = parseOpenSpecTasksMarkdown(markdown);
    expect(stats.total).toBe(4);
    for (const item of stats.items) {
      expect(item.taskId).toMatch(/^t-[a-f0-9]{16}$/);
      expect(item.label).not.toContain('<!--'); // display labels are clean
    }
    // Heuristic classification is sensible and checker differs from maker.
    const byLabel = new Map(manifest.assignments.map((assignment) => [assignment.label, assignment]));
    expect(byLabel.get('Implement or update UI screen "订单总览" with states default / empty.')?.makerRoleId).toBe('frontend_developer');
    expect(byLabel.get('Add or update automated tests for success and error paths.')?.makerRoleId).toBe('qa_engineer');
    expect(byLabel.get('Add or update automated tests for success and error paths.')?.checkerRoleId).toBe('tech_director');
    expect(byLabel.get('Prepare staging deployment notes and rollback plan.')?.makerRoleId).toBe('ops_release_manager');
    expect(byLabel.get('Map domain objects to data/API contracts; document migrations.')?.makerRoleId).toBe('backend_developer');
  });

  it('is deterministic per (runId, changeSlug, ordinal, label) and legacy unannotated markdown stays unattributed', () => {
    const first = annotateOpenSpecTasksMarkdown(SAMPLE_TASKS, 'evo-task-1', 'change-x', 1_000);
    const second = annotateOpenSpecTasksMarkdown(SAMPLE_TASKS, 'evo-task-1', 'change-x', 2_000);
    expect(first.manifest.assignments.map((assignment) => assignment.taskId))
      .toEqual(second.manifest.assignments.map((assignment) => assignment.taskId));
    const otherRun = annotateOpenSpecTasksMarkdown(SAMPLE_TASKS, 'evo-task-2', 'change-x', 1_000);
    expect(otherRun.manifest.assignments[0]?.taskId).not.toBe(first.manifest.assignments[0]?.taskId);

    const legacy = parseOpenSpecTasksMarkdown(SAMPLE_TASKS);
    expect(legacy.items.every((item) => item.taskId === undefined)).toBe(true);
    expect(splitEvolutionTaskLabel('plain label').taskId).toBeUndefined();
  });
});

describe('desync diff — detection only', () => {
  it('reports lost and unknown annotations without relinking', () => {
    const { markdown, manifest } = annotateOpenSpecTasksMarkdown(SAMPLE_TASKS, 'evo-task-3', 'change-y', 1_000);
    const stats = parseOpenSpecTasksMarkdown(markdown);
    const clean = diffTaskAnnotationsAgainstManifest(stats.items, manifest);
    expect(clean.annotationLostTaskIds).toEqual([]);
    expect(clean.unknownAnnotationTaskIds).toEqual([]);

    // Agent rewrites the file: drops one annotation, invents another.
    const lostId = manifest.assignments[0]!.taskId;
    const mutated = markdown
      .replace(formatEvolutionTaskAnnotation(lostId), '')
      .replace('# Tasks', '# Tasks\n\n- [x] invented work <!-- task:t-deadbeefdeadbeef -->');
    const diff = diffTaskAnnotationsAgainstManifest(parseOpenSpecTasksMarkdown(mutated).items, manifest);
    expect(diff.annotationLostTaskIds).toEqual([lostId]);
    expect(diff.unknownAnnotationTaskIds).toEqual(['t-deadbeefdeadbeef']);
  });
});

describe('generation + passed-gate detection integration', () => {
  it('tasks_ready writes annotated tasks.md + a valid manifest artifact; tampering surfaces desync evidence at passed', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/task-manifest.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 需求\n\n实现订单看板，包含列表与统计。\n', 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 40_000,
      request: { requestId: 'req-task-manifest', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 41_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const changeName = autopilot.value.linkedOpenSpecChange!;
    const tasksPath = join(root, 'openspec/changes', changeName, 'tasks.md');
    const tasksMarkdown = await readFile(tasksPath, 'utf8');
    expect(tasksMarkdown).toMatch(/<!-- task:t-[a-f0-9]{16} -->/);
    const manifestRaw = await readFile(join(root, '.imc/evolution', launched.value.runId, EVOLUTION_TASK_ASSIGNMENT_MANIFEST_RELATIVE_PATH), 'utf8');
    const manifest = validateEvolutionTaskAssignmentManifest(JSON.parse(manifestRaw) as unknown);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.assignments.length).toBe(parseOpenSpecTasksMarkdown(tasksMarkdown).total);

    // Simulated agent rewrite loses one annotation.
    const lostId = manifest.value.assignments[0]!.taskId;
    await writeFile(tasksPath, tasksMarkdown.replace(formatEvolutionTaskAnnotation(lostId), ''), 'utf8');
    const updates = await recordEvolutionOpenSpecProjection({
      projection: {
        visibility: 'full',
        projectionVersion: 1,
        runId: 'auto_taskman',
        changeName,
        presetId: 'standard',
        materializedLimits: { specAuditRepairRounds: 1, implementationAuditRepairRounds: 2, maxImplementationPrompts: 12, maxElapsedMinutes: 480 },
        owningMainSessionName: 'deck_demo_brain',
        launchedFromSessionName: 'deck_demo_brain',
        targetImplementationSessionName: 'deck_demo_brain',
        generation: 1,
        implementationPromptCount: 1,
        elapsedMs: 500,
        status: 'passed',
        stage: 'passed',
        taskStats: { total: 1, checked: 1, unchecked: 0, items: [] },
        specAuditRepairRound: 0,
        implementationAuditRepairRound: 0,
        canStop: false,
        canContinue: false,
        moduleScores: [],
        evidence: [],
        lastMessage: 'passed',
      } as never,
      nowMs: 42_000,
    });
    const projection = updates.find((entry) => entry.runId === launched.value.runId);
    expect(projection?.evidence).toContainEqual(expect.objectContaining({
      source: 'task_manifest',
      summary: expect.stringContaining(`annotation_lost=[${lostId}]`),
    }));
    expect(projection?.evidence.some((entry) => entry.summary.includes('UNATTRIBUTED'))).toBe(true);
  });
});

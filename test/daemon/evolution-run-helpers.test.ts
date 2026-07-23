import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_EVIDENCE_ITEMS_MAX,
  EVOLUTION_LIVE_EVENTS_MAX,
} from '../../shared/evolution-pipeline-constants.js';
import type { EvolutionRun } from '../../shared/evolution-pipeline-types.js';
import {
  appendDiscussion,
  appendEvidence,
  appendLiveEvent,
  shortSha256,
  upsertArtifact,
  upsertScore,
} from '../../src/daemon/evolution-run-helpers.js';

function makeRun(): EvolutionRun {
  return {
    runId: 'run-helpers-test',
    requestId: 'req-helpers-test',
    stage: 'detected',
    sessionName: 'deck_test_brain',
    sourceRelativePath: 'inbox/requirements/brief.md',
    sourceSizeBytes: 1,
    createdAt: 1,
    updatedAt: 1,
    roles: [],
    artifacts: [],
    scores: [],
    evidence: [],
    blockingQuestions: [],
  } as unknown as EvolutionRun;
}

describe('evolution-run-helpers (shared single source of truth)', () => {
  it('appendEvidence caps at the shared EVOLUTION_EVIDENCE_ITEMS_MAX constant', () => {
    // Regression guard for the pre-extraction drift: the orchestrator's old
    // copy hardcoded `.slice(-200)` instead of importing the shared constant.
    const run = makeRun();
    for (let i = 0; i < EVOLUTION_EVIDENCE_ITEMS_MAX + 25; i++) {
      appendEvidence(run, { source: 'test', summary: `evidence-${i}`, createdAt: i });
    }
    expect(run.evidence).toHaveLength(EVOLUTION_EVIDENCE_ITEMS_MAX);
    expect(run.evidence[run.evidence.length - 1]!.summary).toBe(`evidence-${EVOLUTION_EVIDENCE_ITEMS_MAX + 24}`);
    // Oldest entries were dropped, newest kept.
    expect(run.evidence[0]!.summary).toBe('evidence-25');
  });

  it('appendDiscussion dedupes identical messages and assigns stable ids', () => {
    const run = makeRun();
    const message = { kind: 'role_update', stage: 'detected', text: 'hello', createdAt: 42 } as const;
    appendDiscussion(run, message as never);
    appendDiscussion(run, message as never);
    expect(run.discussion).toHaveLength(1);
    expect(run.discussion![0]!.id).toBe(
      `discussion-${shortSha256('role_update:detected:system:hello:42')}`,
    );
  });

  it('upsertArtifact replaces by id or path instead of appending duplicates', () => {
    const run = makeRun();
    const artifact = { id: 'kind:design/a.svg', kind: 'hifi_mockup', path: 'design/a.svg', title: 'v1', createdAt: 1 };
    upsertArtifact(run, artifact as never);
    upsertArtifact(run, { ...artifact, title: 'v2' } as never);
    expect(run.artifacts).toHaveLength(1);
    expect((run.artifacts[0] as { title: string }).title).toBe('v2');
  });

  it('upsertScore replaces per module', () => {
    const run = makeRun();
    upsertScore(run, { module: 'product', score: 5, maxScore: 10, summary: 'a', updatedAt: 1 } as never);
    upsertScore(run, { module: 'product', score: 8, maxScore: 10, summary: 'b', updatedAt: 2 } as never);
    expect(run.scores).toHaveLength(1);
    expect((run.scores[0] as { score: number }).score).toBe(8);
  });

  it('appendLiveEvent dedupes identical events and caps at EVOLUTION_LIVE_EVENTS_MAX', () => {
    const run = makeRun();
    const base = {
      source: 'taste_skill',
      kind: 'status',
      severity: 'info',
      stage: 'design_lofi',
      title: 'Taste-skill generation · started',
      detail: 'Running run-taste-skill.mjs (up to 10 min).',
    } as const;
    appendLiveEvent(run, { ...base, createdAt: 1 } as never);
    appendLiveEvent(run, { ...base, createdAt: 1 } as never); // identical → deduped
    expect(run.liveEvents).toHaveLength(1);
    // Distinct createdAt values keep repeated same-shaped events distinct.
    for (let i = 2; i <= EVOLUTION_LIVE_EVENTS_MAX + 10; i++) {
      appendLiveEvent(run, { ...base, createdAt: i } as never);
    }
    expect(run.liveEvents).toHaveLength(EVOLUTION_LIVE_EVENTS_MAX);
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  EVOLUTION_GATE_KIND_POLICIES,
  authorizeEvolutionGateAction,
  evolutionGateApprovalAssurance,
} from '../../shared/evolution-gate-policies.js';
import {
  applyEvolutionGateAction,
  launchEvolutionRun,
  openEvolutionTypedGate,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-gate-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('gate kind policy table', () => {
  it('keeps the risk gates human-only and never waivable', () => {
    for (const kind of ['design_review', 'development_mode', 'external_infrastructure', 'production_release'] as const) {
      expect(EVOLUTION_GATE_KIND_POLICIES[kind]).toEqual({ allowedActors: ['human'], waivable: false });
    }
  });

  it('authorizes by actor and action: system actors are rejected on human-only kinds and may never waive', () => {
    expect(authorizeEvolutionGateAction('product_review', 'approve', 'human').ok).toBe(true);
    expect(authorizeEvolutionGateAction('product_review', 'approve', 'system').ok).toBe(true);
    expect(authorizeEvolutionGateAction('product_review', 'waive', 'human').ok).toBe(true);

    const systemOnHuman = authorizeEvolutionGateAction('design_review', 'approve', 'system');
    expect(systemOnHuman).toEqual(expect.objectContaining({ ok: false, code: 'evolution_gate_actor_forbidden' }));
    const waiveRisk = authorizeEvolutionGateAction('production_release', 'waive', 'human');
    expect(waiveRisk).toEqual(expect.objectContaining({ ok: false, code: 'evolution_gate_waiver_forbidden' }));
    const systemWaive = authorizeEvolutionGateAction('planning_review', 'waive', 'system');
    expect(systemWaive).toEqual(expect.objectContaining({ ok: false, code: 'evolution_gate_waiver_forbidden' }));
  });

  it('maps approvals to honest assurance levels', () => {
    expect(evolutionGateApprovalAssurance('approve', 'human')).toBe('human_approved');
    expect(evolutionGateApprovalAssurance('approve', 'system')).toBe('checker_verified');
    expect(evolutionGateApprovalAssurance('waive', 'human')).toBe('waived');
  });
});

describe('typed gate actions with actor authorization', () => {
  async function launchToOpenDesignGate(root: string): Promise<{
    runId: string;
    gateId: string;
    candidateRevisionIds: string[];
    runRevision: number;
  }> {
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/gate-actor.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 门禁\n\n实现一个带人工审批的仪表盘功能。\n', 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 50_000,
      request: {
        requestId: `req-gate-${randomUUID().slice(0, 8)}`,
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        requireHifiHumanApproval: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) throw new Error('launch failed');
    const waiting = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 51_000 });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) throw new Error('autopilot failed');
    const gate = waiting.value.gates?.find((entry) => entry.kind === 'design_review' && entry.status === 'open');
    expect(gate).toBeDefined();
    return {
      runId: waiting.value.runId,
      gateId: gate!.id,
      candidateRevisionIds: gate!.candidateRevisionIds,
      runRevision: waiting.value.runRevision!,
    };
  }

  it('rejects a system actor on the human-only design_review gate and any waive attempt on it', async () => {
    const root = await makeRoot();
    const { runId, gateId, runRevision } = await launchToOpenDesignGate(root);

    const systemApprove = await applyEvolutionGateAction({
      runId,
      gateId,
      action: 'approve',
      actor: { type: 'system', id: 'auto-checker-1' },
      mutationId: 'gate-system-approve',
      expectedRunRevision: runRevision,
      nowMs: 52_000,
    });
    expect(systemApprove.ok).toBe(false);
    if (!systemApprove.ok) expect(systemApprove.issues[0]?.code).toBe('evolution_gate_actor_forbidden');

    const waive = await applyEvolutionGateAction({
      runId,
      gateId,
      action: 'waive',
      mutationId: 'gate-waive',
      expectedRunRevision: runRevision,
      feedback: 'trying to skip visual review',
      nowMs: 52_100,
    });
    expect(waive.ok).toBe(false);
    if (!waive.ok) expect(waive.issues[0]?.code).toBe('evolution_gate_waiver_forbidden');
  });

  it('opens a generic typed gate, honors system approval with checker_verified, and records the actor', async () => {
    const root = await makeRoot();
    const design = await launchToOpenDesignGate(root);

    // Open an architecture_review gate over the same existing revisions.
    const opened = await openEvolutionTypedGate({
      runId: design.runId,
      kind: 'architecture_review',
      candidateRevisionIds: design.candidateRevisionIds,
      nowMs: 53_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const archGate = opened.value.gates?.find((entry) => entry.kind === 'architecture_review' && entry.status === 'open');
    expect(archGate).toBeDefined();
    expect(archGate?.requiredAssurance).toBe('checker_verified');

    const approved = await applyEvolutionGateAction({
      runId: design.runId,
      gateId: archGate!.id,
      action: 'approve',
      actor: { type: 'system', id: 'architecture-checker' },
      mutationId: 'arch-system-approve',
      expectedRunRevision: opened.value.runRevision!,
      nowMs: 53_500,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    const resolved = approved.value.gates?.find((entry) => entry.id === archGate!.id);
    expect(resolved?.status).toBe('approved');
    expect(resolved?.decision).toEqual(expect.objectContaining({ actor: 'system', actorId: 'architecture-checker' }));
    // System approval never fabricates human_approved.
    for (const revisionId of archGate!.candidateRevisionIds) {
      expect(approved.value.artifactRevisions?.find((revision) => revision.id === revisionId)?.assurance)
        .toBe('checker_verified');
    }
    expect(approved.value.evidence).toContainEqual(expect.objectContaining({
      source: 'typed_gate',
      summary: expect.stringContaining('architecture_review'),
    }));
  });

  it('waives a waivable gate only with a justification and records waived assurance', async () => {
    const root = await makeRoot();
    const design = await launchToOpenDesignGate(root);
    const opened = await openEvolutionTypedGate({
      runId: design.runId,
      kind: 'planning_review',
      candidateRevisionIds: design.candidateRevisionIds,
      nowMs: 54_000,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const gate = opened.value.gates?.find((entry) => entry.kind === 'planning_review' && entry.status === 'open');
    expect(gate).toBeDefined();

    const noJustification = await applyEvolutionGateAction({
      runId: design.runId,
      gateId: gate!.id,
      action: 'waive',
      mutationId: 'plan-waive-nofeedback',
      expectedRunRevision: opened.value.runRevision!,
      nowMs: 54_100,
    });
    expect(noJustification.ok).toBe(false);
    if (!noJustification.ok) expect(noJustification.issues[0]?.code).toBe('evolution_gate_feedback_required');

    const waived = await applyEvolutionGateAction({
      runId: design.runId,
      gateId: gate!.id,
      action: 'waive',
      mutationId: 'plan-waive',
      expectedRunRevision: opened.value.runRevision!,
      feedback: '演示运行：规划复核由演示负责人线下确认。',
      nowMs: 54_200,
    });
    expect(waived.ok).toBe(true);
    if (!waived.ok) return;
    const resolved = waived.value.gates?.find((entry) => entry.id === gate!.id);
    expect(resolved?.status).toBe('waived');
    // Waived revisions are authorized to proceed but honestly marked waived.
    for (const revisionId of gate!.candidateRevisionIds) {
      expect(waived.value.artifactRevisions?.find((revision) => revision.id === revisionId)?.assurance).toBe('waived');
    }
  });

  it('refuses to open managed or invalid gates', async () => {
    const root = await makeRoot();
    const design = await launchToOpenDesignGate(root);
    const managed = await openEvolutionTypedGate({
      runId: design.runId,
      kind: 'design_review',
      candidateRevisionIds: design.candidateRevisionIds,
      nowMs: 55_000,
    });
    expect(managed.ok).toBe(false);
    if (!managed.ok) expect(managed.issues[0]?.code).toBe('evolution_gate_kind_managed');

    const missing = await openEvolutionTypedGate({
      runId: design.runId,
      kind: 'architecture_review',
      candidateRevisionIds: ['rev-does-not-exist'],
      nowMs: 55_100,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues[0]?.code).toBe('evolution_gate_revision_missing');
  });
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_APPROVAL_ACTOR_ASSURANCE_UNVERIFIED_LOCAL,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import {
  appendDispatchJournalRecord,
  currentDispatchJournalBootId,
  reconcileDispatchJournalOnStartup,
} from '../../src/daemon/auto-deliver-dispatch-journal.js';
import { preflightImplementationPromptBytes } from '../../src/daemon/openspec-auto-deliver-orchestrator.js';
import {
  approveEvolutionRoleSkillCandidate,
  launchEvolutionRun,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  updateEvolutionRoleSkill,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-e2-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('E2.3 — final payload preflight', () => {
  it('flags an oversized composed prompt instead of allowing a blind send', () => {
    const small = preflightImplementationPromptBytes('implement the tasks');
    expect(small.exceeded).toBe(false);
    const huge = preflightImplementationPromptBytes('x'.repeat(600 * 1024));
    expect(huge.exceeded).toBe(true);
    expect(huge.bytes).toBeGreaterThan(huge.limit);
  });
});

describe('E2.4 — dispatch journal', () => {
  it('reconciles prior-boot pending_send entries as interrupted; same-boot and accepted entries stay untouched', async () => {
    const root = await makeRoot();
    const journalPath = join(root, 'journal.jsonl');
    // Prior boot: crashed inside the send window.
    await appendDispatchJournalRecord({
      entryId: 'old-crashed', ts: 1, state: 'pending_send', runId: 'run-1', bootId: 'previous-boot',
    }, journalPath);
    // Prior boot: send was locally accepted — dispatch-scope terminal.
    await appendDispatchJournalRecord({
      entryId: 'old-sent', ts: 2, state: 'pending_send', runId: 'run-1', bootId: 'previous-boot',
    }, journalPath);
    await appendDispatchJournalRecord({
      entryId: 'old-sent', ts: 3, state: 'local_transport_accepted', runId: 'run-1', bootId: 'previous-boot',
    }, journalPath);
    // Current boot: in-flight, must not be reconciled by this boot.
    await appendDispatchJournalRecord({
      entryId: 'current-inflight', ts: 4, state: 'pending_send', runId: 'run-2', bootId: currentDispatchJournalBootId(),
    }, journalPath);

    const result = await reconcileDispatchJournalOnStartup(journalPath);
    expect(result.interruptedEntryIds).toEqual(['old-crashed']);
    const lines = (await readFile(journalPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { entryId: string; state: string });
    const reconciled = lines.filter((line) => line.state === 'reconciled_interrupted');
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]?.entryId).toBe('old-crashed');
    // Idempotence: a second reconciliation adds nothing (last state is now terminal).
    const again = await reconcileDispatchJournalOnStartup(journalPath);
    expect(again.interruptedEntryIds).toEqual([]);
  });
});

describe('E2.2 — approval votes carry honest local-actor assurance', () => {
  it('records unverified_local on every vote in deployments without authenticated identity', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/actor-honesty.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# 需求\n\n实现订单看板。\n', 'utf8');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: { requestId: 'req-actor-honesty', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const skillPath = join(root, '.imc/skills/evolution/backend-implementation.md');
    const original = await readFile(skillPath, 'utf8');
    const updated = await updateEvolutionRoleSkill({
      runId: launched.value.runId,
      roleId: 'backend_developer',
      markdown: `${original}\n## Team Overrides\n- Prefer idempotent handlers.\n`,
      nowMs: 30_500,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const candidate = updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'backend_developer');
    expect(candidate).toBeDefined();

    const approved = await approveEvolutionRoleSkillCandidate({
      runId: launched.value.runId,
      roleId: 'backend_developer',
      candidateArtifactId: candidate!.id,
      approverId: 'totally-real-cto',
      approvalMessage: 'looks good',
      nowMs: 31_000,
    });
    expect(approved.ok).toBe(true);

    const recordsDir = join(root, 'config/evolution/role-skills/approvals');
    const files = await readdir(recordsDir);
    expect(files.length).toBeGreaterThan(0);
    const record = JSON.parse(await readFile(join(recordsDir, files[0]!), 'utf8')) as {
      votes?: Array<{ approverId?: string; actorAssurance?: string }>;
    };
    expect(record.votes?.[0]).toEqual(expect.objectContaining({
      approverId: 'totally-real-cto',
      actorAssurance: EVOLUTION_APPROVAL_ACTOR_ASSURANCE_UNVERIFIED_LOCAL,
    }));
  });
});

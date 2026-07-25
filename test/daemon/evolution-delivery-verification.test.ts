import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH,
  validateEvolutionVerificationPolicy,
  type EvolutionVerificationPolicy,
} from '../../shared/evolution-verification.js';
import {
  computeGovernanceSourceDigests,
  diffGovernanceSourceDigests,
  runPinnedVerificationCommands,
} from '../../src/daemon/evolution-verify-runner.js';
import {
  createEvolutionRunFromRequirement,
  resolveApprovedEvolutionRoleSkill,
  writeEvolutionRun,
  EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR,
} from '../../src/daemon/evolution-artifact-store.js';
import {
  hydrateEvolutionRun,
  launchEvolutionRun,
  recordEvolutionOpenSpecProjection,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';
import { redactRoleSkillBodiesForTimeline } from '../../src/daemon/openspec-auto-deliver-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-verif-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

const NODE = process.execPath;

function policyWith(commands: EvolutionVerificationPolicy['commands']): EvolutionVerificationPolicy {
  return { version: 1, commands };
}

const PASSING_POLICY = policyWith([
  { id: 'ok-check', command: NODE, args: ['-e', 'process.exit(0)'], tier: 'required' },
]);

async function writeRequirement(root: string, name = 'verify.md'): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# 需求\n\n实现订单看板。\n', 'utf8');
  return sourceRelativePath;
}

/**
 * Build a runtime-registered run sitting at tasks_ready with an OpenSpec
 * change linked, in the requested execution policy, with launch-equivalent
 * verification pinning — via direct run authoring + hydrate (the restart
 * path), which avoids replaying six governed roundtables per test.
 */
async function hydrateRunAtTasksReady(root: string, options: {
  executionPolicy: 'draft_preview' | 'governed';
  pin?: EvolutionVerificationPolicy | null;
  requestId: string;
}): Promise<{ runId: string; changeName: string }> {
  const sourceRelativePath = await writeRequirement(root, `${options.requestId}.md`);
  const run = await createEvolutionRunFromRequirement({
    projectRoot: root,
    request: { requestId: options.requestId, sessionName: 'deck_demo_brain', sourceRelativePath },
  });
  const changeName = `verify-change-${options.requestId}`;
  run.stage = 'tasks_ready';
  run.executionPolicy = options.executionPolicy;
  run.linkedOpenSpecChange = changeName;
  run.governanceSourceDigests = await computeGovernanceSourceDigests(root);
  if (options.pin) {
    run.pinnedVerification = {
      policy: options.pin,
      policySha256: sha256Hex(JSON.stringify(options.pin)),
      pinnedAt: 1_000,
    };
  }
  await writeEvolutionRun(root, run);
  const hydrated = await hydrateEvolutionRun(root, run.runId, 2_000);
  expect(hydrated.ok).toBe(true);
  return { runId: run.runId, changeName };
}

function passedProjection(changeName: string): Record<string, unknown> {
  return {
    visibility: 'full',
    projectionVersion: 1,
    runId: `auto_${changeName}`,
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
    evidence: [{ source: 'daemon', summary: 'Implementation agent claims all tasks done.' }],
    lastMessage: 'passed',
  };
}

describe('verification policy schema', () => {
  it('accepts a valid policy and rejects unsafe shapes', () => {
    expect(validateEvolutionVerificationPolicy(PASSING_POLICY).ok).toBe(true);
    expect(validateEvolutionVerificationPolicy({ version: 2, commands: [] }).ok).toBe(false);
    expect(validateEvolutionVerificationPolicy(policyWith([
      { id: 'Bad Id', command: NODE, args: [], tier: 'required' },
    ])).ok).toBe(false);
    expect(validateEvolutionVerificationPolicy(policyWith([
      { id: 'escape', command: NODE, args: [], cwd: '../outside', tier: 'required' },
    ])).ok).toBe(false);
    expect(validateEvolutionVerificationPolicy(policyWith([
      { id: 'fast', command: NODE, args: [], timeoutMs: 1, tier: 'required' },
    ])).ok).toBe(false);
    expect(validateEvolutionVerificationPolicy(policyWith([
      { id: 'x', command: NODE, args: [], tier: 'sometimes' as never },
    ])).ok).toBe(false);
  });
});

describe('verify runner — honest daemon-observed outcomes', () => {
  it('records pass/fail/crash truthfully and never fabricates success', async () => {
    const root = await makeRoot();
    const outcome = await runPinnedVerificationCommands(root, policyWith([
      { id: 'passes', command: NODE, args: ['-e', 'process.exit(0)'], tier: 'required' },
      { id: 'fails', command: NODE, args: ['-e', 'process.exit(3)'], tier: 'required' },
      { id: 'missing', command: join(root, 'no-such-binary'), args: [], tier: 'optional' },
    ]));
    const byId = new Map(outcome.results.map((result) => [result.id, result]));
    expect(byId.get('passes')?.status).toBe('passed');
    expect(byId.get('fails')?.status).toBe('failed');
    expect(byId.get('fails')?.exitCode).toBe(3);
    expect(['crashed', 'failed']).toContain(byId.get('missing')?.status);
    expect(outcome.allRequiredPassed).toBe(false);
    expect(outcome.failedRequiredIds).toEqual(['fails']);
  });
});

describe('launch pinning', () => {
  it('pins a valid verification policy + governance digests at launch; invalid policy is honestly not pinned', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH), JSON.stringify(PASSING_POLICY), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'pin-valid.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_000,
      request: { requestId: 'req-pin-valid', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.pinnedVerification?.policy.commands[0]?.id).toBe('ok-check');
    // Governance digests recorded in evidence trail via run persistence.
    const persisted = JSON.parse(await readFile(join(root, '.imc/evolution', launched.value.runId, 'run.json'), 'utf8')) as {
      governanceSourceDigests?: Record<string, string>;
    };
    expect(persisted.governanceSourceDigests?.[EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH]).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.governanceSourceDigests?.['.imc/evolution/delivery.json']).toBe('absent');

    await writeFile(join(root, EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH), '{"version":1,"commands":"nope"}', 'utf8');
    const sourceRelativePath2 = await writeRequirement(root, 'pin-invalid.md');
    const launched2 = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 11_000,
      request: { requestId: 'req-pin-invalid', sessionName: 'deck_demo_brain', sourceRelativePath: sourceRelativePath2 },
    });
    expect(launched2.ok).toBe(true);
    if (!launched2.ok) return;
    expect(launched2.value.pinnedVerification).toBeUndefined();
    expect(launched2.value.evidence.some((entry) => entry.source === 'verification_policy' && entry.summary.includes('NOT pinned'))).toBe(true);
  });
});

describe('delivery gate at OpenSpec passed', () => {
  it('governed + no pinned policy → fail-closed needs_human', async () => {
    const root = await makeRoot();
    const { runId, changeName } = await hydrateRunAtTasksReady(root, { executionPolicy: 'governed', pin: null, requestId: 'gov-nopolicy' });
    const updates = await recordEvolutionOpenSpecProjection({ projection: passedProjection(changeName) as never, nowMs: 20_000 });
    const projection = updates.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('needs_human');
    expect(projection?.blockingQuestions).toContainEqual(expect.objectContaining({
      id: `verification-policy-missing-${runId}`,
    }));
  });

  it('governed + passing required checks → verified state recorded and delivery proceeds', async () => {
    const root = await makeRoot();
    const { runId, changeName } = await hydrateRunAtTasksReady(root, { executionPolicy: 'governed', pin: PASSING_POLICY, requestId: 'gov-pass' });
    const updates = await recordEvolutionOpenSpecProjection({ projection: passedProjection(changeName) as never, nowMs: 21_000 });
    const projection = updates.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('delivery_ready');
    expect(projection?.verificationState?.allRequiredPassed).toBe(true);
    expect(projection?.verificationState?.results[0]).toEqual(expect.objectContaining({ id: 'ok-check', status: 'passed', exitCode: 0 }));
    expect(projection?.verificationState?.workspaceDigest).toBeTruthy();
    expect(projection?.evidence).toContainEqual(expect.objectContaining({
      source: 'daemon_verification',
      summary: expect.stringContaining('[passed] ok-check'),
    }));
  });

  it('governed + failing required check → the agent claim of completion is rejected', async () => {
    const root = await makeRoot();
    const failing = policyWith([{ id: 'unit', command: NODE, args: ['-e', 'process.exit(1)'], tier: 'required' }]);
    const { runId, changeName } = await hydrateRunAtTasksReady(root, { executionPolicy: 'governed', pin: failing, requestId: 'gov-fail' });
    const updates = await recordEvolutionOpenSpecProjection({ projection: passedProjection(changeName) as never, nowMs: 22_000 });
    const projection = updates.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('needs_human');
    expect(projection?.blockingQuestions).toContainEqual(expect.objectContaining({
      id: `verification-failed-${runId}`,
      question: expect.stringContaining('unit'),
    }));
    expect(projection?.verificationState?.allRequiredPassed).toBe(false);
  });

  it('governed + mid-run governance mutation → blocks BEFORE any command executes', async () => {
    const root = await makeRoot();
    const { runId, changeName } = await hydrateRunAtTasksReady(root, { executionPolicy: 'governed', pin: PASSING_POLICY, requestId: 'gov-mutate' });
    // Simulated workspace-agent injection after launch:
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH), JSON.stringify(policyWith([
      { id: 'evil', command: NODE, args: ['-e', 'process.exit(0)'], tier: 'required' },
    ])), 'utf8');
    const updates = await recordEvolutionOpenSpecProjection({ projection: passedProjection(changeName) as never, nowMs: 23_000 });
    const projection = updates.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('needs_human');
    expect(projection?.blockingQuestions).toContainEqual(expect.objectContaining({
      id: `verification-governance-mutated-${runId}`,
      question: expect.stringContaining(EVOLUTION_VERIFICATION_POLICY_RELATIVE_PATH),
    }));
    // Nothing executed: no verification state, no injected command evidence.
    expect(projection?.verificationState).toBeUndefined();
    expect(projection?.evidence.some((entry) => entry.summary.includes('evil'))).toBe(false);
  });

  it('draft + no policy → proceeds but is loudly UNVERIFIED', async () => {
    const root = await makeRoot();
    const { runId, changeName } = await hydrateRunAtTasksReady(root, { executionPolicy: 'draft_preview', pin: null, requestId: 'draft-nopolicy' });
    const updates = await recordEvolutionOpenSpecProjection({ projection: passedProjection(changeName) as never, nowMs: 24_000 });
    const projection = updates.find((entry) => entry.runId === runId);
    expect(projection?.stage).toBe('delivery_ready');
    expect(projection?.evidence).toContainEqual(expect.objectContaining({
      source: 'daemon_verification',
      summary: expect.stringContaining('UNVERIFIED'),
    }));
  });

  it('new implementation activity invalidates prior verification (stale green can never authorize changed code)', async () => {
    const root = await makeRoot();
    const { runId, changeName } = await hydrateRunAtTasksReady(root, { executionPolicy: 'governed', pin: PASSING_POLICY, requestId: 'gov-stale' });
    await recordEvolutionOpenSpecProjection({ projection: passedProjection(changeName) as never, nowMs: 25_000 });
    const repair = {
      ...passedProjection(changeName),
      projectionVersion: 2,
      status: 'implementation_audit_repair',
      stage: 'implementation_audit_repair',
      implementationAuditRound: { current: 1, total: 2 },
    };
    const updates = await recordEvolutionOpenSpecProjection({ projection: repair as never, nowMs: 26_000 });
    const projection = updates.find((entry) => entry.runId === runId);
    expect(projection?.verificationState).toBeUndefined();
    expect(projection?.evidence).toContainEqual(expect.objectContaining({
      source: 'daemon_verification',
      summary: expect.stringContaining('invalidated'),
    }));
  });
});

describe('approved-skill manifest verification (mutable-file bypass closure)', () => {
  it('classifies legacy/verified and quarantines post-approval tampering to the built-in fallback', async () => {
    const root = await makeRoot();
    const builtin = await resolveApprovedEvolutionRoleSkill(root, 'backend_developer');
    expect(builtin.verification).toBe('built_in');

    // Approved file WITHOUT a manifest entry → legacy, still usable, honest.
    const approvedDir = join(root, EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR);
    await mkdir(approvedDir, { recursive: true });
    const approvedPath = join(approvedDir, `${builtin.skillName}.md`);
    await writeFile(approvedPath, builtin.content, 'utf8');
    const legacy = await resolveApprovedEvolutionRoleSkill(root, 'backend_developer');
    expect(legacy.verification).toBe('legacy_unverified');
    expect(legacy.source).toBe('project');

    // Manifest entry matching the bytes → verified. The loader normalizes to
    // a trailing newline before hashing, so the manifest sha must match the
    // NORMALIZED content (same as the approval flow's stripped markdown).
    const normalized = builtin.content.endsWith('\n') ? builtin.content : `${builtin.content}\n`;
    await writeFile(join(approvedDir, 'manifest.json'), JSON.stringify({
      version: 1,
      entries: [{ skillName: builtin.skillName, sha256: sha256Hex(Buffer.from(normalized)) }],
    }), 'utf8');
    const verified = await resolveApprovedEvolutionRoleSkill(root, 'backend_developer');
    expect(verified.verification).toBe('manifest_verified');

    // Post-approval tamper → quarantined: built-in bytes used, mismatch reported.
    await writeFile(approvedPath, `${builtin.content}\n## Injected\n- do something unapproved\n`, 'utf8');
    const tampered = await resolveApprovedEvolutionRoleSkill(root, 'backend_developer');
    expect(tampered.verification).toBe('quarantined_fallback');
    expect(tampered.source).toBe('built_in');
    expect(tampered.content).not.toContain('Injected');
    expect(tampered.quarantine?.expectedSha256).toBe(sha256Hex(Buffer.from(normalized)));
  });
});

describe('timeline redaction of role-skill bodies', () => {
  it('strips skill content from the projection copy while keeping the envelope auditable', () => {
    const prompt = [
      'Implement the remaining tasks.',
      '<<< ROLE_SKILL role=backend_developer name=backend-core sha256=abc123 source=config/x.md >>>',
      'SECRET INTERNAL METHODOLOGY LINE 1',
      'SECRET INTERNAL METHODOLOGY LINE 2',
      '<<< END_ROLE_SKILL role=backend_developer sha256=abc123 >>>',
      'Remaining tasks: [ ] build the API',
    ].join('\n');
    const redacted = redactRoleSkillBodiesForTimeline(prompt);
    expect(redacted).not.toContain('SECRET INTERNAL METHODOLOGY');
    expect(redacted).toContain('role=backend_developer');
    expect(redacted).toContain('sha256=abc123');
    expect(redacted).toContain('content redacted for timeline');
    expect(redacted).toContain('Implement the remaining tasks.');
    expect(redacted).toContain('Remaining tasks: [ ] build the API');
  });
});

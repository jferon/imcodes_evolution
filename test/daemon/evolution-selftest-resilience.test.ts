import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
  EVOLUTION_PROJECT_POLICY_RELATIVE_PATH,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import { validateEvolutionProjectPolicy } from '../../shared/evolution-pipeline-validators.js';
import {
  EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH,
  EVOLUTION_SELFTEST_REQUIREMENT_RELATIVE_PATH,
  runEvolutionSelftestSetup,
} from '../../src/cli/evolution-selftest.js';
import {
  getEvolutionRun,
  hydrateEvolutionRun,
  launchEvolutionRun,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
} from '../../src/daemon/evolution-orchestrator.js';

const execFileAsync = promisify(execFile);

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-resil-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

async function writeRequirement(root: string, name: string): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# 需求\n\n实现一个订单看板，包含列表与 GMV 统计。\n', 'utf8');
  return sourceRelativePath;
}

describe('P6.1a — daemon restart recovery (hydrate from disk)', () => {
  it('reloads a governed run from disk with governance records intact and stays resumable', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'restart-recovery.md');
    setEvolutionRoundtableLauncher(async (request) => ({
      ok: true,
      p2pRunId: `p2p_${request.roundtableSpecId}`,
      discussionId: `dsc_${request.roundtableSpecId}`,
      contextPath: `.imc/discussions/${request.roundtableSpecId}.md`,
    }));
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 80_000,
      request: {
        requestId: 'req-restart-recovery',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const runId = launched.value.runId;
    await runEvolutionAutopilot(runId, null, { nowMs: 81_000 });
    const before = getEvolutionRun(runId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    // Governed launch produced real governance state worth surviving a restart.
    expect(before.value.attempts?.length ?? 0).toBeGreaterThan(0);
    expect(before.value.roundtables.length).toBeGreaterThan(0);

    // Simulated restart: hydrate replaces the in-memory entry with what is
    // actually persisted on disk — nothing may silently vanish.
    const hydrated = await hydrateEvolutionRun(root, runId, 82_000);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.value.stage).toBe(before.value.stage);
    expect(hydrated.value.executionPolicy).toBe('governed');
    expect(hydrated.value.roundtableGateMode).toBe('strict');
    expect(hydrated.value.attempts?.map((attempt) => attempt.id).sort())
      .toEqual(before.value.attempts?.map((attempt) => attempt.id).sort());
    expect(hydrated.value.roundtables.map((roundtable) => `${roundtable.id}:${roundtable.status}`).sort())
      .toEqual(before.value.roundtables.map((roundtable) => `${roundtable.id}:${roundtable.status}`).sort());
    expect(hydrated.value.runRevision).toBe(before.value.runRevision);
    // The reloaded run still enforces the strict gate: autopilot must not
    // silently advance past the waiting roundtable after the restart.
    const resumed = await runEvolutionAutopilot(runId, null, { nowMs: 83_000 });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.stage).toBe(before.value.stage);
  });
});

describe('P6.1b — launcher fault injection', () => {
  it('a THROWING roundtable launcher degrades to a failed roundtable + strict-gate block, never an unhandled rejection', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'crash-roundtable.md');
    setEvolutionRoundtableLauncher(async () => {
      throw new Error('simulated network partition');
    });
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 90_000,
      request: {
        requestId: 'req-crash-roundtable',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 91_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const run = getEvolutionRun(launched.value.runId);
    const maker = run.ok ? run.value.roundtables.find((entry) => entry.id === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID) : undefined;
    expect(maker?.status).toBe('failed');
    expect(maker?.error).toContain('roundtable_launcher_crashed');
    expect(maker?.error).toContain('simulated network partition');
    // Fail-closed: the crash is a hard block, not a silent local PASS.
    expect(run.ok && run.value.stage).toBe('needs_human');
  });

  it('a THROWING auto-deliver launcher blocks delivery with the crash reason instead of rejecting', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'crash-autodeliver.md');
    setEvolutionAutoDeliverLauncher(async () => {
      throw new Error('simulated daemon OOM');
    });
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 95_000,
      request: {
        requestId: 'req-crash-autodeliver',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, { send() { /* ignore */ } }, { nowMs: 96_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('needs_human');
    expect(autopilot.value.blockingQuestions).toContainEqual(expect.objectContaining({
      question: expect.stringContaining('openspec_auto_deliver_launcher_crashed'),
    }));
  });
});

describe('P6.2 — screenshot script honest failure contract', () => {
  it('exits non-zero without writing output when the preview is missing or playwright is absent', async () => {
    const root = await makeRoot();
    const scriptPath = join(process.cwd(), 'scripts/evolution-screenshot.mjs');
    const outputPath = join(root, 'shot.png');

    // Missing preview → honest failure, no output file.
    const missingPreview = await execFileAsync('node', [scriptPath, join(root, 'nope.html'), outputPath, '1440', '900'], { cwd: root })
      .then(() => null)
      .catch((error: { code?: number; stderr?: string }) => error);
    expect(missingPreview?.code).toBe(1);
    expect(missingPreview?.stderr).toContain('preview file not found');
    await expect(stat(outputPath)).rejects.toThrow();

    // Preview exists but playwright is not installed in the temp cwd → the
    // script must say so honestly (or capture successfully if the host repo
    // provides playwright — both are honest outcomes; silence is not).
    await writeFile(join(root, 'preview.html'), '<html><body id="screen-1">ok</body></html>', 'utf8');
    const noPlaywright = await execFileAsync('node', [scriptPath, join(root, 'preview.html'), outputPath, '1440', '900', '#screen-1'], { cwd: root })
      .then(() => null)
      .catch((error: { code?: number; stderr?: string }) => error);
    if (noPlaywright) {
      expect(noPlaywright.code).toBe(1);
      expect(noPlaywright.stderr).toMatch(/playwright is not installed|render failed/);
      await expect(stat(outputPath)).rejects.toThrow();
    } else {
      await expect(stat(outputPath)).resolves.toBeDefined();
    }
  });
});

describe('P6.3 — governed self-test scaffolder', () => {
  it('scaffolds a valid governed policy, screenshot wiring, and a substantive requirement — idempotently', async () => {
    const root = await makeRoot();
    const first = await runEvolutionSelftestSetup(root);
    expect(first.files.map((file) => file.status)).toEqual(['created', 'created', 'created']);
    expect(first.runbook.length).toBeGreaterThanOrEqual(4);

    const policyRaw = JSON.parse(await readFile(join(root, EVOLUTION_PROJECT_POLICY_RELATIVE_PATH), 'utf8')) as unknown;
    const policy = validateEvolutionProjectPolicy(policyRaw);
    expect(policy.ok).toBe(true);
    if (policy.ok) {
      expect(policy.value.executionPolicy).toBe('governed');
      expect(policy.value.roundtableGateMode).toBe('strict');
      expect(policy.value.requireHifiHumanApproval).toBe(true);
    }
    const design = JSON.parse(await readFile(join(root, EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH), 'utf8')) as {
      screenshot?: { enabled?: boolean; command?: string; args?: string[] };
    };
    expect(design.screenshot?.enabled).toBe(true);
    expect(design.screenshot?.args?.join(' ')).toContain('evolution-screenshot.mjs');
    expect(design.screenshot?.args?.join(' ')).toContain('{previewPath}');
    const requirement = await readFile(join(root, EVOLUTION_SELFTEST_REQUIREMENT_RELATIVE_PATH), 'utf8');
    expect(requirement.trim().length).toBeGreaterThan(300);
    expect(requirement).toContain('验收标准');

    // Second run never overwrites user-edited files.
    await writeFile(join(root, EVOLUTION_PROJECT_POLICY_RELATIVE_PATH), '{"version":1,"executionPolicy":"draft_preview"}\n', 'utf8');
    const second = await runEvolutionSelftestSetup(root);
    expect(second.files.every((file) => file.status === 'skipped_exists')).toBe(true);
    expect(await readFile(join(root, EVOLUTION_PROJECT_POLICY_RELATIVE_PATH), 'utf8')).toContain('draft_preview');
  });
});

describe('P6.3+ — scaffolder generates a real verification policy from package.json scripts', () => {
  it('creates verification.json with detected commands, and honestly skips it when no scripts exist', async () => {
    const root = await makeRoot();
    // No package.json → no fabricated always-green policy.
    const bare = await runEvolutionSelftestSetup(root);
    expect(bare.files.some((file) => file.relativePath.includes('verification.json'))).toBe(false);
    expect(bare.runbook.some((line) => line.includes('verification_policy_missing'))).toBe(true);

    const root2 = await mkdtemp(join(tmpdir(), `imcodes-evolution-resil-${randomUUID().slice(0, 8)}-`));
    try {
      await writeFile(join(root2, 'package.json'), JSON.stringify({
        name: 'target', scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', build: 'vite build' },
      }), 'utf8');
      const scaffolded = await runEvolutionSelftestSetup(root2);
      const verification = scaffolded.files.find((file) => file.relativePath.includes('verification.json'));
      expect(verification?.status).toBe('created');
      const { validateEvolutionVerificationPolicy } = await import('../../shared/evolution-verification.js');
      const parsed = validateEvolutionVerificationPolicy(
        JSON.parse(await readFile(join(root2, verification!.relativePath), 'utf8')) as unknown,
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.commands.map((command) => command.id).sort()).toEqual(['build', 'typecheck', 'unit']);
        expect(parsed.value.commands.filter((command) => command.tier === 'required').map((command) => command.id).sort()).toEqual(['typecheck', 'unit']);
      }
      expect(scaffolded.runbook.some((line) => line.includes('daemon 亲测'))).toBe(true);
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });
});

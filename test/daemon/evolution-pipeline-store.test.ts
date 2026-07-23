import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  createEvolutionRunFromRequirement,
  EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR,
  readEvolutionRun,
} from '../../src/daemon/evolution-artifact-store.js';
import { EvolutionInboxPoller, scanEvolutionRequirementInbox } from '../../src/daemon/evolution-inbox-watcher.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('evolution artifact store and inbox scanner', () => {
  it('scans stable requirement documents and ignores unsupported files', async () => {
    const root = await makeRoot();
    const inbox = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR);
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, 'brief.md'), '# Brief\n', 'utf8');
    await writeFile(join(inbox, 'brief.pdf'), '%PDF', 'utf8');

    const candidates = await scanEvolutionRequirementInbox(root, { nowMs: Date.now() + 10_000, stableMs: 0 });

    expect(candidates.map((candidate) => candidate.sourceRelativePath)).toEqual([
      `${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`,
    ]);
  });

  it('persists inbox poller seen identities across daemon-style poller restarts', async () => {
    const root = await makeRoot();
    const inbox = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR);
    await mkdir(inbox, { recursive: true });
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`;
    await writeFile(join(root, sourceRelativePath), '# Brief\n', 'utf8');
    const triggered: string[] = [];
    const stableNowMs = Date.now() + 60_000;

    const firstPoller = new EvolutionInboxPoller({
      projectRoot: root,
      nowMs: stableNowMs,
      stableMs: 0,
      onCandidate(candidate) {
        triggered.push(candidate.sourceRelativePath);
      },
    });
    await expect(firstPoller.scanOnce()).resolves.toHaveLength(1);

    const restartedPoller = new EvolutionInboxPoller({
      projectRoot: root,
      nowMs: stableNowMs,
      stableMs: 0,
      onCandidate(candidate) {
        triggered.push(candidate.sourceRelativePath);
      },
    });
    await expect(restartedPoller.scanOnce()).resolves.toHaveLength(0);

    await writeFile(join(root, sourceRelativePath), '# Brief\n\nUpdated scope.\n', 'utf8');
    const changedFilePoller = new EvolutionInboxPoller({
      projectRoot: root,
      nowMs: stableNowMs + 1_000,
      stableMs: 0,
      onCandidate(candidate) {
        triggered.push(candidate.sourceRelativePath);
      },
    });
    await expect(changedFilePoller.scanOnce()).resolves.toHaveLength(1);

    expect(triggered).toEqual([sourceRelativePath, sourceRelativePath]);
    const ledger = JSON.parse(await readFile(join(root, '.imc/evolution/inbox-ledger.json'), 'utf8')) as { version?: number; seen?: string[] };
    expect(ledger.version).toBe(1);
    expect(ledger.seen).toHaveLength(2);
  });

  it('creates a run ledger, copies the input artifact, and can read the run back', async () => {
    const root = await makeRoot();
    const inbox = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR);
    await mkdir(inbox, { recursive: true });
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/checkout.md`;
    await writeFile(join(root, sourceRelativePath), '# Checkout\n', 'utf8');

    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      nowMs: 1_000,
      request: {
        requestId: 'req-1',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });

    expect(run.stage).toBe('detected');
    expect(run.roundtableGateMode).toBe('planning');
    expect(run.artifacts[0]?.path).toBe('input/checkout.md');
    expect(run.artifacts.filter((artifact) => artifact.kind === 'role_skill')).toHaveLength(12);
    const productSkillArtifact = run.artifacts.find((artifact) => artifact.roleId === 'product_manager' && artifact.kind === 'role_skill');
    expect(productSkillArtifact?.path).toBe('.imc/skills/evolution/product-prd.md');
    expect(productSkillArtifact?.preview).toEqual(expect.objectContaining({
      previewType: 'markdown',
      language: 'markdown',
    }));
    expect(productSkillArtifact?.preview?.content).toContain('# 产品经理');
    expect(run.roles.find((role) => role.roleId === 'loop_supervisor')?.status).toBe('running');

    const reloaded = await readEvolutionRun(root, run.runId);
    expect(reloaded.runId).toBe(run.runId);
    expect(reloaded.roundtableGateMode).toBe('planning');
    await expect(readFile(join(root, '.imc/evolution', run.runId, 'input/checkout.md'), 'utf8')).resolves.toBe('# Checkout\n');
    await expect(readFile(join(root, '.imc/skills/evolution/product-prd.md'), 'utf8')).resolves.toContain('name: product-prd');
    await expect(readFile(join(root, '.imc/skills/evolution/ops-release.md'), 'utf8')).resolves.toContain('production 必须人工确认');
  });

  it('preserves existing project evolution skill files while registering them as artifacts', async () => {
    const root = await makeRoot();
    const inbox = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR);
    await mkdir(inbox, { recursive: true });
    await mkdir(join(root, '.imc/skills/evolution'), { recursive: true });
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/custom-skill.md`;
    const customSkill = [
      '---',
      'name: product-prd',
      'category: evolution',
      'description: custom product skill',
      '---',
      '',
      '# Custom Product Skill',
      'Keep my team-specific PRD rules.',
      '',
    ].join('\n');
    await writeFile(join(root, sourceRelativePath), '# Custom Skill\n', 'utf8');
    await writeFile(join(root, '.imc/skills/evolution/product-prd.md'), customSkill, 'utf8');

    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      nowMs: 2_000,
      request: {
        requestId: 'req-custom-skill',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });

    const productSkillArtifact = run.artifacts.find((artifact) => artifact.path === '.imc/skills/evolution/product-prd.md');
    expect(productSkillArtifact?.kind).toBe('role_skill');
    expect(productSkillArtifact?.preview?.content).toContain('Keep my team-specific PRD rules.');
    await expect(readFile(join(root, '.imc/skills/evolution/product-prd.md'), 'utf8')).resolves.toBe(customSkill);
  });

  it('seeds project role skills from approved evolution skill library templates', async () => {
    const root = await makeRoot();
    const inbox = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR);
    await mkdir(inbox, { recursive: true });
    await mkdir(join(root, EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR), { recursive: true });
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/approved-library.md`;
    const approvedProductSkill = [
      '---',
      'name: product-prd',
      'category: evolution',
      'description: approved org product skill',
      '---',
      '',
      '# Approved Product Skill',
      'Use the organization PRD template and explicit pricing assumptions.',
      '',
    ].join('\n');
    await writeFile(join(root, sourceRelativePath), '# Approved Library\n', 'utf8');
    await writeFile(join(root, EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR, 'product-prd.md'), approvedProductSkill, 'utf8');

    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      nowMs: 2_500,
      request: {
        requestId: 'req-approved-library',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });

    const productSkillArtifact = run.artifacts.find((artifact) => artifact.roleId === 'product_manager' && artifact.kind === 'role_skill');
    const libraryArtifact = run.artifacts.find((artifact) => artifact.roleId === 'product_manager' && artifact.kind === 'role_skill_library');
    expect(productSkillArtifact?.preview?.content).toContain('organization PRD template');
    expect(libraryArtifact?.path).toBe(`${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/product-prd.md`);
    await expect(readFile(join(root, '.imc/skills/evolution/product-prd.md'), 'utf8')).resolves.toBe(approvedProductSkill);
  });

  it('persists strict roundtable gate mode from launch requests', async () => {
    const root = await makeRoot();
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/strict-gates.md`;
    await writeFile(join(root, sourceRelativePath), '# Strict Gates\n', 'utf8');

    const run = await createEvolutionRunFromRequirement({
      projectRoot: root,
      nowMs: 3_000,
      request: {
        requestId: 'req-strict-gates',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        roundtableGateMode: 'strict',
      },
    });

    expect(run.roundtableGateMode).toBe('strict');
    await expect(readEvolutionRun(root, run.runId)).resolves.toEqual(expect.objectContaining({
      roundtableGateMode: 'strict',
    }));
  });
});

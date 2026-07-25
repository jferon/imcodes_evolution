import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVOLUTION_ROLE_SKILL_DEFINITIONS,
  resolveApprovedEvolutionRoleSkill,
} from '../../src/daemon/evolution-artifact-store.js';
import {
  describeEffectiveSkillResolution,
  resolveEffectiveRoleSkill,
} from '../../src/daemon/evolution-skill-resolution.js';
import { EVOLUTION_ROLE_EVAL_CLASSIFICATION } from '../../src/daemon/evolution-role-evals.js';
import baseline from '../fixtures/evolution-role-skills/builtin-baseline.json';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-resolve-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('E3.1 — baseline classification and builtin body freeze (#1)', () => {
  it('the substring evals are labeled a static contract lint, not expert evaluation', () => {
    expect(EVOLUTION_ROLE_EVAL_CLASSIFICATION).toBe('static_contract_lint');
  });

  it('every built-in role skill body matches its frozen baseline hash — silent drift fails', async () => {
    const root = await makeRoot();
    const entries = (baseline as { entries: Record<string, string> }).entries;
    expect(Object.keys(entries)).toHaveLength(12);
    for (const definition of EVOLUTION_ROLE_SKILL_DEFINITIONS) {
      const resolved = await resolveApprovedEvolutionRoleSkill(root, definition.roleId);
      expect(resolved.source).toBe('built_in');
      // Intentional playbook changes must update the baseline manifest in the
      // SAME commit — that is the conscious-change ritual this test enforces.
      expect(`${definition.skillName}:${resolved.sha256}`).toBe(`${definition.skillName}:${entries[definition.skillName]}`);
    }
  });
});

describe('E3.2 — central effective-skill resolver (#4)', () => {
  it('returns a typed resolution with consumer identity and honest verification', async () => {
    const root = await makeRoot();
    const resolution = await resolveEffectiveRoleSkill(root, 'backend_developer', 'auto_deliver_implementation', 1_000);
    expect(resolution).toEqual(expect.objectContaining({
      roleId: 'backend_developer',
      consumer: 'auto_deliver_implementation',
      sourceClass: 'built_in',
      verification: 'built_in',
      capturedAt: 1_000,
    }));
    expect(resolution.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resolution.contentBytes).toBeGreaterThan(0);
    const summary = describeEffectiveSkillResolution(resolution);
    expect(summary).toContain('consumer=auto_deliver_implementation');
    expect(summary).toContain('verification=built_in');
  });
});

describe('E3.2 — bypass enumeration (#5): no direct resolveApprovedEvolutionRoleSkill consumers', () => {
  it('only the artifact store (definition) and the central resolver may reference the raw resolution function', async () => {
    const allowed = new Set([
      'evolution-artifact-store.ts',    // definition site
      'evolution-skill-resolution.ts',  // the single sanctioned wrapper
    ]);
    const daemonDir = join(process.cwd(), 'src/daemon');
    const offenders: string[] = [];
    for (const file of await readdir(daemonDir)) {
      if (!file.endsWith('.ts') || allowed.has(file)) continue;
      const content = await readFile(join(daemonDir, file), 'utf8');
      if (content.includes('resolveApprovedEvolutionRoleSkill')) offenders.push(file);
    }
    // A new direct consumer must go through resolveEffectiveRoleSkill instead
    // (typed consumer identity + audit summary) — add it there, not here.
    expect(offenders).toEqual([]);
  });
});

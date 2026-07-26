#!/usr/bin/env node
/**
 * DEV TOOL (discussion 30f25d75-67c, checklist #13): regenerate the frozen
 * C0 treatment fixtures under test/fixtures/evolution-role-evaluation/.
 *
 * The weak baseline is rendered INSIDE a git worktree pinned to the
 * pre-expansion commit, using the renderer AS OF THAT COMMIT — never the
 * current renderer — so treatment bytes measure skill content, not template
 * drift (round-6 requirement: "historical executable bytes must be stored
 * once, not dynamically rebuilt with today's renderer").
 *
 * Production code must never run git extraction; fixtures are committed and
 * verified by test/daemon/evolution-role-evaluation.test.ts.
 *
 * Usage: node scripts/extract-evolution-role-evaluation-baseline.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const WEAK_COMMIT = '9107008'; // last commit before feat(evolution): strengthen expert role skills
const OUT_DIR = join(REPO_ROOT, 'test/fixtures/evolution-role-evaluation/treatments');

function extractionScript(storePath, outPath, treatmentId, provenance) {
  return `
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveApprovedEvolutionRoleSkill, EVOLUTION_ROLE_SKILL_DEFINITIONS } from '${storePath}';
const root = mkdtempSync(join(tmpdir(), 'treatment-extract-'));
const entries = {};
for (const def of EVOLUTION_ROLE_SKILL_DEFINITIONS) {
  const resolved = await resolveApprovedEvolutionRoleSkill(root, def.roleId);
  entries[def.skillName] = { sha256: createHash('sha256').update(Buffer.from(resolved.content)).digest('hex'), content: resolved.content };
}
writeFileSync('${outPath}', JSON.stringify({ version: 1, treatmentId: '${treatmentId}', provenance: ${JSON.stringify(provenance)}, entries }, null, 2) + '\\n');
console.log('${treatmentId} frozen:', Object.keys(entries).length);
`;
}

// 1. Weak baseline — inside the pinned worktree, with THAT commit's renderer.
const worktree = mkdtempSync(join(tmpdir(), 'weak-baseline-worktree-'));
rmSync(worktree, { recursive: true, force: true });
execFileSync('git', ['worktree', 'add', worktree, WEAK_COMMIT], { cwd: REPO_ROOT, stdio: 'inherit' });
try {
  const script = join(tmpdir(), `extract-weak-${Date.now()}.mts`);
  writeFileSync(script, extractionScript(
    join(worktree, 'src/daemon/evolution-artifact-store.js'),
    join(OUT_DIR, 'weak-baseline.json'),
    'weak_baseline',
    { extractedFromCommit: WEAK_COMMIT, renderedBy: 'renderer at that commit (git worktree), NOT the current renderer — template drift is excluded by construction' },
  ));
  execFileSync('npx', ['tsx', script], { cwd: worktree, stdio: 'inherit' });
  rmSync(script, { force: true });
} finally {
  execFileSync('git', ['worktree', 'remove', worktree, '--force'], { cwd: REPO_ROOT, stdio: 'inherit' });
}

// 2. Current expanded — current tree, current renderer.
{
  const script = join(tmpdir(), `extract-current-${Date.now()}.mts`);
  writeFileSync(script, extractionScript(
    join(REPO_ROOT, 'src/daemon/evolution-artifact-store.js'),
    join(OUT_DIR, 'current-expanded.json'),
    'current_expanded',
    { note: 'cycle-1 expanded playbooks rendered by the current renderer; hashes must match test/fixtures/evolution-role-skills/builtin-baseline.json' },
  ));
  execFileSync('npx', ['tsx', script], { cwd: REPO_ROOT, stdio: 'inherit' });
  rmSync(script, { force: true });
}
console.log('done');

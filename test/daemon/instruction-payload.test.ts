import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GOVERNED_SKILL_CLOSE_TAG,
  GOVERNED_SKILL_OPEN_TAG,
  ROLE_SKILL_BLOCK_END_PREFIX,
  ROLE_SKILL_BLOCK_PREFIX,
  containsInstructionPayload,
} from '../../shared/instruction-payload.js';
import { redactRoleSkillBodiesForTimeline } from '../../src/daemon/openspec-auto-deliver-orchestrator.js';

describe('instruction payload classification (#8)', () => {
  it('classifies both fence families and passes ordinary text through', () => {
    expect(containsInstructionPayload(`${ROLE_SKILL_BLOCK_PREFIX} role=backend_developer sha256=x >>>\nBODY\n${ROLE_SKILL_BLOCK_END_PREFIX} role=backend_developer >>>`)).toBe(true);
    expect(containsInstructionPayload(`${GOVERNED_SKILL_OPEN_TAG}\nBODY\n${GOVERNED_SKILL_CLOSE_TAG}`)).toBe(true);
    expect(containsInstructionPayload('ordinary user question about ROLE and SKILL words')).toBe(false);
    expect(containsInstructionPayload('')).toBe(false);
    expect(containsInstructionPayload(undefined)).toBe(false);
    expect(containsInstructionPayload(null)).toBe(false);
  });

  it('the redacted timeline copy of an implementation prompt is STILL classified as payload (memory stays clean either way)', () => {
    const prompt = [
      'Implement the tasks.',
      `${ROLE_SKILL_BLOCK_PREFIX} role=backend_developer name=x sha256=abc source=y >>>`,
      'SECRET BODY',
      `${ROLE_SKILL_BLOCK_END_PREFIX} role=backend_developer sha256=abc >>>`,
    ].join('\n');
    const redacted = redactRoleSkillBodiesForTimeline(prompt);
    expect(redacted).not.toContain('SECRET BODY');
    // The envelope line keeps the marker → ingestion drops the whole event.
    expect(containsInstructionPayload(redacted)).toBe(true);
  });
});

describe('marker literal bypass enumeration', () => {
  it('no daemon file outside shared/instruction-payload.ts hardcodes the fence literals', async () => {
    const roots = ['src/daemon', 'src/context'];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = join(process.cwd(), root);
      for (const file of await readdir(dir)) {
        if (!file.endsWith('.ts')) continue;
        const content = await readFile(join(dir, file), 'utf8');
        if (content.includes("'<<< ROLE_SKILL") || content.includes("'<governed-skill>'") || content.includes('"<<< ROLE_SKILL')) {
          offenders.push(`${root}/${file}`);
        }
      }
    }
    // New emitters must import the shared constants so classification can
    // never drift from emission.
    expect(offenders).toEqual([]);
  });
});

/**
 * Central effective-skill resolver (discussion 30f25d75-67c, repair
 * checklist #4/#5).
 *
 * SINGLE choke point through which every governed consumer obtains role-skill
 * bytes. Each resolution records WHO consumed it, WHAT bytes (sha256), from
 * WHERE (source class + path), and with WHICH authority verification — so
 * "what will actually run" is answerable from one typed record instead of
 * three consumer-specific precedence rules.
 *
 * Enforcement: a repository test enumerates direct
 * `resolveApprovedEvolutionRoleSkill` call sites; new bypasses fail review.
 */
import type { EvolutionRoleId } from '../../shared/evolution-pipeline-constants.js';
import { resolveApprovedEvolutionRoleSkill } from './evolution-artifact-store.js';

/** Authoritative consumers of role-skill bytes. */
export type EvolutionSkillConsumer =
  | 'auto_deliver_implementation'
  | 'generic_discussion'
  | 'evolution_roundtable';

export interface EffectiveSkillResolution {
  roleId: EvolutionRoleId;
  consumer: EvolutionSkillConsumer;
  skillName: string;
  sourceClass: 'project_approved' | 'built_in';
  sourcePath: string;
  contentSha256: string;
  contentBytes: number;
  /** Authority classification from the manifest check (E1.3). */
  verification: 'manifest_verified' | 'legacy_unverified' | 'built_in' | 'quarantined_fallback';
  quarantine?: { relativePath: string; expectedSha256: string; actualSha256: string };
  capturedAt: number;
}

export interface EffectiveSkillResolutionWithContent extends EffectiveSkillResolution {
  content: string;
}

/**
 * Resolve the effective skill for a role on behalf of a named consumer.
 * This is the ONLY sanctioned path to role-skill bytes for execution.
 */
export async function resolveEffectiveRoleSkill(
  projectRoot: string,
  roleId: EvolutionRoleId,
  consumer: EvolutionSkillConsumer,
  nowMs = Date.now(),
): Promise<EffectiveSkillResolutionWithContent> {
  const resolved = await resolveApprovedEvolutionRoleSkill(projectRoot, roleId);
  return {
    roleId,
    consumer,
    skillName: resolved.skillName,
    sourceClass: resolved.source === 'project' ? 'project_approved' : 'built_in',
    sourcePath: resolved.sourcePath,
    contentSha256: resolved.sha256,
    contentBytes: Buffer.byteLength(resolved.content),
    verification: resolved.verification,
    ...(resolved.quarantine ? { quarantine: resolved.quarantine } : {}),
    capturedAt: nowMs,
    content: resolved.content,
  };
}

/** One-line audit summary for evidence trails. */
export function describeEffectiveSkillResolution(resolution: EffectiveSkillResolution): string {
  return [
    `role=${resolution.roleId}`,
    `consumer=${resolution.consumer}`,
    `source=${resolution.sourceClass}:${resolution.sourcePath}`,
    `sha256=${resolution.contentSha256.slice(0, 12)}`,
    `verification=${resolution.verification}`,
  ].join(' ');
}

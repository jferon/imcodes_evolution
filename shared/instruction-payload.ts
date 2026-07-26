/**
 * Instruction-payload classification (discussion 30f25d75-67c, repair
 * checklist #7/#8).
 *
 * Executable role-skill bodies are POLICY PAYLOAD for the provider runtime,
 * not conversation content. Every block that carries them is fenced with one
 * of the canonical markers below so any projection/indexing surface can
 * classify it without knowing the emitter:
 * - timeline projections redact or exclude it;
 * - live-context/memory ingestion drops it (this module's helper);
 * - future share/export surfaces apply the same rule.
 *
 * Data-minimization contract, not secrecy: the provider necessarily receives
 * the full bytes at execution.
 */

/** Auto Deliver implementation prompt skill fence (openspec orchestrator). */
export const ROLE_SKILL_BLOCK_PREFIX = '<<< ROLE_SKILL';
export const ROLE_SKILL_BLOCK_END_PREFIX = '<<< END_ROLE_SKILL';

/** Governed generic-discussion skill fence (discussion orchestrator). */
export const GOVERNED_SKILL_OPEN_TAG = '<governed-skill>';
export const GOVERNED_SKILL_CLOSE_TAG = '</governed-skill>';

const INSTRUCTION_PAYLOAD_MARKERS = [
  ROLE_SKILL_BLOCK_PREFIX,
  GOVERNED_SKILL_OPEN_TAG,
] as const;

/**
 * True when the text carries an executable instruction payload and must be
 * kept out of ordinary memory/summary/share indexing.
 */
export function containsInstructionPayload(text: string | undefined | null): boolean {
  if (!text) return false;
  return INSTRUCTION_PAYLOAD_MARKERS.some((marker) => text.includes(marker));
}

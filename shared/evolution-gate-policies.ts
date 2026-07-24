/**
 * Typed-gate kind policies for the Evolution pipeline.
 *
 * Every gate kind declares, in ONE place, which actors may resolve it, whether
 * it can be waived, and what assurance level an approval grants per actor.
 * The orchestrator consults this table instead of hardcoding per-kind rules,
 * so adding a gate kind means adding a policy row — not another special case.
 *
 * Safety invariants encoded here:
 * - Waiving is human-only everywhere; a system actor can never waive.
 * - design_review (high-fidelity visual approval), development_mode,
 *   external_infrastructure, and production_release can NEVER be waived and
 *   are human-only — these are the risk gates the security baseline demands.
 * - A system actor's approval grants `checker_verified`, never
 *   `human_approved`; only a human decision can produce `human_approved`.
 */
import type { EvolutionAssuranceLevel, EvolutionGateAction, EvolutionGateKind } from './evolution-pipeline-constants.js';

export type EvolutionGateActorType = 'human' | 'system';

export interface EvolutionGateKindPolicy {
  /** Actors allowed to resolve (approve/request_changes) this gate kind. */
  readonly allowedActors: readonly EvolutionGateActorType[];
  /** Whether a human may waive this gate (system waive is always forbidden). */
  readonly waivable: boolean;
}

export const EVOLUTION_GATE_KIND_POLICIES: Record<EvolutionGateKind, EvolutionGateKindPolicy> = {
  product_review: { allowedActors: ['human', 'system'], waivable: true },
  design_review: { allowedActors: ['human'], waivable: false },
  architecture_review: { allowedActors: ['human', 'system'], waivable: true },
  planning_review: { allowedActors: ['human', 'system'], waivable: true },
  development_mode: { allowedActors: ['human'], waivable: false },
  external_infrastructure: { allowedActors: ['human'], waivable: false },
  production_release: { allowedActors: ['human'], waivable: false },
} as const;

export type EvolutionGateAuthorization =
  | { ok: true }
  | { ok: false; code: 'evolution_gate_actor_forbidden' | 'evolution_gate_waiver_forbidden'; message: string };

/**
 * Authorize a gate action for an actor type. Pure and side-effect free so the
 * daemon, server, and web can all pre-validate with identical semantics.
 */
export function authorizeEvolutionGateAction(
  kind: EvolutionGateKind,
  action: EvolutionGateAction,
  actorType: EvolutionGateActorType,
): EvolutionGateAuthorization {
  const policy = EVOLUTION_GATE_KIND_POLICIES[kind];
  if (!policy.allowedActors.includes(actorType)) {
    return {
      ok: false,
      code: 'evolution_gate_actor_forbidden',
      message: `Gate kind ${kind} can only be resolved by: ${policy.allowedActors.join(', ')}.`,
    };
  }
  if (action === 'waive') {
    if (!policy.waivable) {
      return {
        ok: false,
        code: 'evolution_gate_waiver_forbidden',
        message: `Gate kind ${kind} cannot be waived.`,
      };
    }
    if (actorType !== 'human') {
      return {
        ok: false,
        code: 'evolution_gate_waiver_forbidden',
        message: 'Only a human actor may waive a gate.',
      };
    }
  }
  return { ok: true };
}

/**
 * Assurance level granted to candidate revisions when a gate is resolved
 * positively. A waiver honestly records `waived` — it authorizes downstream
 * progress without pretending anyone approved the content.
 */
export function evolutionGateApprovalAssurance(
  action: EvolutionGateAction,
  actorType: EvolutionGateActorType,
): EvolutionAssuranceLevel {
  if (action === 'waive') return 'waived';
  return actorType === 'human' ? 'human_approved' : 'checker_verified';
}

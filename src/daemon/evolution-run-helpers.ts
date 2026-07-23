/**
 * Shared mutation helpers for EvolutionRun state.
 *
 * Single source of truth for the append/upsert helpers that were previously
 * duplicated (and had silently drifted) between `evolution-orchestrator.ts`
 * and `evolution-stage-runner.ts`. Both files import from here.
 *
 * Consolidation notes:
 * - `appendEvidence` keeps the stage-runner implementation (imports the shared
 *   `EVOLUTION_EVIDENCE_ITEMS_MAX` cap; the orchestrator copy hardcoded `200`
 *   and paid an unnecessary per-call clone of every existing entry).
 * - `upsertArtifact`/`upsertScore` were byte-identical — pure moves.
 * - `appendDiscussion`'s two copies computed the same 16-char sha256 id via
 *   different code shapes; consolidated on the shared `shortSha256` helper.
 * - `appendLiveEvent` had a single copy (orchestrator); moved verbatim, with
 *   its cap promoted to the shared `EVOLUTION_LIVE_EVENTS_MAX` constant.
 */
import { createHash } from 'node:crypto';
import type {
  EvolutionRun,
  EvolutionEvidence,
  EvolutionDiscussionMessage,
  EvolutionArtifactRef,
  EvolutionScore,
  EvolutionLiveEvent,
} from '../../shared/evolution-pipeline-types.js';
import {
  EVOLUTION_EVIDENCE_ITEMS_MAX,
  EVOLUTION_DISCUSSION_ITEMS_MAX,
  EVOLUTION_ARTIFACTS_MAX,
  EVOLUTION_LIVE_EVENTS_MAX,
} from '../../shared/evolution-pipeline-constants.js';

export function shortSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function appendEvidence(run: EvolutionRun, evidence: EvolutionEvidence): void {
  run.evidence = [...run.evidence, evidence].slice(-EVOLUTION_EVIDENCE_ITEMS_MAX);
}

export function appendDiscussion(run: EvolutionRun, message: Omit<EvolutionDiscussionMessage, 'id'>): void {
  const id = `discussion-${shortSha256(`${message.kind}:${message.stage}:${message.roleId ?? 'system'}:${message.text}:${message.createdAt}`)}`;
  if ((run.discussion ?? []).some((entry) => entry.id === id)) return;
  run.discussion = [...(run.discussion ?? []), { id, ...message }].slice(-EVOLUTION_DISCUSSION_ITEMS_MAX);
}

export function upsertArtifact(run: EvolutionRun, artifact: EvolutionArtifactRef): void {
  const index = run.artifacts.findIndex((entry) => entry.id === artifact.id || entry.path === artifact.path);
  if (index >= 0) run.artifacts[index] = artifact;
  else run.artifacts.push(artifact);
  run.artifacts = run.artifacts.slice(-EVOLUTION_ARTIFACTS_MAX);
}

export function upsertScore(run: EvolutionRun, score: EvolutionScore): void {
  const index = run.scores.findIndex((entry) => entry.module === score.module);
  if (index >= 0) run.scores[index] = score;
  else run.scores.push(score);
}

export function appendLiveEvent(run: EvolutionRun, event: Omit<EvolutionLiveEvent, 'id'>): void {
  const id = `live-${shortSha256(`${event.source}:${event.kind}:${event.stage}:${event.roleId ?? 'system'}:${event.title}:${event.detail}:${event.createdAt}`)}`;
  const existing = run.liveEvents ?? [];
  if (existing.some((entry) => entry.id === id)) return;
  run.liveEvents = [...existing, { id, ...event }].slice(-EVOLUTION_LIVE_EVENTS_MAX);
}

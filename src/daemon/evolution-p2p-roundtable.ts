import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ServerLink } from './server-link.js';
import { listSessions, getSession, type SessionRecord } from '../store/session-store.js';
import { appendP2pRunUserIntervention, startP2pRun, type P2pTarget } from './p2p-orchestrator.js';
import {
  EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID,
  EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID,
  EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID,
} from '../../shared/evolution-pipeline-constants.js';
import { isClaudeCodeFamily } from '../../shared/agent-types.js';
import { defaultDedicatedExecutionRoutingPreference } from '../../shared/execution-clone.js';
import { createExecutionClone } from './execution-clone.js';
import logger from '../util/logger.js';
import { P2P_RUN_STATUS_VALUES, type P2pRunUpdatePayload } from '../../shared/p2p-status.js';
import { P2P_WORKFLOW_MSG } from '../../shared/p2p-workflow-messages.js';
import {
  recordEvolutionP2pRunProjection,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  type EvolutionRoundtableLaunchRequest,
  type EvolutionRoundtableLaunchResult,
  type EvolutionRoundtableRoleInstruction,
  type EvolutionServerLink,
} from './evolution-orchestrator.js';

function mainDomain(sessionName: string): string {
  if (sessionName.startsWith('deck_sub_')) {
    const record = getSession(sessionName);
    if (record?.parentSession) return mainDomain(record.parentSession);
  }
  const parts = sessionName.split('_');
  return parts.length >= 3 ? parts.slice(0, -1).join('_') : sessionName;
}

function sameProjectRoot(left: string, right: string): boolean {
  try { return resolve(left) === resolve(right); } catch { return false; }
}

function isVisualFidelityRequest(request: EvolutionRoundtableLaunchRequest): boolean {
  return request.roundtableSpecId === EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID;
}

function isMakerRequest(request: EvolutionRoundtableLaunchRequest): boolean {
  return request.roundtableSpecId === EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID
    || request.roundtableSpecId === EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID;
}

export function isEligibleHelper(session: SessionRecord, request: EvolutionRoundtableLaunchRequest): boolean {
  if (!session.name || session.name === request.sessionName) return false;
  if (session.state === 'stopped') return false;
  if (session.role === 'brain') return false;
  if (!session.projectDir || !sameProjectRoot(session.projectDir, request.projectRoot)) return false;
  // The visual-fidelity gate depends on Read-tool image comprehension. A
  // shell/codex/other helper would still emit a PASS/REWORK-shaped verdict
  // without ever seeing the reference image — a fabricated review is worse
  // than no review, so restrict this spec to the Claude Code family.
  if (isVisualFidelityRequest(request) && !isClaudeCodeFamily(session.agentType)) return false;
  return mainDomain(session.name) === mainDomain(request.sessionName);
}

/**
 * Dedicated-spawn fallback for the visual-fidelity gate: when no eligible
 * idle helper exists, clone a capable session's configuration into a fresh
 * ephemeral sub-session (templates may be `idle` OR `running` — cloning
 * copies config, never live state). Returns null when no valid template
 * exists at all or the clone fails — the caller then hard-blocks; it must
 * never silently downgrade to the deterministic text-only review.
 * Clone lifecycle/GC is handled by the existing execution-clone sweeper.
 */
async function spawnFidelityCloneTarget(request: EvolutionRoundtableLaunchRequest): Promise<P2pTarget | null> {
  const candidates = listSessions().filter((session) =>
    session.name !== request.sessionName
    && session.state !== 'stopped'
    && isClaudeCodeFamily(session.agentType)
    && !!session.projectDir
    && sameProjectRoot(session.projectDir, request.projectRoot));
  // Prefer an SDK template over a tmux/process one: both are equally capable
  // of Read-tool image review, but the SDK event stream signals completion of
  // a large structured report more reliably than tmux output scraping.
  const template = candidates.find((session) => session.agentType === 'claude-code-sdk') ?? candidates[0];
  if (!template) return null;
  try {
    const clone = await createExecutionClone({
      templateSessionName: template.name,
      parentRunId: request.runId,
      parentStage: 'generic_execution',
      ownerSessionName: request.sessionName,
      owningMainSessionName: request.sessionName,
      pref: defaultDedicatedExecutionRoutingPreference(),
    });
    return { session: clone.sessionName, mode: modeForRole(request.roles[0]) };
  } catch (error) {
    logger.warn({ err: error, runId: request.runId, template: template.name }, 'visual-fidelity clone spawn failed — gate will hard-block');
    return null;
  }
}

async function resolveTargets(request: EvolutionRoundtableLaunchRequest): Promise<P2pTarget[]> {
  const helperLimit = Math.min(4, Math.max(2, request.roleInstructions.length || request.roles.length || 2));
  const targets = listSessions()
    .filter((session) => isEligibleHelper(session, request))
    .slice(0, helperLimit)
    .map((session, index) => ({
      session: session.name,
      mode: modeForRole(request.roleInstructions[index]?.roleId ?? request.roles[index]),
    }));
  if (targets.length === 0 && isVisualFidelityRequest(request)) {
    const clone = await spawnFidelityCloneTarget(request);
    if (clone) return [clone];
  }
  return targets;
}

function modeForRole(roleId: string | undefined): string {
  if (!roleId) return 'discuss';
  if (roleId.includes('critic') || roleId.includes('security')) return 'audit';
  if (roleId.includes('tech') || roleId.includes('ops')) return 'plan';
  if (roleId.includes('qa') || roleId.includes('designer') || roleId.includes('developer')) return 'review';
  return 'discuss';
}

function formatRoleInstruction(role: EvolutionRoundtableRoleInstruction): string {
  const lines = [
    `### ${role.label} (${role.roleId})`,
    `- Skill: ${role.skillName ?? 'role-local-playbook'}`,
    `- Mission: ${role.skillSummary ?? '按该角色职责参与圆桌讨论。'}`,
  ];
  if (role.currentAction) lines.push(`- Current action: ${role.currentAction}`);
  if (role.skillSnapshotId) lines.push(`- Bound skill snapshot: ${role.skillSnapshotId} (${role.skillSha256 ?? 'sha256 unavailable'})`);
  if (role.responsibilities.length > 0) {
    lines.push('- Responsibilities:');
    for (const item of role.responsibilities.slice(0, 8)) lines.push(`  - ${item}`);
  }
  if (role.skillContent) {
    lines.push('- Exact governed skill content:');
    lines.push('```markdown');
    lines.push(role.skillContent);
    lines.push('```');
  }
  return lines.join('\n');
}

function formatTargetAssignments(request: EvolutionRoundtableLaunchRequest, targets: P2pTarget[]): string {
  const roles = request.roleInstructions.length > 0
    ? request.roleInstructions
    : request.roles.map((roleId) => ({ roleId, label: roleId, responsibilities: [] }));
  return targets.map((target, index) => {
    const primary = roles[index % Math.max(roles.length, 1)];
    const secondary = roles[(index + targets.length) % Math.max(roles.length, 1)];
    const secondaryText = secondary && secondary.roleId !== primary?.roleId ? `；同时交叉审查 ${secondary.label}` : '';
    return `- ${target.session}: 主持 ${primary?.label ?? '多角色'}（${target.mode}）${secondaryText}`;
  }).join('\n');
}

function composeRoundtablePrompt(request: EvolutionRoundtableLaunchRequest, targets: P2pTarget[]): string {
  return [
    request.prompt,
    '',
    '## 子 Session 角色 Skill 注入',
    '',
    '本轮不是单模型“审查”，而是 IM.codes 子 session 多机器人圆桌。每个 helper 必须按分配的角色 skill/playbook 发言，并引用输入产物中的事实；不要泛泛而谈。',
    '',
    '### Helper 分工',
    formatTargetAssignments(request, targets),
    '',
    '### 角色 Skill Playbooks',
    ...(request.roleInstructions.length > 0
      ? request.roleInstructions.map(formatRoleInstruction)
      : request.roles.map((roleId) => `### ${roleId}\n- Skill: role-local-playbook\n- Mission: 按该角色职责参与圆桌讨论。`)),
    '',
    '## 两轮讨论协议',
    '',
    'Round 1（发散/补齐）：每个 helper 从自己的角色 skill 出发，补齐需求、设计、技术、测试或发布缺口，列出必须落地的具体修改点。',
    'Round 2（交叉收敛）：互相挑战上一轮结论，消除矛盾，合并重复意见，给出能进入下一阶段的最小修改清单。',
    '',
    '## 最终输出',
    '',
    '先写结论与证据；如果是 REWORK，列出阻塞项、归属角色、建议修改到哪个 artifact；如果是 PASS，说明为什么足以进入下一阶段。',
    '最后一行必须且只能使用以下机器可读标记之一：`<!-- EVOLUTION_VERDICT: PASS -->`、`<!-- EVOLUTION_VERDICT: REWORK -->`、`<!-- EVOLUTION_VERDICT: BLOCKED -->`。缺失或格式错误会按阻塞处理。',
  ].join('\n');
}

function safeInside(root: string, candidate: string): string | null {
  if (!candidate || candidate.includes('\0') || isAbsolute(candidate) || candidate.includes('\\')) return null;
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

async function readRoundtableArtifact(request: EvolutionRoundtableLaunchRequest, artifactPath: string): Promise<{ path: string; content: string } | null> {
  const projectPath = safeInside(request.projectRoot, artifactPath);
  const runPath = safeInside(request.projectRoot, join('.imc/evolution', request.runId, artifactPath));
  for (const candidate of [projectPath, runPath]) {
    if (!candidate) continue;
    try {
      const content = await readFile(candidate, 'utf8');
      if (content.includes('\0')) return { path: artifactPath, content: '' };
      return { path: artifactPath, content: content.slice(0, 50_000) };
    } catch { /* try next candidate */ }
  }
  return null;
}

async function readRoundtableArtifacts(request: EvolutionRoundtableLaunchRequest): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  for (const artifactPath of request.artifactPaths.slice(0, 12)) {
    const file = await readRoundtableArtifact(request, artifactPath);
    if (file) files.push(file);
  }
  return files;
}

function contextPathRelative(projectRoot: string, contextFilePath: string): string | undefined {
  try {
    const root = resolve(projectRoot);
    const rel = relative(root, resolve(contextFilePath));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
    return rel;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isP2pRunUpdatePayload(value: unknown): value is P2pRunUpdatePayload {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' &&
    typeof value.discussion_id === 'string' &&
    typeof value.mode_key === 'string' &&
    typeof value.current_round === 'number' &&
    typeof value.total_rounds === 'number' &&
    typeof value.status === 'string' &&
    (P2P_RUN_STATUS_VALUES as readonly string[]).includes(value.status);
}

function isRoundtableP2pProjectionMessage(message: unknown): message is { type: string; run: P2pRunUpdatePayload } {
  if (!isRecord(message)) return false;
  return (
    message.type === P2P_WORKFLOW_MSG.RUN_SAVE ||
    message.type === P2P_WORKFLOW_MSG.RUN_COMPLETE ||
    message.type === P2P_WORKFLOW_MSG.RUN_ERROR
  ) && isP2pRunUpdatePayload(message.run);
}

function wrapRoundtableServerLink(serverLink: EvolutionServerLink | null): ServerLink | null {
  if (!serverLink) return null;
  const proxy: Pick<ServerLink, 'send' | 'getServerId'> = {
    send(message: unknown) {
      if (isRecord(message)) {
        try { serverLink.send(message); } catch { /* preserve existing P2P best-effort send semantics */ }
      }
      if (isRoundtableP2pProjectionMessage(message)) {
        void recordEvolutionP2pRunProjection({
          run: message.run,
          serverLink,
        }).catch(() => {
          /* best-effort bridge: P2P UI delivery must not fail because Evolution backflow failed */
        });
      }
    },
    getServerId() {
      return typeof serverLink.getServerId === 'function' ? serverLink.getServerId() : '';
    },
  };
  return proxy as unknown as ServerLink;
}

setEvolutionRoundtableLauncher(async (
  request,
  serverLink,
): Promise<EvolutionRoundtableLaunchResult> => {
  const targets = await resolveTargets(request);
  if (targets.length === 0) {
    return { ok: false, skippedReason: 'no_eligible_p2p_helper_sessions' };
  }
  try {
    const run = await startP2pRun({
      initiatorSession: request.sessionName,
      targets,
      userText: composeRoundtablePrompt(request, targets),
      fileContents: await readRoundtableArtifacts(request),
      serverLink: wrapRoundtableServerLink(serverLink),
      rounds: 2,
      modeOverride: 'discuss',
      hopTimeoutMs: 300_000,
      // Maker helpers discuss/review across both rounds, then write/promote the
      // artifact once after convergence. Executing after every intermediate
      // round duplicated expensive agent work and made a healthy Maker look
      // stuck for twice as long.
      postSummaryExecution: isMakerRequest(request) ? 'final_only' : 'disabled',
      finalSummaryExtraInstruction: isMakerRequest(request)
        ? [
            'Evolution Maker mode requires real artifact execution after the two-round discussion.',
            '两轮讨论收敛后，必须使用可用的文件工具真实写入 Maker 要求的产物文件，并严格写到原始请求指定的路径。',
            'Do not implement application code and do not edit run.json; only create or update the declared Maker output artifacts.',
            'Never claim PASS until the required files exist and contain substantive, requirement-specific content.',
            'The final line must be exactly one machine marker: <!-- EVOLUTION_VERDICT: PASS -->, <!-- EVOLUTION_VERDICT: REWORK -->, or <!-- EVOLUTION_VERDICT: BLOCKED -->.',
          ].join('\n')
        : [
            'Evolution roundtable mode is discussion-and-review.',
            'Use the injected role skill playbooks: Round 1 expands and improves the artifact set; Round 2 cross-reviews and converges to PASS/REWORK.',
            'Do not execute the original requirement, do not edit project files, do not run delivery/development tasks, and do not write P2P execution proof markers.',
            'End with role-owned required changes, artifact paths that should be updated, and any human decisions needed before the Evolution pipeline continues.',
            'The final line must be exactly one machine marker: <!-- EVOLUTION_VERDICT: PASS -->, <!-- EVOLUTION_VERDICT: REWORK -->, or <!-- EVOLUTION_VERDICT: BLOCKED -->.',
          ].join('\n'),
      launchOrigin: {
        kind: 'manual',
        commandId: request.requestId,
      },
    });
    return {
      ok: true,
      p2pRunId: run.id,
      discussionId: run.discussionId,
      ...(contextPathRelative(request.projectRoot, run.contextFilePath) ? { contextPath: contextPathRelative(request.projectRoot, run.contextFilePath)! } : {}),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

setEvolutionRoundtableUserMessageSink(async (request) => {
  if (!request.roundtable.p2pRunId) return { ok: false, error: 'roundtable_missing_p2p_run_id' };
  const result = await appendP2pRunUserIntervention(request.roundtable.p2pRunId, {
    author: request.author,
    text: request.text,
    ...(request.roleLabel ? { roleLabel: request.roleLabel } : {}),
    createdAt: request.createdAt,
  });
  if (!result.ok) return { ok: false, error: result.error ?? 'p2p_user_intervention_failed' };
  return {
    ok: true,
    ...(request.roundtable.contextPath ? { contextPath: request.roundtable.contextPath } : {}),
    ...(result.currentTargetSession !== undefined ? { currentTargetSession: result.currentTargetSession } : {}),
  };
});

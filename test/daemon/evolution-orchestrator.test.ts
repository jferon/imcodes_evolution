import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX, EVOLUTION_PIPELINE_MSG, EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import type { EvolutionProjection } from '../../shared/evolution-pipeline-types.js';
import { parseOpenSpecTasksMarkdown } from '../../shared/openspec-auto-deliver-validators.js';
import { validateEvolutionProjection } from '../../shared/evolution-pipeline-validators.js';
import { stopAllEvolutionInboxWatchers } from '../../src/daemon/evolution-inbox-watch-manager.js';
import {
  advanceEvolutionRunStage,
  applyEvolutionGateAction,
  approveEvolutionRoleSkillCandidate,
  checkEvolutionStagingConfig,
  continueEvolutionRun,
  getEvolutionRun,
  handleEvolutionPipelineCommand,
  hydrateEvolutionRun,
  launchEvolutionRun,
  pauseEvolutionRun,
  recordEvolutionOpenSpecProjection,
  recordEvolutionP2pRunProjection,
  recordEvolutionUserMessage,
  resumePendingEvolutionAutoDeliveries,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
  setEvolutionRoundtableLauncher,
  setEvolutionRoundtableUserMessageSink,
  stopEvolutionRun,
  updateEvolutionRoleSkill,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-orch-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  stopAllEvolutionInboxWatchers();
  setEvolutionAutoDeliverLauncher(null);
  setEvolutionRoundtableLauncher(null);
  setEvolutionRoundtableUserMessageSink(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

async function writeRequirement(root: string, name = 'checkout.md'): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# Checkout\n\nBuild a fast checkout flow.\n', 'utf8');
  return sourceRelativePath;
}

async function writeRequirementContent(root: string, name: string, content: string): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${name}`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), content, 'utf8');
  return sourceRelativePath;
}

describe('evolution orchestrator', () => {
  it('launches a run and returns a valid War Room projection', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root);

    const result = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 1_000,
      request: {
        requestId: 'req-orch-1',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('detected');
    expect(result.value.roles.find((role) => role.roleId === 'loop_supervisor')?.status).toBe('running');
    expect(result.value.roles.find((role) => role.roleId === 'product_manager')?.skillName).toBe('product-prd');
    expect(result.value.discussion[0]?.text).toContain('已检测到需求文档');
    expect(result.value.loopControl.source).toBe('loop_engineering');
    expect(result.value.loopControl.mode).toBe('planning_only');
    expect(result.value.loopControl.signals.find((signal) => signal.id === 'role_skills')?.status).toBe('complete');
    expect(result.value.loopControl.budget.maxAutoDeployStage).toBe('staging');
    expect(validateEvolutionProjection(result.value).ok).toBe(true);
  });

  it('accepts an absolute requirement path inside the project and records a project-relative source', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'absolute-path.md');

    const result = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 1_500,
      request: {
        requestId: 'req-orch-absolute-path',
        sessionName: 'deck_demo_brain',
        sourceRelativePath: join(root, sourceRelativePath),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source.relativePath).toBe(sourceRelativePath);
    expect(result.value.discussion[0]?.text).toContain(sourceRelativePath);
  });

  it('advances valid stages, updates roles, and persists the ledger', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'search.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 2_000,
      request: { requestId: 'req-orch-2', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const advanced = await advanceEvolutionRunStage({
      runId: launched.value.runId,
      nextStage: 'intake_normalized',
      reason: 'Requirement normalized for product review.',
      nowMs: 3_000,
    });

    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.stage).toBe('intake_normalized');
    expect(advanced.value.roles.find((role) => role.roleId === 'product_manager')?.status).toBe('running');
    const persisted = JSON.parse(await readFile(join(root, '.imc/evolution', launched.value.runId, 'run.json'), 'utf8')) as { stage: string; latestMessage?: string };
    expect(persisted.stage).toBe('intake_normalized');
    expect(persisted.latestMessage).toContain('Requirement normalized');
  });

  it('rejects invalid stage jumps and supports user messages, human continue, and stop', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'orders.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 4_000,
      request: { requestId: 'req-orch-3', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const invalid = await advanceEvolutionRunStage({ runId: launched.value.runId, nextStage: 'implementation_loop' });
    expect(invalid.ok).toBe(false);

    const messaged = await recordEvolutionUserMessage({ runId: launched.value.runId, roleId: 'product_manager', text: '优先支持移动端。', nowMs: 4_500 });
    expect(messaged.ok).toBe(true);
    if (!messaged.ok) return;
    expect(messaged.value.latestMessage).toContain('product_manager');
    expect(messaged.value.discussion.at(-2)?.kind).toBe('user_message');
    expect(messaged.value.discussion.at(-2)?.author).toContain('产品经理');
    expect(messaged.value.discussion.at(-2)?.artifactIds?.[0]).toContain('war_room_instruction');
    expect(messaged.value.discussion.at(-1)).toEqual(expect.objectContaining({
      kind: 'role_update',
      roleId: 'product_manager',
      author: '产品经理',
    }));
    expect(messaged.value.discussion.at(-1)?.text).toContain('收到 War Room 指令');
    const instructionArtifact = messaged.value.artifacts.find((artifact) => artifact.kind === 'discussion' && artifact.path.includes('user-instructions'));
    expect(instructionArtifact).toEqual(expect.objectContaining({
      roleId: 'product_manager',
      stage: 'detected',
    }));
    expect(instructionArtifact?.preview?.content).toContain('优先支持移动端。');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, instructionArtifact!.path), 'utf8')).resolves.toContain('## Role Acknowledgement');
    const responseArtifact = messaged.value.artifacts.find((artifact) => artifact.kind === 'role_instruction_response' && artifact.roleId === 'product_manager');
    expect(responseArtifact).toEqual(expect.objectContaining({
      title: 'Role Response · 产品经理',
      stage: 'detected',
    }));
    expect(responseArtifact?.preview?.content).toContain('Local Execution Plan');
    expect(messaged.value.discussion.at(-1)?.artifactIds).toEqual(expect.arrayContaining([
      instructionArtifact!.id,
      responseArtifact!.id,
    ]));
    expect(messaged.value.liveEvents.some((entry) => entry.source === 'war_room' && entry.artifactIds?.includes(responseArtifact!.id))).toBe(true);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, responseArtifact!.path), 'utf8')).resolves.toContain('Role Instruction Response');

    const broadcast = await recordEvolutionUserMessage({
      runId: launched.value.runId,
      text: '全局约束：所有角色都要优先复用现有能力，不要引入新依赖。',
      nowMs: 4_600,
    });
    expect(broadcast.ok).toBe(true);
    if (!broadcast.ok) return;
    expect(broadcast.value.discussion.at(-2)).toEqual(expect.objectContaining({
      kind: 'user_message',
      author: 'User',
    }));
    expect(broadcast.value.discussion.at(-1)).toEqual(expect.objectContaining({
      kind: 'role_update',
      roleId: 'loop_supervisor',
      author: 'Loop Supervisor / 总控',
    }));
    expect(broadcast.value.discussion.at(-1)?.text).toContain('收到全局 War Room 指令');
    const broadcastArtifact = broadcast.value.artifacts.find((artifact) => artifact.kind === 'discussion' && artifact.path.includes('all_roles'));
    expect(broadcastArtifact?.preview?.content).toContain('全部角色');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, broadcastArtifact!.path), 'utf8')).resolves.toContain('所有角色都要优先复用现有能力');
    const broadcastResponse = broadcast.value.artifacts.find((artifact) => artifact.kind === 'role_instruction_response' && artifact.path.includes('loop_supervisor'));
    expect(broadcastResponse?.preview?.content).toContain('Conversation Contract');

    const needsHuman = await advanceEvolutionRunStage({ runId: launched.value.runId, nextStage: 'needs_human', reason: 'Need payment provider choice.', nowMs: 5_000 });
    expect(needsHuman.ok).toBe(true);
    const continued = await continueEvolutionRun({ runId: launched.value.runId, targetStage: 'intake_normalized', message: 'Use Stripe for MVP.', nowMs: 6_000 });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.stage).toBe('intake_normalized');

    const stopped = await stopEvolutionRun({ runId: launched.value.runId, reason: 'manual stop', nowMs: 7_000 });
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.value.stage).toBe('stopped');
    expect(getEvolutionRun(launched.value.runId).ok).toBe(true);
  });

  it('pauses a running evolution run and resumes from the previous stage', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'pause-resume.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 7_100,
      request: { requestId: 'req-orch-pause-resume', sessionName: 'deck_demo_brain', sourceRelativePath },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const advanced = await advanceEvolutionRunStage({
      runId: launched.value.runId,
      nextStage: 'intake_normalized',
      reason: 'Requirement normalized before pause.',
      nowMs: 7_200,
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;

    const paused = await pauseEvolutionRun({
      runId: launched.value.runId,
      reason: 'Paused from Evolution War Room.',
      nowMs: 7_300,
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.value.stage).toBe('needs_human');
    expect(paused.value.verdict).toBe('BLOCKED');
    expect(paused.value.latestMessage).toBe('Paused from Evolution War Room.');
    expect(paused.value.blockingQuestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `user-pause-${launched.value.runId}-intake_normalized`,
        stage: 'intake_normalized',
        question: expect.stringContaining('稍后点击“继续执行”'),
      }),
    ]));

    const resumed = await continueEvolutionRun({
      runId: launched.value.runId,
      message: '继续执行。',
      nowMs: 7_400,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.stage).toBe('intake_normalized');
    expect(resumed.value.verdict).toBeUndefined();
    expect(resumed.value.blockingQuestions.some((question) => question.id.startsWith('user-pause-'))).toBe(false);
    expect(resumed.value.discussion.at(-1)?.text).toContain('用户恢复自我进化任务');
  });

  it('handles websocket-style launch and status commands', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'war-room.md');
    const sent: Record<string, unknown>[] = [];
    const serverLink = { send(message: Record<string, unknown>) { sent.push(message); } };

    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.LAUNCH,
      projectRoot: root,
      request: {
        requestId: 'req-orch-4',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    }, serverLink as never);

    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.LAUNCH_ACK);
    const ack = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.LAUNCH_ACK) as { projection?: { runId?: string } } | undefined;
    expect(ack?.projection?.runId).toBeTruthy();

    await handleEvolutionPipelineCommand({ type: EVOLUTION_PIPELINE_MSG.STATUS_REQUEST, runId: ack?.projection?.runId }, serverLink as never);
    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION);
    const status = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION) as { watchers?: unknown[] } | undefined;
    expect(Array.isArray(status?.watchers)).toBe(true);

    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.SCAN_INBOX,
      requestId: 'req-orch-4-scan',
      sessionName: 'deck_demo_brain',
      projectRoot: root,
    }, serverLink as never);
    const scanAck = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.SCAN_INBOX_ACK) as { scanned?: number; candidates?: number; watchers?: unknown[] } | undefined;
    expect(scanAck).toEqual(expect.objectContaining({
      scanned: 0,
      candidates: 0,
    }));
    expect(Array.isArray(scanAck?.watchers)).toBe(true);
  });

  it('handles websocket-style requirement directory changes', async () => {
    const root = await makeRoot();
    const selectedDirectory = join(root, 'incoming-requirements');
    await mkdir(selectedDirectory, { recursive: true });
    const sent: Record<string, unknown>[] = [];
    const serverLink = { send(message: Record<string, unknown>) { sent.push(message); } };

    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.SET_INBOX_DIRECTORY,
      requestId: 'req-orch-set-inbox',
      sessionName: 'deck_demo_brain',
      projectName: 'demo',
      projectRoot: root,
      directoryPath: selectedDirectory,
    }, serverLink as never);

    expect(sent).toContainEqual(expect.objectContaining({
      type: EVOLUTION_PIPELINE_MSG.SET_INBOX_DIRECTORY_ACK,
      requestId: 'req-orch-set-inbox',
      directoryPath: selectedDirectory,
      watchers: [
        expect.objectContaining({
          sessionName: 'deck_demo_brain',
          inboxAbsolutePath: selectedDirectory,
          active: true,
        }),
      ],
    }));
  });

  it('handles websocket-style demo launch by seeding a demo requirement', async () => {
    const root = await makeRoot();
    const sent: Record<string, unknown>[] = [];
    const serverLink = { send(message: Record<string, unknown>) { sent.push(message); } };

    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO,
      requestId: 'req-orch-demo',
      sessionName: 'deck_demo_brain',
      projectRoot: root,
      autoStart: false,
      autoStartImplementation: false,
      roundtableGateMode: 'planning',
    }, serverLink as never);

    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO_ACK);
    const ack = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.LAUNCH_DEMO_ACK) as { projection?: { runId?: string; source?: { relativePath?: string; requestedBy?: string } } } | undefined;
    const projection = ack?.projection;
    expect(projection?.runId).toBeTruthy();
    expect(projection?.source?.requestedBy).toBe('demo');
    expect(projection?.source?.relativePath).toMatch(/^\.imcodes\/inbox\/requirements\/demo\/evolution-factory-/);
    const sourcePath = projection?.source?.relativePath;
    expect(sourcePath).toBeTruthy();
    if (!sourcePath || !projection) return;
    await expect(readFile(join(root, sourcePath), 'utf8')).resolves.toContain('IM.codes Evolution Factory Demo');
    expect(validateEvolutionProjection(projection).ok).toBe(true);
  });

  it('imports uploaded reference images into the requirements inbox and writes a launchable brief', async () => {
    const root = await makeRoot();
    const uploadSource = join(root, 'dashboard-reference.png');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(uploadSource, imageBytes);
    const { createProjectFileHandle } = await import('../../src/daemon/file-transfer-handler.js');
    const handle = createProjectFileHandle(uploadSource, 'Dashboard Reference.png', 'image/png', imageBytes.length);
    const sent: Record<string, unknown>[] = [];
    const serverLink = { send(message: Record<string, unknown>) { sent.push(message); } };

    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES,
      requestId: 'req-ref-import',
      sessionName: 'deck_demo_brain',
      projectRoot: root,
      projectName: 'demo',
      note: '参考图用于生成订单管理页面。',
      attachments: [{
        attachmentId: handle.id,
        originalName: handle.originalName,
        mime: handle.mime,
        size: handle.size,
      }],
    }, serverLink as never);

    const ack = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.IMPORT_REFERENCES_ACK) as {
      ok?: boolean;
      result?: {
        sourceRelativePath?: string;
        copiedImages?: Array<{ relativePath: string }>;
        imageCount?: number;
      };
    } | undefined;
    expect(ack?.ok).toBe(true);
    expect(ack?.result?.sourceRelativePath).toMatch(/^\.imcodes\/inbox\/requirements\/reference-/);
    expect(ack?.result?.imageCount).toBe(1);
    const sourceRelativePath = ack?.result?.sourceRelativePath;
    const copiedRelativePath = ack?.result?.copiedImages?.[0]?.relativePath;
    expect(sourceRelativePath).toBeTruthy();
    expect(copiedRelativePath).toBeTruthy();
    if (!sourceRelativePath || !copiedRelativePath) return;
    const brief = await readFile(join(root, sourceRelativePath), 'utf8');
    expect(brief).toContain('参考图驱动的设计与需求 Brief');
    expect(brief).toContain('Dashboard Reference.png');
    expect(brief).toContain('references/01-Dashboard-Reference.png');
    await expect(readFile(join(root, copiedRelativePath))).resolves.toEqual(imageBytes);
  });

  it('checks staging delivery config without executing the command', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'staging-check.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_200,
      request: {
        requestId: 'req-orch-staging-check',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const missing = await checkEvolutionStagingConfig({
      runId: launched.value.runId,
      nowMs: 8_300,
    });
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value.stagingDelivery?.status).toBe('not_configured');
    expect(missing.value.artifacts.find((artifact) => artifact.kind === 'staging_config_check')?.preview?.content)
      .toContain('No staging delivery config found');

    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/delivery.json'), JSON.stringify({
      staging: {
        enabled: true,
        command: process.execPath,
        args: ['-e', 'throw new Error("must not execute during check")'],
        cwd: '.',
        timeoutMs: 60_000,
      },
    }, null, 2), 'utf8');

    const ready = await checkEvolutionStagingConfig({
      runId: launched.value.runId,
      nowMs: 8_400,
    });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    expect(ready.value.stage).toBe('detected');
    expect(ready.value.stagingDelivery?.status).toBe('ready');
    expect(ready.value.stagingDelivery?.command).toContain('-e');
    expect(ready.value.evidence.at(-1)).toEqual(expect.objectContaining({
      source: 'staging_config_check',
      summary: expect.stringContaining('Staging delivery config is ready'),
    }));
    expect(ready.value.liveEvents.at(-1)).toEqual(expect.objectContaining({
      source: 'staging_delivery',
      kind: 'gate',
      severity: 'success',
      title: 'Staging config check',
    }));
    expect(ready.value.artifacts.find((artifact) => artifact.kind === 'staging_config_check')?.preview?.content)
      .toContain('This check does not execute the staging command');
    expect(validateEvolutionProjection(ready.value).ok).toBe(true);
  });

  it('normalizes legacy stopped runs so stale staging messages do not look active', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'legacy-stopped-staging.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_450,
      request: {
        requestId: 'req-orch-legacy-stopped-staging',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const staleMessage = 'No staging delivery config found at .imc/evolution/delivery.json.';
    const runPath = join(root, '.imc/evolution', launched.value.runId, 'run.json');
    const raw = JSON.parse(await readFile(runPath, 'utf8')) as Record<string, unknown>;
    raw.stage = 'stopped';
    raw.verdict = 'REWORK';
    raw.latestMessage = staleMessage;
    raw.terminalReason = 'Stopped from Evolution War Room.';
    raw.stagingDelivery = {
      status: 'not_configured',
      configPath: '.imc/evolution/delivery.json',
      summary: staleMessage,
      completedAt: 8_500,
    };
    await writeFile(runPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const hydrated = await hydrateEvolutionRun(root, launched.value.runId, 8_600);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.value.stage).toBe('stopped');
    expect(hydrated.value.terminalReason).toBe('Stopped from Evolution War Room.');
    expect(hydrated.value.latestMessage).toBe('Stopped from Evolution War Room.');

    const persisted = JSON.parse(await readFile(runPath, 'utf8')) as { latestMessage?: string };
    expect(persisted.latestMessage).toBe('Stopped from Evolution War Room.');
  });

  it('reports unsafe staging config as a fixable War Room gate', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'staging-check-fail.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_500,
      request: {
        requestId: 'req-orch-staging-check-fail',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/delivery.json'), JSON.stringify({
      staging: {
        enabled: true,
        command: 'npm',
        args: ['run', 'deploy:production'],
        cwd: '.',
      },
    }, null, 2), 'utf8');

    const failed = await checkEvolutionStagingConfig({
      runId: launched.value.runId,
      nowMs: 8_600,
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.stagingDelivery?.status).toBe('failed');
    expect(failed.value.stagingDelivery?.lastError).toContain('production');
    expect(failed.value.blockingQuestions.some((question) => question.id.includes('staging-config') && question.question.includes('delivery.json'))).toBe(true);
    expect(failed.value.liveEvents.at(-1)).toEqual(expect.objectContaining({
      source: 'staging_delivery',
      kind: 'gate',
      severity: 'error',
    }));
    expect(validateEvolutionProjection(failed.value).ok).toBe(true);
  });

  it('updates role skill playbooks from War Room and records a revision backup', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'skills.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 7_500,
      request: {
        requestId: 'req-orch-skill-editor',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const skillPath = join(root, '.imc/skills/evolution/visual-hifi.md');
    const original = await readFile(skillPath, 'utf8');
    const edited = `${original}\n## Team Overrides\n- Use taste-skill SVG references instead of Figma by default.\n`;
    const updated = await updateEvolutionRoleSkill({
      runId: launched.value.runId,
      roleId: 'visual_designer',
      markdown: edited,
      nowMs: 7_800,
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(await readFile(skillPath, 'utf8')).toContain('Use taste-skill SVG references');
    expect(updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill' && artifact.roleId === 'visual_designer')?.preview?.content)
      .toContain('Team Overrides');
    expect(updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill_revision' && artifact.roleId === 'visual_designer')?.path)
      .toContain('skills/revisions/');
    expect(updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'visual_designer')?.path)
      .toContain('skills/release-candidates/');
    expect(updated.value.discussion.at(-1)?.text).toContain('角色 skill 已从 War Room 更新');
    expect(updated.value.evidence.some((entry) => entry.source === 'role_skill_editor')).toBe(true);
    expect(updated.value.evidence.at(-1)?.source).toBe('role_skill_release_candidate');
    expect(validateEvolutionProjection(updated.value).ok).toBe(true);
    const updatedSnapshot = [...(updated.value.skillSnapshots ?? [])].reverse()
      .find((snapshot) => snapshot.roleId === 'visual_designer');
    expect(updatedSnapshot).toEqual(expect.objectContaining({
      source: 'custom_user',
      sha256: expect.any(String),
    }));
    await expect(readFile(
      join(root, '.imc/evolution', launched.value.runId, 'skill-snapshots', `${updatedSnapshot?.id}.md`),
      'utf8',
    )).resolves.toBe(await readFile(skillPath, 'utf8'));
    const releaseCandidate = updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'visual_designer');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, releaseCandidate!.path), 'utf8')).resolves.toContain('Release Candidate Governance');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, releaseCandidate!.path), 'utf8')).resolves.toContain('config/evolution/role-skills/approved/visual-hifi.md');

    const approved = await approveEvolutionRoleSkillCandidate({
      runId: launched.value.runId,
      roleId: 'visual_designer',
      candidateArtifactId: releaseCandidate!.id,
      approvalMessage: 'Team approved visual taste-skill defaults.',
      nowMs: 7_900,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.artifacts.find((artifact) => artifact.kind === 'role_skill_library' && artifact.roleId === 'visual_designer')?.path)
      .toBe('config/evolution/role-skills/approved/visual-hifi.md');
    expect(approved.value.discussion.at(-1)?.text).toContain('审批为共享模板');
    expect(approved.value.evidence.at(-1)?.source).toBe('role_skill_approval');
    expect(approved.value.evidence.at(-1)?.summary).toContain('v1.0.0');
    await expect(readFile(join(root, 'config/evolution/role-skills/approved/visual-hifi.md'), 'utf8')).resolves.toContain('Use taste-skill SVG references');
    await expect(readFile(join(root, 'config/evolution/role-skills/approved/visual-hifi.md'), 'utf8')).resolves.not.toContain('Release Candidate Governance');
    const manifest = JSON.parse(await readFile(join(root, 'config/evolution/role-skills/approved/manifest.json'), 'utf8')) as {
      entries?: Array<{ skillName?: string; version?: string; candidateArtifactId?: string; approvalMessage?: string; sha256?: string }>;
    };
    expect(manifest.entries?.at(-1)).toEqual(expect.objectContaining({
      skillName: 'visual-hifi',
      version: '1.0.0',
      candidateArtifactId: releaseCandidate!.id,
      approvalMessage: 'Team approved visual taste-skill defaults.',
      sha256: expect.any(String),
    }));
    expect(approved.value.artifacts.find((artifact) => artifact.kind === 'role_skill_library' && artifact.path.endsWith('manifest.json'))?.preview?.content)
      .toContain('"version": "1.0.0"');
    expect(validateEvolutionProjection(approved.value).ok).toBe(true);

    const sent: Record<string, unknown>[] = [];
    const qaSkillPath = join(root, '.imc/skills/evolution/qa-acceptance.md');
    const qaOriginal = await readFile(qaSkillPath, 'utf8');
    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL,
      requestId: 'req-orch-skill-editor-ws',
      runId: launched.value.runId,
      roleId: 'qa_engineer',
      markdown: `${qaOriginal}\n## Team Overrides\n- Add hostile acceptance cases before staging.\n`,
    }, { send(message: Record<string, unknown>) { sent.push(message); } } as never);

    const ack = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.UPDATE_ROLE_SKILL_ACK) as { projection?: { runId?: string; artifacts?: Array<{ id?: string; kind?: string; roleId?: string; preview?: { content?: string } }> } } | undefined;
    expect(ack?.projection?.runId).toBe(launched.value.runId);
    expect(await readFile(qaSkillPath, 'utf8')).toContain('hostile acceptance cases');
    expect(ack?.projection?.artifacts?.some((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'qa_engineer')).toBe(true);

    const qaCandidate = ack?.projection?.artifacts?.find((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'qa_engineer');
    expect(qaCandidate?.id).toBeTruthy();
    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE,
      requestId: 'req-orch-skill-approve-ws',
      runId: launched.value.runId,
      roleId: 'qa_engineer',
      candidateArtifactId: qaCandidate!.id,
    }, { send(message: Record<string, unknown>) { sent.push(message); } } as never);
    const approveAck = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.APPROVE_ROLE_SKILL_CANDIDATE_ACK) as { projection?: { runId?: string; artifacts?: Array<{ kind?: string; roleId?: string; path?: string }> } } | undefined;
    expect(approveAck?.projection?.runId).toBe(launched.value.runId);
    expect(approveAck?.projection?.artifacts?.some((artifact) => (
      artifact.kind === 'role_skill_library'
      && artifact.roleId === 'qa_engineer'
      && artifact.path === 'config/evolution/role-skills/approved/qa-acceptance.md'
    ))).toBe(true);
    await expect(readFile(join(root, 'config/evolution/role-skills/approved/qa-acceptance.md'), 'utf8')).resolves.toContain('hostile acceptance cases');
  });

  it('requires multiple role skill approvals when a project policy asks for them', async () => {
    const root = await makeRoot();
    await mkdir(join(root, 'config/evolution/role-skills'), { recursive: true });
    await writeFile(join(root, 'config/evolution/role-skills/approval-policy.json'), JSON.stringify({
      version: 1,
      requiredApprovals: 2,
      approvers: ['product-owner', 'tech-lead'],
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'skill-multi-approval.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 9_100,
      request: {
        requestId: 'req-orch-skill-multi-approval',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const skillPath = join(root, '.imc/skills/evolution/backend-implementation.md');
    const original = await readFile(skillPath, 'utf8');
    const edited = `${original}\n## Team Overrides\n- Require API contract tests before implementation handoff.\n`;
    const updated = await updateEvolutionRoleSkill({
      runId: launched.value.runId,
      roleId: 'backend_developer',
      markdown: edited,
      nowMs: 9_200,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const releaseCandidate = updated.value.artifacts.find((artifact) => artifact.kind === 'role_skill_release_candidate' && artifact.roleId === 'backend_developer');
    expect(releaseCandidate).toBeTruthy();
    if (!releaseCandidate) return;

    const firstVote = await approveEvolutionRoleSkillCandidate({
      runId: launched.value.runId,
      roleId: 'backend_developer',
      candidateArtifactId: releaseCandidate.id,
      approverId: 'product-owner',
      approvalMessage: 'Product approves backend handoff quality rule.',
      nowMs: 9_300,
    });
    expect(firstVote.ok).toBe(true);
    if (!firstVote.ok) return;
    expect(firstVote.value.evidence.at(-1)?.source).toBe('role_skill_approval_pending');
    expect(firstVote.value.evidence.at(-1)?.summary).toContain('1/2');
    expect(firstVote.value.artifacts.find((artifact) => artifact.kind === 'role_skill_approval_record' && artifact.roleId === 'backend_developer')?.preview?.content)
      .toContain('Votes: 1/2');
    await expect(readFile(join(root, 'config/evolution/role-skills/approved/backend-implementation.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const secondVote = await approveEvolutionRoleSkillCandidate({
      runId: launched.value.runId,
      roleId: 'backend_developer',
      candidateArtifactId: releaseCandidate.id,
      approverId: 'tech-lead',
      approvalMessage: 'Tech lead approves backend implementation playbook.',
      nowMs: 9_400,
    });
    expect(secondVote.ok).toBe(true);
    if (!secondVote.ok) return;
    expect(secondVote.value.evidence.at(-1)?.source).toBe('role_skill_approval');
    expect(secondVote.value.evidence.at(-1)?.summary).toContain('2/2');
    await expect(readFile(join(root, 'config/evolution/role-skills/approved/backend-implementation.md'), 'utf8')).resolves.toContain('API contract tests');
    const manifest = JSON.parse(await readFile(join(root, 'config/evolution/role-skills/approved/manifest.json'), 'utf8')) as {
      entries?: Array<{ skillName?: string; version?: string; candidateArtifactId?: string; approvalMessage?: string }>;
    };
    expect(manifest.entries?.at(-1)).toEqual(expect.objectContaining({
      skillName: 'backend-implementation',
      version: '1.0.0',
      candidateArtifactId: releaseCandidate.id,
      approvalMessage: 'Tech lead approves backend implementation playbook.',
    }));
    expect(secondVote.value.artifacts.filter((artifact) => artifact.kind === 'role_skill_approval_record' && artifact.roleId === 'backend_developer').at(-1)?.preview?.content)
      .toContain('Votes: 2/2');
    expect(validateEvolutionProjection(secondVote.value).ok).toBe(true);
  });

  it('runs planning autopilot, writes role artifacts, and materializes an OpenSpec change', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'evolution-factory.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_000,
      request: {
        requestId: 'req-orch-autopilot',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const sent: Record<string, unknown>[] = [];

    const autopilot = await runEvolutionAutopilot(launched.value.runId, {
      send(message: Record<string, unknown>) { sent.push(message); },
    }, { nowMs: 11_000 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.linkedOpenSpecChange).toBeTruthy();
    expect(autopilot.value.loopControl.mode).toBe('planning_only');
    expect(autopilot.value.loopControl.signals.find((signal) => signal.id === 'maker_checker_tasks')?.status).toBe('complete');
    expect(autopilot.value.loopControl.signals.find((signal) => signal.id === 'high_fidelity_design')?.status).toBe('complete');
    expect(autopilot.value.loopControl.readinessScore).toBeGreaterThanOrEqual(70);
    expect(autopilot.value.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'prd',
      'prd_review',
      'ux_flow',
      'wireframe',
      'lofi_mockup',
      'hifi_spec',
      'hifi_mockup',
      'taste_hifi_prompt',
      'taste_hifi_output',
      'design_handoff',
      'architecture_baseline',
      'adr',
      'openspec_proposal',
      'openspec_design',
      'openspec_tasks',
      'openspec_spec',
      'implementation_task_matrix',
      'test_plan',
      'test_cases',
      'deployment_plan',
      'staging_setup',
      'staging_config_example',
      'role_skill',
      'roundtable_review',
    ]));
    expect(autopilot.value.artifacts.filter((artifact) => artifact.kind === 'role_skill')).toHaveLength(12);
    expect(autopilot.value.artifacts.find((artifact) => artifact.kind === 'role_skill' && artifact.roleId === 'visual_designer')?.preview).toEqual(expect.objectContaining({
      previewType: 'markdown',
      language: 'markdown',
    }));
    expect(autopilot.value.artifacts.find((artifact) => artifact.kind === 'role_skill' && artifact.roleId === 'visual_designer')?.preview?.content)
      .toContain('taste-skill');
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'artifacts/prd.md')?.preview).toEqual(expect.objectContaining({
      previewType: 'markdown',
    }));
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/hifi-mockup.svg')?.preview).toEqual(expect.objectContaining({
      previewType: 'svg',
    }));
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/hifi-mockup.svg')?.preview?.content).toContain('<svg');
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/taste-hifi-prompt.md')?.preview).toEqual(expect.objectContaining({
      previewType: 'markdown',
    }));
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/taste-hifi-output.md')?.preview).toEqual(expect.objectContaining({
      previewType: 'markdown',
    }));
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/design-handoff.json')?.preview).toEqual(expect.objectContaining({
      previewType: 'text',
      language: 'json',
    }));
    expect(autopilot.value.roles.find((role) => role.roleId === 'tech_director')?.label).toBe('技术总监');
    expect(autopilot.value.discussion.map((entry) => entry.roleId)).toEqual(expect.arrayContaining([
      'product_manager',
      'product_critic',
      'ux_designer',
      'visual_designer',
      'tech_director',
      'qa_engineer',
      'ops_release_manager',
    ]));
    expect(autopilot.value.executionTimeline.length).toBeGreaterThan(0);
    expect(autopilot.value.executionTimeline.map((entry) => entry.roleId)).toEqual(expect.arrayContaining([
      'product_manager',
      'visual_designer',
      'tech_director',
      'qa_engineer',
    ]));
    expect(autopilot.value.executionTimeline.map((entry) => entry.source)).toEqual(expect.arrayContaining([
      'discussion',
      'artifact',
    ]));
    expect(autopilot.value.discussion.some((entry) => entry.kind === 'gate' && entry.text.includes('production'))).toBe(true);
    expect(autopilot.value.roundtables.map((roundtable) => roundtable.id)).toEqual([
      'product-review',
      'design-review',
      'architecture-review',
      'planning-review',
    ]);
    expect(autopilot.value.roundtables.every((roundtable) => roundtable.status === 'complete')).toBe(true);
    expect(autopilot.value.roundtables.find((roundtable) => roundtable.id === 'planning-review')?.summary).toContain('PASS: local deterministic');
    expect(autopilot.value.loopControl.signals.find((signal) => signal.id === 'p2p_roundtables')).toEqual(expect.objectContaining({
      status: 'complete',
    }));
    expect(autopilot.value.evidence.some((entry) => entry.source === 'local_roundtable_review')).toBe(true);
    expect(autopilot.value.liveEvents.some((entry) => entry.title.includes('local fallback PASS'))).toBe(true);
    expect(sent.filter((message) => message.type === EVOLUTION_PIPELINE_MSG.PROJECTION).length).toBeGreaterThanOrEqual(7);

    const change = autopilot.value.linkedOpenSpecChange!;
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/prd.md'), 'utf8')).resolves.toContain('Acceptance Criteria');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/wireframe.svg'), 'utf8')).resolves.toContain('<svg');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/hifi-mockup.svg'), 'utf8')).resolves.toContain('High-fidelity');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-prompt.md'), 'utf8')).resolves.toContain('https://github.com/Leonxlnx/taste-skill');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-output.md'), 'utf8')).resolves.toContain('Built-in taste-skill High-Fidelity Output');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/design-handoff.json'), 'utf8')).resolves.toContain('highFidelityProvider');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'discussions/roundtables/planning-review-local-review.md'), 'utf8')).resolves.toContain('Local Roundtable Review');
    await expect(readFile(join(root, 'openspec/changes', change, 'proposal.md'), 'utf8')).resolves.toContain('What Changes');
    const tasks = await readFile(join(root, 'openspec/changes', change, 'tasks.md'), 'utf8');
    expect(parseOpenSpecTasksMarkdown(tasks).total).toBeGreaterThan(0);
    await expect(readFile(join(root, 'openspec/changes', change, 'specs/evolution-factory/spec.md'), 'utf8')).resolves.toContain('ADDED Requirements');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'implementation/agent-task-matrix.md'), 'utf8')).resolves.toContain('Maker/Checker');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/test-cases.md'), 'utf8')).resolves.toContain('EVT-001');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'delivery/staging-setup.md'), 'utf8')).resolves.toContain('.imc/evolution/delivery.json');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'delivery/delivery.example.json'), 'utf8')).resolves.toContain('"deploy:staging"');
    expect(autopilot.value.loopControl.signals.find((signal) => signal.id === 'delivery_gate')?.artifactIds).toEqual(expect.arrayContaining([
      'deployment_plan:delivery/deployment-plan.md',
      'staging_setup:delivery/staging-setup.md',
      'staging_config_example:delivery/delivery.example.json',
    ]));
  });

  it('waits for explicit high-fidelity approval when requested by the launch', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'hifi-human-review.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_000,
      request: {
        requestId: 'req-hifi-human-review',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        requireHifiHumanApproval: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const waiting = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 8_100 });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    expect(waiting.value.stage).toBe('needs_human');
    expect(waiting.value.blockingQuestions.map((question) => question.id)).toContain(
      `design-hifi-approval-${launched.value.runId}`,
    );
    expect(waiting.value.artifacts.some((artifact) => artifact.kind === 'hifi_mockup' && !!artifact.preview)).toBe(true);
    const firstDesignReviewUpdatedAt = waiting.value.roundtables.find((roundtable) => roundtable.id === 'design-review')?.updatedAt;

    const redesignRequested = await continueEvolutionRun({
      runId: launched.value.runId,
      targetStage: 'design_lofi',
      message: `${EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX} Increase contrast and clarify the primary action.`,
      nowMs: 8_150,
    });
    expect(redesignRequested.ok).toBe(true);
    if (!redesignRequested.ok) return;
    expect(redesignRequested.value.stage).toBe('design_lofi');
    expect(redesignRequested.value.artifacts.some((artifact) => artifact.kind === 'visual_fidelity_report')).toBe(true);
    expect(redesignRequested.value.evidence).toContainEqual(expect.objectContaining({
      source: 'human_design_rework_review_invalidation',
      summary: expect.stringContaining('design-review'),
    }));

    const redesigned = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 8_200 });
    expect(redesigned.ok).toBe(true);
    if (!redesigned.ok) return;
    expect(redesigned.value.stage).toBe('needs_human');
    expect(redesigned.value.blockingQuestions.map((question) => question.id)).toContain(
      `design-hifi-approval-${launched.value.runId}`,
    );
    expect(redesigned.value.roundtables.find((roundtable) => roundtable.id === 'design-review')?.updatedAt)
      .toBeGreaterThan(firstDesignReviewUpdatedAt ?? 0);

    const approved = await continueEvolutionRun({
      runId: launched.value.runId,
      targetStage: 'design_hifi',
      message: 'Approved after previewing the redesigned set.',
      nowMs: 8_250,
    });
    expect(approved.ok).toBe(true);
    const completed = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 8_300 });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.stage).toBe('tasks_ready');
    expect(completed.value.evidence.some((entry) => entry.source === 'human_design_approval')).toBe(true);
  });

  it('applies high-fidelity decisions through a CAS and idempotent typed gate', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'hifi-typed-gate.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_320,
      request: {
        requestId: 'req-hifi-typed-gate',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        requireHifiHumanApproval: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const waiting = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 8_330 });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    const gate = waiting.value.gates?.find((entry) => entry.kind === 'design_review' && entry.status === 'open');
    expect(gate).toBeDefined();
    expect(waiting.value.runRevision).toBeTypeOf('number');
    if (!gate || waiting.value.runRevision === undefined) return;

    const stale = await applyEvolutionGateAction({
      runId: waiting.value.runId,
      gateId: gate.id,
      action: 'approve',
      mutationId: 'typed-gate-stale',
      expectedRunRevision: waiting.value.runRevision - 1,
      nowMs: 8_340,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.issues[0]?.code).toBe('stale_evolution_run_revision');

    const approved = await applyEvolutionGateAction({
      runId: waiting.value.runId,
      gateId: gate.id,
      action: 'approve',
      mutationId: 'typed-gate-approve',
      expectedRunRevision: waiting.value.runRevision,
      nowMs: 8_350,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.gates?.find((entry) => entry.id === gate.id)?.status).toBe('approved');
    for (const revisionId of gate.candidateRevisionIds) {
      expect(approved.value.artifactRevisions?.find((revision) => revision.id === revisionId)).toEqual(
        expect.objectContaining({ status: 'approved', assurance: 'human_approved' }),
      );
    }

    const duplicate = await applyEvolutionGateAction({
      runId: waiting.value.runId,
      gateId: gate.id,
      action: 'approve',
      mutationId: 'typed-gate-approve',
      expectedRunRevision: waiting.value.runRevision,
      nowMs: 8_360,
    });
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.value.runRevision).toBe(approved.value.runRevision);
  });

  it('rejects a high-fidelity review set through the typed gate and requires a fresh revision set', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'hifi-typed-request-changes.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_365,
      request: {
        requestId: 'req-hifi-typed-request-changes',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        requireHifiHumanApproval: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const waiting = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 8_370 });
    expect(waiting.ok).toBe(true);
    if (!waiting.ok) return;
    const gate = waiting.value.gates?.find((entry) => entry.kind === 'design_review' && entry.status === 'open');
    const reviewSet = waiting.value.designReviewSets?.find((entry) => entry.id === gate?.reviewSetId);
    expect(gate).toBeDefined();
    expect(reviewSet).toBeDefined();
    expect(waiting.value.runRevision).toBeTypeOf('number');
    if (!gate || !reviewSet || waiting.value.runRevision === undefined) return;

    const missingFeedback = await applyEvolutionGateAction({
      runId: waiting.value.runId,
      gateId: gate.id,
      action: 'request_changes',
      mutationId: 'typed-gate-request-changes-empty',
      expectedRunRevision: waiting.value.runRevision,
      feedback: '   ',
      nowMs: 8_375,
    });
    expect(missingFeedback.ok).toBe(false);
    if (!missingFeedback.ok) expect(missingFeedback.issues[0]?.code).toBe('evolution_gate_feedback_required');

    const changed = await applyEvolutionGateAction({
      runId: waiting.value.runId,
      gateId: gate.id,
      action: 'request_changes',
      mutationId: 'typed-gate-request-changes',
      expectedRunRevision: waiting.value.runRevision,
      feedback: 'Increase contrast and include the payment failure state.',
      nowMs: 8_380,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.value.gates?.find((entry) => entry.id === gate.id)).toEqual(expect.objectContaining({
      status: 'rejected',
      decision: expect.objectContaining({
        action: 'request_changes',
        feedback: 'Increase contrast and include the payment failure state.',
      }),
    }));
    expect(changed.value.designReviewSets?.find((entry) => entry.id === reviewSet.id)).toEqual(expect.objectContaining({
      status: 'rejected',
      feedback: 'Increase contrast and include the payment failure state.',
    }));
    for (const revisionId of gate.candidateRevisionIds) {
      expect(changed.value.artifactRevisions?.find((revision) => revision.id === revisionId)?.status).toBe('rejected');
    }
    expect(changed.value.evidence).toContainEqual(expect.objectContaining({
      source: 'human_design_rework_review_invalidation',
    }));

    const regenerated = await runEvolutionAutopilot(changed.value.runId, null, { nowMs: 8_390 });
    expect(regenerated.ok).toBe(true);
    if (!regenerated.ok) return;
    const nextOpenGate = regenerated.value.gates?.find((entry) => (
      entry.kind === 'design_review'
      && entry.status === 'open'
      && entry.id !== gate.id
    ));
    expect(nextOpenGate).toBeUndefined();
    expect(regenerated.value.stage).toBe('needs_human');
    expect(regenerated.value.blockingQuestions).toContainEqual(expect.objectContaining({
      id: `design-hifi-regeneration-unchanged-${regenerated.value.runId}`,
    }));
    expect(regenerated.value.evidence).toContainEqual(expect.objectContaining({
      source: 'human_design_rework_unchanged',
      summary: expect.stringContaining(reviewSet.id),
    }));
    expect(regenerated.value.gates?.filter((entry) => entry.id === gate.id)).toHaveLength(1);
  });

  it('binds greenfield mode to an empty in-root target and plans foundation work', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'greenfield-platform.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_400,
      request: {
        requestId: 'req-greenfield-platform',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        developmentMode: 'greenfield_new_system',
        developmentTargetRelativeDir: 'apps/new-system',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.developmentMode).toBe('greenfield_new_system');
    expect(launched.value.developmentTargetRelativeDir).toBe('apps/new-system');

    const planned = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 8_500 });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const baseline = await readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/architecture-baseline.md'), 'utf8');
    expect(baseline).toContain('greenfield_new_system');
    expect(baseline).toContain('apps/new-system');
    expect(baseline).toContain('walking-skeleton');
    const changeRoot = join(root, 'openspec/changes', planned.value.linkedOpenSpecChange!);
    const design = await readFile(join(changeRoot, 'design.md'), 'utf8');
    const tasks = await readFile(join(changeRoot, 'tasks.md'), 'utf8');
    const taskMatrix = await readFile(join(root, '.imc/evolution', launched.value.runId, 'implementation/agent-task-matrix.md'), 'utf8');
    expect(design).toContain('apps/new-system');
    expect(design).toContain('walking skeleton');
    expect(tasks).toContain('health/readiness checks');
    expect(tasks).toContain('container/staging and rollback');
    expect(taskMatrix).toContain('greenfield_new_system');

    await mkdir(join(root, 'apps/occupied'), { recursive: true });
    await writeFile(join(root, 'apps/occupied/existing.txt'), 'do not overwrite', 'utf8');
    const rejected = await launchEvolutionRun({
      projectRoot: root,
      request: {
        requestId: 'req-greenfield-occupied',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        developmentMode: 'greenfield_new_system',
        developmentTargetRelativeDir: 'apps/occupied',
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.issues.map((issue) => issue.code)).toContain('greenfield_target_not_empty');
  });

  it('rejects a greenfield target whose existing path traverses a symbolic link', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'greenfield-symlink.md');
    await mkdir(join(root, 'actual-empty-target'), { recursive: true });
    await mkdir(join(root, 'apps'), { recursive: true });
    await symlink(join(root, 'actual-empty-target'), join(root, 'apps', 'linked-target'));

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_550,
      request: {
        requestId: 'req-greenfield-symlink',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        developmentMode: 'greenfield_new_system',
        developmentTargetRelativeDir: 'apps/linked-target/new-system',
      },
    });
    expect(launched.ok).toBe(false);
    if (!launched.ok) expect(launched.issues.map((entry) => entry.code)).toContain('greenfield_target_symlink');
  });

  it('rechecks the frozen greenfield inventory before auto delivery', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'greenfield-inventory-change.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 8_560,
      request: {
        requestId: 'req-greenfield-inventory-change',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        developmentMode: 'greenfield_new_system',
        developmentTargetRelativeDir: 'apps/inventory-target',
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.writePolicy?.targetInventorySha256).toMatch(/^[a-f0-9]{64}$/);

    await mkdir(join(root, 'apps/inventory-target'), { recursive: true });
    await writeFile(join(root, 'apps/inventory-target/unexpected.txt'), 'occupied\n', 'utf8');
    const autoDeliver = vi.fn().mockResolvedValue({ ok: true });
    setEvolutionAutoDeliverLauncher(autoDeliver);
    const result = await runEvolutionAutopilot(
      launched.value.runId,
      { send: vi.fn() },
      { nowMs: 8_570 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stage).toBe('needs_human');
    expect(result.value.autoDelivery?.lastError).toContain('greenfield_target_not_empty');
    expect(autoDeliver).not.toHaveBeenCalled();
  });

  it('propagates War Room instructions into generated planning and taste-skill artifacts', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'visual-direction.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_050,
      request: {
        requestId: 'req-orch-instructions',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const instruction = '请高保真优先采用移动端优先和高级暗色科技风。';
    const messaged = await recordEvolutionUserMessage({
      runId: launched.value.runId,
      roleId: 'visual_designer',
      text: instruction,
      nowMs: 10_075,
    });
    expect(messaged.ok).toBe(true);

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_100 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const change = autopilot.value.linkedOpenSpecChange!;

    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/prd.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/hifi-spec.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-prompt.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-output.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/design-handoff.json'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, 'openspec/changes', change, 'design.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, 'openspec/changes', change, 'tasks.md'), 'utf8')).resolves.toContain('War Room user instructions');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'implementation/agent-task-matrix.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/test-cases.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'delivery/deployment-plan.md'), 'utf8')).resolves.toContain(instruction);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'delivery/staging-setup.md'), 'utf8')).resolves.toContain(instruction);
  });

  it('derives high-fidelity UI context from the requirement instead of a hardcoded test domain', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirementContent(root, 'course-booking.md', [
      '# 校园课程预约后台',
      '',
      '面向教务管理员和教师，设计一个 PC 管理端课程预约页面。',
      '- 导航包含课程概览、预约管理、教室配置。',
      '- 核心对象包括课程、教师、教室、学生预约记录。',
      '- 支持新增课程、编辑课程、查看预约详情、筛选预约状态、导出预约记录。',
      '- 页面需要列表、详情抽屉、表单弹窗、空状态、加载状态和无权限状态。',
    ].join('\n'));
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_120,
      request: {
        requestId: 'req-orch-source-driven-ui',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_130 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');

    const prompt = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-prompt.md'), 'utf8');
    const handoff = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/design-handoff.json'), 'utf8');
    expect(prompt).toContain('校园课程预约后台');
    expect(prompt).toContain('课程');
    expect(prompt).toContain('教师');
    expect(prompt).not.toContain('IM.codes Evolution War Room for operators');
    expect(prompt).not.toContain('区域代理');
    expect(handoff).toContain('"domain": "business_app"');
    expect(handoff).toContain('预约管理');
    expect(handoff).not.toContain('淘金树');
  });

  it('keeps a business requirement source-bound even when the MD mentions IM.codes/OpenSpec', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirementContent(root, 'taojinshu-agent-plan.md', [
      '# 淘金树超级管理员代理层级管理技术方案',
      '',
      '这份 MD 由 IM.codes 机器人讨论后沉淀，后续用 OpenSpec 进入开发，但业务目标不是 IM.codes War Room。',
      '根据需求截图，本次改造目标是在淘金树体系中新增“超级管理员视角”的账号管理能力，覆盖三端。',
      '- `taojinshu-AI`：服务端 jar 项目，提供数据模型、事务、权限和 API。',
      '- `taoAi`：H5 项目，新增移动端超级管理员账号管理页面。',
      '- `taojinshu-ai-admin`：PC 管理端新增代理层级管理页面。',
      '- 区域代理：有姓名、手机号、所属区域、状态、初始/剩余/已用官方代理资格，可充值、停用、编辑、重置密码、查看详情。',
      '- 官方代理：归属于某个上级区域代理，有体验版账号资格和标准版账号资格两类库存，可充值、停用、编辑、重置密码、查看详情。',
      '- 绑定账号：官方代理详情中按体验版账号、标准版账号分 tab 展示绑定账号和剩余天数。',
      '- 一期默认支持“新建并绑定账号”，不默认支持绑定既有账号或跨官方代理迁移。',
    ].join('\n'));
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_160,
      request: {
        requestId: 'req-orch-taojinshu-source-bound',
        sessionName: 'deck_tjs_brain',
        projectName: 'tjs',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_170 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');
    const change = autopilot.value.linkedOpenSpecChange!;

    const prd = await readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/prd.md'), 'utf8');
    expect(prd).toContain('区域代理');
    expect(prd).toContain('官方代理');
    expect(prd).toContain('体验版账号');
    expect(prd).toContain('标准版账号');
    expect(prd).not.toContain('把需求文档放入 inbox 后自动得到 PRD');
    expect(prd).not.toContain('War Room 中看到角色状态');

    const prompt = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-prompt.md'), 'utf8');
    expect(prompt).toContain('H5/移动端');
    expect(prompt).toContain('PC/管理端');
    expect(prompt).toContain('区域代理');
    expect(prompt).toContain('官方代理');
    expect(prompt).not.toContain('Evolution War Room operations console');

    const tasks = await readFile(join(root, 'openspec/changes', change, 'tasks.md'), 'utf8');
    expect(tasks).toContain('区域代理');
    expect(tasks).toContain('官方代理');
    expect(tasks).toContain('体验版账号');
    expect(tasks).not.toContain('Implement the smallest product slice');
  });

  it('applies the selected high-fidelity target surface to PRD, prompt, and handoff', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirementContent(root, 'surface-choice.md', [
      '# 代理账号管理改造',
      '',
      '为超级管理员设计代理账号管理能力，当前业务同时需要移动端快速查看和 PC 管理后台批量维护。',
      '- 核心对象包括区域代理、官方代理、体验版账号、标准版账号。',
      '- 支持新增、编辑、停用、充值、重置密码、查看详情、筛选和导出。',
      '- 需要列表、详情、表单弹窗、库存/配额展示、空状态、加载状态和无权限状态。',
    ].join('\n'));
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_180,
      request: {
        requestId: 'req-orch-surface-choice',
        sessionName: 'deck_tjs_brain',
        projectName: 'tjs',
        sourceRelativePath,
        autoStart: true,
        designTargetSurface: 'both',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.designTargetSurface).toBe('both');

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_190 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.designTargetSurface).toBe('both');

    const prd = await readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/prd.md'), 'utf8');
    const prompt = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-prompt.md'), 'utf8');
    const hifiSpec = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/hifi-spec.md'), 'utf8');
    const handoff = JSON.parse(await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/design-handoff.json'), 'utf8')) as {
      designTargetSurface?: string;
      primarySurface?: string;
      screens?: Array<{ name?: string; purpose?: string }>;
      hifiScreens?: Array<{ name?: string; path?: string }>;
    };

    expect(prd).toContain('H5/移动端 + PC/管理端');
    expect(prompt).toContain('高保真目标端：移动端/H5 + PC/管理端');
    expect(hifiSpec).toContain('高保真目标端：移动端/H5 + PC/管理端');
    expect(handoff.designTargetSurface).toBe('both');
    expect(handoff.primarySurface).toContain('H5/移动端 + PC/管理端');
    expect(handoff.screens?.some((screen) => screen.name?.includes('移动端/H5'))).toBe(true);
    expect(handoff.screens?.some((screen) => screen.name?.includes('PC/管理端'))).toBe(true);
    expect(handoff.hifiScreens?.some((screen) => screen.path === 'design/hifi-screens/screen-01.svg')).toBe(true);
  });

  it('copies sibling reference images into the design manifest and prompt when screenshots are supplied', async () => {
    const root = await makeRoot();
    const inbox = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR);
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, '01-dashboard.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Dashboard reference</text></svg>', 'utf8');
    await writeFile(join(inbox, '02-detail.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Detail reference</text></svg>', 'utf8');
    const sourceRelativePath = await writeRequirementContent(root, 'reference-driven.md', [
      '# 会员积分管理页面',
      '',
      '请根据用户提供的 7 张参考图生成高保真，当前目录下已放入部分参考图。',
      '- 页面包含积分概览、会员列表、积分明细。',
      '- 支持搜索会员、调整积分、查看积分流水、导出明细。',
    ].join('\n'));
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_140,
      request: {
        requestId: 'req-orch-reference-images',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    // Reference images engage the alwaysGate visual-fidelity roundtable at
    // design_hifi — provide a live launcher and a PASS verdict so the run
    // can advance to tasks_ready (a silent local fallback is forbidden).
    setEvolutionRoundtableLauncher(async (request) => ({
      ok: true,
      p2pRunId: `p2p_ref_${request.roundtableSpecId}`,
      discussionId: `dsc_ref_${request.roundtableSpecId}`,
      contextPath: `.imc/discussions/p2p_ref_${request.roundtableSpecId}.md`,
    }));
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_150 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('design_hifi');
    await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_ref_visual-fidelity-review',
        discussion_id: 'dsc_ref_visual-fidelity-review',
        status: 'completed',
        mode_key: 'review',
        current_round: 2,
        total_rounds: 2,
        result_summary: 'PASS: 高保真与参考图布局一致。',
        completed_at: '2026-07-08T00:00:00.000Z',
      },
      serverLink: { send() { /* ignore */ } },
      nowMs: 10_160,
    });
    const resumed = await getEvolutionRun(launched.value.runId);
    expect(resumed?.value?.stage).toBe('tasks_ready');
    expect(resumed?.value?.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'design_reference_manifest',
      'design_reference_image',
      'hifi_mockup',
      'taste_hifi_prompt',
    ]));

    const manifest = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/reference-images.md'), 'utf8');
    const prompt = await readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-prompt.md'), 'utf8');
    expect(manifest).toContain('READY — found 2 reference image');
    expect(manifest).toContain('01-dashboard.svg');
    expect(prompt).toContain('design/reference-images/01-01-dashboard.svg');
    expect(prompt).toContain('at least 2 screens or states');
    expect(prompt).toContain('会员积分管理页面');
    expect(autopilot.value.artifacts.filter((artifact) => artifact.kind === 'hifi_mockup' && artifact.path.startsWith('design/hifi-screens/'))).toHaveLength(2);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/hifi-screens/screen-01.svg'), 'utf8')).resolves.toContain('Ref 1/2');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/hifi-screens/screen-02.svg'), 'utf8')).resolves.toContain('Ref 2/2');
  });

  it('runs a configured taste-skill high-fidelity generator and records its output artifact', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/design.json'), JSON.stringify({
      tasteSkill: {
        enabled: true,
        command: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'const out = process.argv[1];',
            'const prompt = process.env.IMCODES_EVOLUTION_TASTE_PROMPT;',
            'fs.writeFileSync(out, "# taste-skill output\\n\\nGenerated from " + prompt + "\\n", "utf8");',
          ].join(' '),
          '{outputPath}',
        ],
        outputRelativePath: 'design/taste-hifi-output.md',
        timeoutMs: 30_000,
      },
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'taste-runner.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_120,
      request: {
        requestId: 'req-orch-taste-runner',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_150 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'taste_hifi_output',
      'taste_hifi_log',
    ]));
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/taste-hifi-output.md')?.preview).toEqual(expect.objectContaining({
      previewType: 'markdown',
    }));
    expect(autopilot.value.evidence.some((entry) => entry.source === 'taste_skill_hifi_generation' && entry.summary.includes('passed'))).toBe(true);
    expect(autopilot.value.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'visual_designer', source: 'evidence', stage: 'design_hifi' }),
    ]));
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-output.md'), 'utf8')).resolves.toContain('taste-skill output');
    expect(validateEvolutionProjection(autopilot.value).ok).toBe(true);
  });

  it('runs the bundled taste-skill runner and records its SVG reference artifact', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    const runnerPath = join(process.cwd(), 'scripts/run-taste-skill.mjs');
    await writeFile(join(root, '.imc/evolution/design.json'), JSON.stringify({
      tasteSkill: {
        enabled: true,
        command: process.execPath,
        args: [
          runnerPath,
          '--prompt',
          '{promptPath}',
          '--design-handoff',
          '{designHandoffPath}',
          '--output',
          '{outputPath}',
          '--reference-output',
          '{referencePath}',
        ],
        outputRelativePath: 'design/taste-hifi-output.md',
        referenceRelativePath: 'design/taste-hifi-reference.svg',
        timeoutMs: 30_000,
      },
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'bundled-taste-runner.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_160,
      request: {
        requestId: 'req-orch-bundled-taste-runner',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_175 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'taste_hifi_output',
      'taste_hifi_reference',
      'taste_hifi_log',
    ]));
    expect(autopilot.value.artifacts.find((artifact) => artifact.path === 'design/taste-hifi-reference.svg')?.preview).toEqual(expect.objectContaining({
      previewType: 'svg',
    }));
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-output.md'), 'utf8')).resolves.toContain('Figma Bypass Contract');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-output.md'), 'utf8')).resolves.toContain('Design Read');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-reference.svg'), 'utf8')).resolves.toContain('<svg');
    expect(validateEvolutionProjection(autopilot.value).ok).toBe(true);
  });

  it('records PNG high-fidelity reference output as an image preview artifact', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/design.json'), JSON.stringify({
      tasteSkill: {
        enabled: true,
        command: process.execPath,
        args: [
          '-e',
          [
            'const fs = require("node:fs");',
            'const out = process.argv[1];',
            'const ref = process.argv[2];',
            'fs.writeFileSync(out, "# taste-skill output\\n\\nPNG reference generated.\\n", "utf8");',
            'fs.writeFileSync(ref, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAwUBAScY42YAAAAASUVORK5CYII=", "base64"));',
          ].join(' '),
          '{outputPath}',
          '{referencePath}',
        ],
        outputRelativePath: 'design/taste-hifi-output.md',
        referenceRelativePath: 'design/taste-hifi-reference.png',
        timeoutMs: 30_000,
      },
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'taste-png-reference.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_176,
      request: {
        requestId: 'req-orch-taste-png-reference',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_177 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const reference = autopilot.value.artifacts.find((artifact) => artifact.path === 'design/taste-hifi-reference.png');
    expect(reference).toEqual(expect.objectContaining({
      kind: 'taste_hifi_reference',
      title: 'taste-skill High-Fidelity PNG Reference',
      bytes: expect.any(Number),
    }));
    expect(reference?.preview).toEqual(expect.objectContaining({
      previewType: 'image',
      language: 'image/png',
    }));
    expect(reference?.preview?.content).toMatch(/^data:image\/png;base64,/);
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'design/taste-hifi-reference.png'))).resolves.toBeInstanceOf(Buffer);
    expect(validateEvolutionProjection(autopilot.value).ok).toBe(true);
  });

  it('pauses at needs_human when required taste-skill high-fidelity generation fails', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/design.json'), JSON.stringify({
      tasteSkill: {
        enabled: true,
        required: true,
        command: process.execPath,
        args: ['-e', 'process.stderr.write("taste generation failed"); process.exit(8)'],
        timeoutMs: 30_000,
      },
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'taste-required-fail.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_180,
      request: {
        requestId: 'req-orch-taste-required-fail',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 10_210 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('needs_human');
    expect(autopilot.value.blockingQuestions.some((question) => question.question.includes('Required taste-skill high-fidelity generation failed'))).toBe(true);
    expect(autopilot.value.artifacts.map((artifact) => artifact.kind)).toContain('taste_hifi_log');
    expect(autopilot.value.artifacts.map((artifact) => artifact.kind)).not.toContain('taste_hifi_output');
    expect(autopilot.value.discussion.at(-1)?.kind).toBe('gate');
    expect(autopilot.value.discussion.at(-1)?.text).toContain('taste-skill 高保真生成失败');
  });

  it('generates run-isolated OpenSpec change names for repeated requirement titles', async () => {
    const root = await makeRoot();
    const firstSource = await writeRequirement(root, 'repeat-a.md');
    const secondSource = await writeRequirement(root, 'repeat-b.md');
    const first = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_100,
      request: {
        requestId: 'req-orch-repeat-a',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath: firstSource,
        autoStart: true,
      },
    });
    const second = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 10_200,
      request: {
        requestId: 'req-orch-repeat-b',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath: secondSource,
        autoStart: true,
      },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstPlan = await runEvolutionAutopilot(first.value.runId, null, { nowMs: 10_300 });
    const secondPlan = await runEvolutionAutopilot(second.value.runId, null, { nowMs: 10_400 });
    expect(firstPlan.ok).toBe(true);
    expect(secondPlan.ok).toBe(true);
    if (!firstPlan.ok || !secondPlan.ok) return;
    expect(firstPlan.value.linkedOpenSpecChange).toBeTruthy();
    expect(secondPlan.value.linkedOpenSpecChange).toBeTruthy();
    expect(firstPlan.value.linkedOpenSpecChange).not.toBe(secondPlan.value.linkedOpenSpecChange);

    const updates = await recordEvolutionOpenSpecProjection({
      projection: {
        visibility: 'full',
        projectionVersion: 1,
        runId: 'auto_repeat_second_only',
        changeName: secondPlan.value.linkedOpenSpecChange!,
        presetId: 'standard',
        materializedLimits: {
          specAuditRepairRounds: 1,
          implementationAuditRepairRounds: 1,
          maxImplementationPrompts: 6,
          maxElapsedMinutes: 240,
        },
        status: 'implementation_task_loop',
        stage: 'implementation_task_loop',
        owningMainSessionName: 'deck_demo_brain',
        launchedFromSessionName: 'deck_demo_brain',
        targetImplementationSessionName: 'deck_demo_brain',
        generation: 1,
        implementationPromptCount: 1,
        elapsedMs: 50,
        taskStats: { total: 1, checked: 0, unchecked: 1, items: [] },
        specAuditRepairRound: 0,
        implementationAuditRepairRound: 0,
        canStop: true,
        canContinue: false,
      },
      nowMs: 10_500,
    });
    expect(updates.map((entry) => entry.runId)).toEqual([second.value.runId]);
    expect(updates[0]?.stage).toBe('implementation_loop');
    const firstAfterBackflow = getEvolutionRun(first.value.runId);
    expect(firstAfterBackflow.ok).toBe(true);
    if (firstAfterBackflow.ok) expect(firstAfterBackflow.value.stage).toBe('tasks_ready');
  });

  it('records a running P2P planning roundtable when a roundtable launcher is available', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'roundtable.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 12_000,
      request: {
        requestId: 'req-orch-roundtable',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const launchRequests: Array<{
      topic: string;
      roles: string[];
      roleInstructions: Array<{ roleId: string; skillName?: string; responsibilities: string[] }>;
      artifactPaths: string[];
    }> = [];
    setEvolutionRoundtableLauncher(async (request) => {
      launchRequests.push({
        topic: request.topic,
        roles: [...request.roles],
        roleInstructions: request.roleInstructions.map((role) => ({
          roleId: role.roleId,
          ...(role.skillName ? { skillName: role.skillName } : {}),
          responsibilities: [...role.responsibilities],
        })),
        artifactPaths: [...request.artifactPaths],
      });
      const p2pRunId = request.topic === '规划复核圆桌' ? 'p2p_roundtable_1' : `p2p_${request.stage}`;
      const discussionId = request.topic === '规划复核圆桌' ? 'dsc_roundtable_1' : `dsc_${request.stage}`;
      return {
        ok: true,
        p2pRunId,
        discussionId,
        contextPath: `.imc/discussions/${p2pRunId}.md`,
      };
    });

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 13_000 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(launchRequests.map((request) => request.topic)).toEqual(['规划复核圆桌']);
    const planningRequest = launchRequests.find((request) => request.topic === '规划复核圆桌');
    expect(planningRequest?.roles).toContain('tech_director');
    expect(planningRequest?.roleInstructions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleId: 'product_manager',
        skillName: 'product-prd',
        responsibilities: expect.arrayContaining(['需求分析', 'PRD']),
      }),
      expect.objectContaining({
        roleId: 'tech_director',
        skillName: 'tech-baseline-adr',
        responsibilities: expect.arrayContaining(['架构基线', 'OpenSpec 任务']),
      }),
    ]));
    expect(planningRequest?.artifactPaths).toEqual(expect.arrayContaining([
      'artifacts/prd.md',
      'design/hifi-mockup.svg',
      'design/taste-hifi-prompt.md',
      'implementation/agent-task-matrix.md',
      'artifacts/test-cases.md',
    ]));
    const planningRoundtable = autopilot.value.roundtables.find((roundtable) => roundtable.id === 'planning-review');
    expect(planningRoundtable).toEqual(expect.objectContaining({
      id: 'planning-review',
      status: 'running',
      p2pRunId: 'p2p_roundtable_1',
      discussionId: 'dsc_roundtable_1',
    }));
    expect(autopilot.value.roundtables.find((roundtable) => roundtable.id === 'product-review')).toEqual(expect.objectContaining({ status: 'complete' }));
    expect(autopilot.value.discussion.some((entry) => entry.text.includes('已启动 IM.codes P2P 规划复核圆桌'))).toBe(true);

    const sent: Record<string, unknown>[] = [];
    const runningBackflow = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_roundtable_1',
        discussion_id: 'dsc_roundtable_1',
        status: 'running',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        current_target_session: 'deck_demo_w1',
      },
      serverLink: { send(message: Record<string, unknown>) { sent.push(message); } },
      nowMs: 14_000,
    });
    expect(runningBackflow[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'running',
      currentTargetSession: 'deck_demo_w1',
    }));

    const completeBackflow = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_roundtable_1',
        discussion_id: 'dsc_roundtable_1',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'PASS: allow development loop after product and QA checks.',
        completed_at: '2026-07-08T00:00:00.000Z',
      },
      serverLink: { send(message: Record<string, unknown>) { sent.push(message); } },
      nowMs: 15_000,
    });
    expect(completeBackflow[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'complete',
      summary: 'PASS: allow development loop after product and QA checks.',
      completedAt: '2026-07-08T00:00:00.000Z',
    }));
    expect(completeBackflow[0]?.discussion.some((entry) =>
      entry.author === 'P2P 规划复核圆桌' && entry.text.includes('PASS: allow development loop'),
    )).toBe(true);
    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.PROJECTION);
  });

  it('reconciles completed P2P roundtable context files on War Room status refresh', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'roundtable-context-rework.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 15_100,
      request: {
        requestId: 'req-orch-roundtable-context',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    setEvolutionRoundtableLauncher(async (request) => {
      const p2pRunId = request.topic === '规划复核圆桌' ? 'p2p_context_gate' : `p2p_context_${request.stage}`;
      return {
        ok: true,
        p2pRunId,
        discussionId: `dsc_${p2pRunId}`,
        contextPath: `.imc/discussions/${p2pRunId}.md`,
      };
    });

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 15_200 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_context_gate',
    }));

    await mkdir(join(root, '.imc/discussions'), { recursive: true });
    await writeFile(join(root, '.imc/discussions/p2p_context_gate.md'), [
      '# P2P Discussion: p2p_context_gate',
      '',
      '## User Request',
      '',
      '输出要求：先给 PASS / REWORK 建议。',
      '',
      '## Business Summary',
      '',
      '结论：REWORK。不允许进入 OpenSpec Auto Deliver 开发 loop。',
      '',
      '必须先修正 PRD、设计状态、架构边界和测试缺口。',
      '',
    ].join('\n'), 'utf8');

    const sent: Record<string, unknown>[] = [];
    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.STATUS_REQUEST,
      requestId: 'req-orch-roundtable-context-status',
      projectRoot: root,
      runId: launched.value.runId,
    }, { send(message: Record<string, unknown>) { sent.push(message); } } as never);

    const status = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION) as { projection?: { stage?: string; roundtables?: Array<{ id?: string; status?: string; summary?: string }>; blockingQuestions?: Array<{ question?: string }> } } | undefined;
    expect(status?.projection?.stage).toBe('needs_human');
    expect(status?.projection?.roundtables?.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'complete',
      summary: expect.stringContaining('REWORK'),
    }));
    expect(status?.projection?.blockingQuestions?.[0]?.question).toContain('planning_roundtable_requires_rework');
  });

  it('recovers legacy post-summary timeout roundtables from discussion verdicts on status refresh', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'roundtable-legacy-timeout.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 15_500,
      request: {
        requestId: 'req-orch-roundtable-timeout-recover',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    setEvolutionRoundtableLauncher(async (request) => {
      const p2pRunId = request.topic === '规划复核圆桌' ? 'p2p_legacy_timeout_gate' : `p2p_timeout_${request.stage}`;
      return {
        ok: true,
        p2pRunId,
        discussionId: `dsc_${p2pRunId}`,
        contextPath: `.imc/discussions/${p2pRunId}.md`,
      };
    });

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 15_600 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_legacy_timeout_gate',
    }));

    await mkdir(join(root, '.imc/discussions'), { recursive: true });
    await writeFile(join(root, '.imc/discussions/p2p_legacy_timeout_gate.md'), [
      '# P2P Discussion: p2p_legacy_timeout_gate',
      '',
      '## brain:codex-sdk:review — Final Summary',
      '',
      '### Summary',
      '',
      '结论：REWORK。当前需求、设计、架构仍然错域，不能启动开发 loop。',
      '',
      '必须先重写 PRD、UX flow、架构基线和任务矩阵。',
      '',
    ].join('\n'), 'utf8');

    const failedBackflow = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_legacy_timeout_gate',
        discussion_id: 'dsc_p2p_legacy_timeout_gate',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        status: 'timed_out',
        current_target_session: null,
        error: 'timed_out: post_summary_execution_confirmation_timeout',
      } as never,
    });
    expect(failedBackflow[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'failed',
      summary: 'timed_out: post_summary_execution_confirmation_timeout',
    }));

    const sent: Record<string, unknown>[] = [];
    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.STATUS_REQUEST,
      requestId: 'req-orch-roundtable-timeout-recover-status',
      projectRoot: root,
      runId: launched.value.runId,
    }, { send(message: Record<string, unknown>) { sent.push(message); } } as never);

    const status = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION) as { projection?: { stage?: string; roundtables?: Array<{ id?: string; status?: string; summary?: string; error?: string }>; blockingQuestions?: Array<{ question?: string }> } } | undefined;
    const planning = status?.projection?.roundtables?.find((roundtable) => roundtable.id === 'planning-review');
    expect(status?.projection?.stage).toBe('needs_human');
    expect(planning).toEqual(expect.objectContaining({
      status: 'complete',
      summary: expect.stringContaining('REWORK'),
    }));
    expect(planning?.error).toBeUndefined();
    expect(status?.projection?.blockingQuestions?.[0]?.question).toContain('planning_roundtable_requires_rework');
  });

  it('does not remove an existing planning blocker when recovering a non-planning timeout roundtable', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'roundtable-non-planning-timeout.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 15_900,
      request: {
        requestId: 'req-orch-roundtable-non-planning-timeout',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    setEvolutionRoundtableLauncher(async (request) => {
      const p2pRunId = request.topic === '产品需求圆桌'
        ? 'p2p_product_timeout'
        : request.topic === '规划复核圆桌'
          ? 'p2p_planning_rework'
          : `p2p_${request.stage}`;
      return {
        ok: true,
        p2pRunId,
        discussionId: `dsc_${p2pRunId}`,
        contextPath: `.imc/discussions/${p2pRunId}.md`,
      };
    });

    const firstPause = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 16_000 });
    expect(firstPause.ok).toBe(true);
    if (!firstPause.ok) return;
    expect(firstPause.value.roundtables.find((roundtable) => roundtable.id === 'product-review')).toEqual(expect.objectContaining({ p2pRunId: 'p2p_product_timeout' }));

    const productPass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_product_timeout',
        discussion_id: 'dsc_p2p_product_timeout',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        status: 'completed',
        current_target_session: null,
        result_summary: 'PASS: product roundtable passed initially.',
        completed_at: '2026-07-08T00:00:00.000Z',
      } as never,
      nowMs: 16_010,
    });
    expect(productPass[0]?.roundtables.find((roundtable) => roundtable.id === 'design-review')).toEqual(expect.objectContaining({ p2pRunId: 'p2p_design_hifi' }));

    const designPass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_design_hifi',
        discussion_id: 'dsc_p2p_design_hifi',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        status: 'completed',
        current_target_session: null,
        result_summary: 'PASS: design roundtable passed.',
        completed_at: '2026-07-08T00:00:10.000Z',
      } as never,
      nowMs: 16_020,
    });
    expect(designPass[0]?.roundtables.find((roundtable) => roundtable.id === 'architecture-review')).toEqual(expect.objectContaining({ p2pRunId: 'p2p_architecture_baseline' }));

    const architecturePass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_architecture_baseline',
        discussion_id: 'dsc_p2p_architecture_baseline',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        status: 'completed',
        current_target_session: null,
        result_summary: 'PASS: architecture roundtable passed.',
        completed_at: '2026-07-08T00:00:20.000Z',
      } as never,
      nowMs: 16_030,
    });
    expect(architecturePass[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({ p2pRunId: 'p2p_planning_rework' }));

    await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_planning_rework',
        discussion_id: 'dsc_p2p_planning_rework',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        status: 'completed',
        current_target_session: null,
        result_summary: 'REWORK: planning gate must block implementation.',
        completed_at: '2026-07-08T00:00:30.000Z',
      } as never,
      nowMs: 16_040,
    });

    await mkdir(join(root, '.imc/discussions'), { recursive: true });
    await writeFile(join(root, '.imc/discussions/p2p_product_timeout.md'), [
      '# P2P Discussion: p2p_product_timeout',
      '',
      '## brain:codex-sdk:review — Final Summary',
      '',
      '结论：REWORK。产品需求仍不完整，但这是产品圆桌，不是规划圆桌。',
      '',
    ].join('\n'), 'utf8');
    await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_product_timeout',
        discussion_id: 'dsc_p2p_product_timeout',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        status: 'timed_out',
        current_target_session: null,
        error: 'timed_out: post_summary_execution_timeout',
      } as never,
      nowMs: 16_050,
    });

    const sent: Record<string, unknown>[] = [];
    await handleEvolutionPipelineCommand({
      type: EVOLUTION_PIPELINE_MSG.STATUS_REQUEST,
      requestId: 'req-orch-roundtable-non-planning-timeout-status',
      projectRoot: root,
      runId: launched.value.runId,
    }, { send(message: Record<string, unknown>) { sent.push(message); } } as never);

    const status = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.STATUS_PROJECTION) as { projection?: { roundtables?: Array<{ id?: string; status?: string; summary?: string; error?: string }>; blockingQuestions?: Array<{ id?: string; question?: string }> } } | undefined;
    expect(status?.projection?.roundtables?.find((roundtable) => roundtable.id === 'product-review')).toEqual(expect.objectContaining({
      status: 'complete',
      summary: expect.stringContaining('PASS'),
    }));
    expect(status?.projection?.blockingQuestions?.some((question) =>
      question.id === `planning-roundtable-${launched.value.runId}-blocked` &&
      question.question?.includes('planning_roundtable_requires_rework'),
    )).toBe(true);
  });

  it('records failed P2P planning roundtables as War Room gates', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'roundtable-failure.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 16_000,
      request: {
        requestId: 'req-orch-roundtable-fail',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    setEvolutionRoundtableLauncher(async (request) => ({
      ok: true,
      p2pRunId: request.topic === '规划复核圆桌' ? 'p2p_roundtable_fail' : `p2p_${request.stage}`,
      discussionId: request.topic === '规划复核圆桌' ? 'dsc_roundtable_fail' : `dsc_${request.stage}`,
    }));
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 17_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;

    const failed = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_roundtable_fail',
        discussion_id: 'dsc_roundtable_fail',
        status: 'failed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        error: 'critic found contradictory acceptance criteria',
        completed_at: '2026-07-08T00:01:00.000Z',
      },
      nowMs: 18_000,
    });

    expect(failed[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'failed',
      error: 'critic found contradictory acceptance criteria',
      completedAt: '2026-07-08T00:01:00.000Z',
    }));
    expect(failed[0]?.stage).toBe('needs_human');
    expect(failed[0]?.blockingQuestions[0]?.question).toContain('planning roundtable gate');
    expect(failed[0]?.discussion.at(-1)).toEqual(expect.objectContaining({
      kind: 'gate',
    }));
  });

  it('binds governed roundtables to exact skill bytes and blocks a verdict marker that is not last', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'governed-receipt.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 16_500,
      request: {
        requestId: 'req-governed-receipt',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        executionPolicy: 'governed',
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    let captured: {
      roleInstructions: Array<{ roleId: string; skillSnapshotId?: string; skillSha256?: string; skillContent?: string }>;
    } | null = null;
    setEvolutionRoundtableLauncher(async (request) => {
      captured = request;
      return {
        ok: true,
        p2pRunId: 'p2p_governed_receipt',
        discussionId: 'dsc_governed_receipt',
      };
    });
    const pending = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 16_510 });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    const productInstruction = captured?.roleInstructions.find((entry) => entry.roleId === 'product_manager');
    expect(productInstruction?.skillSnapshotId).toBeTruthy();
    expect(productInstruction?.skillSha256).toMatch(/^[a-f0-9]{64}$/);
    const snapshottedBytes = await readFile(
      join(root, '.imc/evolution', launched.value.runId, 'skill-snapshots', `${productInstruction?.skillSnapshotId}.md`),
      'utf8',
    );
    expect(productInstruction?.skillContent).toBe(snapshottedBytes);

    const blocked = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_governed_receipt',
        discussion_id: 'dsc_governed_receipt',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: [
          '<!-- EVOLUTION_VERDICT: PASS -->',
          'This trailing prose makes the structured receipt invalid.',
        ].join('\n'),
        completed_at: '2026-07-08T00:02:00.000Z',
      },
      nowMs: 16_520,
    });
    expect(blocked[0]?.stage).toBe('needs_human');
    // The first governed roundtable at intake_normalized is now the Product Maker.
    expect(blocked[0]?.roundtables.find((entry) => entry.id === 'product-maker')?.summary)
      .not.toContain('EVOLUTION_VERDICT');
    expect(blocked[0]?.attempts?.find((entry) => entry.p2pRunId === 'p2p_governed_receipt')?.status)
      .toBe('blocked');
    expect(blocked[0]?.verdictRecords).toHaveLength(0);
  });

  it('delivers War Room role messages into the matching active P2P roundtable context', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'war-room-message.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 19_000,
      request: {
        requestId: 'req-orch-roundtable-message',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    setEvolutionRoundtableLauncher(async (request) => ({
      ok: true,
      p2pRunId: request.topic === '规划复核圆桌' ? 'p2p_message_planning' : `p2p_message_${request.stage}`,
      discussionId: request.topic === '规划复核圆桌' ? 'dsc_message_planning' : `dsc_message_${request.stage}`,
      contextPath: `.imc/discussions/${request.stage}.md`,
    }));
    const deliveries: Array<{ roundtableId: string; roleId?: string; text: string }> = [];
    setEvolutionRoundtableUserMessageSink(async (request) => {
      deliveries.push({
        roundtableId: request.roundtable.id,
        ...(request.roleId ? { roleId: request.roleId } : {}),
        text: request.text,
      });
      return {
        ok: true,
        ...(request.roundtable.contextPath ? { contextPath: request.roundtable.contextPath } : {}),
        currentTargetSession: 'deck_demo_w2',
      };
    });

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 19_500 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(autopilot.value.stage).toBe('tasks_ready');

    const messaged = await recordEvolutionUserMessage({
      runId: launched.value.runId,
      roleId: 'tech_director',
      text: '请技术总监把数据库迁移风险作为实现前阻塞项复核。',
      nowMs: 19_800,
    });

    expect(messaged.ok).toBe(true);
    if (!messaged.ok) return;
    expect(deliveries).toEqual([
      {
        roundtableId: 'planning-review',
        roleId: 'tech_director',
        text: '请技术总监把数据库迁移风险作为实现前阻塞项复核。',
      },
    ]);
    expect(messaged.value.evidence.some((entry) => entry.source === 'p2p_roundtable_user_message')).toBe(true);
    expect(messaged.value.discussion.at(-1)?.text).toContain('注入正在运行的 规划复核圆桌');
  });

  it('links OpenSpec Auto Deliver projections back into the Evolution ledger', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'auto-deliver.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 20_000,
      request: {
        requestId: 'req-orch-backflow',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 21_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const changeName = autopilot.value.linkedOpenSpecChange!;
    const sent: Record<string, unknown>[] = [];
    const link = { send(message: Record<string, unknown>) { sent.push(message); } };

    const baseProjection = {
      visibility: 'full',
      projectionVersion: 1,
      runId: 'auto_backflow_1',
      changeName,
      presetId: 'standard',
      materializedLimits: {
        specAuditRepairRounds: 1,
        implementationAuditRepairRounds: 2,
        maxImplementationPrompts: 12,
        maxElapsedMinutes: 480,
      },
      owningMainSessionName: 'deck_demo_brain',
      launchedFromSessionName: 'deck_demo_brain',
      targetImplementationSessionName: 'deck_demo_brain',
      generation: 1,
      implementationPromptCount: 1,
      elapsedMs: 100,
      taskStats: {
        total: 2,
        checked: 1,
        unchecked: 1,
        items: [
          { line: 1, checked: true, label: 'Implement backend checkout API endpoint' },
          { line: 2, checked: false, label: 'Build frontend checkout screen' },
        ],
      },
      specAuditRepairRound: 0,
      implementationAuditRepairRound: 0,
      selectedTeamComboId: 'audit>review>plan',
      canStop: true,
      canContinue: false,
      moduleScores: [
        { module: 'implementation', score: 7, max_score: 10, summary: 'Implementation progressing.' },
        { module: 'tests', score: 6, max_score: 10, summary: 'Tests still need completion.' },
      ],
      evidence: [{ source: 'daemon', summary: 'Implementation prompt dispatched.' }],
      lastMessage: 'implementation running',
    } as const;

    const implementation = await recordEvolutionOpenSpecProjection({
      projection: { ...baseProjection, status: 'implementation_task_loop', stage: 'implementation_task_loop' },
      serverLink: link,
      nowMs: 22_000,
    });
    expect(implementation[0]?.stage).toBe('implementation_loop');
    expect(implementation[0]?.linkedAutoDeliverRunId).toBe('auto_backflow_1');
    expect(implementation[0]?.scores.find((score) => score.module === 'implementation')?.score).toBe(7);
    expect(implementation[0]?.discussion.at(-1)?.author).toBe('OpenSpec Auto Deliver');
    expect(implementation[0]?.discussion).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleId: 'frontend_developer',
        text: expect.stringContaining('Build frontend checkout screen'),
      }),
    ]));
    expect(implementation[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'openspec_task_board',
        summary: expect.stringContaining('implementation prompts=1/12'),
      }),
      expect.objectContaining({
        source: 'openspec_score:implementation',
        summary: expect.stringContaining('Implementation progressing.'),
      }),
    ]));
    expect(implementation[0]?.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'backend_developer', source: 'evidence' }),
      expect.objectContaining({ roleId: 'frontend_developer', source: 'discussion', stage: 'implementation_loop' }),
      expect.objectContaining({ roleId: 'tech_director', source: 'evidence', stage: 'implementation_loop' }),
    ]));
    expect(implementation[0]?.liveEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'openspec_auto_deliver',
        kind: 'task_progress',
        roleId: 'tech_director',
        progress: expect.objectContaining({ current: 1, total: 2 }),
      }),
      expect.objectContaining({
        source: 'openspec_auto_deliver',
        kind: 'score',
        title: expect.stringContaining('implementation 7/10'),
      }),
    ]));

    const qa = await recordEvolutionOpenSpecProjection({
      projection: {
        ...baseProjection,
        projectionVersion: 2,
        status: 'implementation_audit_repair',
        stage: 'implementation_audit_repair',
        implementationAuditRound: { current: 1, total: 2 },
        activeOpenSpecPromptId: 'implementation_audit',
        latestVerdict: 'REWORK',
        latestRepairSummary: 'Fixed missing regression coverage.',
      },
      serverLink: link,
      nowMs: 23_000,
    });
    expect(qa[0]?.stage).toBe('qa_completion');
    expect(qa[0]?.discussion).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleId: 'qa_engineer',
        text: expect.stringContaining('审查修复轮次 1/2'),
      }),
      expect.objectContaining({
        roleId: 'qa_engineer',
        text: expect.stringContaining('最近修复摘要'),
      }),
    ]));

    const passed = await recordEvolutionOpenSpecProjection({
      projection: {
        ...baseProjection,
        projectionVersion: 3,
        status: 'passed',
        stage: 'passed',
        taskStats: { total: 2, checked: 2, unchecked: 0, items: [] },
        moduleScores: [
          { module: 'implementation', score: 9, max_score: 10, summary: 'Implementation complete.' },
          { module: 'tests', score: 8, max_score: 10, summary: 'Tests passed.' },
          { module: 'risk', score: 8, max_score: 10, summary: 'Risk acceptable for staging.' },
        ],
      },
      serverLink: link,
      nowMs: 24_000,
    });
    expect(passed[0]?.stage).toBe('delivery_ready');
    expect(passed[0]?.scores.find((score) => score.module === 'tests')?.score).toBe(8);
    const testEvidence = passed[0]?.artifacts.find((artifact) => artifact.kind === 'test_evidence');
    expect(testEvidence).toEqual(expect.objectContaining({
      path: 'artifacts/test-evidence.md',
      roleId: 'qa_engineer',
      stage: 'qa_completion',
    }));
    expect(testEvidence?.preview?.content).toContain('QA Completion Evidence');
    expect(passed[0]?.evidence.some((entry) => entry.source === 'test_evidence' && entry.artifactId === testEvidence?.id)).toBe(true);
    expect(passed[0]?.liveEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'openspec_auto_deliver', kind: 'artifact', title: 'QA completion evidence' }),
    ]));
    expect(passed[0]?.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'qa_engineer', source: 'evidence', stage: 'delivery_ready' }),
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'evidence', stage: 'delivery_ready' }),
    ]));
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'artifacts/test-evidence.md'), 'utf8'))
      .resolves.toContain('Risk acceptable for staging.');

    const needsHuman = await recordEvolutionOpenSpecProjection({
      projection: {
        ...baseProjection,
        projectionVersion: 4,
        status: 'needs_human',
        stage: 'needs_human',
        terminalReason: 'production_release_gate',
      },
      serverLink: link,
      nowMs: 25_000,
    });
    expect(needsHuman[0]?.stage).toBe('needs_human');
    expect(needsHuman[0]?.blockingQuestions.some((question) => question.question.includes('production_release_gate'))).toBe(true);
    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.PROJECTION);
    const persisted = JSON.parse(await readFile(join(root, '.imc/evolution', launched.value.runId, 'run.json'), 'utf8')) as { linkedAutoDeliverRunId?: string; stage?: string };
    expect(persisted.linkedAutoDeliverRunId).toBe('auto_backflow_1');
    expect(persisted.stage).toBe('needs_human');
  });

  it('runs configured staging delivery after OpenSpec passes and then waits at the production gate', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/delivery.json'), JSON.stringify({
      staging: {
        enabled: true,
        command: process.execPath,
        args: ['-e', 'console.log("staging delivery ok")'],
        timeoutMs: 30_000,
      },
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'staging-success.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 26_000,
      request: {
        requestId: 'req-orch-staging-success',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 27_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    const changeName = autopilot.value.linkedOpenSpecChange!;

    const stagingUpdates = await recordEvolutionOpenSpecProjection({
      projection: {
        visibility: 'full',
        projectionVersion: 1,
        runId: 'auto_staging_success_1',
        changeName,
        presetId: 'standard',
        materializedLimits: {
          specAuditRepairRounds: 1,
          implementationAuditRepairRounds: 1,
          maxImplementationPrompts: 6,
          maxElapsedMinutes: 240,
        },
        status: 'passed',
        stage: 'passed',
        owningMainSessionName: 'deck_demo_brain',
        launchedFromSessionName: 'deck_demo_brain',
        targetImplementationSessionName: 'deck_demo_brain',
        generation: 1,
        implementationPromptCount: 1,
        elapsedMs: 100,
        taskStats: { total: 1, checked: 1, unchecked: 0, items: [] },
        specAuditRepairRound: 0,
        implementationAuditRepairRound: 0,
        selectedTeamComboId: 'audit>review>plan',
        canStop: false,
        canContinue: false,
        moduleScores: [
          { module: 'implementation', score: 9, max_score: 10, summary: 'Implementation complete.' },
          { module: 'tests', score: 8, max_score: 10, summary: 'Tests passed.' },
        ],
      },
      nowMs: 28_000,
    });
    const projection = stagingUpdates.find((entry) => entry.runId === launched.value.runId);

    expect(projection?.stage).toBe('human_release_gate');
    expect(projection?.stagingDelivery?.status).toBe('passed');
    expect(projection?.scores.find((score) => score.module === 'delivery')?.summary).toContain('production');
    expect(projection?.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'evidence', stage: 'deployed_staging' }),
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'discussion', stage: 'human_release_gate' }),
    ]));
    const log = projection?.artifacts.find((artifact) => artifact.kind === 'staging_deploy_log');
    expect(log?.path).toBeTruthy();
    expect(log?.preview?.content).toContain('staging delivery ok');
    if (log?.path) {
      await expect(readFile(join(root, log.path), 'utf8')).resolves.toContain('staging delivery ok');
    }
    expect(projection?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'staging_delivery_command',
        command: expect.stringContaining('console.log'),
        exitCode: 0,
      }),
      expect.objectContaining({
        source: 'staging_delivery_stdout',
        summary: expect.stringContaining('staging delivery ok'),
        artifactId: log?.id,
      }),
    ]));
    expect(projection?.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'evidence', title: '证据 · staging_delivery_stdout' }),
    ]));
    expect(projection?.liveEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'staging_delivery', kind: 'command', command: expect.stringContaining('console.log'), exitCode: 0 }),
      expect.objectContaining({ source: 'staging_delivery', kind: 'stdout', detail: expect.stringContaining('staging delivery ok') }),
    ]));
    expect(validateEvolutionProjection(projection).ok).toBe(true);
    const persisted = JSON.parse(await readFile(join(root, '.imc/evolution', launched.value.runId, 'run.json'), 'utf8')) as { stage?: string; stagingDelivery?: { status?: string } };
    expect(persisted.stage).toBe('human_release_gate');
    expect(persisted.stagingDelivery?.status).toBe('passed');

    const approved = await continueEvolutionRun({
      runId: launched.value.runId,
      message: '人工确认 staging、回滚计划和风险后批准生产发布记录。',
      nowMs: 28_500,
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.stage).toBe('deployed_production');
    expect(approved.value.evidence.some((entry) => entry.source === 'human_release_gate' && entry.summary.includes('no production command executed'))).toBe(true);
    expect(approved.value.discussion.some((entry) => entry.kind === 'gate' && entry.text.includes('生产发布人工门禁已批准'))).toBe(true);
    expect(approved.value.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'artifact', stage: 'human_release_gate' }),
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'evidence', stage: 'human_release_gate' }),
    ]));
    const releaseGate = approved.value.artifacts.find((artifact) => artifact.kind === 'release_gate');
    expect(releaseGate?.path).toBe('release/release-gate.md');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'release/release-gate.md'), 'utf8'))
      .resolves.toContain('人工确认 staging、回滚计划和风险后批准生产发布记录。');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'release/release-gate.md'), 'utf8'))
      .resolves.toContain('does not execute any production deployment command');
    await expect(readFile(join(root, '.imc/evolution', launched.value.runId, 'run.json'), 'utf8'))
      .resolves.toContain('"stage": "deployed_production"');
    expect(validateEvolutionProjection(approved.value).ok).toBe(true);
  });

  it('blocks for human help when configured staging delivery fails', async () => {
    const root = await makeRoot();
    await mkdir(join(root, '.imc/evolution'), { recursive: true });
    await writeFile(join(root, '.imc/evolution/delivery.json'), JSON.stringify({
      staging: {
        enabled: true,
        command: process.execPath,
        args: ['-e', 'process.stderr.write("staging exploded"); process.exit(7)'],
        timeoutMs: 30_000,
      },
    }, null, 2), 'utf8');
    const sourceRelativePath = await writeRequirement(root, 'staging-fail.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 28_500,
      request: {
        requestId: 'req-orch-staging-fail',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 29_000 });
    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;

    const stagingUpdates = await recordEvolutionOpenSpecProjection({
      projection: {
        visibility: 'full',
        projectionVersion: 1,
        runId: 'auto_staging_fail_1',
        changeName: autopilot.value.linkedOpenSpecChange!,
        presetId: 'standard',
        materializedLimits: {
          specAuditRepairRounds: 1,
          implementationAuditRepairRounds: 1,
          maxImplementationPrompts: 6,
          maxElapsedMinutes: 240,
        },
        status: 'passed',
        stage: 'passed',
        owningMainSessionName: 'deck_demo_brain',
        launchedFromSessionName: 'deck_demo_brain',
        targetImplementationSessionName: 'deck_demo_brain',
        generation: 1,
        implementationPromptCount: 1,
        elapsedMs: 100,
        taskStats: { total: 1, checked: 1, unchecked: 0, items: [] },
        specAuditRepairRound: 0,
        implementationAuditRepairRound: 0,
        canStop: false,
        canContinue: false,
      },
      nowMs: 29_500,
    });
    const projection = stagingUpdates.find((entry) => entry.runId === launched.value.runId);

    expect(projection?.stage).toBe('needs_human');
    expect(projection?.stagingDelivery?.status).toBe('failed');
    expect(projection?.stagingDelivery?.exitCode).toBe(7);
    expect(projection?.blockingQuestions.some((question) => question.id.includes('staging-delivery') && question.question.includes('failed'))).toBe(true);
    const failedLog = projection?.artifacts.find((artifact) => artifact.kind === 'staging_deploy_log');
    expect(failedLog?.preview?.content).toContain('staging exploded');
    expect(projection?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'staging_delivery_stderr',
        summary: expect.stringContaining('staging exploded'),
        exitCode: 7,
      }),
    ]));
    expect(projection?.executionTimeline).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'evidence', stage: 'needs_human', status: 'failed' }),
      expect.objectContaining({ roleId: 'ops_release_manager', source: 'evidence', title: '证据 · staging_delivery_stderr' }),
    ]));
    expect(projection?.liveEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'staging_delivery', kind: 'stderr', severity: 'error', detail: expect.stringContaining('staging exploded') }),
    ]));
    expect(validateEvolutionProjection(projection).ok).toBe(true);
  });

  it('auto-starts OpenSpec Auto Deliver after tasks_ready when implementation automation is enabled', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'auto-start.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 30_000,
      request: {
        requestId: 'req-orch-auto-start',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStartImplementation: true,
        autoDeliverPresetId: 'fast',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const launchRequests: Array<{ changeName: string; presetId: string; autoCommitPush: boolean }> = [];
    setEvolutionAutoDeliverLauncher(async (request) => {
      launchRequests.push({
        changeName: request.changeName,
        presetId: request.presetId,
        autoCommitPush: request.autoCommitPush,
      });
      return {
        ok: true,
        projection: {
          visibility: 'full',
          projectionVersion: 1,
          runId: 'auto_from_evolution_1',
          changeName: request.changeName,
          presetId: request.presetId,
          materializedLimits: {
            specAuditRepairRounds: 0,
            implementationAuditRepairRounds: 1,
            maxImplementationPrompts: 6,
            maxElapsedMinutes: 360,
          },
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: request.sessionName,
          launchedFromSessionName: request.sessionName,
          targetImplementationSessionName: request.sessionName,
          generation: 1,
          implementationPromptCount: 1,
          elapsedMs: 1,
          taskStats: { total: 2, checked: 0, unchecked: 2, items: [] },
          specAuditRepairRound: 0,
          implementationAuditRepairRound: 0,
          canStop: true,
          canContinue: false,
        },
      };
    });
    const sent: Record<string, unknown>[] = [];

    const autopilot = await runEvolutionAutopilot(launched.value.runId, {
      send(message: Record<string, unknown>) { sent.push(message); },
    }, { nowMs: 31_000 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(launchRequests).toHaveLength(1);
    expect(launchRequests[0]?.presetId).toBe('fast');
    expect(autopilot.value.stage).toBe('implementation_loop');
    expect(autopilot.value.linkedAutoDeliverRunId).toBe('auto_from_evolution_1');
    expect(autopilot.value.loopControl.mode).toBe('auto_implementation');
    expect(autopilot.value.loopControl.signals.find((signal) => signal.id === 'implementation_loop')?.status).toBe('running');
    expect(autopilot.value.autoDelivery?.launchedAt).toBe(31_000);
    expect(autopilot.value.discussion.some((entry) => entry.text.includes('自动启动 OpenSpec Auto Deliver'))).toBe(true);
    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.PROJECTION);
  });

  it('defers auto delivery without a server link and resumes automatically when the link returns', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'auto-resume-server-link.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 35_000,
      request: {
        requestId: 'req-orch-auto-resume-server-link',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStartImplementation: true,
        autoDeliverPresetId: 'fast',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const launchRequests: Array<{ changeName: string; presetId: string; autoCommitPush: boolean }> = [];
    setEvolutionAutoDeliverLauncher(async (request) => {
      launchRequests.push({
        changeName: request.changeName,
        presetId: request.presetId,
        autoCommitPush: request.autoCommitPush,
      });
      return {
        ok: true,
        projection: {
          visibility: 'full',
          projectionVersion: 1,
          runId: 'auto_from_recovered_server_link',
          changeName: request.changeName,
          presetId: request.presetId,
          materializedLimits: {
            specAuditRepairRounds: 0,
            implementationAuditRepairRounds: 1,
            maxImplementationPrompts: 6,
            maxElapsedMinutes: 360,
          },
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: request.sessionName,
          launchedFromSessionName: request.sessionName,
          targetImplementationSessionName: request.sessionName,
          generation: 1,
          implementationPromptCount: 1,
          elapsedMs: 1,
          taskStats: { total: 2, checked: 0, unchecked: 2, items: [] },
          specAuditRepairRound: 0,
          implementationAuditRepairRound: 0,
          canStop: true,
          canContinue: false,
        },
      };
    });

    const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 36_000 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(launchRequests).toHaveLength(0);
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.linkedAutoDeliverRunId).toBeUndefined();
    expect(autopilot.value.autoDelivery?.lastError).toBe('missing_server_link');
    expect(autopilot.value.blockingQuestions.some((question) => question.id.includes('auto-delivery'))).toBe(false);
    expect(autopilot.value.discussion.some((entry) => entry.text.includes('连接恢复后会自动重试 OpenSpec Auto Deliver'))).toBe(true);
    expect(autopilot.value.liveEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Auto delivery waiting for server link', severity: 'warning' }),
    ]));

    const sent: Record<string, unknown>[] = [];
    const resumed = await resumePendingEvolutionAutoDeliveries({
      send(message: Record<string, unknown>) { sent.push(message); },
    }, 37_000);

    expect(launchRequests).toHaveLength(1);
    expect(launchRequests[0]?.presetId).toBe('fast');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.stage).toBe('implementation_loop');
    expect(resumed[0]?.linkedAutoDeliverRunId).toBe('auto_from_recovered_server_link');
    expect(resumed[0]?.autoDelivery?.lastError).toBeUndefined();
    expect(resumed[0]?.autoDelivery?.launchedAt).toBe(37_000);
    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.PROJECTION);
    expect(validateEvolutionProjection(resumed[0]).ok).toBe(true);
  });

  it('waits for a P2P planning gate before auto-starting implementation and resumes on PASS', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'auto-start-gated.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 40_000,
      request: {
        requestId: 'req-orch-auto-start-gated',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStartImplementation: true,
        autoDeliverPresetId: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const roundtableRequests: string[] = [];
    const autoRequests: Array<{ changeName: string; presetId: string }> = [];
    setEvolutionRoundtableLauncher(async (request) => {
      roundtableRequests.push(request.topic);
      const p2pRunId = request.topic === '规划复核圆桌' ? 'p2p_gate_1' : `p2p_gate_${request.stage}`;
      const discussionId = request.topic === '规划复核圆桌' ? 'dsc_gate_1' : `dsc_gate_${request.stage}`;
      return {
        ok: true,
        p2pRunId,
        discussionId,
        contextPath: `.imc/discussions/${p2pRunId}.md`,
      };
    });
    setEvolutionAutoDeliverLauncher(async (request) => {
      autoRequests.push({ changeName: request.changeName, presetId: request.presetId });
      return {
        ok: true,
        projection: {
          visibility: 'full',
          projectionVersion: 1,
          runId: 'auto_after_p2p_pass',
          changeName: request.changeName,
          presetId: request.presetId,
          materializedLimits: {
            specAuditRepairRounds: 1,
            implementationAuditRepairRounds: 2,
            maxImplementationPrompts: 12,
            maxElapsedMinutes: 480,
          },
          status: 'implementation_task_loop',
          stage: 'implementation_task_loop',
          owningMainSessionName: request.sessionName,
          launchedFromSessionName: request.sessionName,
          targetImplementationSessionName: request.sessionName,
          generation: 1,
          implementationPromptCount: 1,
          elapsedMs: 1,
          taskStats: { total: 3, checked: 0, unchecked: 3, items: [] },
          specAuditRepairRound: 0,
          implementationAuditRepairRound: 0,
          canStop: true,
          canContinue: false,
        },
      };
    });
    const sent: Record<string, unknown>[] = [];
    const link = { send(message: Record<string, unknown>) { sent.push(message); } };

    const autopilot = await runEvolutionAutopilot(launched.value.runId, link, { nowMs: 41_000 });

    expect(autopilot.ok).toBe(true);
    if (!autopilot.ok) return;
    expect(roundtableRequests).toEqual(['规划复核圆桌']);
    expect(autoRequests).toHaveLength(0);
    expect(autopilot.value.stage).toBe('tasks_ready');
    expect(autopilot.value.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_gate_1',
    }));
    expect(autopilot.value.roundtables.find((roundtable) => roundtable.id === 'design-review')).toEqual(expect.objectContaining({ status: 'complete' }));
    expect(autopilot.value.autoDelivery?.lastError).toBe('waiting_for_planning-review');
    expect(autopilot.value.discussion.some((entry) => entry.text.includes('等待 IM.codes P2P 规划复核圆桌'))).toBe(true);

    const afterPass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_gate_1',
        discussion_id: 'dsc_gate_1',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'PASS: product, design, architecture, QA, and ops agree implementation can start.',
        completed_at: '2026-07-08T00:02:00.000Z',
      },
      serverLink: link,
      nowMs: 42_000,
    });

    expect(autoRequests).toHaveLength(1);
    expect(autoRequests[0]?.presetId).toBe('strict');
    expect(afterPass[0]?.stage).toBe('implementation_loop');
    expect(afterPass[0]?.linkedAutoDeliverRunId).toBe('auto_after_p2p_pass');
    expect(afterPass[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'complete',
      summary: 'PASS: product, design, architecture, QA, and ops agree implementation can start.',
    }));
    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.PROJECTION);
  });

  it('strict gate mode fails closed when no live roundtable helper is available', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'strict-helper-required.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 49_000,
      request: {
        requestId: 'req-orch-strict-helper-required',
        sessionName: 'deck_demo_brain',
        sourceRelativePath,
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const paused = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 49_100 });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.value.stage).toBe('needs_human');
    expect(paused.value.roundtables).toContainEqual(expect.objectContaining({
      id: 'product-review',
      status: 'failed',
      error: 'roundtable_launcher_unavailable',
    }));
    expect(paused.value.evidence.some((entry) => entry.source === 'local_roundtable_review')).toBe(false);
  });

  it('strict gate mode pauses after product, design, and architecture roundtables until PASS', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'strict-roundtables.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 50_000,
      request: {
        requestId: 'req-orch-strict-roundtables',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const roundtableRequests: string[] = [];
    const p2pIds: Record<string, string> = {
      产品需求圆桌: 'p2p_strict_product',
      设计复核圆桌: 'p2p_strict_design',
      架构基线圆桌: 'p2p_strict_architecture',
      规划复核圆桌: 'p2p_strict_planning',
    };
    const discussionIds: Record<string, string> = {
      产品需求圆桌: 'dsc_strict_product',
      设计复核圆桌: 'dsc_strict_design',
      架构基线圆桌: 'dsc_strict_architecture',
      规划复核圆桌: 'dsc_strict_planning',
    };
    setEvolutionRoundtableLauncher(async (request) => {
      roundtableRequests.push(request.topic);
      return {
        ok: true,
        p2pRunId: p2pIds[request.topic],
        discussionId: discussionIds[request.topic],
      };
    });

    const firstPause = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 51_000 });

    expect(firstPause.ok).toBe(true);
    if (!firstPause.ok) return;
    expect(firstPause.value.stage).toBe('product_discussion');
    expect(firstPause.value.roundtableGateMode).toBe('strict');
    expect(roundtableRequests).toEqual(['产品需求圆桌']);
    expect(firstPause.value.roundtables).toEqual([
      expect.objectContaining({ id: 'product-review', status: 'running', p2pRunId: 'p2p_strict_product' }),
    ]);
    expect(firstPause.value.artifacts.find((artifact) => artifact.kind === 'prd')).toEqual(expect.objectContaining({
      status: 'candidate',
      assurance: 'pipeline_draft',
    }));
    expect(firstPause.value.latestMessage).toContain('waiting_for_product-review');

    const afterProductPass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_strict_product',
        discussion_id: 'dsc_strict_product',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'PASS: product scope is clear.',
        completed_at: '2026-07-08T00:03:00.000Z',
      },
      nowMs: 52_000,
    });

    expect(roundtableRequests).toEqual(['产品需求圆桌', '设计复核圆桌']);
    expect(afterProductPass[0]?.stage).toBe('design_hifi');
    expect(afterProductPass[0]?.roundtables.find((roundtable) => roundtable.id === 'product-review')).toEqual(expect.objectContaining({
      status: 'complete',
      summary: 'PASS: product scope is clear.',
    }));
    expect(afterProductPass[0]?.roundtables.find((roundtable) => roundtable.id === 'design-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_strict_design',
    }));

    const afterDesignPass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_strict_design',
        discussion_id: 'dsc_strict_design',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'PASS: design is actionable.',
        completed_at: '2026-07-08T00:04:00.000Z',
      },
      nowMs: 53_000,
    });

    expect(roundtableRequests).toEqual(['产品需求圆桌', '设计复核圆桌', '架构基线圆桌']);
    expect(afterDesignPass[0]?.stage).toBe('architecture_baseline');
    expect(afterDesignPass[0]?.roundtables.find((roundtable) => roundtable.id === 'architecture-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_strict_architecture',
    }));

    const afterArchitecturePass = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_strict_architecture',
        discussion_id: 'dsc_strict_architecture',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'PASS: architecture baseline is safe enough for tasks.',
        completed_at: '2026-07-08T00:05:00.000Z',
      },
      nowMs: 54_000,
    });

    expect(roundtableRequests).toEqual(['产品需求圆桌', '设计复核圆桌', '架构基线圆桌', '规划复核圆桌']);
    expect(afterArchitecturePass[0]?.stage).toBe('tasks_ready');
    expect(afterArchitecturePass[0]?.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_strict_planning',
    }));
    expect(afterArchitecturePass[0]?.linkedOpenSpecChange).toBeTruthy();
  });

  it('strict gate mode blocks on REWORK before later planning artifacts are generated', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root, 'strict-rework.md');
    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 60_000,
      request: {
        requestId: 'req-orch-strict-rework',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        roundtableGateMode: 'strict',
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    let launchCount = 0;
    const launcherLinks: unknown[] = [];
    setEvolutionRoundtableLauncher(async (_request, serverLink) => {
      launchCount += 1;
      launcherLinks.push(serverLink);
      return {
        ok: true,
        p2pRunId: `p2p_strict_rework_${launchCount}`,
        discussionId: `dsc_strict_rework_${launchCount}`,
      };
    });

    const paused = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 61_000 });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    expect(paused.value.stage).toBe('product_discussion');

    const blocked = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_strict_rework_1',
        discussion_id: 'dsc_strict_rework_1',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'REWORK: clarify buyer personas and payment assumptions before PRD.',
        completed_at: '2026-07-08T00:06:00.000Z',
      },
      nowMs: 62_000,
    });

    expect(blocked[0]?.stage).toBe('needs_human');
    expect(blocked[0]?.verdict).toBe('BLOCKED');
    expect(blocked[0]?.roundtables.find((roundtable) => roundtable.id === 'product-review')).toEqual(expect.objectContaining({
      status: 'complete',
      summary: 'REWORK: clarify buyer personas and payment assumptions before PRD.',
    }));
    expect(blocked[0]?.blockingQuestions[0]?.question).toContain('strict roundtable gate');
    expect(blocked[0]?.artifacts.find((artifact) => artifact.kind === 'prd')).toEqual(expect.objectContaining({
      status: 'candidate',
      assurance: 'pipeline_draft',
    }));

    const sent: Record<string, unknown>[] = [];
    const retryServerLink = { send(message: Record<string, unknown>) { sent.push(message); } };
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(63_000);
    try {
      await handleEvolutionPipelineCommand({
        type: EVOLUTION_PIPELINE_MSG.CONTINUE,
        requestId: 'req-strict-rework-continue',
        runId: launched.value.runId,
        message: '已补充 buyer personas 和支付假设，允许继续生成 PRD。',
      }, retryServerLink as never);
    } finally {
      nowSpy.mockRestore();
    }

    const continueAck = sent.find((message) => message.type === EVOLUTION_PIPELINE_MSG.CONTINUE_ACK) as {
      projection?: EvolutionProjection;
    } | undefined;
    expect(continueAck?.projection?.stage).toBe('product_discussion');
    expect(continueAck?.projection?.verdict).toBeUndefined();
    expect(continueAck?.projection?.blockingQuestions).toHaveLength(0);
    expect(continueAck?.projection?.roundtables.find((roundtable) => roundtable.id === 'product-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_strict_rework_2',
    }));
    expect(continueAck?.projection?.roundtables.find((roundtable) => roundtable.id === 'product-review')?.summary).toBeUndefined();
    expect(continueAck?.projection?.evidence).toContainEqual(expect.objectContaining({
      source: 'human_roundtable_retry',
      summary: expect.stringContaining('Previous verdict=REWORK'),
    }));
    expect(launcherLinks[1]).toBe(retryServerLink);

    const retryPending = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: 64_000 });
    expect(retryPending.ok).toBe(true);
    if (!retryPending.ok) return;
    expect(retryPending.value.stage).toBe('product_discussion');
    expect(retryPending.value.artifacts.find((artifact) => artifact.kind === 'prd')).toEqual(expect.objectContaining({
      status: 'candidate',
      assurance: 'pipeline_draft',
    }));

    const retried = await recordEvolutionP2pRunProjection({
      run: {
        id: 'p2p_strict_rework_2',
        discussion_id: 'dsc_strict_rework_2',
        status: 'completed',
        mode_key: 'review',
        current_round: 1,
        total_rounds: 1,
        result_summary: 'PASS: buyer personas and payment assumptions are now reviewable.',
        completed_at: '2026-07-08T00:07:00.000Z',
      },
      nowMs: 65_000,
    });

    expect(retried[0]?.stage).toBe('design_hifi');
    expect(retried[0]?.artifacts.some((artifact) => artifact.kind === 'prd')).toBe(true);
    expect(retried[0]?.roundtables.find((roundtable) => roundtable.id === 'design-review')).toEqual(expect.objectContaining({
      status: 'running',
    }));
    expect(launchCount).toBe(3);
  });
});

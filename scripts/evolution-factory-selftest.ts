#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../shared/evolution-pipeline-constants.js';
import type { EvolutionProjection } from '../shared/evolution-pipeline-types.js';
import { validateEvolutionProjection } from '../shared/evolution-pipeline-validators.js';
import type { OpenSpecAutoDeliverProjection } from '../shared/openspec-auto-deliver-types.js';
import { createProjectFileHandle } from '../src/daemon/file-transfer-handler.js';
import {
  importEvolutionReferenceBrief,
  launchEvolutionRun,
  runEvolutionAutopilot,
  setEvolutionAutoDeliverLauncher,
} from '../src/daemon/evolution-orchestrator.js';

interface SelftestScenarioResult {
  id: string;
  projectRoot: string;
  runId: string;
  stage: EvolutionProjection['stage'];
  artifactKinds: string[];
  roundtables: string[];
  evidenceCount: number;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = join(repoRoot, 'tmp', `evolution-factory-selftest-${randomUUID().slice(0, 8)}`);
const baseNow = Date.now();

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeRequirement(projectRoot: string, scenarioId: string, content: string): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/${scenarioId}/brief.md`;
  await mkdir(dirname(join(projectRoot, sourceRelativePath)), { recursive: true });
  await writeFile(join(projectRoot, sourceRelativePath), content, 'utf8');
  return sourceRelativePath;
}

async function writeTasteConfig(projectRoot: string): Promise<void> {
  await writeJson(join(projectRoot, '.imc/evolution/design.json'), {
    tasteSkill: {
      enabled: true,
      required: true,
      command: process.execPath,
      args: [
        join(repoRoot, 'scripts/run-taste-skill.mjs'),
        '--prompt',
        '{promptPath}',
        '--design-handoff',
        '{designHandoffPath}',
        '--output',
        '{outputPath}',
        '--reference-output',
        '{referencePath}',
        '--project-root',
        '{projectRoot}',
        '--style-audit-output',
        '{styleAuditOutputPath}',
      ],
      outputRelativePath: 'design/taste-hifi-output.md',
      referenceRelativePath: 'design/taste-hifi-reference.svg',
      styleAuditRelativePath: 'design/project-style-audit.md',
      timeoutMs: 30_000,
    },
  });
}

async function prepareProject(scenarioId: string): Promise<string> {
  const projectRoot = join(workspaceRoot, scenarioId);
  await mkdir(projectRoot, { recursive: true });
  await writeTasteConfig(projectRoot);
  await writeJson(join(projectRoot, 'package.json'), {
    name: `evolution-selftest-${scenarioId}`,
    private: true,
    dependencies: { react: '^19.0.0', tailwindcss: '^4.0.0' },
  });
  await mkdir(join(projectRoot, 'src/app'), { recursive: true });
  await writeFile(join(projectRoot, 'src/app/globals.css'), [
    ':root { --brand-selftest: #0f766e; --brand-accent: #f97316; font-family: Inter, system-ui, sans-serif; }',
    '.legacy-shell { background: #0f766e; color: #ecfeff; border-radius: 24px; }',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(projectRoot, 'src/app/page.tsx'), [
    'export default function Page() {',
    '  return <main className="legacy-shell">Legacy dashboard shell</main>;',
    '}',
    '',
  ].join('\n'), 'utf8');
  return projectRoot;
}

function passedOpenSpecProjection(request: {
  runId: string;
  changeName: string;
  presetId: OpenSpecAutoDeliverProjection['presetId'];
  sessionName: string;
}): OpenSpecAutoDeliverProjection {
  return {
    visibility: 'full',
    projectionVersion: 1,
    runId: `auto-${request.runId}`,
    changeName: request.changeName,
    presetId: request.presetId,
    materializedLimits: {
      specAuditRepairRounds: 1,
      implementationAuditRepairRounds: 1,
      maxImplementationPrompts: 6,
      maxElapsedMinutes: 360,
    },
    status: 'passed',
    stage: 'passed',
    owningMainSessionName: request.sessionName,
    launchedFromSessionName: request.sessionName,
    targetImplementationSessionName: request.sessionName,
    generation: 1,
    implementationPromptCount: 1,
    elapsedMs: 100,
    taskStats: {
      total: 4,
      checked: 4,
      unchecked: 0,
      items: [
        { line: 1, checked: true, label: '[x] PRD and design artifacts generated' },
        { line: 2, checked: true, label: '[x] Architecture baseline generated' },
        { line: 3, checked: true, label: '[x] Implementation matrix generated' },
        { line: 4, checked: true, label: '[x] QA and staging evidence generated' },
      ],
    },
    specAuditRepairRound: 0,
    implementationAuditRepairRound: 0,
    canStop: false,
    canContinue: false,
    latestVerdict: 'PASS',
    moduleScores: [
      { module: 'spec', score: 9, max_score: 10, summary: 'Selftest spec passed.' },
      { module: 'tasks', score: 9, max_score: 10, summary: 'Selftest tasks passed.' },
      { module: 'implementation', score: 8, max_score: 10, summary: 'Selftest implementation callback passed.' },
      { module: 'tests', score: 8, max_score: 10, summary: 'Selftest QA callback passed.' },
      { module: 'risk', score: 8, max_score: 10, summary: 'Production remains behind human gate.' },
    ],
    evidence: [{ source: 'scripts/evolution-factory-selftest.ts', summary: 'Deterministic OpenSpec PASS callback.', exitCode: 0 }],
    lastMessage: 'OpenSpec Auto Deliver selftest callback passed.',
  };
}

function artifactKinds(projection: EvolutionProjection): string[] {
  return projection.artifacts.map((artifact) => artifact.kind).sort();
}

function requireArtifactKinds(projection: EvolutionProjection, scenarioId: string, requiredKinds: string[]): void {
  const kinds = new Set(artifactKinds(projection));
  for (const kind of requiredKinds) {
    if (!kinds.has(kind)) throw new Error(`${scenarioId}: missing artifact kind ${kind}`);
  }
}

function assertNoUnexpectedBlockers(projection: EvolutionProjection, scenarioId: string, expectedStages: EvolutionProjection['stage'][]): void {
  const validation = validateEvolutionProjection(projection);
  if (!validation.ok) {
    throw new Error(`${scenarioId}: projection validation failed: ${validation.issues.map((issue) => issue.code).join(', ')}`);
  }
  if (!expectedStages.includes(projection.stage)) {
    throw new Error(`${scenarioId}: expected stage ${expectedStages.join('/')} but got ${projection.stage}: ${projection.latestMessage ?? ''}`);
  }
  if (projection.blockingQuestions.length > 0) {
    throw new Error(`${scenarioId}: unexpected blocking questions: ${projection.blockingQuestions.map((question) => question.question).join(' | ')}`);
  }
  const errors = projection.liveEvents.filter((event) => event.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`${scenarioId}: unexpected error live events: ${errors.map((event) => event.title).join(', ')}`);
  }
  const blockedSignals = projection.loopControl.signals.filter((signal) => signal.status === 'blocked');
  if (blockedSignals.length > 0 && projection.stage !== 'human_release_gate') {
    throw new Error(`${scenarioId}: unexpected blocked loop signals: ${blockedSignals.map((signal) => signal.id).join(', ')}`);
  }
}

async function runPlanningScenario(options: {
  id: string;
  content: string;
  designTargetSurface?: 'auto' | 'mobile' | 'pc' | 'both';
  sourceRelativePath?: string;
  projectRoot?: string;
  nowOffset: number;
  expectedVisualFidelityLauncherBlock?: boolean;
}): Promise<SelftestScenarioResult> {
  const projectRoot = options.projectRoot ?? await prepareProject(options.id);
  const sourceRelativePath = options.sourceRelativePath ?? await writeRequirement(projectRoot, options.id, options.content);
  const launched = await launchEvolutionRun({
    projectRoot,
    nowMs: baseNow + options.nowOffset,
    request: {
      requestId: `selftest-${options.id}`,
      sessionName: `deck_${options.id.replace(/[^a-z0-9]/gi, '_')}_brain`,
      projectName: `Selftest ${options.id}`,
      sourceRelativePath,
      autoStart: true,
      autoStartImplementation: false,
      designTargetSurface: options.designTargetSurface ?? 'auto',
    },
  });
  if (!launched.ok) throw new Error(`${options.id}: launch failed: ${launched.issues.map((issue) => issue.message).join('; ')}`);

  const autopilot = await runEvolutionAutopilot(launched.value.runId, null, { nowMs: baseNow + options.nowOffset + 1 });
  if (!autopilot.ok) throw new Error(`${options.id}: autopilot failed: ${autopilot.issues.map((issue) => issue.message).join('; ')}`);
  if (options.expectedVisualFidelityLauncherBlock) {
    const validation = validateEvolutionProjection(autopilot.value);
    if (!validation.ok) {
      throw new Error(`${options.id}: projection validation failed: ${validation.issues.map((issue) => issue.code).join(', ')}`);
    }
    if (autopilot.value.stage !== 'needs_human') {
      throw new Error(`${options.id}: expected honest visual-fidelity needs_human gate but got ${autopilot.value.stage}`);
    }
    const fidelity = autopilot.value.roundtables.find((roundtable) => roundtable.id === 'visual-fidelity-review');
    if (fidelity?.status !== 'failed' || fidelity.error !== 'roundtable_launcher_unavailable') {
      throw new Error(`${options.id}: expected visual-fidelity launcher hard block, got ${fidelity?.status ?? 'missing'}:${fidelity?.error ?? 'no_error'}`);
    }
    if (!autopilot.value.blockingQuestions.some((question) => question.id.includes('visual-fidelity-review-blocked'))) {
      throw new Error(`${options.id}: visual-fidelity hard block did not create an actionable blocking question`);
    }
    requireArtifactKinds(autopilot.value, options.id, [
      'prd',
      'design_reference_manifest',
      'design_reference_image',
      'hifi_spec',
      'hifi_mockup',
      'taste_hifi_prompt',
      'taste_hifi_output',
      'taste_hifi_reference',
    ]);
  } else {
    assertNoUnexpectedBlockers(autopilot.value, options.id, ['tasks_ready']);
    requireArtifactKinds(autopilot.value, options.id, [
      'prd',
      'hifi_spec',
      'hifi_mockup',
      'taste_hifi_prompt',
      'taste_hifi_output',
      'architecture_baseline',
      'openspec_tasks',
      'implementation_task_matrix',
      'test_plan',
      'test_cases',
      'deployment_plan',
    ]);
  }
  return {
    id: options.id,
    projectRoot,
    runId: autopilot.value.runId,
    stage: autopilot.value.stage,
    artifactKinds: artifactKinds(autopilot.value),
    roundtables: autopilot.value.roundtables.map((roundtable) => `${roundtable.id}:${roundtable.status}`),
    evidenceCount: autopilot.value.evidence.length,
  };
}

async function runReferenceImportScenario(): Promise<SelftestScenarioResult> {
  const id = 'reference-images';
  const projectRoot = await prepareProject(id);
  const first = join(projectRoot, 'ref-dashboard.svg');
  const second = join(projectRoot, 'ref-detail.svg');
  await writeFile(first, '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#0f766e" width="64" height="64"/><text>dashboard</text></svg>', 'utf8');
  await writeFile(second, '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#f97316" width="64" height="64"/><text>detail</text></svg>', 'utf8');
  const a = createProjectFileHandle(first, 'Dashboard Reference.svg', 'image/svg+xml', Buffer.byteLength(await readFile(first)));
  const b = createProjectFileHandle(second, 'Detail Reference.svg', 'image/svg+xml', Buffer.byteLength(await readFile(second)));
  const imported = await importEvolutionReferenceBrief({
    projectRoot,
    requestId: 'selftest-reference-images',
    sessionName: 'deck_reference_images_brain',
    projectName: 'Selftest reference images',
    note: '根据两张参考图生成会员积分管理页面，保留颜色、布局和详情页层级。',
    attachments: [
      { attachmentId: a.id, originalName: a.originalName, mime: a.mime, size: a.size },
      { attachmentId: b.id, originalName: b.originalName, mime: b.mime, size: b.size },
    ],
    nowMs: baseNow + 20,
  });
  if (!imported.ok) throw new Error(`${id}: import failed: ${imported.issues.map((issue) => issue.message).join('; ')}`);
  const result = await runPlanningScenario({
    id,
    projectRoot,
    sourceRelativePath: imported.value.sourceRelativePath,
    content: '',
    designTargetSurface: 'both',
    nowOffset: 21,
    expectedVisualFidelityLauncherBlock: true,
  });
  const runDir = join(projectRoot, '.imc/evolution', result.runId);
  const prompt = await readFile(join(runDir, 'design/taste-hifi-prompt.md'), 'utf8');
  if (!prompt.includes('at least 2 screens or states')) throw new Error(`${id}: prompt did not require multi-reference screen pack`);
  return result;
}

async function runDeliveryScenario(): Promise<SelftestScenarioResult> {
  const id = 'auto-delivery-staging';
  const projectRoot = await prepareProject(id);
  await writeJson(join(projectRoot, '.imc/evolution/delivery.json'), {
    staging: {
      enabled: true,
      command: process.execPath,
      args: ['-e', 'console.log("evolution selftest staging ok")'],
      timeoutMs: 30_000,
      env: {},
    },
  });
  const sourceRelativePath = await writeRequirement(projectRoot, id, [
    '# 完整 PRD：自助工单管理',
    '',
    '## 背景',
    '客服团队需要一个 PC 管理后台和移动端查看入口来处理自助工单。',
    '## 范围',
    '- 工单列表、详情、状态流转、批量分派、导出。',
    '- 空状态、加载、错误、无权限状态。',
    '## 验收标准',
    '- Given 待处理工单 When 管理员批量分派 Then 系统显示分派结果并记录失败项。',
    '- Staging 验证通过后生产仍必须人工门禁。',
  ].join('\n'));

  setEvolutionAutoDeliverLauncher(async (request) => ({
    ok: true,
    projection: passedOpenSpecProjection({
      runId: request.requestId,
      changeName: request.changeName,
      presetId: request.presetId,
      sessionName: request.sessionName,
    }),
  }));
  const sent: unknown[] = [];
  const launched = await launchEvolutionRun({
    projectRoot,
    nowMs: baseNow + 40,
    request: {
      requestId: `selftest-${id}`,
      sessionName: 'deck_auto_delivery_staging_brain',
      projectName: 'Selftest delivery',
      sourceRelativePath,
      autoStart: true,
      autoStartImplementation: true,
      autoDeliverPresetId: 'fast',
      designTargetSurface: 'both',
    },
  });
  if (!launched.ok) throw new Error(`${id}: launch failed: ${launched.issues.map((issue) => issue.message).join('; ')}`);
  const autopilot = await runEvolutionAutopilot(launched.value.runId, { send(message: unknown) { sent.push(message); } }, { nowMs: baseNow + 41 });
  if (!autopilot.ok) throw new Error(`${id}: autopilot failed: ${autopilot.issues.map((issue) => issue.message).join('; ')}`);
  assertNoUnexpectedBlockers(autopilot.value, id, ['human_release_gate']);
  requireArtifactKinds(autopilot.value, id, ['staging_deploy_log', 'test_evidence']);
  const logArtifact = autopilot.value.artifacts.find((artifact) => artifact.kind === 'staging_deploy_log');
  if (!logArtifact) throw new Error(`${id}: missing staging log`);
  const logPath = logArtifact.path.startsWith('.imc/evolution/') ? join(projectRoot, logArtifact.path) : join(projectRoot, '.imc/evolution', autopilot.value.runId, logArtifact.path);
  const log = await readFile(logPath, 'utf8');
  if (!log.includes('evolution selftest staging ok')) throw new Error(`${id}: staging log missing expected output`);
  return {
    id,
    projectRoot,
    runId: autopilot.value.runId,
    stage: autopilot.value.stage,
    artifactKinds: artifactKinds(autopilot.value),
    roundtables: autopilot.value.roundtables.map((roundtable) => `${roundtable.id}:${roundtable.status}`),
    evidenceCount: autopilot.value.evidence.length,
  };
}

async function main(): Promise<void> {
  const results: SelftestScenarioResult[] = [];
  try {
    results.push(await runPlanningScenario({
      id: 'raw-idea',
      nowOffset: 1,
      content: [
        '# 初始想法：会员增长小工具',
        '',
        '我只有一些概念：希望运营能配置会员成长任务、查看奖励发放和异常补偿。',
        '请系统自动补齐 PRD、设计、架构、任务和测试。',
      ].join('\n'),
    }));
    results.push(await runReferenceImportScenario());
    results.push(await runPlanningScenario({
      id: 'legacy-replica',
      nowOffset: 30,
      designTargetSurface: 'pc',
      content: [
        '# 老系统复刻：代理后台',
        '',
        '请先分析现有 src/app 页面和 globals.css 的颜色、圆角、字体和组件风格，再复刻为新的代理账号管理模块。',
        '- 需要列表、详情、充值、停用、重置密码、导出。',
        '- 新设计必须和老系统 #0f766e 品牌色、卡片圆角和后台布局统一。',
      ].join('\n'),
    }));
    results.push(await runPlanningScenario({
      id: 'complete-prd',
      nowOffset: 35,
      designTargetSurface: 'mobile',
      content: [
        '# 完整需求文档：移动端库存预警',
        '',
        '## 目标用户',
        '仓库管理员和区域负责人。',
        '## 功能范围',
        '- 移动端库存看板、低库存预警、补货申请、审批记录。',
        '- 加载、空状态、无权限、网络失败和审批驳回。',
        '## 验收标准',
        '- Given 库存低于阈值 When 管理员打开看板 Then 显示红色预警和补货入口。',
        '- Given 审批失败 When 查看详情 Then 展示失败原因和重新提交入口。',
      ].join('\n'),
    }));
    results.push(await runDeliveryScenario());

    const report = [
      '# Evolution Factory Selftest Report',
      '',
      `- Workspace: \`${workspaceRoot}\``,
      `- Scenarios: ${results.length}`,
      '- Result: PASS — no unexpected blockers; the reference-image scenario honestly hard-blocked at visual fidelity because no live checker launcher was installed.',
      '',
      '| Scenario | Stage | Run | Evidence | Roundtables |',
      '| --- | --- | --- | ---: | --- |',
      ...results.map((result) => `| ${result.id} | ${result.stage} | \`${result.runId}\` | ${result.evidenceCount} | ${result.roundtables.join('<br>')} |`),
      '',
      '## Coverage',
      '- Raw idea / incomplete PRD → deterministic planning artifacts.',
      '- Reference images → import brief, image copy, multi-reference high-fidelity requirement, then an honest needs_human gate without a live visual checker.',
      '- Existing code replica → project style audit and style-preserving design handoff.',
      '- Complete PRD → direct planning without extra blockers.',
      '- Auto Deliver + staging → deterministic PASS callback, safe staging command, production human gate.',
      '',
    ].join('\n');
    await writeFile(join(workspaceRoot, 'evolution-factory-selftest-report.md'), report, 'utf8');

    process.stdout.write([
      'Evolution Factory selftest passed.',
      `Workspace: ${workspaceRoot}`,
      `Report: ${join(workspaceRoot, 'evolution-factory-selftest-report.md')}`,
      ...results.map((result) => `- ${result.id}: ${result.stage} (${result.runId})`),
      '',
    ].join('\n'));
  } finally {
    setEvolutionAutoDeliverLauncher(null);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

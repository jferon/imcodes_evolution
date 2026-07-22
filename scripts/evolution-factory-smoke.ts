#!/usr/bin/env tsx
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../shared/evolution-pipeline-constants.js';
import type { EvolutionPipelineMsgType } from '../shared/evolution-pipeline-constants.js';
import type { EvolutionProjection } from '../shared/evolution-pipeline-types.js';
import { validateEvolutionProjection } from '../shared/evolution-pipeline-validators.js';
import type { OpenSpecAutoDeliverProjection } from '../shared/openspec-auto-deliver-types.js';
import {
  scanEvolutionInboxWatchers,
  stopAllEvolutionInboxWatchers,
  syncEvolutionInboxWatchers,
} from '../src/daemon/evolution-inbox-watch-manager.js';
import {
  continueEvolutionRun,
  setEvolutionAutoDeliverLauncher,
} from '../src/daemon/evolution-orchestrator.js';

interface SmokeOptions {
  projectRoot?: string;
  approveProductionRecord: boolean;
  help: boolean;
}

interface SmokeMessage {
  type?: EvolutionPipelineMsgType;
  projection?: EvolutionProjection;
  [key: string]: unknown;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): string {
  return `Usage: npm run smoke:evolution -- [--project <dir>] [--approve-production-record]

Runs a local deterministic Evolution Factory smoke:
1. creates/writes a requirement file under .imcodes/inbox/requirements/
2. lets the inbox watcher launch the Evolution pipeline
3. executes the local taste-skill adapter for high-fidelity output
4. simulates an OpenSpec Auto Deliver PASS callback
5. executes a safe staging command and stops at the production human gate

Artifacts are kept so you can inspect the generated War Room ledger.
`;
}

function parseArgs(argv: string[]): SmokeOptions {
  const options: SmokeOptions = { approveProductionRecord: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project') options.projectRoot = argv[++index];
    else if (arg === '--approve-production-record') options.approveProductionRecord = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function smokeProjectRoot(options: SmokeOptions): string {
  if (options.projectRoot) return resolve(options.projectRoot);
  return join(repoRoot, 'tmp', `evolution-factory-smoke-${randomUUID().slice(0, 8)}`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function prepareProject(projectRoot: string): Promise<string> {
  await mkdir(projectRoot, { recursive: true });
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
  await writeJson(join(projectRoot, '.imc/evolution/delivery.json'), {
    staging: {
      enabled: true,
      command: process.execPath,
      args: ['-e', 'console.log("evolution factory staging smoke ok")'],
      timeoutMs: 30_000,
      env: {},
    },
  });
  await writeJson(join(projectRoot, 'package.json'), {
    name: 'evolution-smoke-style-fixture',
    private: true,
    dependencies: {
      '@vitejs/plugin-react': '^5.0.0',
      react: '^19.0.0',
      tailwindcss: '^4.0.0',
    },
  });
  await mkdir(join(projectRoot, 'src/app'), { recursive: true });
  await writeFile(join(projectRoot, 'src/app/globals.css'), [
    ':root {',
    '  --brand-deep-ocean: #143c5a;',
    '  --brand-signal-cyan: #38bdf8;',
    '  --surface-ink: #07111f;',
    '  font-family: "IBM Plex Sans", Inter, ui-sans-serif, system-ui;',
    '}',
    '.project-shell {',
    '  background: #143c5a;',
    '  color: #f8fafc;',
    '  border-radius: 22px;',
    '  box-shadow: 0 24px 80px rgb(8 47 73 / 0.32);',
    '}',
    '.brand-orbit { color: #f97316; }',
    '',
  ].join('\n'), 'utf8');
  await writeFile(join(projectRoot, 'src/app/page.tsx'), [
    'export default function Page() {',
    '  return <main className="project-shell bg-slate-950 text-sky-100 rounded-3xl border border-sky-400/40">Existing smoke UI</main>;',
    '}',
    '',
  ].join('\n'), 'utf8');

  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/smoke/evolution-factory.md`;
  const sourcePath = join(projectRoot, sourceRelativePath);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, [
    '# Evolution Factory Smoke Requirement',
    '',
    'Build a self-evolving IM.codes workflow where a requirement document triggers:',
    '',
    '- product analysis and PRD refinement',
    '- UX flow, wireframe, and taste-skill high-fidelity direction',
    '- architecture baseline and OpenSpec task breakdown',
    '- multi-agent implementation loop with QA evidence',
    '- safe staging delivery with production behind a human gate',
    '',
    'The War Room must show role status, artifacts, evidence, live events, and accept user instructions.',
    '',
  ].join('\n'), 'utf8');
  const stableTime = new Date(Date.now() - 5_000);
  await utimes(sourcePath, stableTime, stableTime);
  return sourceRelativePath;
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
      total: 5,
      checked: 5,
      unchecked: 0,
      items: [
        { line: 1, checked: true, label: '[x] Product PRD generated' },
        { line: 2, checked: true, label: '[x] taste-skill design handoff generated' },
        { line: 3, checked: true, label: '[x] architecture baseline generated' },
        { line: 4, checked: true, label: '[x] implementation task matrix generated' },
        { line: 5, checked: true, label: '[x] QA and staging evidence generated' },
      ],
    },
    specAuditRepairRound: 0,
    implementationAuditRepairRound: 0,
    selectedTeamComboId: 'audit>review>plan',
    canStop: false,
    canContinue: false,
    latestVerdict: 'PASS',
    moduleScores: [
      { module: 'spec', score: 9, max_score: 10, summary: 'PRD, architecture, and tasks are coherent.' },
      { module: 'tasks', score: 9, max_score: 10, summary: 'Maker/checker tasks are complete.' },
      { module: 'implementation', score: 8, max_score: 10, summary: 'Deterministic smoke implementation callback passed.' },
      { module: 'tests', score: 8, max_score: 10, summary: 'Smoke tests and QA evidence are present.' },
      { module: 'risk', score: 8, max_score: 10, summary: 'Production remains behind a human gate.' },
    ],
    evidence: [
      {
        source: 'scripts/evolution-factory-smoke.ts',
        summary: 'Deterministic OpenSpec Auto Deliver PASS callback for local smoke validation.',
        command: 'npm run smoke:evolution',
        exitCode: 0,
      },
    ],
    lastMessage: 'OpenSpec Auto Deliver smoke callback passed.',
  };
}

async function waitForProjection(
  messages: SmokeMessage[],
  predicate: (projection: EvolutionProjection) => boolean,
  timeoutMs = 20_000,
): Promise<EvolutionProjection> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const message of messages) {
      if (message.projection && predicate(message.projection)) return message.projection;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Evolution projection after ${timeoutMs}ms.`);
}

function requireArtifact(projection: EvolutionProjection, kind: string): string {
  const artifact = projection.artifacts.find((item) => item.kind === kind);
  if (!artifact) throw new Error(`Missing expected artifact kind: ${kind}`);
  return artifact.path;
}

function artifactAbsolutePath(projectRoot: string, runId: string, artifactPath: string): string {
  return artifactPath.startsWith('.imc/evolution/')
    ? join(projectRoot, artifactPath)
    : join(projectRoot, '.imc/evolution', runId, artifactPath);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const projectRoot = smokeProjectRoot(options);
  const sourceRelativePath = await prepareProject(projectRoot);
  const messages: SmokeMessage[] = [];
  const sessionName = 'deck_evolution_smoke';
  const serverLink = {
    getServerId() {
      return 'evolution-smoke';
    },
    send(message: SmokeMessage) {
      messages.push(message);
    },
  };

  setEvolutionAutoDeliverLauncher(async (request) => ({
    ok: true,
    projection: passedOpenSpecProjection({
      runId: request.requestId,
      changeName: request.changeName,
      presetId: request.presetId,
      sessionName: request.sessionName,
    }),
  }));

  try {
    syncEvolutionInboxWatchers(serverLink, [
      { name: sessionName, projectName: 'Evolution Factory Smoke', projectDir: projectRoot, state: 'running' },
    ]);
    const scan = await scanEvolutionInboxWatchers({ sessionName, projectRoot, serverLink });
    const finalProjection = await waitForProjection(
      messages,
      (projection) => projection.stage === 'human_release_gate' && projection.source.relativePath === sourceRelativePath,
    );
    const validation = validateEvolutionProjection(finalProjection);
    if (!validation.ok) {
      throw new Error(`Final projection failed validation: ${validation.issues.map((issue) => issue.code).join(', ')}`);
    }

    if (finalProjection.blockingQuestions.length > 0) {
      throw new Error(`unexpected blocking questions in final smoke projection: ${finalProjection.blockingQuestions.map((question) => question.question).join(' | ')}`);
    }
    const errorEvents = finalProjection.liveEvents.filter((event) => event.severity === 'error');
    if (errorEvents.length > 0) {
      throw new Error(`unexpected error live events in final smoke projection: ${errorEvents.map((event) => event.title).join(', ')}`);
    }

    const requiredKinds = [
      'prd',
      'hifi_mockup',
      'project_style_audit',
      'taste_hifi_output',
      'taste_hifi_reference',
      'architecture_baseline',
      'openspec_tasks',
      'implementation_task_matrix',
      'test_cases',
      'test_evidence',
      'staging_deploy_log',
    ];
    const artifactPaths = new Map(requiredKinds.map((kind) => [kind, requireArtifact(finalProjection, kind)]));
    const tasteOutput = await readFile(artifactAbsolutePath(projectRoot, finalProjection.runId, artifactPaths.get('taste_hifi_output')!), 'utf8');
    const styleAudit = await readFile(artifactAbsolutePath(projectRoot, finalProjection.runId, artifactPaths.get('project_style_audit')!), 'utf8');
    const stagingLog = await readFile(artifactAbsolutePath(projectRoot, finalProjection.runId, artifactPaths.get('staging_deploy_log')!), 'utf8');
    if (!tasteOutput.includes('taste-skill High-Fidelity Output')) throw new Error('taste-skill output did not contain the expected heading.');
    if (!tasteOutput.includes('Existing Project Style Audit')) throw new Error('taste-skill output did not include the project style audit section.');
    if (!tasteOutput.includes('#143c5a')) throw new Error('taste-skill output did not include the existing project color token.');
    if (!styleAudit.includes('#143c5a')) throw new Error('project style audit did not include the existing project color token.');
    if (!stagingLog.includes('evolution factory staging smoke ok')) throw new Error('staging log did not contain the expected smoke output.');

    let approved: EvolutionProjection | null = null;
    if (options.approveProductionRecord) {
      const result = await continueEvolutionRun({
        runId: finalProjection.runId,
        message: 'Smoke operator approved the production gate record only; no production command was executed.',
      });
      if (!result.ok) throw new Error(`Production gate record failed: ${result.issues.map((issue) => issue.code).join(', ')}`);
      approved = result.value;
      requireArtifact(approved, 'release_gate');
    }

    const runDir = join(projectRoot, '.imc/evolution', finalProjection.runId);
    const report = [
      '# Evolution Factory Smoke Report',
      '',
      `- Project root: \`${projectRoot}\``,
      `- Requirement: \`${sourceRelativePath}\``,
      `- Run ID: \`${finalProjection.runId}\``,
      `- Run dir: \`${runDir}\``,
      `- Inbox scan: scanned=${scan.scanned}, candidates=${scan.candidates}`,
      `- Final stage: \`${approved?.stage ?? finalProjection.stage}\``,
      `- Staging: \`${finalProjection.stagingDelivery?.status ?? 'not_recorded'}\``,
      `- Messages observed: ${messages.length}`,
      '',
      '## Key Artifacts',
      ...[...artifactPaths.entries()].map(([kind, path]) => `- ${kind}: \`${path}\``),
      ...(approved ? [`- release_gate: \`${requireArtifact(approved, 'release_gate')}\``] : []),
      '',
      'Production command execution: not performed by this smoke.',
      '',
    ].join('\n');
    await writeFile(join(projectRoot, 'evolution-factory-smoke-report.md'), report, 'utf8');

    process.stdout.write([
      'Evolution Factory smoke passed.',
      `Project root: ${projectRoot}`,
      `Run dir: ${runDir}`,
      `Final stage: ${approved?.stage ?? finalProjection.stage}`,
      `Report: ${join(projectRoot, 'evolution-factory-smoke-report.md')}`,
      '',
    ].join('\n'));
  } finally {
    stopAllEvolutionInboxWatchers();
    setEvolutionAutoDeliverLauncher(null);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';

const { listSessionsMock, getSessionMock, startP2pRunMock } = vi.hoisted(() => ({
  listSessionsMock: vi.fn(),
  getSessionMock: vi.fn(),
  startP2pRunMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: getSessionMock,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/p2p-orchestrator.js')>();
  return {
    ...actual,
    startP2pRun: startP2pRunMock,
    appendP2pRunUserIntervention: vi.fn(),
  };
});

import {
  launchEvolutionRun,
  runEvolutionAutopilot,
  setEvolutionRoundtableLauncher,
} from '../../src/daemon/evolution-orchestrator.js';
import '../../src/daemon/evolution-p2p-roundtable.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-p2p-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

async function writeRequirement(root: string): Promise<string> {
  const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/p2p-roundtable.md`;
  await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
  await writeFile(join(root, sourceRelativePath), '# P2P Roundtable\n\nBuild a self-evolving flow.\n', 'utf8');
  return sourceRelativePath;
}

afterEach(async () => {
  startP2pRunMock.mockReset();
  listSessionsMock.mockReset();
  getSessionMock.mockReset();
  setEvolutionRoundtableLauncher(null);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('evolution P2P roundtable launcher', () => {
  it('launches role-skill-backed two-round discussions instead of one-round review-only audits', async () => {
    const root = await makeRoot();
    const sourceRelativePath = await writeRequirement(root);
    listSessionsMock.mockReturnValue([
      { name: 'deck_demo_brain', role: 'brain', state: 'running', projectDir: root },
      { name: 'deck_demo_w1', role: 'worker', state: 'running', projectDir: root },
      { name: 'deck_demo_w2', role: 'worker', state: 'running', projectDir: root },
      { name: 'deck_demo_w3', role: 'worker', state: 'running', projectDir: root },
      { name: 'deck_demo_w4', role: 'worker', state: 'running', projectDir: root },
      { name: 'deck_other_w1', role: 'worker', state: 'running', projectDir: root },
    ]);
    getSessionMock.mockImplementation((name: string) => ({ name, role: name.endsWith('_brain') ? 'brain' : 'worker', state: 'running', projectDir: root }));
    startP2pRunMock.mockResolvedValue({
      id: 'p2p_two_rounds',
      discussionId: 'dsc_two_rounds',
      contextFilePath: join(root, '.imc/discussions/p2p_two_rounds.md'),
    });

    const launched = await launchEvolutionRun({
      projectRoot: root,
      nowMs: 1_000,
      request: {
        requestId: 'req-p2p-two-rounds',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath,
        autoStart: true,
        autoStartImplementation: true,
      },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;

    const projection = await runEvolutionAutopilot(launched.value.runId, { send() { /* no-op */ } }, { nowMs: 2_000 });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;

    expect(startP2pRunMock).toHaveBeenCalledTimes(1);
    const options = startP2pRunMock.mock.calls[0]?.[0] as {
      targets: Array<{ session: string; mode: string }>;
      userText: string;
      rounds: number;
      modeOverride: string;
      postSummaryExecution: string;
      finalSummaryExtraInstruction: string;
    };
    expect(options.rounds).toBe(2);
    expect(options.modeOverride).toBe('discuss');
    expect(options.postSummaryExecution).toBe('disabled');
    expect(options.targets.map((target) => target.session)).toEqual(['deck_demo_w1', 'deck_demo_w2', 'deck_demo_w3', 'deck_demo_w4']);
    expect(options.userText).toContain('子 Session 角色 Skill 注入');
    expect(options.userText).toContain('Round 1（发散/补齐）');
    expect(options.userText).toContain('Round 2（交叉收敛）');
    expect(options.userText).toContain('product-prd');
    expect(options.userText).toContain('tech-baseline-adr');
    expect(options.userText).toContain('Helper 分工');
    expect(options.finalSummaryExtraInstruction).toContain('discussion-and-review');
    expect(options.finalSummaryExtraInstruction).not.toContain('review-only');
    expect(projection.value.roundtables.find((roundtable) => roundtable.id === 'planning-review')).toEqual(expect.objectContaining({
      status: 'running',
      p2pRunId: 'p2p_two_rounds',
      discussionId: 'dsc_two_rounds',
    }));
  });
});

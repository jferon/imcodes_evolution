import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvolutionWarRoomPanel } from '../../src/components/EvolutionWarRoom.js';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '@shared/evolution-pipeline-constants.js';
import type { EvolutionProjection } from '@shared/evolution-pipeline-types.js';

afterEach(() => cleanup());

function props(overrides = {}) {
  return {
    projection: null,
    watchers: [],
    serverId: 'srv-main',
    sessionName: 'deck_rnd_brain',
    projectRoot: '/Users/mac/tjs',
    launchPending: false,
    scanPending: false,
    stagingCheckPending: false,
    skillUpdatePending: false,
    stopPending: false,
    continuePending: false,
    referenceBriefPending: false,
    lastReferenceBrief: null,
    autoDeliverPending: false,
    lastError: null,
    onClose: vi.fn(),
    onLaunch: vi.fn(),
    onLaunchDemo: vi.fn(),
    onCreateReferenceBrief: vi.fn(),
    onScanInbox: vi.fn(),
    onCheckStaging: vi.fn(),
    onStop: vi.fn(),
    onContinue: vi.fn(),
    onStartAutoDeliver: vi.fn(),
    onSendUserMessage: vi.fn(),
    onUpdateRoleSkill: vi.fn(),
    onApproveRoleSkillCandidate: vi.fn(),
    onRefresh: vi.fn(),
    ...overrides,
  };
}

const requiredArtifactKinds = [
  'prd',
  'acceptance_criteria',
  'hifi_spec',
  'hifi_mockup',
  'architecture_baseline',
  'openspec_proposal',
  'openspec_design',
  'openspec_tasks',
  'implementation_task_matrix',
  'test_plan',
  'test_cases',
] as const;

function makeProjection(overrides: Partial<EvolutionProjection> = {}): EvolutionProjection {
  const now = Date.now();
  return {
    projectionVersion: 1,
    runId: 'evo-test',
    requestId: 'req-test',
    stage: 'tasks_ready',
    sessionName: 'deck_tjs_brain',
    source: {
      relativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`,
      fileName: 'brief.md',
      requestedBy: 'user',
      ingestedAt: now,
    },
    roles: [],
    artifacts: requiredArtifactKinds.map((kind) => ({
      id: `artifact-${kind}`,
      kind,
      path: `${kind}.md`,
      createdAt: now,
    })),
    scores: [],
    blockingQuestions: [],
    discussion: [],
    roundtables: ['product-review', 'design-review', 'architecture-review', 'planning-review'].map((id) => ({
      id,
      stage: 'tasks_ready',
      topic: id,
      roles: ['loop_supervisor'],
      status: 'complete',
      summary: '结论：PASS。允许进入开发 Loop。',
      createdAt: now,
      updatedAt: now,
    })),
    roundtableGateMode: 'strict',
    evidence: [],
    executionTimeline: [],
    liveEvents: [],
    loopControl: {
      source: 'loop_engineering',
      mode: 'auto_implementation',
      readinessScore: 100,
      canAutonomouslyContinue: true,
      currentGate: 'tasks_ready',
      budget: {
        maxRoleTurns: 12,
        maxElapsedMinutes: 60,
        maxImplementationAttempts: 2,
        maxAutoDeployStage: 'staging',
      },
      usage: {
        elapsedMinutes: 1,
        roleTurns: 4,
        implementationAttempts: 0,
        artifactCount: requiredArtifactKinds.length,
        evidenceCount: 0,
        discussionCount: 0,
      },
      signals: [],
      updatedAt: now,
    },
    autoDelivery: {
      enabled: true,
      presetId: 'standard',
      autoCommitPush: false,
      requestedBy: 'user',
    },
    stagingDelivery: {
      status: 'not_configured',
    },
    linkedOpenSpecChange: 'evo-change',
    elapsedMs: 1000,
    updatedAt: now,
    ...overrides,
  };
}

describe('EvolutionWarRoomPanel status feedback', () => {
  it('shows an explicit idle status before a run starts', () => {
    render(<EvolutionWarRoomPanel {...props()} />);

    const status = screen.getByTestId('evolution-run-status');

    expect(status.textContent).toContain('等待启动');
    expect(status.textContent).toContain('先确认需求文件真实存在');
  });

  it('shows a reference image entry point for generating a launchable brief', () => {
    render(<EvolutionWarRoomPanel {...props()} />);

    const entry = screen.getByTestId('evolution-reference-import');
    expect(entry.textContent).toContain('参考图/手稿生成需求');
    expect(entry.textContent).toContain('.imcodes/inbox/requirements/<任务>/brief.md');
    expect(screen.getByRole('button', { name: '生成 brief' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '生成 brief 并启动' })).toBeTruthy();
  });

  it('shows immediate feedback after clicking launch from requirement document', () => {
    const onLaunch = vi.fn();
    render(<EvolutionWarRoomPanel {...props({ onLaunch })} />);

    fireEvent.click(screen.getByRole('button', { name: '从需求文档启动' }));

    const expectedPath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`;
    const fullPath = `/Users/mac/tjs/${expectedPath}`;
    expect(onLaunch).toHaveBeenCalledWith(expectedPath, {
      autoStartImplementation: true,
      roundtableGateMode: 'planning',
      designTargetSurface: 'auto',
    });
    const status = screen.getByTestId('evolution-run-status');
    expect(status.textContent).toContain('从需求文档启动已发出');
    expect(status.textContent).toContain(`目标: ${fullPath}`);
    expect(status.textContent).toContain('如果这里长时间没有变成具体阶段');
  });

  it('converts a pasted absolute inbox file path to the daemon relative path', () => {
    const onLaunch = vi.fn();
    render(<EvolutionWarRoomPanel {...props({ onLaunch })} />);

    const absolutePath = '/Users/mac/tjs/.imcodes/inbox/requirements/specs/payment.md';
    fireEvent.input(screen.getByPlaceholderText('/Users/mac/tjs/.imcodes/inbox/requirements/brief.md'), {
      target: { value: absolutePath },
    });
    fireEvent.click(screen.getByRole('button', { name: '从需求文档启动' }));

    expect(onLaunch).toHaveBeenCalledWith('.imcodes/inbox/requirements/specs/payment.md', {
      autoStartImplementation: true,
      roundtableGateMode: 'planning',
      designTargetSurface: 'auto',
    });
    expect(screen.getByTestId('evolution-run-status').textContent).toContain(`目标: ${absolutePath}`);
  });

  it('passes the selected high-fidelity target surface when launching', () => {
    const onLaunch = vi.fn();
    render(<EvolutionWarRoomPanel {...props({ onLaunch })} />);

    const targetSelect = screen.getByLabelText('高保真目标端') as HTMLSelectElement;
    fireEvent.input(targetSelect, { target: { value: 'both' } });
    fireEvent.click(screen.getByRole('button', { name: '从需求文档启动' }));

    expect(onLaunch).toHaveBeenCalledWith(`${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.md`, {
      autoStartImplementation: true,
      roundtableGateMode: 'planning',
      designTargetSurface: 'both',
    });
  });

  it('uses a stronger pending message while the launch request is in flight', () => {
    render(<EvolutionWarRoomPanel {...props({ launchPending: true })} />);

    const status = screen.getByTestId('evolution-run-status');

    expect(status.textContent).toContain('启动请求已发送');
    expect(status.textContent).toContain('等待 daemon 返回 ACK');
  });

  it('keeps the OpenSpec development loop button disabled until blockers and roundtables pass', () => {
    const onStartAutoDeliver = vi.fn();
    render(<EvolutionWarRoomPanel {...props({
      onStartAutoDeliver,
      projection: makeProjection({
        stage: 'needs_human',
        blockingQuestions: [{
          id: 'planning-blocked',
          stage: 'needs_human',
          roleId: 'loop_supervisor',
          question: 'planning_roundtable_requires_rework',
          createdAt: Date.now(),
        }],
        roundtables: makeProjection().roundtables.map((roundtable) => (
          roundtable.id === 'planning-review'
            ? { ...roundtable, summary: '结论：REWORK。不允许进入开发 Loop。' }
            : roundtable
        )),
      }),
    })} />);

    const button = screen.getByRole('button', { name: '启动 OpenSpec 开发 Loop' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/当前处于人工阻塞/).textContent).toContain('planning_roundtable_requires_rework');

    fireEvent.click(button);
    expect(onStartAutoDeliver).not.toHaveBeenCalled();
  });

  it('shows a top-level progress bar and explains why multiple reviews exist', () => {
    render(<EvolutionWarRoomPanel {...props({
      projection: makeProjection({
        stage: 'design_hifi',
        artifacts: makeProjection().artifacts.slice(0, 5),
        roundtables: makeProjection().roundtables.map((roundtable, index) => ({
          ...roundtable,
          status: index === 0 ? 'complete' : index === 1 ? 'running' : 'planned',
        })),
      }),
    })} />);

    const progress = screen.getByTestId('evolution-progress-overview');
    const progressbar = screen.getByRole('progressbar', { name: '自我进化总进度' });

    expect(progress.textContent).toContain('总进度');
    expect(progress.textContent).toContain('当前');
    expect(progress.textContent).toContain('高保真设计');
    expect(progress.textContent).toContain('圆桌 1/4');
    expect(progressbar.getAttribute('aria-valuenow')).toBeTruthy();

    const explainer = screen.getByTestId('evolution-roundtable-explainer');
    expect(explainer.textContent).toContain('为什么会有多个圆桌');
    expect(explainer.textContent).toContain('2 轮多机器人讨论');
    expect(explainer.textContent).toContain('产品圆桌细化需求/PRD');
    expect(explainer.textContent).toContain('规划圆桌决定是否允许进入开发 Loop');
  });

  it('does not present stale staging config messages as the current reason after a run is stopped', () => {
    const onLaunch = vi.fn();
    render(<EvolutionWarRoomPanel {...props({
      onLaunch,
      projection: makeProjection({
        stage: 'stopped',
        latestMessage: 'No staging delivery config found at .imc/evolution/delivery.json.',
        terminalReason: 'Stopped from Evolution War Room.',
        stagingDelivery: {
          status: 'not_configured',
          summary: 'No staging delivery config found at .imc/evolution/delivery.json.',
        },
      }),
    })} />);

    const status = screen.getByTestId('evolution-run-status');

    expect(status.textContent).toContain('当前执行到：已停止');
    expect(status.textContent).toContain('当前原因：Stopped from Evolution War Room.');
    expect(status.textContent).not.toContain('最近消息：No staging delivery config found');
    expect(screen.getByTestId('evolution-operator-guide').textContent).toContain('这不是还在卡住');
    expect(screen.getByTestId('evolution-operator-guide').textContent).toContain('/Users/mac/tjs/.imc/evolution/delivery.json');

    const restart = screen.getByRole('button', { name: '从当前需求重新启动' });
    fireEvent.click(restart);
    expect(onLaunch).toHaveBeenCalledWith('.imcodes/inbox/requirements/brief.md', {
      autoStartImplementation: true,
      roundtableGateMode: 'planning',
      designTargetSurface: 'auto',
    });
  });

  it('shows a resumable paused state with a continue execution action', () => {
    const pausedProjection = makeProjection({
      stage: 'needs_human',
      latestMessage: 'Paused from Evolution War Room.',
      blockingQuestions: [{
        id: 'user-pause-evo-test-design_hifi',
        stage: 'design_hifi',
        roleId: 'loop_supervisor',
        question: '用户暂停了自我进化任务。暂停前阶段：design_hifi。',
        createdAt: Date.now(),
      }],
    });
    render(<EvolutionWarRoomPanel {...props({ projection: pausedProjection })} />);

    const status = screen.getByTestId('evolution-run-status');
    expect(status.textContent).toContain('当前执行到：已暂停');
    expect(status.textContent).toContain('暂停前阶段：高保真设计');
    expect(screen.getByTestId('evolution-operator-guide').textContent).toContain('换个时间回来后，直接点击“继续执行”');
    expect(screen.getByRole('button', { name: '继续执行' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '暂停' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('evolution-progress-overview').textContent).toContain('已暂停');
  });

  it('enables the OpenSpec development loop button after all required preconditions pass', () => {
    const onStartAutoDeliver = vi.fn();
    render(<EvolutionWarRoomPanel {...props({
      onStartAutoDeliver,
      projection: makeProjection(),
    })} />);

    const button = screen.getByRole('button', { name: '启动 OpenSpec 开发 Loop' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByText(/所有前置产物与圆桌门禁已 PASS/)).toBeTruthy();

    fireEvent.click(button);
    expect(onStartAutoDeliver).toHaveBeenCalledWith('evo-change');
  });
});

import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_REQUIREMENT_INBOX_DIR,
  canTransitionEvolutionStage,
  isEvolutionTerminalStage,
} from '../../shared/evolution-pipeline-constants.js';
import {
  isEvolutionSafeRelativePath,
  validateEvolutionArtifactRelativePath,
  validateEvolutionLaunchRequest,
  validateEvolutionProjection,
  validateEvolutionRequirementSourcePath,
  validateEvolutionStageTransition,
} from '../../shared/evolution-pipeline-validators.js';

const sha = 'a'.repeat(64);

describe('evolution pipeline shared contract', () => {
  it('accepts requirement files only from the configured inbox', () => {
    const source = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/new-checkout.md`;
    expect(validateEvolutionRequirementSourcePath(source)).toEqual({
      ok: true,
      value: source,
      issues: [],
    });
    expect(validateEvolutionRequirementSourcePath(`${EVOLUTION_REQUIREMENT_INBOX_DIR}/brief.JSON`).ok).toBe(true);
  });

  it('rejects unsafe or unsupported requirement source paths', () => {
    for (const source of [
      '../requirements/new.md',
      '/tmp/new.md',
      'C:\\tmp\\new.md',
      `${EVOLUTION_REQUIREMENT_INBOX_DIR}/../secret.md`,
      `${EVOLUTION_REQUIREMENT_INBOX_DIR}/new.pdf`,
      `requirements/new.md`,
      `${EVOLUTION_REQUIREMENT_INBOX_DIR}/new.md `,
    ]) {
      expect(validateEvolutionRequirementSourcePath(source).ok, source).toBe(false);
    }
  });

  it('validates launch requests and normalizes optional fields', () => {
    const result = validateEvolutionLaunchRequest({
      requestId: 'req-1',
      serverId: 'server-a',
      sessionName: 'deck_demo_brain',
      projectName: 'demo',
      sourceRelativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/checkout.md`,
      sourceSizeBytes: 123,
      sourceSha256: sha.toUpperCase(),
      locale: ' zh-CN ',
      requestedBy: 'watcher',
      autoStart: true,
      autoStartImplementation: true,
      autoDeliverPresetId: 'strict',
      autoCommitPush: false,
      roundtableGateMode: 'strict',
      designTargetSurface: 'mobile',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        requestId: 'req-1',
        serverId: 'server-a',
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        sourceRelativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/checkout.md`,
        sourceSizeBytes: 123,
        sourceSha256: sha,
        locale: 'zh-CN',
        requestedBy: 'watcher',
        autoStart: true,
        autoStartImplementation: true,
        autoDeliverPresetId: 'strict',
        autoCommitPush: false,
        roundtableGateMode: 'strict',
        designTargetSurface: 'mobile',
      },
      issues: [],
    });

    const demo = validateEvolutionLaunchRequest({
      requestId: 'req-demo',
      sessionName: 'deck_demo_brain',
      sourceRelativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/demo/evolution-factory.md`,
      requestedBy: 'demo',
    });
    expect(demo.ok).toBe(true);
    if (demo.ok) {
      expect(demo.value.requestedBy).toBe('demo');
      expect(demo.value.designTargetSurface).toBe('auto');
    }
  });

  it('rejects invalid auto delivery launch options', () => {
    const result = validateEvolutionLaunchRequest({
      requestId: 'req-auto-options',
      sessionName: 'deck_demo_brain',
      sourceRelativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/checkout.md`,
      autoStartImplementation: 'yes',
      autoDeliverPresetId: 'unsafe',
      autoCommitPush: 'yes',
      roundtableGateMode: 'always',
      designTargetSurface: 'desktop',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        'invalid_auto_start_implementation',
        'invalid_auto_deliver_preset_id',
        'invalid_auto_commit_push',
        'invalid_roundtable_gate_mode',
        'invalid_design_target_surface',
      ]));
    }
  });

  it('requires a safe dedicated target for greenfield development', () => {
    const base = {
      requestId: 'req-greenfield',
      sessionName: 'deck_demo_brain',
      sourceRelativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/greenfield.md`,
      developmentMode: 'greenfield_new_system',
    };
    expect(validateEvolutionLaunchRequest(base).ok).toBe(false);
    expect(validateEvolutionLaunchRequest({ ...base, developmentTargetRelativeDir: '.imc/new-system' }).ok).toBe(false);
    const valid = validateEvolutionLaunchRequest({
      ...base,
      developmentTargetRelativeDir: 'apps/new-system',
      requireHifiHumanApproval: true,
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.developmentTargetRelativeDir).toBe('apps/new-system');
      expect(valid.value.requireHifiHumanApproval).toBe(true);
    }
  });

  it('rejects oversized requirement launch payloads before daemon file reads', () => {
    const result = validateEvolutionLaunchRequest({
      requestId: 'req-oversize',
      sessionName: 'deck_demo_brain',
      sourceRelativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/large.md`,
      sourceSizeBytes: 9 * 1024 * 1024,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('invalid_source_size');
  });

  it('keeps artifact paths relative and traversal-free', () => {
    expect(isEvolutionSafeRelativePath('artifacts/prd.md')).toBe(true);
    expect(validateEvolutionArtifactRelativePath('artifacts/prd.md')).toEqual({
      ok: true,
      value: 'artifacts/prd.md',
      issues: [],
    });
    expect(validateEvolutionArtifactRelativePath('/artifacts/prd.md').ok).toBe(false);
    expect(validateEvolutionArtifactRelativePath('artifacts/../secrets.md').ok).toBe(false);
  });

  it('exposes canonical stage transitions for the orchestration state machine', () => {
    expect(canTransitionEvolutionStage('detected', 'intake_normalized')).toBe(true);
    expect(canTransitionEvolutionStage('tasks_ready', 'implementation_loop')).toBe(true);
    expect(canTransitionEvolutionStage('implementation_loop', 'tasks_ready')).toBe(true);
    expect(canTransitionEvolutionStage('deployed_production', 'implementation_loop')).toBe(false);
    expect(validateEvolutionStageTransition('prd_ready', 'implementation_loop').ok).toBe(false);
  });

  it('treats needs_human as a resumable human gate rather than a terminal state', () => {
    expect(isEvolutionTerminalStage('needs_human')).toBe(false);
    expect(canTransitionEvolutionStage('needs_human', 'implementation_loop')).toBe(true);
    expect(canTransitionEvolutionStage('needs_human', 'stopped')).toBe(true);
  });

  it('validates a minimal War Room projection shape', () => {
    const projection = validateEvolutionProjection({
      projectionVersion: 1,
      runId: 'run-2026-07-07T120000Z',
      requestId: 'req-1',
      stage: 'product_discussion',
      sessionName: 'deck_demo_brain',
      projectName: 'demo',
      source: {
        relativePath: `${EVOLUTION_REQUIREMENT_INBOX_DIR}/checkout.md`,
        fileName: 'checkout.md',
        requestedBy: 'watcher',
        sizeBytes: 120,
        sha256: sha.toUpperCase(),
        ingestedAt: 1,
      },
      roles: [
        {
          roleId: 'product_manager',
          label: '产品经理',
          skillName: 'product-prd',
          skillSummary: '澄清需求并输出 PRD。',
          responsibilities: ['PRD', '验收标准'],
          status: 'running',
          stage: 'product_discussion',
          updatedAt: 2,
        },
        { roleId: 'qa_engineer', status: 'pending', updatedAt: 2 },
      ],
      artifacts: [
        {
          id: 'prd',
          kind: 'prd',
          path: 'artifacts/prd.md',
          preview: {
            previewType: 'markdown',
            content: '# PRD\n\nPreviewable product document.',
          },
          roleId: 'product_manager',
          stage: 'prd_ready',
          sha256: sha,
          bytes: 42,
          createdAt: 3,
        },
        { id: 'role_skill:product-prd', kind: 'role_skill', path: '.imc/skills/evolution/product-prd.md', roleId: 'product_manager', stage: 'detected', sha256: sha, bytes: 420, createdAt: 3 },
      ],
      scores: [
        { module: 'product', score: 8, maxScore: 10, summary: 'Clear enough for MVP.' },
      ],
      blockingQuestions: [],
      discussion: [
        {
          id: 'discussion-1',
          kind: 'role_update',
          stage: 'product_discussion',
          roleId: 'product_manager',
          author: '产品经理',
          text: '开始整理 PRD。',
          artifactIds: ['prd'],
          createdAt: 4,
        },
      ],
      roundtables: [
        {
          id: 'planning-review',
          stage: 'tasks_ready',
          topic: '规划复核圆桌',
          roles: ['product_manager', 'tech_director', 'qa_engineer'],
          status: 'skipped',
          error: 'no_eligible_p2p_helper_sessions',
          createdAt: 4,
          updatedAt: 4,
        },
      ],
      roundtableGateMode: 'planning',
      evidence: [
        { source: 'daemon', summary: 'Requirement file ingested.', createdAt: 4 },
      ],
      executionTimeline: [
        {
          id: 'exec-1',
          roleId: 'product_manager',
          stage: 'product_discussion',
          status: 'running',
          title: '产品经理 · 当前任务',
          detail: '整理 PRD',
          artifactIds: ['prd'],
          source: 'discussion',
          createdAt: 4,
        },
      ],
      liveEvents: [
        {
          id: 'live-1',
          source: 'openspec_auto_deliver',
          kind: 'task_progress',
          severity: 'info',
          roleId: 'tech_director',
          stage: 'implementation_loop',
          title: 'OpenSpec task board',
          detail: 'checked=1; unchecked=1',
          progress: { current: 1, total: 2, label: '1/2 checked' },
          createdAt: 4,
        },
      ],
      loopControl: {
        source: 'loop_engineering',
        mode: 'auto_implementation',
        readinessScore: 63,
        canAutonomouslyContinue: true,
        currentGate: 'No blocking gate; loop may continue within configured budget and safety policy.',
        budget: {
          maxRoleTurns: 40,
          maxElapsedMinutes: 480,
          maxImplementationAttempts: 3,
          maxAutoDeployStage: 'staging',
        },
        usage: {
          elapsedMinutes: 1,
          roleTurns: 1,
          implementationAttempts: 0,
          artifactCount: 2,
          evidenceCount: 1,
          discussionCount: 1,
        },
        signals: [
          {
            id: 'state_memory',
            label: 'State + memory',
            status: 'complete',
            detail: 'run.json keeps state durable.',
            artifactIds: ['prd'],
          },
        ],
        updatedAt: 5,
      },
      elapsedMs: 500,
      updatedAt: 5,
    });

    expect(projection.ok).toBe(true);
    if (projection.ok) {
      expect(projection.value.source.sha256).toBe(sha);
      expect(projection.value.source.requestedBy).toBe('watcher');
      expect(projection.value.roles.map((role) => role.roleId)).toEqual(['product_manager', 'qa_engineer']);
      expect(projection.value.roles[0]?.skillName).toBe('product-prd');
      expect(projection.value.artifacts[0]?.preview?.previewType).toBe('markdown');
      expect(projection.value.artifacts[1]?.kind).toBe('role_skill');
      expect(projection.value.discussion[0]?.roleId).toBe('product_manager');
      expect(projection.value.roundtables[0]?.status).toBe('skipped');
      expect(projection.value.roundtableGateMode).toBe('planning');
      expect(projection.value.executionTimeline[0]?.roleId).toBe('product_manager');
      expect(projection.value.liveEvents[0]?.kind).toBe('task_progress');
      expect(projection.value.loopControl.source).toBe('loop_engineering');
      expect(projection.value.loopControl.signals[0]?.status).toBe('complete');

      const malformedV2 = validateEvolutionProjection({
        ...projection.value,
        controlVersion: 2,
        runRevision: -1,
        artifactRevisions: [],
        authorizedRevisions: { 'artifacts/prd.md': 'revision-missing' },
      });
      expect(malformedV2.ok).toBe(false);
      if (!malformedV2.ok) {
        expect(malformedV2.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
          'invalid_run_revision',
          'unknown_authorized_revision',
        ]));
      }

      const revisionId = 'revision-prd-v2';
      const skillSnapshotId = 'skill-product-v2';
      const attemptId = 'attempt-product-check-v2';
      const verdictId = 'verdict-product-pass-v2';
      const reviewSetId = 'review-product-v2';
      const validV2 = validateEvolutionProjection({
        ...projection.value,
        controlVersion: 2,
        runRevision: 3,
        executionPolicy: 'governed',
        skillSnapshots: [{
          id: skillSnapshotId,
          roleId: 'product_manager',
          skillName: 'product-prd',
          sourcePath: 'builtin:evolution/product-prd',
          source: 'builtin',
          sha256: sha,
          bytes: 100,
          capturedAt: 10,
        }],
        artifactRevisions: [{
          id: revisionId,
          artifactId: 'prd',
          kind: 'prd',
          logicalPath: 'artifacts/prd.md',
          immutablePath: `revisions/blobs/${sha}.md`,
          sha256: sha,
          bytes: 42,
          stage: 'product_discussion',
          roleId: 'product_manager',
          status: 'approved',
          assurance: 'checker_verified',
          producerAttemptId: attemptId,
          authorizedByVerdictId: verdictId,
          createdAt: 10,
        }],
        attempts: [{
          id: attemptId,
          kind: 'checker',
          stage: 'product_discussion',
          roleId: 'product_manager',
          checkerRoleId: 'product_critic',
          status: 'passed',
          dispatchToken: 'dispatch-product-v2',
          inputRevisionIds: [revisionId],
          skillSnapshotIds: [skillSnapshotId],
          outputRevisionIds: [],
          startedAt: 10,
          completedAt: 11,
        }],
        verdictRecords: [{
          id: verdictId,
          attemptId,
          stage: 'product_discussion',
          checkerRoleId: 'product_critic',
          verdict: 'PASS',
          machineReadable: true,
          summary: '<!-- EVOLUTION_VERDICT: PASS -->',
          inputRevisionIds: [revisionId],
          approvedRevisionIds: [revisionId],
          createdAt: 11,
        }],
        designReviewSets: [{
          id: reviewSetId,
          attemptId,
          revisionIds: [revisionId],
          immutableManifestPath: `review-sets/${reviewSetId}.approved.json`,
          status: 'approved',
          createdAt: 11,
          decidedAt: 12,
        }],
        gates: [{
          id: 'gate-product-v2',
          kind: 'product_review',
          stage: 'product_discussion',
          status: 'approved',
          candidateRevisionIds: [revisionId],
          reviewSetId,
          requiredAssurance: 'checker_verified',
          openedAt: 11,
          resolvedAt: 12,
          decision: {
            id: 'mutation-product-v2',
            action: 'approve',
            actor: 'human',
            expectedRunRevision: 2,
            createdAt: 12,
          },
        }],
        authorizedRevisions: {
          'artifacts/prd.md': revisionId,
        },
      });
      expect(validV2.ok, JSON.stringify(validV2)).toBe(true);

      const brokenReferences = validateEvolutionProjection({
        ...(validV2.ok ? validV2.value : projection.value),
        artifactRevisions: [{
          ...(validV2.ok ? validV2.value.artifactRevisions?.[0] : {}),
          id: revisionId,
          artifactId: 'prd',
          kind: 'prd',
          logicalPath: 'artifacts/prd.md',
          immutablePath: `revisions/blobs/${sha}.md`,
          sha256: sha,
          bytes: 42,
          stage: 'product_discussion',
          status: 'approved',
          assurance: 'checker_verified',
          producerAttemptId: 'attempt-missing',
          authorizedByVerdictId: 'verdict-missing',
          supersedesRevisionId: 'revision-missing-parent',
          createdAt: 10,
        }],
        attempts: [{
          ...(validV2.ok ? validV2.value.attempts?.[0] : {}),
          id: attemptId,
          kind: 'checker',
          stage: 'product_discussion',
          roleId: 'product_manager',
          status: 'passed',
          dispatchToken: 'dispatch-product-v2',
          inputRevisionIds: ['revision-missing-input'],
          outputRevisionIds: ['revision-missing-output'],
          skillSnapshotIds: ['skill-missing'],
          startedAt: 10,
        }],
        verdictRecords: [{
          ...(validV2.ok ? validV2.value.verdictRecords?.[0] : {}),
          id: verdictId,
          attemptId: 'attempt-missing',
          verdict: 'PASS',
          machineReadable: true,
          approvedRevisionIds: ['revision-missing-approved'],
        }],
        designReviewSets: [{
          ...(validV2.ok ? validV2.value.designReviewSets?.[0] : {}),
          id: reviewSetId,
          attemptId: 'attempt-missing',
          revisionIds: ['revision-missing-review'],
          status: 'pending',
        }],
        gates: [{
          ...(validV2.ok ? validV2.value.gates?.[0] : {}),
          id: 'gate-product-v2',
          kind: 'product_review',
          status: 'open',
          candidateRevisionIds: ['revision-missing-gate'],
          reviewSetId: 'review-missing',
          requiredAssurance: 'human_approved',
        }],
        authorizedRevisions: {},
      });
      expect(brokenReferences.ok).toBe(false);
      if (!brokenReferences.ok) {
        const codes = brokenReferences.issues.map((entry) => entry.code);
        expect(codes).toEqual(expect.arrayContaining([
          'unknown_revision_reference',
          'unknown_skill_snapshot_reference',
          'unknown_attempt_reference',
          'unknown_verdict_reference',
          'unknown_review_set_reference',
        ]));
        expect(brokenReferences.issues.map((entry) => entry.path)).toEqual(expect.arrayContaining([
          'artifactRevisions[0].supersedesRevisionId',
          'artifactRevisions[0].producerAttemptId',
          'artifactRevisions[0].authorizedByVerdictId',
          'attempts[0].outputRevisionIds',
          'verdictRecords[0].approvedRevisionIds',
          'designReviewSets[0].revisionIds',
          'gates[0].candidateRevisionIds',
          'gates[0].reviewSetId',
        ]));
      }
    }
  });
});

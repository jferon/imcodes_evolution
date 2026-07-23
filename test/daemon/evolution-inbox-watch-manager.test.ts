import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_PIPELINE_MSG, EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import type { EvolutionProjection } from '../../shared/evolution-pipeline-types.js';
import {
  configureEvolutionInboxWatcherDirectory,
  listEvolutionInboxWatchers,
  scanEvolutionInboxWatchers,
  stopAllEvolutionInboxWatchers,
  syncEvolutionInboxWatchers,
} from '../../src/daemon/evolution-inbox-watch-manager.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-watch-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

async function waitForProjection(
  messages: Record<string, unknown>[],
  predicate: (projection: EvolutionProjection) => boolean,
  timeoutMs = 8_000,
): Promise<EvolutionProjection> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const message of messages) {
      const projection = message.projection as EvolutionProjection | undefined;
      if (projection && predicate(projection)) return projection;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Evolution projection after ${timeoutMs}ms.`);
}

async function waitForWatcherDirectory(directoryPath: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (listEvolutionInboxWatchers().some((watcher) => watcher.inboxAbsolutePath === directoryPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Evolution watcher directory ${directoryPath}.`);
}

afterEach(async () => {
  stopAllEvolutionInboxWatchers();
  // The watch manager fires `void runEvolutionAutopilot(...)` in the
  // background; retry the temp-dir removal so a still-in-flight run-file
  // write cannot race the teardown into ENOTEMPTY.
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  tempRoot = null;
});

describe('evolution inbox watch manager', () => {
  it('tracks active main sessions and drops stopped or subsession watches', async () => {
    const root = await makeRoot();
    syncEvolutionInboxWatchers(null, [
      { name: 'deck_demo_brain', projectName: 'demo', projectDir: root, state: 'running' },
      { name: 'deck_sub_worker', projectName: 'demo', projectDir: root, state: 'running' },
      { name: 'deck_missing_project_dir', projectName: 'demo', state: 'running' },
    ]);

    expect(listEvolutionInboxWatchers()).toEqual([
      expect.objectContaining({
        key: `deck_demo_brain\u0000${root}`,
        sessionName: 'deck_demo_brain',
        projectName: 'demo',
        projectRoot: root,
        inboxRelativePath: EVOLUTION_REQUIREMENT_INBOX_DIR,
        inboxAbsolutePath: `${root}/${EVOLUTION_REQUIREMENT_INBOX_DIR}`,
        intervalMs: 15_000,
        stableMs: 2_000,
        active: true,
      }),
    ]);
    expect(listEvolutionInboxWatchers()[0]?.startedAt).toBeGreaterThan(0);

    syncEvolutionInboxWatchers(null, [
      { name: 'deck_demo_brain', projectName: 'demo', projectDir: root, state: 'stopped' },
    ]);

    expect(listEvolutionInboxWatchers()).toEqual([]);
  });

  it('auto-launches an Evolution run when a stable requirement file lands in the inbox', async () => {
    const root = await makeRoot();
    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/auto-trigger.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# Auto Trigger\n\nBuild a self-evolving agent factory.\n', 'utf8');
    const stableTime = new Date(Date.now() - 5_000);
    await utimes(join(root, sourceRelativePath), stableTime, stableTime);

    const sent: Record<string, unknown>[] = [];
    const serverLink = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
    };

    syncEvolutionInboxWatchers(serverLink as never, [
      { name: 'deck_demo_brain', projectName: 'demo', projectDir: root, state: 'running' },
    ]);

    const projection = await waitForProjection(
      sent,
      (candidate) => candidate.stage === 'tasks_ready' && candidate.source.relativePath === sourceRelativePath,
      10_000,
    );

    expect(sent.map((message) => message.type)).toContain(EVOLUTION_PIPELINE_MSG.PROJECTION);
    expect(projection.requestId).toMatch(/^watcher-/);
    expect(projection.source.requestedBy).toBe('watcher');
    expect(projection.autoDelivery?.enabled).toBe(true);
    expect(projection.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      'prd',
      'taste_hifi_output',
      'implementation_task_matrix',
      'test_cases',
    ]));
    await expect(readFile(join(root, '.imc/evolution', projection.runId, 'design/taste-hifi-output.md'), 'utf8'))
      .resolves.toContain('Built-in taste-skill High-Fidelity Output');
  });

  it('manually scans active inbox watchers without waiting for the poll interval', async () => {
    const root = await makeRoot();
    const sent: Record<string, unknown>[] = [];
    const serverLink = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
    };
    syncEvolutionInboxWatchers(serverLink as never, [
      { name: 'deck_demo_brain', projectName: 'demo', projectDir: root, state: 'running' },
    ]);

    const sourceRelativePath = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/manual-scan.md`;
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, sourceRelativePath), '# Manual Scan\n\n需要实现一个手动触发扫描的功能，用户可以立即触发 inbox 扫描而不等待轮询间隔。\n', 'utf8');
    const stableTime = new Date(Date.now() - 5_000);
    await utimes(join(root, sourceRelativePath), stableTime, stableTime);

    const scan = await scanEvolutionInboxWatchers({
      sessionName: 'deck_demo_brain',
      projectRoot: root,
      serverLink: serverLink as never,
    });

    expect(scan.scanned).toBe(1);
    expect(scan.candidates).toBe(1);
    expect(scan.watchers[0]).toEqual(expect.objectContaining({
      sessionName: 'deck_demo_brain',
      active: true,
    }));
    const projection = await waitForProjection(
      sent,
      (candidate) => candidate.stage === 'tasks_ready' && candidate.source.relativePath === sourceRelativePath,
      10_000,
    );
    expect(projection.source.requestedBy).toBe('watcher');
  });

  it('switches to a browsed directory, imports its requirements safely, and restores it after restart', async () => {
    const root = await makeRoot();
    const selectedDirectory = join(root, 'product-requirements');
    await mkdir(selectedDirectory, { recursive: true });
    const sent: Record<string, unknown>[] = [];
    const serverLink = {
      send(message: Record<string, unknown>) {
        sent.push(message);
      },
    };

    syncEvolutionInboxWatchers(serverLink as never, [
      { name: 'deck_demo_brain', projectName: 'demo', projectDir: root, state: 'running' },
    ]);

    const configured = await configureEvolutionInboxWatcherDirectory({
      sessionName: 'deck_demo_brain',
      projectRoot: root,
      directoryPath: selectedDirectory,
      serverLink: serverLink as never,
    });

    expect(configured.watchers).toEqual([
      expect.objectContaining({
        sessionName: 'deck_demo_brain',
        projectRoot: root,
        inboxAbsolutePath: selectedDirectory,
        active: true,
      }),
    ]);

    const selectedRequirement = join(selectedDirectory, 'feature.md');
    await writeFile(selectedRequirement, '# Feature\n\nBuild the selected-directory flow.\n', 'utf8');
    const stableTime = new Date(Date.now() - 5_000);
    await utimes(selectedRequirement, stableTime, stableTime);

    const scan = await scanEvolutionInboxWatchers({
      sessionName: 'deck_demo_brain',
      projectRoot: root,
      serverLink: serverLink as never,
    });

    expect(scan.scanned).toBe(1);
    expect(scan.candidates).toBe(1);
    const projection = await waitForProjection(
      sent,
      (candidate) => candidate.stage === 'tasks_ready' && candidate.source.fileName === 'feature.md',
      10_000,
    );
    expect(projection.source.relativePath).toMatch(/^\.imcodes\/inbox\/requirements\/imported\//);
    await expect(readFile(join(root, '.imc/evolution', projection.runId, 'input/feature.md'), 'utf8'))
      .resolves.toContain('selected-directory flow');

    stopAllEvolutionInboxWatchers();
    syncEvolutionInboxWatchers(serverLink as never, [
      { name: 'deck_demo_brain', projectName: 'demo', projectDir: root, state: 'running' },
    ]);
    await waitForWatcherDirectory(selectedDirectory);
  });
});

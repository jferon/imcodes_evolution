import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { EVOLUTION_REQUIREMENT_INBOX_DIR } from '../../shared/evolution-pipeline-constants.js';
import {
  EvolutionInboxPoller,
  recordEvolutionInboxSeenFiles,
  scanEvolutionRequirementInbox,
  scanEvolutionRequirementInboxGrouped,
  type EvolutionInboxCandidate,
  type EvolutionInboxCandidateGroup,
} from '../../src/daemon/evolution-inbox-watcher.js';
import {
  launchEvolutionRunFromInboxCandidateGroup,
  getEvolutionRun,
  runEvolutionAutopilot,
} from '../../src/daemon/evolution-orchestrator.js';

let tempRoot: string | null = null;

async function makeRoot(): Promise<string> {
  tempRoot = await mkdtemp(join(tmpdir(), `imcodes-evolution-grp-${randomUUID().slice(0, 8)}-`));
  return tempRoot;
}

afterEach(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

const FUTURE = () => Date.now() + 60_000;

describe('A2 — inbox image trigger + directory grouping', () => {
  it('groups a multi-file subdirectory drop (photos + brief) into ONE candidate group', async () => {
    const root = await makeRoot();
    const groupDir = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'manuscript-a');
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, 'brief.md'), '# 手稿需求\n\n实现下面照片里的界面。\n', 'utf8');
    for (const name of ['p1.png', 'p2.jpg', 'p3.jpeg', 'p4.webp']) {
      await writeFile(join(groupDir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    const { singles, groups } = await scanEvolutionRequirementInboxGrouped(root, { nowMs: FUTURE(), stableMs: 0 });
    expect(singles).toHaveLength(0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groupRelativeDir).toBe(`${EVOLUTION_REQUIREMENT_INBOX_DIR}/manuscript-a`);
    expect(groups[0]!.files).toHaveLength(5);
    expect(groups[0]!.files.filter((f) => f.kind === 'image')).toHaveLength(4);
    expect(groups[0]!.files.filter((f) => f.kind === 'text')).toHaveLength(1);
  });

  it('holds back the WHOLE group while any member file is still settling (per-group max-mtime stability)', async () => {
    const root = await makeRoot();
    const groupDir = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'manuscript-b');
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, 'p1.png'), Buffer.from([1]));
    await writeFile(join(groupDir, 'p2.png'), Buffer.from([2]));
    // nowMs = now → freshly-written files are inside the stability window.
    const withheld = await scanEvolutionRequirementInboxGrouped(root, { nowMs: Date.now(), stableMs: 60_000 });
    expect(withheld.groups).toHaveLength(0);
    // Once the window passes for every member, the group appears.
    const settled = await scanEvolutionRequirementInboxGrouped(root, { nowMs: FUTURE(), stableMs: 1_000 });
    expect(settled.groups).toHaveLength(1);
  });

  it('keeps root-level text files as 1:1 singletons (legacy behavior preserved)', async () => {
    const root = await makeRoot();
    await mkdir(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR), { recursive: true });
    await writeFile(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'plain.md'), '# 需求\n\n实现导出功能。\n', 'utf8');
    const { singles, groups } = await scanEvolutionRequirementInboxGrouped(root, { nowMs: FUTURE(), stableMs: 0 });
    expect(groups).toHaveLength(0);
    expect(singles).toHaveLength(1);
    expect(singles[0]!.kind).toBe('text');
    // Legacy flat scan still ignores images entirely and stays text-only.
    await writeFile(join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'photo.png'), Buffer.from([3]));
    const legacy = await scanEvolutionRequirementInbox(root, { nowMs: FUTURE(), stableMs: 0 });
    expect(legacy.map((c) => c.sourceRelativePath)).toEqual([`${EVOLUTION_REQUIREMENT_INBOX_DIR}/plain.md`]);
  });

  it('poller fires onCandidateGroup ONCE for a grouped drop and never re-fires for seen files', async () => {
    const root = await makeRoot();
    const groupDir = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'manuscript-c');
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, 'p1.png'), Buffer.from([1]));
    await writeFile(join(groupDir, 'p2.png'), Buffer.from([2]));
    const groupsSeen: EvolutionInboxCandidateGroup[] = [];
    const singlesSeen: EvolutionInboxCandidate[] = [];
    const poller = new EvolutionInboxPoller({
      projectRoot: root,
      nowMs: FUTURE(),
      stableMs: 0,
      persistSeen: false,
      onCandidate: (candidate) => { singlesSeen.push(candidate); },
      onCandidateGroup: (group) => { groupsSeen.push(group); },
    });
    await poller.scanOnce();
    await poller.scanOnce();
    expect(singlesSeen).toHaveLength(0);
    expect(groupsSeen).toHaveLength(1);
    expect(groupsSeen[0]!.files).toHaveLength(2);
  });

  it('legacy pollers without onCandidateGroup keep per-file text dispatch and image invisibility', async () => {
    const root = await makeRoot();
    const groupDir = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'legacy-d');
    await mkdir(groupDir, { recursive: true });
    await writeFile(join(groupDir, 'a.md'), '# A\n\n实现 A。\n', 'utf8');
    await writeFile(join(groupDir, 'b.md'), '# B\n\n实现 B。\n', 'utf8');
    await writeFile(join(groupDir, 'photo.png'), Buffer.from([4]));
    const singlesSeen: EvolutionInboxCandidate[] = [];
    const poller = new EvolutionInboxPoller({
      projectRoot: root,
      nowMs: FUTURE(),
      stableMs: 0,
      persistSeen: false,
      onCandidate: (candidate) => { singlesSeen.push(candidate); },
    });
    await poller.scanOnce();
    expect(singlesSeen.map((c) => c.sourceRelativePath).sort()).toEqual([
      `${EVOLUTION_REQUIREMENT_INBOX_DIR}/legacy-d/a.md`,
      `${EVOLUTION_REQUIREMENT_INBOX_DIR}/legacy-d/b.md`,
    ]);
  });
});

describe('A3 — ledger pre-seed prevents duplicate launches', () => {
  it('poller skips files whose identities were pre-seeded into the ledger by another flow', async () => {
    const root = await makeRoot();
    const groupDir = join(root, EVOLUTION_REQUIREMENT_INBOX_DIR, 'reference-20260101000000-task');
    await mkdir(groupDir, { recursive: true });
    const briefRel = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/reference-20260101000000-task/brief.md`;
    const imageRel = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/reference-20260101000000-task/01-shot.png`;
    await writeFile(join(root, briefRel), '# Brief\n\n实现参考图。\n', 'utf8');
    await writeFile(join(root, imageRel), Buffer.from([5]));

    // Simulate the deliberate upload flow pre-seeding its own files.
    await recordEvolutionInboxSeenFiles(root, [briefRel, imageRel]);

    const groupsSeen: EvolutionInboxCandidateGroup[] = [];
    const singlesSeen: EvolutionInboxCandidate[] = [];
    const poller = new EvolutionInboxPoller({
      projectRoot: root,
      nowMs: FUTURE(),
      stableMs: 0,
      onCandidate: (candidate) => { singlesSeen.push(candidate); },
      onCandidateGroup: (group) => { groupsSeen.push(group); },
    });
    await poller.scanOnce();
    expect(singlesSeen).toHaveLength(0);
    expect(groupsSeen).toHaveLength(0);
  });
});

describe('A2 — images-only group launches ONE run via a synthesized brief', () => {
  it('4 photos in one subdirectory produce exactly one run whose source is a synthesized text brief', async () => {
    const root = await makeRoot();
    const groupRel = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/manuscript-e`;
    await mkdir(join(root, groupRel), { recursive: true });
    const files = [];
    for (const name of ['s1.png', 's2.png', 's3.png', 's4.png']) {
      await writeFile(join(root, groupRel, name), Buffer.from([6]));
      files.push({ relativePath: `${groupRel}/${name}`, sizeBytes: 1, mtimeMs: Date.now(), kind: 'image' as const });
    }
    const result = await launchEvolutionRunFromInboxCandidateGroup({
      projectRoot: root,
      sessionName: 'deck_grouptest_brain',
      group: { groupRelativeDir: groupRel, files },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const run = getEvolutionRun(result.value.runId);
    expect(run?.value?.source.relativePath).toBe(`${groupRel}/brief.md`);
    const brief = await readFile(join(root, groupRel, 'brief.md'), 'utf8');
    expect(brief).toContain('s1.png');
    expect(brief).toContain('s4.png');
    // The synthesized brief was pre-seeded so the watcher never re-triggers on it.
    const ledger = JSON.parse(await readFile(join(root, '.imc/evolution/inbox-ledger.json'), 'utf8')) as { seen: string[] };
    expect(ledger.seen.some((entry) => entry.startsWith(`${groupRel}/brief.md:`))).toBe(true);
  });
});

describe('A1 — requirement classification gate (watcher-triggered runs only)', () => {
  it('a clearly-non-actionable watcher drop pauses at needs_human with a classification artifact', async () => {
    const root = await makeRoot();
    const groupRel = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/notes-f`;
    await mkdir(join(root, groupRel), { recursive: true });
    const noteRel = `${groupRel}/meeting-notes.md`;
    await writeFile(join(root, noteRel), 'ok\n', 'utf8'); // short, no requirement language, notes-shaped name
    const result = await launchEvolutionRunFromInboxCandidateGroup({
      projectRoot: root,
      sessionName: 'deck_grouptest_brain',
      group: { groupRelativeDir: groupRel, files: [{ relativePath: noteRel, sizeBytes: 3, mtimeMs: Date.now(), kind: 'text' }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await runEvolutionAutopilot(result.value.runId, null);
    const run = getEvolutionRun(result.value.runId);
    expect(run?.value?.stage).toBe('needs_human');
    expect(run?.value?.artifacts.some((artifact) => artifact.kind === 'requirement_classification')).toBe(true);
    expect(run?.value?.blockingQuestions.some((question) => question.id.startsWith('requirement-classification-'))).toBe(true);
  });

  it('a clear feature request proceeds past detected unchanged', async () => {
    const root = await makeRoot();
    const groupRel = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/feature-g`;
    await mkdir(join(root, groupRel), { recursive: true });
    const reqRel = `${groupRel}/export-feature.md`;
    await writeFile(join(root, reqRel), '# 导出功能\n\n需要实现订单数据导出为 CSV，用户可以选择时间范围。\n', 'utf8');
    const result = await launchEvolutionRunFromInboxCandidateGroup({
      projectRoot: root,
      sessionName: 'deck_grouptest_brain',
      group: { groupRelativeDir: groupRel, files: [{ relativePath: reqRel, sizeBytes: 60, mtimeMs: Date.now(), kind: 'text' }] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await runEvolutionAutopilot(result.value.runId, null);
    const run = getEvolutionRun(result.value.runId);
    expect(run?.value?.stage).not.toBe('needs_human');
    expect(run?.value?.blockingQuestions.some((question) => question.id.startsWith('requirement-classification-'))).toBe(false);
    // Verdict is still recorded as an auditable artifact even when proceeding.
    expect(run?.value?.artifacts.some((artifact) => artifact.kind === 'requirement_classification')).toBe(true);
  });
});

/**
 * Greenfield foundation execution for the Evolution pipeline.
 *
 * Two responsibilities, both fail-closed and honest about what was actually
 * observed:
 *
 * 1. `bootstrapGreenfieldFoundation` — materialize the approved greenfield
 *    target directory as an ISOLATED git repository (its own `git init`, not a
 *    branch of the host project) with a foundation manifest and an initial
 *    commit. The returned HEAD sha is the reproducible proof that the
 *    `repository` capability is real, so its foundation evidence may be
 *    upgraded from `planned` to `verified`.
 *
 * 2. `probeFoundationCapabilities` — deterministic, read-only filesystem/git
 *    probes over the target directory. A capability is reported `verified`
 *    ONLY when a concrete marker was observed (the proof names it); anything
 *    unobservable stays `planned`. No probe ever fabricates a verdict.
 */
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { EvolutionFoundationEvidence } from '../../shared/evolution-pipeline-types.js';

export type FoundationCapability = EvolutionFoundationEvidence['capability'];

export interface FoundationProbeResult {
  capability: FoundationCapability;
  status: 'verified' | 'planned';
  /** Present iff status is `verified`: names the concrete marker observed. */
  proof?: string;
}

export interface FoundationBootstrapResult {
  ok: boolean;
  reason?: string;
  /** HEAD sha of the initial commit; present iff ok. */
  headSha?: string;
  manifestRelativePath?: string;
}

const GIT_TIMEOUT_MS = 15_000;
const GIT_IDENTITY_ARGS = ['-c', 'user.name=IM.codes Evolution', '-c', 'user.email=evolution@imcodes.local'];
export const FOUNDATION_MANIFEST_FILENAME = 'FOUNDATION.md';

function safeTargetPath(projectRoot: string, targetRelativeDir: string): string {
  const resolvedRoot = resolve(projectRoot);
  const resolvedTarget = resolve(resolvedRoot, targetRelativeDir);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('evolution_foundation_target_outside_project');
  }
  return resolvedTarget;
}

function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolvePromise({ ok: !error, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() });
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function anyPathExists(base: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await pathExists(join(base, candidate))) return candidate;
  }
  return null;
}

async function nonEmptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Initialize the greenfield target as an isolated git repository with a
 * foundation manifest and an initial commit. The caller has already validated
 * that the target is absent or empty (write-policy inventory) — this function
 * re-checks emptiness defensively and never overwrites existing content.
 */
export async function bootstrapGreenfieldFoundation(options: {
  projectRoot: string;
  targetRelativeDir: string;
  runId: string;
  topology?: string | undefined;
  nowMs: number;
}): Promise<FoundationBootstrapResult> {
  let targetPath: string;
  try {
    targetPath = safeTargetPath(options.projectRoot, options.targetRelativeDir);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (await pathExists(targetPath)) {
      if (await nonEmptyDirectory(targetPath)) {
        return { ok: false, reason: 'greenfield_target_not_empty' };
      }
    } else {
      await mkdir(targetPath, { recursive: true });
    }
  } catch (error) {
    return { ok: false, reason: `target_prepare_failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const init = await runGit(targetPath, ['init', '--initial-branch=main']);
  if (!init.ok) {
    // Older git without --initial-branch support: fall back to a plain init.
    const fallback = await runGit(targetPath, ['init']);
    if (!fallback.ok) return { ok: false, reason: `git_init_failed: ${fallback.stderr || init.stderr}` };
  }

  const manifest = [
    '# Foundation',
    '',
    `- Evolution run: \`${options.runId}\``,
    `- Topology: \`${options.topology ?? 'modular_monolith'}\``,
    `- Boundary: \`${options.targetRelativeDir.replace(/\\/g, '/')}\` (isolated git repository inside the host project)`,
    `- Bootstrapped at: ${new Date(options.nowMs).toISOString()}`,
    '',
    'This repository was initialized by the IM.codes Evolution pipeline as the',
    'isolated workspace for a `greenfield_new_system` run. Feature work lands',
    'here; the host project is never mutated by greenfield implementation.',
  ].join('\n');
  try {
    await writeFile(join(targetPath, FOUNDATION_MANIFEST_FILENAME), `${manifest}\n`, 'utf8');
  } catch (error) {
    return { ok: false, reason: `manifest_write_failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const add = await runGit(targetPath, ['add', '-A']);
  if (!add.ok) return { ok: false, reason: `git_add_failed: ${add.stderr}` };
  const commit = await runGit(targetPath, [...GIT_IDENTITY_ARGS, 'commit', '-m', `chore(foundation): bootstrap greenfield workspace for ${options.runId}`]);
  if (!commit.ok) return { ok: false, reason: `git_commit_failed: ${commit.stderr}` };
  const head = await runGit(targetPath, ['rev-parse', 'HEAD']);
  if (!head.ok || !/^[a-f0-9]{40}$/.test(head.stdout)) {
    return { ok: false, reason: `git_head_unreadable: ${head.stderr}` };
  }
  return { ok: true, headSha: head.stdout, manifestRelativePath: FOUNDATION_MANIFEST_FILENAME };
}

const RUNTIME_MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile'];
const DATABASE_MARKERS = ['migrations', 'prisma/schema.prisma', 'drizzle.config.ts', 'drizzle.config.js', 'schema.sql', 'alembic.ini', 'db/migrations'];
const CI_MARKERS = ['.github/workflows', '.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'Jenkinsfile'];
const DEPLOYMENT_MARKERS = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'k8s', 'kubernetes', 'fly.toml', 'vercel.json', 'netlify.toml'];
const OBSERVABILITY_MARKERS = ['otel-collector.yaml', 'otel.config.ts', 'prometheus.yml', 'grafana', 'sentry.properties', 'instrumentation.ts'];

/**
 * Read-only capability probes. `repository` additionally requires a readable
 * git HEAD (a `.git` directory alone is not proof of a usable repository).
 * `auth` has no objectively checkable filesystem marker, so it is always
 * reported `planned` — honesty over optimism.
 */
export async function probeFoundationCapabilities(options: {
  projectRoot: string;
  targetRelativeDir: string;
}): Promise<FoundationProbeResult[]> {
  let targetPath: string;
  try {
    targetPath = safeTargetPath(options.projectRoot, options.targetRelativeDir);
  } catch {
    return (['repository', 'runtime', 'database', 'auth', 'observability', 'ci', 'deployment'] as const)
      .map((capability) => ({ capability, status: 'planned' as const }));
  }
  const results: FoundationProbeResult[] = [];

  if (await pathExists(join(targetPath, '.git'))) {
    const head = await runGit(targetPath, ['rev-parse', 'HEAD']);
    results.push(head.ok && /^[a-f0-9]{40}$/.test(head.stdout)
      ? { capability: 'repository', status: 'verified', proof: `git HEAD ${head.stdout.slice(0, 12)}` }
      : { capability: 'repository', status: 'planned' });
  } else {
    results.push({ capability: 'repository', status: 'planned' });
  }

  const probes: Array<{ capability: FoundationCapability; markers: string[] }> = [
    { capability: 'runtime', markers: RUNTIME_MANIFESTS },
    { capability: 'database', markers: DATABASE_MARKERS },
    { capability: 'observability', markers: OBSERVABILITY_MARKERS },
    { capability: 'ci', markers: CI_MARKERS },
    { capability: 'deployment', markers: DEPLOYMENT_MARKERS },
  ];
  for (const probe of probes) {
    const marker = await anyPathExists(targetPath, probe.markers);
    results.push(marker
      ? { capability: probe.capability, status: 'verified', proof: `observed ${marker}` }
      : { capability: probe.capability, status: 'planned' });
  }

  // No objective filesystem marker proves auth is real; leave it planned.
  results.push({ capability: 'auth', status: 'planned' });
  return results;
}

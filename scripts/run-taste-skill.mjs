#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const TASTE_SKILL_SOURCE_URL = 'https://github.com/Leonxlnx/taste-skill';
const DEFAULT_SKILL_INSTALL_NAME = 'design-taste-frontend';
const STYLE_AUDIT_MAX_FILES = 90;
const STYLE_AUDIT_MAX_DEPTH = 7;
const STYLE_AUDIT_MAX_FILE_BYTES = 96 * 1024;
const STYLE_AUDIT_MAX_TOTAL_BYTES = 768 * 1024;
const STYLE_AUDIT_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.imc',
  '.imcodes',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.output',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp',
  'vendor',
]);
const STYLE_SOURCE_DIRS = new Set(['src', 'app', 'pages', 'components', 'styles', 'web', 'frontend', 'ui', 'client']);
const STYLE_CONFIG_FILES = new Set([
  'package.json',
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
  'tailwind.config.ts',
  'postcss.config.js',
  'vite.config.js',
  'vite.config.ts',
  'next.config.js',
  'next.config.mjs',
  'astro.config.mjs',
  'nuxt.config.ts',
]);
const STYLE_FILE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs']);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--prompt') options.prompt = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--design-handoff') options.designHandoff = argv[++index];
    else if (arg === '--reference-output') options.referenceOutput = argv[++index];
    else if (arg === '--project-root') options.projectRoot = argv[++index];
    else if (arg === '--style-audit-output') options.styleAuditOutput = argv[++index];
    else if (arg === '--skill') options.skill = argv[++index];
    else if (arg === '--no-reference') options.noReference = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return `Usage: node scripts/run-taste-skill.mjs --prompt <path> --output <path> [--design-handoff <path>] [--reference-output <path>] [--project-root <path>] [--style-audit-output <path>] [--skill <SKILL.md>]

Reads IM.codes Evolution Factory design artifacts and emits a lightweight taste-skill high-fidelity Markdown brief. When --reference-output is provided, it also writes a SVG reference frame for War Room preview without Figma.
When --project-root is provided, it audits existing pages, style files, tokens, and colors before generating the high-fidelity direction.
`;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function mdEscape(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

async function readOptional(path) {
  if (!path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function tryJson(value) {
  if (!value?.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function safeWriteTarget(path, root) {
  const resolved = resolve(path);
  if (!root) return resolved;
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write outside IMCODES_EVOLUTION_RUN_DIR: ${path}`);
  }
  return resolved;
}

function candidateSkillPaths(explicit) {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  return [
    explicit,
    process.env.IMCODES_TASTE_SKILL_PATH,
    join(process.cwd(), '.codex/skills/design-taste-frontend/SKILL.md'),
    join(process.cwd(), '.claude/skills/design-taste-frontend/SKILL.md'),
    join(codexHome, 'skills/design-taste-frontend/SKILL.md'),
    join(codexHome, 'skills/gpt-taste/SKILL.md'),
    join(home, '.codex/skills/design-taste-frontend/SKILL.md'),
    join(home, '.codex/skills/gpt-taste/SKILL.md'),
  ].filter(Boolean);
}

async function loadTasteSkill(explicit) {
  for (const candidate of candidateSkillPaths(explicit)) {
    const path = resolve(candidate);
    if (!existsSync(path)) continue;
    const content = await readFile(path, 'utf8');
    return { path, content };
  }
  return null;
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = match?.[1] ?? '';
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() || DEFAULT_SKILL_INSTALL_NAME;
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() || 'Anti-slop frontend design skill.';
  return { name, description };
}

function extractSkillDials(content) {
  const variance = Number(content.match(/DESIGN_VARIANCE:\s*(\d+)/)?.[1] ?? 8);
  const motion = Number(content.match(/MOTION_INTENSITY:\s*(\d+)/)?.[1] ?? 6);
  const density = Number(content.match(/VISUAL_DENSITY:\s*(\d+)/)?.[1] ?? 4);
  return { variance, motion, density };
}

function slashPath(path) {
  return path.replaceAll('\\', '/');
}

function topEntries(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function increment(map, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function compactValue(value, max = 120) {
  const normalized = mdEscape(value);
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function isStyleCandidate(relativePath) {
  const normalized = slashPath(relativePath);
  const fileName = normalized.split('/').pop() || '';
  if (STYLE_CONFIG_FILES.has(fileName)) return true;
  const extension = extname(fileName).toLowerCase();
  if (!STYLE_FILE_EXTENSIONS.has(extension)) return false;
  if (['.css', '.scss', '.sass', '.less'].includes(extension)) return true;
  const segments = normalized.split('/');
  return segments.some((segment) => STYLE_SOURCE_DIRS.has(segment));
}

function parseHexColor(value) {
  const hex = value.replace('#', '');
  if (![3, 4, 6, 8].includes(hex.length)) return null;
  const expanded = hex.length <= 4
    ? hex.slice(0, 3).split('').map((part) => `${part}${part}`).join('')
    : hex.slice(0, 6);
  const r = Number.parseInt(expanded.slice(0, 2), 16);
  const g = Number.parseInt(expanded.slice(2, 4), 16);
  const b = Number.parseInt(expanded.slice(4, 6), 16);
  if (![r, g, b].every(Number.isFinite)) return null;
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  return { r, g, b, brightness, saturation };
}

function colorBy(hexEntries, predicate, fallbackIndex = 0) {
  const found = hexEntries.find((entry) => {
    const parsed = parseHexColor(entry.value);
    return parsed ? predicate(parsed) : false;
  });
  return found?.value || hexEntries[fallbackIndex]?.value;
}

function auditColorFallbacks(styleAudit) {
  const hexEntries = styleAudit?.colors?.hex || [];
  if (!hexEntries.length) return {};
  const dark = colorBy(hexEntries, (color) => color.brightness < 80);
  const darkSurface = colorBy(hexEntries.filter((entry) => entry.value !== dark), (color) => color.brightness < 140);
  const border = colorBy(hexEntries, (color) => color.brightness >= 80 && color.brightness < 190, 2);
  const accent = colorBy(hexEntries, (color) => color.saturation > 80 && color.brightness >= 90, 1);
  const light = colorBy(hexEntries, (color) => color.brightness > 190);
  return {
    ...(dark ? { background: dark } : {}),
    ...(darkSurface ? { surface: darkSurface } : {}),
    ...(border ? { border } : {}),
    ...(accent ? { primary: accent, accent } : {}),
    ...(light ? { text: light } : {}),
  };
}

function inferStackFromPackageJson(content) {
  const stack = new Set();
  const parsed = tryJson(content);
  if (!parsed || typeof parsed !== 'object') return [];
  const dependencies = {
    ...(parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {}),
    ...(parsed.devDependencies && typeof parsed.devDependencies === 'object' ? parsed.devDependencies : {}),
  };
  const names = Object.keys(dependencies);
  const addIf = (name, label) => { if (names.includes(name)) stack.add(label); };
  addIf('react', 'React');
  addIf('preact', 'Preact');
  addIf('vue', 'Vue');
  addIf('svelte', 'Svelte');
  addIf('next', 'Next.js');
  addIf('vite', 'Vite');
  addIf('tailwindcss', 'Tailwind CSS');
  addIf('@tailwindcss/vite', 'Tailwind CSS');
  addIf('framer-motion', 'Framer Motion');
  addIf('motion', 'Motion');
  addIf('@radix-ui/themes', 'Radix Themes');
  addIf('@carbon/react', 'Carbon');
  addIf('@fluentui/react-components', 'Fluent UI');
  return [...stack];
}

async function collectStyleCandidateFiles(projectRoot) {
  const files = [];
  async function walk(currentDir, depth) {
    if (files.length >= STYLE_AUDIT_MAX_FILES || depth > STYLE_AUDIT_MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    const priority = (entry) => {
      if (STYLE_CONFIG_FILES.has(entry.name)) return 0;
      if (entry.isFile()) return 1;
      if (entry.isDirectory() && STYLE_SOURCE_DIRS.has(entry.name)) return 2;
      if (entry.isDirectory()) return 3;
      return 4;
    };
    entries.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= STYLE_AUDIT_MAX_FILES) return;
      if (entry.name.startsWith('.') && !['.storybook'].includes(entry.name) && !STYLE_CONFIG_FILES.has(entry.name)) {
        if (entry.isDirectory()) continue;
      }
      const absolutePath = join(currentDir, entry.name);
      const relativePath = slashPath(relative(projectRoot, absolutePath));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (STYLE_AUDIT_EXCLUDED_DIRS.has(entry.name)) continue;
        await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isStyleCandidate(relativePath)) continue;
      let info;
      try {
        info = await stat(absolutePath);
      } catch {
        continue;
      }
      if (info.size > STYLE_AUDIT_MAX_FILE_BYTES) continue;
      files.push({ absolutePath, relativePath, size: info.size });
    }
  }
  await walk(resolve(projectRoot), 0);
  return files;
}

function extractStyleSignals(relativePath, content, buckets) {
  if (relativePath.endsWith('package.json')) {
    inferStackFromPackageJson(content).forEach((entry) => increment(buckets.stack, entry));
  }
  if (/tailwind\.config\./.test(relativePath)) increment(buckets.stack, 'Tailwind CSS');
  if (/vite\.config\./.test(relativePath)) increment(buckets.stack, 'Vite');
  if (/next\.config\./.test(relativePath)) increment(buckets.stack, 'Next.js');

  const pageFile = /(^|\/)(app|pages|routes)\/.*(?:page|index|route)\.(tsx|jsx|ts|js|vue|svelte)$/.test(relativePath);
  if (pageFile) buckets.pages.add(relativePath);

  for (const match of content.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) increment(buckets.hexColors, match[0].toLowerCase());
  for (const match of content.matchAll(/\b(?:rgba?|hsla?|oklch|oklab)\([^)]+\)/gi)) increment(buckets.functionalColors, compactValue(match[0], 80));
  for (const match of content.matchAll(/(--[A-Za-z0-9_-]*(?:color|bg|background|surface|accent|primary|secondary|text|border|brand|danger|warning|success)[A-Za-z0-9_-]*)\s*:\s*([^;}{]+)/gi)) {
    increment(buckets.cssVariables, `${match[1]}: ${compactValue(match[2], 80)}`);
  }
  for (const match of content.matchAll(/\b(?:bg|text|border|ring|from|via|to|outline|decoration|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-[0-9]{2,3})?(?:\/[0-9]{1,3})?\b/g)) {
    increment(buckets.utilityColors, match[0]);
  }
  for (const match of content.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) increment(buckets.fonts, compactValue(match[1], 100));
  for (const match of content.matchAll(/\bfont-(?:sans|serif|mono|black|bold|semibold|medium|light|thin)\b/g)) increment(buckets.fonts, match[0]);
  for (const match of content.matchAll(/(?:from\s+['"]next\/font\/(?:google|local)['"]|@import\s+url\([^)]*fonts[^)]*\))/gi)) increment(buckets.fonts, compactValue(match[0], 100));
  for (const match of content.matchAll(/border-radius\s*:\s*([^;}{]+)/gi)) increment(buckets.radius, `border-radius: ${compactValue(match[1], 60)}`);
  for (const match of content.matchAll(/\brounded(?:-[A-Za-z0-9/.[\]]+)?\b/g)) increment(buckets.radius, match[0]);
  for (const match of content.matchAll(/\b(?:shadow(?:-[A-Za-z0-9/.[\]]+)?|backdrop-blur(?:-[A-Za-z0-9/.[\]]+)?|blur(?:-[A-Za-z0-9/.[\]]+)?|glass|gradient|bg-gradient-to-[rltb]|dark:|prefers-color-scheme)\b/g)) {
    increment(buckets.surface, match[0]);
  }
  for (const match of content.matchAll(/\b(?:grid|flex|container|max-w-[A-Za-z0-9-]+|gap-[A-Za-z0-9/.[\]]+|space-y-[A-Za-z0-9/.[\]]+|px-[A-Za-z0-9/.[\]]+|py-[A-Za-z0-9/.[\]]+)\b/g)) {
    increment(buckets.layout, match[0]);
  }
}

function inferTheme(hexColors, utilityColors, surfacePatterns) {
  let dark = 0;
  let light = 0;
  for (const entry of hexColors) {
    const parsed = parseHexColor(entry.value);
    if (!parsed) continue;
    if (parsed.brightness < 90) dark += entry.count;
    if (parsed.brightness > 205) light += entry.count;
  }
  for (const entry of utilityColors) {
    if (/(?:slate|gray|zinc|neutral|stone|black)-(?:8|9)\d\d|bg-black|text-white/.test(entry.value)) dark += entry.count;
    if (/(?:slate|gray|zinc|neutral|stone|white)-(?:0|1|2)\d\d|bg-white|text-black/.test(entry.value)) light += entry.count;
  }
  for (const entry of surfacePatterns) {
    if (/dark:|prefers-color-scheme/.test(entry.value)) dark += entry.count;
  }
  if (dark > light * 1.25) return 'dark / high-contrast';
  if (light > dark * 1.25) return 'light / airy';
  if (dark || light) return 'mixed or adaptive';
  return 'not enough color evidence';
}

function styleAuditSummary(styleAudit) {
  if (!styleAudit?.available) return 'No existing UI/style files were found; align primarily to explicit high-fidelity handoff tokens.';
  const colors = [
    ...(styleAudit.colors.hex || []).slice(0, 4).map((entry) => entry.value),
    ...(styleAudit.colors.utilityClasses || []).slice(0, 4).map((entry) => entry.value),
  ].slice(0, 6).join(', ') || 'no dominant tokens';
  const fonts = (styleAudit.typography.fonts || []).slice(0, 3).map((entry) => entry.value).join(', ') || 'system/default fonts';
  return `${styleAudit.theme} project style, stack ${styleAudit.stack.join(' + ') || 'unknown'}, preserve colors ${colors}, typography ${fonts}.`;
}

async function collectProjectStyleAudit(projectRoot) {
  const resolvedRoot = resolve(projectRoot);
  const buckets = {
    hexColors: new Map(),
    functionalColors: new Map(),
    cssVariables: new Map(),
    utilityColors: new Map(),
    fonts: new Map(),
    radius: new Map(),
    surface: new Map(),
    layout: new Map(),
    stack: new Map(),
    pages: new Set(),
  };
  const candidateFiles = await collectStyleCandidateFiles(resolvedRoot);
  let totalBytes = 0;
  const analyzedFiles = [];
  for (const file of candidateFiles) {
    if (totalBytes + file.size > STYLE_AUDIT_MAX_TOTAL_BYTES) break;
    let content;
    try {
      content = await readFile(file.absolutePath, 'utf8');
    } catch {
      continue;
    }
    totalBytes += Buffer.byteLength(content);
    analyzedFiles.push(file.relativePath);
    extractStyleSignals(file.relativePath, content, buckets);
  }
  const colors = {
    hex: topEntries(buckets.hexColors, 12),
    functional: topEntries(buckets.functionalColors, 8),
    cssVariables: topEntries(buckets.cssVariables, 12),
    utilityClasses: topEntries(buckets.utilityColors, 16),
  };
  const typography = { fonts: topEntries(buckets.fonts, 10) };
  const radius = topEntries(buckets.radius, 10);
  const surfacePatterns = topEntries(buckets.surface, 12);
  const layoutPatterns = topEntries(buckets.layout, 12);
  const stack = topEntries(buckets.stack, 8).map((entry) => entry.value);
  const pages = [...buckets.pages].slice(0, 12);
  const available = analyzedFiles.length > 0 && (
    colors.hex.length > 0
    || colors.cssVariables.length > 0
    || colors.utilityClasses.length > 0
    || typography.fonts.length > 0
    || pages.length > 0
  );
  const audit = {
    available,
    projectRoot: resolvedRoot,
    scannedFileCount: candidateFiles.length,
    analyzedFileCount: analyzedFiles.length,
    totalBytes,
    sourceFiles: analyzedFiles.slice(0, 40),
    stack,
    pages,
    theme: inferTheme(colors.hex, colors.utilityClasses, surfacePatterns),
    colors,
    typography,
    radius,
    surfacePatterns,
    layoutPatterns,
  };
  return {
    ...audit,
    summary: styleAuditSummary(audit),
  };
}

function renderStyleAuditMarkdown(styleAudit) {
  const list = (items, empty = 'none detected') => (items?.length ? items.map((entry) => `- ${entry.value} (${entry.count})`) : [`- ${empty}`]);
  return [
    '# Existing Project Style Audit',
    '',
    `Project root: \`${styleAudit.projectRoot}\``,
    `Available: ${styleAudit.available ? 'yes' : 'no'}`,
    `Scanned files: ${styleAudit.scannedFileCount}`,
    `Analyzed files: ${styleAudit.analyzedFileCount}`,
    `Theme: ${styleAudit.theme}`,
    `Stack: ${styleAudit.stack.join(', ') || 'unknown'}`,
    '',
    '## Summary',
    styleAudit.summary,
    '',
    '## Dominant Colors',
    ...list(styleAudit.colors.hex),
    '',
    '## CSS Color Variables',
    ...list(styleAudit.colors.cssVariables),
    '',
    '## Tailwind Color Utilities',
    ...list(styleAudit.colors.utilityClasses),
    '',
    '## Typography',
    ...list(styleAudit.typography.fonts),
    '',
    '## Radius and Surface Patterns',
    ...list(styleAudit.radius),
    ...list(styleAudit.surfacePatterns),
    '',
    '## Existing Pages / Entry Points',
    ...(styleAudit.pages.length ? styleAudit.pages.map((entry) => `- ${entry}`) : ['- none detected']),
    '',
    '## Source Files Sample',
    ...(styleAudit.sourceFiles.length ? styleAudit.sourceFiles.map((entry) => `- ${entry}`) : ['- none']),
    '',
    '## Style Consistency Rule',
    '- Preserve these project tokens when generating a page inside this repository.',
    '- If design-handoff tokens are explicit, reconcile them with this audit and document any intentional deviation.',
    '- Do not introduce an unrelated palette, type scale, radius system, or motion language.',
    '',
  ].join('\n');
}

function collectText(prompt, handoff) {
  return [
    prompt,
    handoff?.title,
    handoff?.summary,
    handoff?.designSystem?.mood,
    handoff?.screens?.map((screen) => `${screen.name} ${screen.purpose} ${(screen.states || []).join(' ')}`).join(' '),
    handoff?.warRoomInstructions?.map((item) => item.text).join(' '),
  ].filter(Boolean).join('\n').toLowerCase();
}

function inferDials(prompt, handoff, base) {
  const text = collectText(prompt, handoff);
  if (/dashboard|war room|operations|agent|evidence|timeline|运维|战情室|多智能体|状态|数据/.test(text)) {
    return { variance: 6, motion: 4, density: 8, preset: 'dense operations product surface' };
  }
  if (/mobile|ios|android|移动|手机/.test(text)) {
    return { variance: 5, motion: 4, density: 6, preset: 'mobile-first product flow' };
  }
  if (/luxury|premium|apple|consumer|品牌|高级|高端/.test(text)) {
    return { variance: 8, motion: 6, density: 4, preset: 'premium product UI' };
  }
  if (/public|government|regulated|accessibility|合规|政务|监管/.test(text)) {
    return { variance: 3, motion: 2, density: 5, preset: 'trust-first regulated surface' };
  }
  return { ...base, preset: 'general taste-skill frontend direction' };
}

function inferDesignRead(prompt, handoff, dials, styleAudit) {
  const title = handoff?.title || 'Evolution UI';
  const screen = handoff?.screens?.[0]?.name || title;
  const text = collectText(prompt, handoff);
  const audience = /agent|developer|technical|运维|开发|技术/.test(text) ? 'technical operators and engineering leads' : 'product users';
  const vibe = handoff?.designSystem?.mood || (dials.density >= 7 ? 'dark evidence-first operations language' : 'premium anti-slop product language');
  const foundation = dials.density >= 7 ? 'existing Preact/CSS dashboard components with taste-skill hierarchy rules' : 'framework-native components with taste-skill spacing, type, and motion rules';
  const styleLock = styleAudit?.available
    ? ` Existing-project style lock: ${styleAudit.summary}`
    : ' No existing UI style lock was detected, so explicit high-fidelity handoff tokens take priority.';
  return `Reading this as: ${screen} for ${audience}, with a ${vibe}, leaning toward ${foundation}.${styleLock}`;
}

function normalizeColors(handoff, styleAudit) {
  const colors = handoff?.designSystem?.colors || {};
  const audited = auditColorFallbacks(styleAudit);
  return {
    background: colors.background || audited.background || '#020617',
    surface: colors.surface || audited.surface || '#0f172a',
    border: colors.border || audited.border || '#334155',
    primary: colors.primary || audited.primary || '#38bdf8',
    success: colors.success || '#22c55e',
    warning: colors.warning || '#f59e0b',
    danger: colors.danger || '#fb7185',
    accent: colors.accent || audited.accent || '#a78bfa',
  };
}

function renderSvgReference({ handoff, dials, designRead, styleAudit }) {
  const colors = normalizeColors(handoff, styleAudit);
  const title = handoff?.title || handoff?.primarySurface || 'Product UI';
  const domain = handoff?.domain || 'product';
  const isWarRoom = domain === 'evolution_war_room';
  const primarySurface = handoff?.primarySurface || handoff?.screens?.[0]?.name || title;
  const components = handoff?.designSystem?.components || [
    'page header',
    'filters/search',
    'main list or cards',
    'detail panel',
    'primary action form',
  ];
  const stages = (handoff?.designSystem?.navigation?.length ? handoff.designSystem.navigation : handoff?.screens?.map((screen) => screen.name))
    || (isWarRoom ? ['Inbox', 'PRD', 'Design', 'Architecture', 'Tasks', 'Dev Loop', 'QA', 'Staging', 'Gate'] : ['Overview', 'Manage', 'Detail', 'Create', 'Validate', 'Audit']);
  const roleLabels = (handoff?.designSystem?.entities?.length ? handoff.designSystem.entities : handoff?.screens?.map((screen) => screen.name))
    || (isWarRoom ? ['Product', 'UX', 'Visual', 'Tech Director', 'Frontend', 'Backend', 'QA', 'Ops'] : ['Primary object', 'Secondary object', 'Status', 'Owner', 'Record', 'Permission', 'Audit']);
  const actionLabels = handoff?.designSystem?.actions?.length ? handoff.designSystem.actions : ['create', 'edit', 'view detail', 'submit', 'filter'];
  const componentRows = components.slice(0, 7);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960" viewBox="0 0 1440 960" role="img" aria-label="taste-skill high-fidelity reference for ${xmlEscape(title)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${colors.background}"/><stop offset="1" stop-color="#111827"/></linearGradient>
    <radialGradient id="glow" cx="0.75" cy="0.1" r="0.75"><stop offset="0" stop-color="${colors.primary}" stop-opacity="0.28"/><stop offset="1" stop-color="${colors.background}" stop-opacity="0"/></radialGradient>
    <filter id="soft"><feDropShadow dx="0" dy="24" stdDeviation="32" flood-color="#000" flood-opacity="0.35"/></filter>
    <style>
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.sans{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}.small{font-size:18px}.xs{font-size:14px}.label{fill:#94a3b8}.white{fill:#e5e7eb}.muted{fill:#64748b}.panel{fill:${colors.surface};stroke:${colors.border};stroke-width:1.5}.hair{stroke:${colors.border};stroke-width:1}.accent{fill:${colors.primary}}.success{fill:${colors.success}}.warning{fill:${colors.warning}}.danger{fill:${colors.danger}}
    </style>
  </defs>
  <rect width="1440" height="960" fill="url(#bg)"/>
  <rect width="1440" height="960" fill="url(#glow)"/>
  <text x="64" y="74" class="mono xs label">${xmlEscape(isWarRoom ? 'IM.CODES / EVOLUTION FACTORY / TASTE-SKILL REFERENCE' : `${String(domain).toUpperCase()} / SOURCE-DRIVEN TASTE-SKILL REFERENCE`)}</text>
  <text x="64" y="124" class="sans" font-size="42" font-weight="760" fill="#f8fafc">${xmlEscape(title)}</text>
  <text x="64" y="160" class="sans small label">${xmlEscape(designRead.slice(0, 138))}</text>
  <g transform="translate(64 206)">${stages.map((stage, index) => {
    const x = index * 142;
    const active = index >= 2 && index <= 5;
    const fill = active ? colors.primary : colors.surface;
    const opacity = active ? '0.18' : '0.78';
    return `<g transform="translate(${x} 0)"><rect width="124" height="42" rx="21" fill="${fill}" fill-opacity="${opacity}" stroke="${active ? colors.primary : colors.border}"/><circle cx="22" cy="21" r="5" fill="${active ? colors.primary : colors.success}"/><text x="38" y="27" class="mono xs white">${xmlEscape(stage)}</text></g>`;
  }).join('')}</g>
  <g transform="translate(64 288)" filter="url(#soft)">
    <rect class="panel" width="402" height="548" rx="28"/>
    <text x="28" y="48" class="sans" font-size="24" font-weight="720" fill="#f8fafc">${xmlEscape(isWarRoom ? 'Role execution' : 'Information objects')}</text>
    ${roleLabels.map((role, index) => {
      const y = 80 + index * 56;
      const color = index < 4 ? colors.primary : index < 6 ? colors.accent : index === 6 ? colors.success : colors.warning;
      return `<g transform="translate(28 ${y})"><rect width="346" height="42" rx="14" fill="#020617" fill-opacity="0.68" stroke="${colors.border}"/><rect width="4" height="26" x="14" y="8" rx="2" fill="${color}"/><text x="32" y="27" class="sans small white">${xmlEscape(role)}</text><text x="245" y="27" class="mono xs label">${index < 5 ? 'running' : 'waiting'}</text></g>`;
    }).join('')}
  </g>
  <g transform="translate(498 288)" filter="url(#soft)">
    <rect class="panel" width="440" height="548" rx="28"/>
    <text x="30" y="48" class="sans" font-size="24" font-weight="720" fill="#f8fafc">High-fidelity surface</text>
    <rect x="30" y="78" width="380" height="208" rx="22" fill="#020617" stroke="${colors.primary}" stroke-opacity="0.45"/>
    <text x="56" y="124" class="sans" font-size="28" font-weight="760" fill="#f8fafc">${xmlEscape(String(primarySurface).slice(0, 28))}</text>
    <text x="56" y="158" class="sans small label">${xmlEscape(stages.slice(0, 5).join(' → ').slice(0, 58))}</text>
    <path d="M56 216 C116 164 174 248 236 198 S330 168 384 222" fill="none" stroke="${colors.primary}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="236" cy="198" r="8" fill="${colors.warning}"/>
    <circle cx="384" cy="222" r="8" fill="${colors.success}"/>
    ${componentRows.map((row, index) => `<g transform="translate(30 ${324 + index * 34})"><circle cx="7" cy="7" r="5" fill="${index % 3 === 0 ? colors.primary : index % 3 === 1 ? colors.accent : colors.success}"/><text x="24" y="12" class="sans xs label">${xmlEscape(row)}</text></g>`).join('')}
  </g>
  <g transform="translate(970 288)" filter="url(#soft)">
    <rect class="panel" width="406" height="548" rx="28"/>
    <text x="28" y="48" class="sans" font-size="24" font-weight="720" fill="#f8fafc">${xmlEscape(isWarRoom ? 'Evidence & gates' : 'Actions & validation')}</text>
    <rect x="28" y="78" width="350" height="112" rx="20" fill="#451a03" fill-opacity="0.52" stroke="${colors.warning}"/>
    <text x="52" y="119" class="sans" font-size="22" font-weight="720" fill="#fef3c7">${xmlEscape(isWarRoom ? 'Production human gate' : 'Critical state guardrail')}</text>
    <text x="52" y="150" class="sans xs" fill="#fde68a">${xmlEscape(isWarRoom ? 'Staging may automate; production needs explicit approval.' : 'Show empty, loading, validation, permission and success states.')}</text>
    ${(isWarRoom ? ['taste-skill output generated', 'OpenSpec tasks ready', 'Maker/checker split visible', 'QA acceptance cases complete', 'Rollback path required'] : actionLabels.slice(0, 5)).map((item, index) => `<g transform="translate(32 ${234 + index * 54})"><rect width="342" height="38" rx="13" fill="#020617" fill-opacity="0.68" stroke="${colors.border}"/><circle cx="22" cy="19" r="5" fill="${index < 3 ? colors.success : colors.warning}"/><text x="42" y="25" class="sans xs white">${xmlEscape(item)}</text></g>`).join('')}
  </g>
  <g transform="translate(64 872)">
    <text class="mono xs label">DIALS</text><text x="72" class="mono xs white">VARIANCE ${dials.variance} / MOTION ${dials.motion} / DENSITY ${dials.density}</text>
    <text x="520" class="mono xs label">FIGMA</text><text x="586" class="mono xs white">bypassed; SVG + Markdown are direct implementation inputs</text>
  </g>
</svg>
`;
}

function markdownTokenList(entries, limit, empty = 'not detected') {
  if (!entries?.length) return empty;
  return entries.slice(0, limit).map((entry) => `${entry.value} (${entry.count})`).join(', ');
}

function hasExplicitDesignTokens(handoff) {
  const colors = handoff?.designSystem?.colors;
  const typography = handoff?.designSystem?.typography;
  return !!(
    (colors && typeof colors === 'object' && Object.keys(colors).length > 0)
    || (typography && typeof typography === 'object' && Object.keys(typography).length > 0)
    || handoff?.designSystem?.mood
  );
}

function renderMarkdown({ prompt, handoff, skill, dials, designRead, referencePath, styleAudit, styleAuditPath }) {
  const title = handoff?.title || 'Evolution UI High-Fidelity Direction';
  const colors = normalizeColors(handoff, styleAudit);
  const components = handoff?.designSystem?.components || [];
  const screens = handoff?.screens || [];
  const checklist = handoff?.acceptanceChecklist || [];
  const instructions = handoff?.warRoomInstructions || [];
  const skillMeta = skill ? extractFrontmatter(skill.content) : { name: DEFAULT_SKILL_INSTALL_NAME, description: 'Built-in distilled taste-skill adapter; install the skill for richer local rules.' };
  const skillDials = skill ? extractSkillDials(skill.content) : { variance: 8, motion: 6, density: 4 };
  const explicitTokens = hasExplicitDesignTokens(handoff);
  return [
    '# taste-skill High-Fidelity Output',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Source: ${TASTE_SKILL_SOURCE_URL}`,
    `Skill: ${skillMeta.name}`,
    `Skill file: ${skill?.path || 'not found; using built-in distilled anti-slop rules'}`,
    `Skill description: ${skillMeta.description}`,
    '',
    '## Design Read',
    designRead,
    '',
    '## Dial Settings',
    `- Inferred preset: ${dials.preset}`,
    `- Applied: DESIGN_VARIANCE ${dials.variance} / MOTION_INTENSITY ${dials.motion} / VISUAL_DENSITY ${dials.density}`,
    `- Source default from skill file: ${skillDials.variance} / ${skillDials.motion} / ${skillDials.density}`,
    '- Interpretation: dense product surfaces need hierarchy, contrast, scannable cards, and restrained motion rather than decorative Figma-heavy mockups.',
    '',
    '## Figma Bypass Contract',
    '- Figma is optional; this Markdown plus the SVG reference is the high-fidelity handoff for frontend agents.',
    '- Treat `design/hifi-spec.md`, `design/hifi-mockup.svg`, this output, and `design/design-handoff.json` as the source of truth.',
    '- If a later image generator is available, use this file as its prompt, not as a replacement for PRD or architecture artifacts.',
    referencePath ? `- SVG reference written to: \`${referencePath}\`` : '- SVG reference not requested for this run.',
    '',
    '## Existing Project Style Audit',
    `- Status: ${styleAudit?.available ? 'existing UI/style files detected and audited before high-fidelity generation' : 'no existing UI/style files detected; use explicit handoff tokens and taste-skill defaults'}`,
    styleAuditPath ? `- Audit artifact: \`${styleAuditPath}\`` : '- Audit artifact: not requested for this run.',
    `- Summary: ${styleAudit?.summary || 'No existing project style evidence available.'}`,
    `- Stack: ${styleAudit?.stack?.join(', ') || 'unknown'}`,
    `- Theme: ${styleAudit?.theme || 'unknown'}`,
    `- Dominant hex colors: ${markdownTokenList(styleAudit?.colors?.hex, 8)}`,
    `- CSS color variables: ${markdownTokenList(styleAudit?.colors?.cssVariables, 6)}`,
    `- Tailwind color utilities: ${markdownTokenList(styleAudit?.colors?.utilityClasses, 8)}`,
    `- Typography signals: ${markdownTokenList(styleAudit?.typography?.fonts, 5)}`,
    `- Radius/surface signals: ${markdownTokenList([...(styleAudit?.radius || []), ...(styleAudit?.surfacePatterns || [])], 8)}`,
    '',
    '## Style Consistency Contract',
    '- Before designing or implementing a new page, read the audit above and reuse the repository palette, typography, radius, surfaces, spacing rhythm, and component motifs.',
    `- Priority order: ${explicitTokens ? 'explicit high-fidelity handoff tokens, then existing project tokens, then taste-skill defaults' : 'existing project tokens, then taste-skill defaults'}.`,
    '- If the high-fidelity handoff conflicts with the existing project, keep the explicit handoff only when it is intentional and document the deviation.',
    '- Do not introduce a second unrelated design system, new random accent color, or mismatched radius scale for a page that lives in this project.',
    '',
    '## Visual System',
    `- Mood: ${handoff?.designSystem?.mood || 'premium evidence-first product UI'}`,
    `- Type: heading ${handoff?.designSystem?.typography?.heading || 'bold geometric sans'}, body ${handoff?.designSystem?.typography?.body || 'system sans'}, code ${handoff?.designSystem?.typography?.code || 'ui-monospace'}`,
    `- Background: ${colors.background}; surface: ${colors.surface}; border: ${colors.border}`,
    `- Primary: ${colors.primary}; success: ${colors.success}; warning: ${colors.warning}; danger: ${colors.danger}; accent: ${colors.accent}`,
    '- Spacing: 8px base grid; 12/16px dense card interiors; 24/32px panel rhythm; keep scan paths left-to-right.',
    '- Shape: 18-28px major panels, 12-14px controls, single-pixel borders, low blur, no generic purple mesh hero.',
    '',
    '## Screen Blueprint',
    ...(screens.length ? screens.map((screen) => `- ${screen.name}: ${screen.purpose || 'primary product surface'}; states: ${(screen.states || []).join(', ') || 'default, loading, blocked, complete'}`) : ['- Primary surface: source-driven product page with navigation, core objects, actions, validation states, and handoff notes.']),
    '',
    '## Component Matrix',
    '| Component | High-fidelity treatment | Failure / empty state |',
    '| --- | --- | --- |',
    ...(components.length ? components : ['stage timeline pills', 'role status cards', 'artifact preview cards', 'evidence feed', 'role-targeted command composer', 'human gate blocker panel']).map((component) => `| ${component} | crisp status color, readable density, explicit owner and timestamp | muted copy, amber blocker state, no hidden affordance |`),
    '',
    '## Motion & Interaction',
    '- Use motion for orientation only: stage changes, new evidence, role focus, artifact preview reveal.',
    '- Maximum continuous motion: subtle opacity/translate; no infinite decorative loops in operations states.',
    '- Reduced motion: disable transforms and keep color/status changes.',
    '- Keyboard: role cards, artifact previews, and composer target picker must be reachable without pointer input.',
    '',
    '## Frontend Implementation Contract',
    '- Existing web stack first; do not add a heavy design system or Figma export dependency for this workflow.',
    '- Preserve actual artifact previews and evidence; never replace generated SVG/Markdown with fake screenshots.',
    '- Keep safety/permission/destructive-action states visually distinct from normal progress.',
    '- Apply maker/checker semantics when this output is used by implementation agents: builders implement, reviewers verify.',
    '',
    '## Acceptance Checklist',
    ...(checklist.length ? checklist.map((item) => `- ${item}`) : ['- Current stage is visible within 3 seconds.', '- Every role shows status and current action.', '- At least one high-fidelity visual preview is visible without Figma.', '- Human-gate states are visually distinct.']),
    '',
    '## War Room User Instructions',
    ...(instructions.length ? instructions.map((item) => `- ${item.roleId || 'all_roles'}: ${mdEscape(item.text)}`) : ['- None recorded.']),
    '',
    '## Prompt Digest',
    prompt.trim().slice(0, 4000),
    '',
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const promptPath = options.prompt || process.env.IMCODES_EVOLUTION_TASTE_PROMPT;
  const outputPath = options.output || process.env.IMCODES_EVOLUTION_TASTE_OUTPUT;
  const handoffPath = options.designHandoff || process.env.IMCODES_EVOLUTION_DESIGN_HANDOFF;
  const referencePath = options.noReference ? null : (options.referenceOutput || process.env.IMCODES_EVOLUTION_TASTE_REFERENCE);
  const projectRoot = resolve(options.projectRoot || process.env.IMCODES_EVOLUTION_PROJECT_ROOT || process.cwd());
  const styleAuditPath = options.styleAuditOutput || process.env.IMCODES_EVOLUTION_STYLE_AUDIT_OUTPUT;
  if (!promptPath || !outputPath) throw new Error('Missing --prompt/--output or IMCODES_EVOLUTION_TASTE_PROMPT/IMCODES_EVOLUTION_TASTE_OUTPUT.');

  const runDir = process.env.IMCODES_EVOLUTION_RUN_DIR;
  const resolvedOutput = safeWriteTarget(outputPath, runDir);
  const resolvedReference = referencePath ? safeWriteTarget(referencePath, runDir) : null;
  const resolvedStyleAudit = styleAuditPath ? safeWriteTarget(styleAuditPath, runDir) : null;
  const prompt = await readFile(promptPath, 'utf8');
  const handoffRaw = await readOptional(handoffPath);
  const handoff = tryJson(handoffRaw) || {};
  const skill = await loadTasteSkill(options.skill);
  const styleAudit = await collectProjectStyleAudit(projectRoot);
  let styleAuditRelative = null;
  if (resolvedStyleAudit) {
    await mkdir(dirname(resolvedStyleAudit), { recursive: true });
    await writeFile(resolvedStyleAudit, renderStyleAuditMarkdown(styleAudit), 'utf8');
    styleAuditRelative = runDir ? relative(resolve(runDir), resolvedStyleAudit).replaceAll('\\', '/') : resolvedStyleAudit;
  }
  const baseDials = skill ? extractSkillDials(skill.content) : { variance: 8, motion: 6, density: 4 };
  const dials = inferDials(prompt, handoff, baseDials);
  const designRead = inferDesignRead(prompt, handoff, dials, styleAudit);

  let referenceRelative = null;
  if (resolvedReference) {
    await mkdir(dirname(resolvedReference), { recursive: true });
    await writeFile(resolvedReference, renderSvgReference({ handoff, dials, designRead, styleAudit }), 'utf8');
    referenceRelative = runDir ? relative(resolve(runDir), resolvedReference).replaceAll('\\', '/') : resolvedReference;
  }

  await mkdir(dirname(resolvedOutput), { recursive: true });
  const markdown = renderMarkdown({ prompt, handoff, skill, dials, designRead, referencePath: referenceRelative, styleAudit, styleAuditPath: styleAuditRelative });
  await writeFile(resolvedOutput, markdown, 'utf8');
  process.stdout.write(`taste-skill high-fidelity output written to ${resolvedOutput}\n`);
  if (resolvedStyleAudit) process.stdout.write(`existing project style audit written to ${resolvedStyleAudit}\n`);
  if (resolvedReference) process.stdout.write(`taste-skill SVG reference written to ${resolvedReference}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

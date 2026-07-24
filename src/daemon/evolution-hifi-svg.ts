/**
 * High-fidelity SVG rendering from the Design Maker's promoted ui-spec.json.
 *
 * The legacy hi-fi path sliced requirement MD text into a generic 3-column
 * skeleton — placeholder-grade output that must never be presented as
 * "high fidelity". This module renders REAL component mockups (stat cards,
 * tables, charts, forms, lists, tab bars…) from the structured, agent-attested
 * `UiSpecDocument`, with a proper typographic hierarchy and an honest
 * provenance footer. When no promoted ui-spec exists the caller falls back to
 * the MD-derived skeleton — which is now explicitly labeled a draft
 * placeholder rather than pretending to be hi-fi.
 */
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import {
  UI_SPEC_RELATIVE_PATH,
  validateUiSpecDocument,
  type UiSpecComponent,
  type UiSpecDocument,
  type UiSpecScreen,
} from '../../shared/ui-spec.js';
import type { EvolutionRun } from '../../shared/evolution-pipeline-types.js';

const T = {
  bg: '#f6f8fb',
  surface: '#ffffff',
  border: '#e2e8f0',
  borderSoft: '#eef2f7',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  primary: '#2563eb',
  primarySoft: '#eff4ff',
  positive: '#16a34a',
  skeleton: '#e8edf4',
  zebra: '#f8fafc',
} as const;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(1, max - 1))}…` : normalized;
}

function text(x: number, y: number, value: string, size: number, weight: number, fill: string, anchor?: 'middle' | 'end'): string {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}"${anchor ? ` text-anchor="${anchor}"` : ''} font-family="-apple-system, 'Segoe UI', 'PingFang SC', sans-serif">${esc(value)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`;
}

type ComponentKind = 'stat' | 'table' | 'line-chart' | 'bar-chart' | 'form' | 'button' | 'list' | 'tabs' | 'panel';

function classifyComponent(component: UiSpecComponent): ComponentKind {
  const type = component.type.toLowerCase();
  if (/stat|kpi|metric|number-card/.test(type)) return 'stat';
  if (/table|grid|data-list/.test(type)) return 'table';
  if (/bar/.test(type)) return 'bar-chart';
  if (/chart|line|trend|graph|spark/.test(type)) return 'line-chart';
  if (/form|input|filter|search|select|field/.test(type)) return 'form';
  if (/button|action|cta/.test(type)) return 'button';
  if (/list|feed|timeline/.test(type)) return 'list';
  if (/tab/.test(type)) return 'tabs';
  return 'panel';
}

interface Block { height: number; body: (x: number, y: number, w: number) => string[] }

function statRowBlock(stats: UiSpecComponent[]): Block {
  const cards = stats.slice(0, 4);
  return {
    height: 116,
    body: (x, y, w) => {
      const gap = 20;
      const cardW = Math.floor((w - gap * (cards.length - 1)) / cards.length);
      return cards.flatMap((card, index) => {
        const cx = x + index * (cardW + gap);
        const label = clip(card.title ?? card.type, Math.floor(cardW / 14));
        const value = typeof card.props?.value === 'string' ? clip(card.props.value, 10) : ['12,480', '¥86.4k', '98.2%', '342'][index % 4]!;
        return [
          rect(cx, y, cardW, 104, 14, T.surface, T.border),
          text(cx + 20, y + 32, label, 13, 600, T.muted),
          text(cx + 20, y + 72, value, 30, 800, T.text),
          text(cx + cardW - 20, y + 32, '▲ 12%', 12, 700, T.positive, 'end'),
        ];
      });
    },
  };
}

function tableBlock(component: UiSpecComponent): Block {
  const columns = (component.children ?? []).slice(0, 6);
  const labels = columns.length > 0 ? columns.map((column) => column.title ?? column.type) : ['名称', '状态', '金额', '时间'];
  return {
    height: 292,
    body: (x, y, w) => {
      const parts = [
        rect(x, y, w, 280, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '数据列表', 40), 16, 750, T.text),
        rect(x + 16, y + 52, w - 32, 36, 8, T.primarySoft),
      ];
      const colW = Math.floor((w - 64) / labels.length);
      labels.forEach((label, index) => {
        parts.push(text(x + 32 + index * colW, y + 76, clip(label, Math.floor(colW / 13)), 13, 700, T.primary));
      });
      for (let row = 0; row < 4; row += 1) {
        const ry = y + 96 + row * 44;
        if (row % 2 === 1) parts.push(rect(x + 16, ry, w - 32, 40, 8, T.zebra));
        labels.forEach((_, index) => {
          const barW = Math.max(36, Math.floor(colW * (0.42 + ((row + index) % 3) * 0.16)));
          parts.push(rect(x + 32 + index * colW, ry + 14, barW, 12, 6, T.skeleton));
        });
      }
      return parts;
    },
  };
}

function lineChartBlock(component: UiSpecComponent): Block {
  return {
    height: 264,
    body: (x, y, w) => {
      const chartX = x + 24;
      const chartY = y + 60;
      const chartW = w - 48;
      const chartH = 160;
      const points = [0.72, 0.55, 0.62, 0.4, 0.48, 0.3, 0.34, 0.18].map((v, i) => (
        `${chartX + Math.round((chartW / 7) * i)},${chartY + Math.round(chartH * v)}`
      ));
      const grid = [0.25, 0.5, 0.75].map((g) => (
        `<line x1="${chartX}" y1="${chartY + chartH * g}" x2="${chartX + chartW}" y2="${chartY + chartH * g}" stroke="${T.borderSoft}" stroke-width="1"/>`
      ));
      return [
        rect(x, y, w, 252, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '趋势', 40), 16, 750, T.text),
        text(x + w - 20, y + 34, '近 30 天', 12, 600, T.muted, 'end'),
        ...grid,
        `<polyline points="${points.join(' ')} ${chartX + chartW},${chartY + chartH} ${chartX},${chartY + chartH}" fill="${T.primary}" fill-opacity="0.08" stroke="none"/>`,
        `<polyline points="${points.join(' ')}" fill="none" stroke="${T.primary}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
        ...points.filter((_, i) => i % 2 === 1).map((p) => {
          const [px, py] = p.split(',');
          return `<circle cx="${px}" cy="${py}" r="3.5" fill="${T.surface}" stroke="${T.primary}" stroke-width="2"/>`;
        }),
        `<line x1="${chartX}" y1="${chartY + chartH}" x2="${chartX + chartW}" y2="${chartY + chartH}" stroke="${T.border}" stroke-width="1.5"/>`,
      ];
    },
  };
}

function barChartBlock(component: UiSpecComponent): Block {
  return {
    height: 264,
    body: (x, y, w) => {
      const baseY = y + 216;
      const bars = [0.9, 0.6, 0.75, 0.45, 0.66, 0.3, 0.52];
      const barW = Math.floor((w - 96) / bars.length) - 16;
      return [
        rect(x, y, w, 252, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '分布', 40), 16, 750, T.text),
        ...bars.map((v, i) => rect(x + 40 + i * (barW + 16), baseY - Math.round(140 * v), barW, Math.round(140 * v), 6, i === 2 ? T.primary : T.primarySoft, i === 2 ? undefined : T.border)),
        `<line x1="${x + 24}" y1="${baseY}" x2="${x + w - 24}" y2="${baseY}" stroke="${T.border}" stroke-width="1.5"/>`,
      ];
    },
  };
}

function formBlock(component: UiSpecComponent): Block {
  const fields = (component.children ?? []).slice(0, 3);
  const labels = fields.length > 0 ? fields.map((field) => field.title ?? field.type) : ['状态', '时间范围'];
  return {
    height: 96,
    body: (x, y, w) => {
      const fieldW = 190;
      const parts = [rect(x, y, w, 84, 14, T.surface, T.border)];
      labels.forEach((label, index) => {
        const fx = x + 20 + index * (fieldW + 16);
        parts.push(
          text(fx + 2, y + 26, clip(label, 12), 12, 650, T.muted),
          rect(fx, y + 36, fieldW, 32, 8, T.bg, T.border),
          text(fx + 12, y + 57, '全部', 13, 500, T.faint),
        );
      });
      const btnX = x + w - 128;
      parts.push(
        rect(btnX, y + 34, 108, 36, 10, T.primary),
        text(btnX + 54, y + 57, clip(component.title ?? '筛选', 8), 14, 700, '#ffffff', 'middle'),
      );
      return parts;
    },
  };
}

function buttonBlock(component: UiSpecComponent): Block {
  return {
    height: 64,
    body: (x, y) => [
      rect(x, y, 172, 44, 12, T.primary),
      text(x + 86, y + 28, clip(component.title ?? '主要操作', 12), 15, 700, '#ffffff', 'middle'),
      rect(x + 188, y, 132, 44, 12, T.surface, T.border),
      text(x + 254, y + 28, '次要操作', 14, 600, T.muted, 'middle'),
    ],
  };
}

function listBlock(component: UiSpecComponent): Block {
  return {
    height: 244,
    body: (x, y, w) => {
      const parts = [
        rect(x, y, w, 232, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '列表', 40), 16, 750, T.text),
      ];
      for (let row = 0; row < 4; row += 1) {
        const ry = y + 56 + row * 42;
        parts.push(
          `<circle cx="${x + 38}" cy="${ry + 14}" r="13" fill="${T.primarySoft}" stroke="${T.border}"/>`,
          rect(x + 64, ry + 2, Math.floor(w * 0.36), 12, 6, T.skeleton),
          rect(x + 64, ry + 20, Math.floor(w * 0.22), 9, 5, T.borderSoft),
          rect(x + w - 96, ry + 6, 64, 20, 10, row % 2 === 0 ? T.primarySoft : T.zebra, T.border),
        );
      }
      return parts;
    },
  };
}

function tabsBlock(component: UiSpecComponent): Block {
  const tabs = (component.children ?? []).slice(0, 5);
  const labels = tabs.length > 0 ? tabs.map((tab) => tab.title ?? tab.type) : ['概览', '明细', '设置'];
  return {
    height: 56,
    body: (x, y) => labels.flatMap((label, index) => {
      const tx = x + index * 128;
      const active = index === 0;
      return [
        ...(active ? [rect(tx, y + 34, 104, 3, 1.5, T.primary)] : []),
        text(tx + 4, y + 26, clip(label, 8), 15, active ? 750 : 550, active ? T.primary : T.muted),
      ];
    }),
  };
}

function panelBlock(component: UiSpecComponent): Block {
  return {
    height: 172,
    body: (x, y, w) => [
      rect(x, y, w, 160, 14, T.surface, T.border),
      text(x + 20, y + 34, clip(component.title ?? component.type, 40), 16, 750, T.text),
      rect(x + 20, y + 56, Math.floor(w * 0.7), 12, 6, T.skeleton),
      rect(x + 20, y + 80, Math.floor(w * 0.52), 12, 6, T.skeleton),
      rect(x + 20, y + 104, Math.floor(w * 0.6), 12, 6, T.borderSoft),
    ],
  };
}

function blocksForScreen(screen: UiSpecScreen): Block[] {
  const blocks: Block[] = [];
  let statBuffer: UiSpecComponent[] = [];
  const flushStats = () => {
    if (statBuffer.length > 0) {
      blocks.push(statRowBlock(statBuffer));
      statBuffer = [];
    }
  };
  for (const component of screen.components.slice(0, 10)) {
    const kind = classifyComponent(component);
    if (kind === 'stat') {
      statBuffer.push(component);
      continue;
    }
    flushStats();
    blocks.push(
      kind === 'table' ? tableBlock(component)
        : kind === 'line-chart' ? lineChartBlock(component)
          : kind === 'bar-chart' ? barChartBlock(component)
            : kind === 'form' ? formBlock(component)
              : kind === 'button' ? buttonBlock(component)
                : kind === 'list' ? listBlock(component)
                  : kind === 'tabs' ? tabsBlock(component)
                    : panelBlock(component),
    );
  }
  flushStats();
  return blocks;
}

function sidebarWidth(spec: UiSpecDocument): number {
  const sidebar = spec.layout?.sidebar;
  if (sidebar && typeof sidebar === 'object' && !Array.isArray(sidebar)) {
    const width = (sidebar as Record<string, unknown>).width;
    if (typeof width === 'number' && width >= 160 && width <= 360) return Math.round(width);
  }
  return 232;
}

/** Render one ui-spec screen as a prototype-grade hi-fi SVG. */
export function renderUiSpecScreenSvg(spec: UiSpecDocument, screenIndex: number): string {
  const screen = spec.screens[screenIndex];
  if (!screen) throw new Error(`ui_spec_screen_out_of_range: ${screenIndex}`);
  const width = screen.viewport.width;
  const height = screen.viewport.height;
  const sbW = sidebarWidth(spec);
  const headerH = 64;
  const contentX = sbW + 32;
  const contentW = width - contentX - 32;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
    `<title id="title">${esc(clip(spec.page.name, 60))} · ${esc(clip(screen.name, 60))}</title>`,
    `<desc id="desc">Screen ${screenIndex + 1}/${spec.screens.length} rendered from the agent-attested ${UI_SPEC_RELATIVE_PATH}.</desc>`,
    rect(0, 0, width, height, 0, T.bg),
    // Sidebar
    rect(0, 0, sbW, height, 0, T.surface),
    `<line x1="${sbW}" y1="0" x2="${sbW}" y2="${height}" stroke="${T.border}"/>`,
    rect(20, 20, 32, 32, 9, T.primary),
    text(64, 42, clip(spec.page.name, 12), 16, 800, T.text),
  ];
  spec.screens.slice(0, 6).forEach((navScreen, navIndex) => {
    const ny = 92 + navIndex * 46;
    const active = navIndex === screenIndex;
    if (active) parts.push(rect(12, ny - 6, sbW - 24, 40, 10, T.primarySoft));
    parts.push(
      rect(28, ny + 6, 16, 16, 5, active ? T.primary : T.skeleton),
      text(56, ny + 19, clip(navScreen.name, Math.floor((sbW - 76) / 14)), 14, active ? 700 : 550, active ? T.primary : T.muted),
    );
  });
  // Header: single title + small muted breadcrumb — a real hierarchy.
  parts.push(
    rect(sbW, 0, width - sbW, headerH, 0, T.surface),
    `<line x1="${sbW}" y1="${headerH}" x2="${width}" y2="${headerH}" stroke="${T.border}"/>`,
    text(contentX, 27, `${clip(spec.page.name, 24)} / ${clip(screen.name, 24)}`, 12, 500, T.faint),
    text(contentX, 50, clip(screen.name, 42), 20, 800, T.text),
    rect(width - 264, 16, 168, 32, 16, T.bg, T.border),
    text(width - 246, 37, '搜索…', 13, 500, T.faint),
    `<circle cx="${width - 58}" cy="32" r="16" fill="${T.primarySoft}" stroke="${T.border}"/>`,
  );
  // Content blocks
  let cursorY = headerH + 28;
  for (const block of blocksForScreen(screen)) {
    if (cursorY + block.height > height - 36) break;
    parts.push(...block.body(contentX, cursorY, contentW));
    cursorY += block.height + 8;
  }
  // Honest provenance footer
  parts.push(text(contentX, height - 14, `${UI_SPEC_RELATIVE_PATH} · ${clip(spec.design.style, 24)} · screen ${screenIndex + 1}/${spec.screens.length}`, 11, 500, T.faint));
  parts.push('</svg>');
  return parts.join('\n');
}

/** Overview sheet: one mini card per screen with its component composition. */
export function renderUiSpecOverviewSvg(spec: UiSpecDocument): string {
  const width = 1440;
  const cols = 3;
  const cardW = 432;
  const cardH = 220;
  const rows = Math.ceil(Math.min(spec.screens.length, 9) / cols);
  const height = 140 + rows * (cardH + 24) + 40;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title">`,
    `<title id="title">${esc(clip(spec.page.name, 60))} · screen overview</title>`,
    rect(0, 0, width, height, 0, T.bg),
    text(64, 64, clip(spec.page.name, 40), 28, 800, T.text),
    text(64, 94, `${spec.screens.length} screens · ${clip(spec.design.style, 32)} · rendered from ${UI_SPEC_RELATIVE_PATH}`, 14, 500, T.muted),
  ];
  spec.screens.slice(0, 9).forEach((screen, index) => {
    const x = 64 + (index % cols) * (cardW + 24);
    const y = 128 + Math.floor(index / cols) * (cardH + 24);
    parts.push(
      rect(x, y, cardW, cardH, 16, T.surface, T.border),
      text(x + 24, y + 38, clip(screen.name, 26), 17, 750, T.text),
      text(x + cardW - 24, y + 38, `${screen.viewport.width}×${screen.viewport.height}`, 12, 600, T.faint, 'end'),
    );
    screen.components.slice(0, 6).forEach((component, chipIndex) => {
      const chipX = x + 24 + (chipIndex % 2) * 196;
      const chipY = y + 60 + Math.floor(chipIndex / 2) * 44;
      parts.push(
        rect(chipX, chipY, 180, 34, 9, T.primarySoft, T.border),
        text(chipX + 12, chipY + 22, clip(component.title ?? component.type, 14), 12, 650, T.primary),
      );
    });
  });
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Load the promoted (agent-attested) ui-spec for a run: only returns a
 * document when the run carries an agent_attested `ui_spec` artifact AND the
 * file on disk parses and validates. Anything else → null (caller falls back
 * to the honestly-labeled draft skeleton).
 */
export async function readPromotedUiSpecDocument(projectRoot: string, run: EvolutionRun): Promise<UiSpecDocument | null> {
  const artifact = run.artifacts.find((entry) => entry.kind === 'ui_spec' && entry.assurance === 'agent_attested');
  if (!artifact) return null;
  const runDir = resolve(projectRoot, '.imc/evolution', run.runId);
  const fullPath = resolve(runDir, artifact.path || UI_SPEC_RELATIVE_PATH);
  const rel = relative(runDir, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  try {
    const parsed = JSON.parse(await readFile(fullPath, 'utf8')) as unknown;
    const validated = validateUiSpecDocument(parsed);
    return validated.ok ? validated.value : null;
  } catch {
    return null;
  }
}

export const EVOLUTION_HIFI_DRAFT_PLACEHOLDER_LABEL = '草稿占位 · 非高保真';

/**
 * High-fidelity SVG rendering from the Design Maker's promoted ui-spec.json.
 *
 * This renderer is the no-browser fallback for governed Evolution runs. It must
 * therefore render a reviewable product screen — never a grey skeleton that is
 * mislabeled as high fidelity. Semantic props emitted by Design Maker
 * (`fields`, `columns`, `items`, `toolbar`, `mockRows`) are converted into
 * realistic controls and domain-shaped sample data. Desktop and mobile use
 * separate compositions so a narrow viewport is never a squeezed desktop app.
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
  bg: '#f3f6fb',
  surface: '#ffffff',
  surfaceRaised: '#fbfdff',
  border: '#dfe6ef',
  borderSoft: '#edf1f6',
  text: '#172033',
  muted: '#64748b',
  faint: '#94a3b8',
  primary: '#1677ff',
  primaryDark: '#075fce',
  primarySoft: '#eaf3ff',
  positive: '#16a166',
  positiveSoft: '#e9f8f1',
  warning: '#c8790a',
  warningSoft: '#fff6df',
  danger: '#d14343',
  dangerSoft: '#fff0f0',
  zebra: '#f8fafc',
  sidebar: '#121a2a',
  sidebarSoft: '#1d2a40',
  sidebarText: '#e8eef8',
  sidebarMuted: '#8fa0b8',
} as const;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(1, max - 1))}…` : normalized;
}

function text(
  x: number,
  y: number,
  value: string,
  size: number,
  weight: number,
  fill: string,
  anchor?: 'middle' | 'end',
  extra = '',
): string {
  return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}"${anchor ? ` text-anchor="${anchor}"` : ''} font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif"${extra}>${esc(value)}</text>`;
}

function rect(x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, extra = ''): string {
  return `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" rx="${r}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}${extra}/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${width}"/>`;
}

type IconName = 'brand' | 'users' | 'file' | 'wallet' | 'grid' | 'search' | 'bell' | 'filter' | 'more' | 'chevron' | 'plus' | 'shield';

const ICON_PATHS: Record<IconName, string> = {
  brand: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6',
  wallet: 'M4 5h14a2 2 0 0 1 2 2v12H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M16 11h6v5h-6a2.5 2.5 0 0 1 0-5z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  filter: 'M4 5h16M7 12h10M10 19h4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevron: 'M9 18l6-6-6-6',
  plus: 'M12 5v14M5 12h14',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
};

function icon(x: number, y: number, name: IconName, size = 18, color = 'currentColor', strokeWidth = 1.8): string {
  const scale = size / 24;
  return `<g data-icon="${name}" transform="translate(${x} ${y}) scale(${scale})"><path d="${ICON_PATHS[name]}" fill="none" stroke="${color}" stroke-width="${strokeWidth / scale}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

const AVATAR_COLORS = [
  ['#6d5dfc', '#b596ff'],
  ['#0f8fbd', '#69d5e7'],
  ['#e05f78', '#f6a1b0'],
  ['#2f7f61', '#76cba6'],
] as const;
const SAMPLE_NAMES = ['林晓夏', '周远山', '沈知行', '许言'];

function avatarDataUri(index: number): string {
  const name = SAMPLE_NAMES[index % SAMPLE_NAMES.length]!;
  const [from, to] = AVATAR_COLORS[index % AVATAR_COLORS.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><circle cx="36" cy="36" r="36" fill="url(#g)"/><circle cx="54" cy="16" r="10" fill="#fff" fill-opacity=".16"/><text x="36" y="45" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="28" font-weight="700" fill="#fff">${name[0]}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function avatarImage(x: number, y: number, size: number, index: number): string {
  return `<image href="${avatarDataUri(index)}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice"/>`;
}

function stringArrayProp(component: UiSpecComponent, key: string): string[] {
  const value = component.props?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function stringProp(component: UiSpecComponent, key: string): string | null {
  const value = component.props?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

type MockRow = Record<string, unknown>;

function mockRowsProp(component: UiSpecComponent): MockRow[] {
  const value = component.props?.mockRows;
  return Array.isArray(value)
    ? value.filter((entry): entry is MockRow => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function mockRowValue(rows: MockRow[], label: string, row: number): string | null {
  if (rows.length === 0) return null;
  const entry = rows[row % rows.length]!;
  const normalizedLabel = label.replace(/\s+/g, '').toLowerCase();
  const key = Object.keys(entry).find((candidate) => candidate.replace(/\s+/g, '').toLowerCase() === normalizedLabel);
  if (!key) return null;
  const value = entry[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

function shortScreenLabel(name: string, index: number): string {
  const withoutViewport = name.replace(/\s*[·|｜/-]\s*\d{3,4}px.*$/i, '').trim();
  const base = withoutViewport.split(/\s*[·|｜]\s*/)[0]?.trim() || withoutViewport;
  if (index > 0 && /窄屏|移动|mobile/i.test(name)) return '移动端';
  return clip(base, 8);
}

function displayScreenTitle(name: string): string {
  return name.replace(/\s*[·|｜/-]\s*\d{3,4}px.*$/i, '').trim();
}

function mockValue(label: string, row: number): string {
  const normalized = label.replace(/\s+/g, '');
  if (/申请单号/.test(normalized)) return ['AP-20260724-018', 'AP-20260723-011', 'AP-20260722-006'][row % 3]!;
  if (/流水号/.test(normalized)) return ['RV-20260724-1092', 'RV-20260724-1088', 'RV-20260723-1033'][row % 3]!;
  if (/订单号/.test(normalized)) return ['OD-240724-8841', 'OD-240724-8796', 'OD-240723-8652'][row % 3]!;
  if (/行政区|区域/.test(normalized)) return ['浙江省 · 杭州市', '浙江省 · 宁波市', '上海市 · 浦东新区'][row % 3]!;
  if (/业务账号/.test(normalized)) return ['taojin-ops-01', 'taojin-agent-07', 'taojin-fin-03'][row % 3]!;
  if (/账号信息|申请人|收益人|姓名|用户/.test(normalized)) return SAMPLE_NAMES[row % SAMPLE_NAMES.length]!;
  if (/后台身份|申请身份|收益身份|身份/.test(normalized)) return ['官方代理', '区域代理', '普通用户'][row % 3]!;
  if (/前台版本|版本/.test(normalized)) return ['SVIP', 'VIP', '体验版'][row % 3]!;
  if (/有效期|日期/.test(normalized)) return ['2027-07-23', '2027-01-18', '2026-08-21'][row % 3]!;
  if (/发生时间|申请时间|确认时间|时间/.test(normalized)) return ['07-24 11:32', '07-24 10:11', '07-23 19:48'][row % 3]!;
  if (/收益类型/.test(normalized)) return ['账号开通收益', '代理采购收益', '资格续费收益'][row % 3]!;
  if (/购买内容|购买类型/.test(normalized)) return ['官方代理名额', 'VIP 资格', '账号续期包'][row % 3]!;
  if (/金额|单价|收益/.test(normalized)) return ['¥12,480.00', '¥7,980.00', '¥4,995.00'][row % 3]!;
  if (/比例/.test(normalized)) return ['40%', '10%', '8%'][row % 3]!;
  if (/状态/.test(normalized)) return ['正常', '待审核', '已结算'][row % 3]!;
  if (/类型/.test(normalized)) return ['官方代理名额', 'VIP 资格', '账号开通收益'][row % 3]!;
  if (/数量/.test(normalized)) return ['10', '20', '5'][row % 3]!;
  if (/操作/.test(normalized)) return row === 1 ? '查看' : '查看 · 更多';
  if (/说明|备注/.test(normalized)) return ['配置 rev.18', '付款证据已核对', '批次 ST-0724-01'][row % 3]!;
  return ['已核验', '自动同步', '业务可用'][row % 3]!;
}

function statusPill(x: number, y: number, value: string): string[] {
  const warning = /待|冻结|审核/.test(value);
  const positive = /正常|已|通过|启用/.test(value);
  const fill = warning ? T.warningSoft : positive ? T.positiveSoft : T.primarySoft;
  const color = warning ? T.warning : positive ? T.positive : T.primaryDark;
  return [rect(x, y, 58, 24, 12, fill), text(x + 29, y + 17, clip(value, 5), 11, 700, color, 'middle')];
}

type ComponentKind = 'context' | 'stat' | 'table' | 'line-chart' | 'bar-chart' | 'form' | 'button' | 'list' | 'tabs' | 'panel';

function classifyComponent(component: UiSpecComponent): ComponentKind {
  const type = component.type.toLowerCase();
  if (/identity.*context|context.*bar|compact.*header/.test(type)) return 'context';
  if (/filter|form|input|search|select|field/.test(type)) return 'form';
  if (/stat|kpi|metric|number-card/.test(type)) return 'stat';
  if (/table|grid|data-list/.test(type)) return 'table';
  if (/bar/.test(type)) return 'bar-chart';
  if (/chart|line|trend|graph|spark/.test(type)) return 'line-chart';
  if (/button|action|cta/.test(type)) return 'button';
  if (/list|feed|timeline/.test(type)) return 'list';
  if (/tab/.test(type)) return 'tabs';
  return 'panel';
}

interface Block { height: number; body: (x: number, y: number, w: number) => string[] }

function contextBlock(component: UiSpecComponent, mobile: boolean): Block {
  const identity = stringProp(component, 'value') ?? stringProp(component, 'identity') ?? '超级管理员';
  const source = stringProp(component, 'source') ?? '新接口';
  const hint = stringProp(component, 'hint') ?? '数据范围和操作权限将随当前身份同步更新';
  return {
    height: mobile ? 82 : 74,
    body: (x, y, w) => mobile
      ? [
          rect(x, y, w, 70, 14, T.surface, T.border),
          icon(x + 16, y + 16, 'shield', 18, T.primary),
          text(x + 44, y + 29, `当前身份 · ${clip(identity, 8)}`, 14, 750, T.text),
          rect(x + 44, y + 38, 58, 22, 11, T.positiveSoft),
          text(x + 73, y + 53, clip(source, 5), 10, 700, T.positive, 'middle'),
          icon(x + w - 34, y + 24, 'chevron', 16, T.muted),
        ]
      : [
          rect(x, y, w, 62, 12, T.surface, T.border),
          icon(x + 18, y + 20, 'shield', 20, T.primary),
          text(x + 50, y + 27, '当前身份', 12, 600, T.muted),
          text(x + 50, y + 47, identity, 15, 750, T.text),
          rect(x + 174, y + 18, 64, 26, 13, T.positiveSoft),
          text(x + 206, y + 36, clip(source, 5), 11, 700, T.positive, 'middle'),
          text(x + 260, y + 37, clip(hint, Math.max(18, Math.floor((w - 320) / 13))), 12, 500, T.muted),
          icon(x + w - 34, y + 23, 'chevron', 16, T.muted),
        ],
  };
}

function expandedStats(stats: UiSpecComponent[]): Array<{ title: string; value?: string }> {
  const result: Array<{ title: string; value?: string }> = [];
  for (const component of stats) {
    const items = stringArrayProp(component, 'items');
    if (items.length > 0) {
      for (const item of items) result.push({ title: item });
    } else {
      result.push({ title: component.title ?? component.type, value: stringProp(component, 'value') ?? undefined });
    }
  }
  return result.slice(0, 4);
}

function statRowBlock(stats: UiSpecComponent[], mobile: boolean): Block {
  const cards = expandedStats(stats);
  return {
    height: mobile ? 190 : 116,
    body: (x, y, w) => {
      const cols = mobile ? 2 : Math.max(1, cards.length);
      const gap = mobile ? 10 : 14;
      const cardH = mobile ? 82 : 104;
      const cardW = Math.floor((w - gap * (cols - 1)) / cols);
      const values = ['¥286,420.50', '¥128,900.00', '¥214,700.50', '¥71,720.00'];
      return cards.flatMap((card, index) => {
        const cx = x + (index % cols) * (cardW + gap);
        const cy = y + Math.floor(index / cols) * (cardH + gap);
        return [
          rect(cx, cy, cardW, cardH, 14, T.surface, T.border),
          rect(cx + 16, cy + 15, 30, 30, 10, index === 3 ? T.warningSoft : T.primarySoft),
          icon(cx + 22, cy + 21, index === 3 ? 'wallet' : 'grid', 18, index === 3 ? T.warning : T.primary),
          text(cx + 56, cy + 29, clip(card.title, Math.floor((cardW - 70) / 12)), 12, 650, T.muted),
          text(cx + 16, cy + (mobile ? 69 : 78), card.value ?? values[index]!, mobile ? 18 : 24, 780, T.text),
        ];
      });
    },
  };
}

function tableColumns(component: UiSpecComponent): string[] {
  const childColumns = (component.children ?? []).map((column) => column.title ?? column.type).filter(Boolean);
  const propColumns = stringArrayProp(component, 'columns');
  const visibleLeadingColumns = stringArrayProp(component, 'visibleLeadingColumns');
  // Grid children often describe row actions or drawers. The explicit semantic
  // column contract is authoritative whenever Design Maker supplied one.
  const labels = propColumns.length > 0 ? propColumns : visibleLeadingColumns.length > 0 ? visibleLeadingColumns : childColumns;
  if (labels.length === 0) return ['账号信息', '后台身份', '金额', '状态', '操作'];
  if (labels.length <= 7) return labels;
  return [...labels.slice(0, 5), labels[labels.length - 1]!];
}

function isAvatarColumn(label: string): boolean {
  return !/行政区|区域/.test(label) && /账号信息|业务账号|用户|申请人|收益人|姓名/.test(label);
}

function tableBlock(component: UiSpecComponent, mobile: boolean): Block {
  const labels = tableColumns(component);
  const toolbar = stringArrayProp(component, 'toolbar')[0] ?? '新增记录';
  const mockRows = mockRowsProp(component);
  if (mobile) {
    const primary = labels[0] ?? '账号信息';
    const secondary = labels.find((label) => /身份|状态|版本/.test(label)) ?? labels[1] ?? '状态';
    return {
      height: 456,
      body: (x, y, w) => {
        const parts = [
          rect(x, y, w, 444, 14, T.surface, T.border),
          text(x + 16, y + 31, clip(component.title ?? '账号列表', 12), 16, 760, T.text),
          rect(x + w - 94, y + 12, 78, 32, 9, T.primary),
          icon(x + w - 82, y + 20, 'plus', 16, '#ffffff'),
          text(x + w - 56, y + 33, clip(toolbar, 4), 12, 700, '#ffffff', 'middle'),
          rect(x + 12, y + 56, w - 24, 38, 8, '#f4f7fb'),
          text(x + 24, y + 80, clip(primary, 8), 12, 700, T.muted),
          text(x + w - 116, y + 80, clip(secondary, 5), 12, 700, T.muted, 'middle'),
          text(x + w - 34, y + 80, '操作', 12, 700, T.muted, 'middle'),
        ];
        for (let row = 0; row < 4; row += 1) {
          const ry = y + 102 + row * 72;
          const primaryValue = mockRowValue(mockRows, primary, row) ?? mockValue(primary, row);
          const secondaryValue = mockRowValue(mockRows, secondary, row) ?? mockValue(secondary, row);
          if (row > 0) parts.push(line(x + 16, ry, x + w - 16, ry, T.borderSoft));
          parts.push(
            avatarImage(x + 20, ry + 14, 38, row),
            text(x + 68, ry + 31, clip(primaryValue, 16), 13, 720, T.text),
            text(x + 68, ry + 49, `taojin0${row + 1} · 138****22${row}1`, 10, 500, T.faint),
            ...statusPill(x + w - 146, ry + 23, secondaryValue),
            icon(x + w - 43, ry + 20, 'more', 18, T.primary),
            text(x + w - 34, ry + 48, '更多', 9, 650, T.primary, 'middle'),
          );
        }
        parts.push(
          text(x + 16, y + 420, '共 128 条 · 受控样例数据', 11, 500, T.faint),
          rect(x + w - 74, y + 408, 24, 24, 7, T.primary),
          text(x + w - 62, y + 425, '01', 10, 700, '#ffffff', 'middle'),
          rect(x + w - 42, y + 408, 24, 24, 7, T.surface, T.border),
          text(x + w - 30, y + 425, '02', 10, 600, T.muted, 'middle'),
        );
        return parts;
      },
    };
  }

  return {
    height: 352,
    body: (x, y, w) => {
      const parts = [
        rect(x, y, w, 340, 14, T.surface, T.border),
        text(x + 20, y + 36, clip(component.title ?? '业务数据', 32), 16, 760, T.text),
        text(x + 20, y + 57, '最新同步 11:32 · 共 128 条', 11, 500, T.faint),
        rect(x + w - 152, y + 16, 132, 34, 9, T.primary),
        icon(x + w - 138, y + 24, 'plus', 17, '#ffffff'),
        text(x + w - 78, y + 38, clip(toolbar, 9), 12, 700, '#ffffff', 'middle'),
        rect(x + 14, y + 72, w - 28, 40, 8, '#f2f6fb'),
      ];
      const colW = Math.floor((w - 52) / labels.length);
      labels.forEach((label, index) => {
        const tx = x + 26 + index * colW;
        parts.push(text(tx, y + 98, clip(label, Math.max(4, Math.floor((colW - 8) / 13))), 11, 700, T.muted));
      });
      for (let row = 0; row < 3; row += 1) {
        const ry = y + 116 + row * 58;
        if (row % 2 === 1) parts.push(rect(x + 14, ry, w - 28, 56, 8, T.zebra));
        labels.forEach((label, index) => {
          const tx = x + 26 + index * colW;
          const value = mockRowValue(mockRows, label, row) ?? mockValue(label, row);
          if (isAvatarColumn(label)) {
            parts.push(
              avatarImage(tx, ry + 10, 34, row),
              text(tx + 44, ry + 29, clip(value, Math.max(4, Math.floor((colW - 50) / 8))), 12, 700, T.text),
              text(tx + 44, ry + 44, `taojin0${row + 1}`, 9, 500, T.faint),
            );
          } else if (/状态/.test(label)) {
            parts.push(...statusPill(tx, ry + 17, value));
          } else if (/操作/.test(label)) {
            parts.push(text(tx, ry + 34, clip(value, Math.max(4, Math.floor(colW / 12))), 11, 700, T.primary));
          } else {
            parts.push(text(tx, ry + 34, clip(value, Math.max(4, Math.floor((colW - 8) / 11))), 11, /金额|收益/.test(label) ? 700 : 550, /金额|收益/.test(label) ? T.text : T.muted));
          }
        });
      }
      parts.push(
        line(x + 18, y + 296, x + w - 18, y + 296, T.borderSoft),
        text(x + 20, y + 323, '受控样例数据 · 非实时账本', 10, 500, T.faint),
        rect(x + w - 86, y + 306, 24, 24, 7, T.primary),
        text(x + w - 74, y + 323, '01', 10, 700, '#ffffff', 'middle'),
        rect(x + w - 54, y + 306, 24, 24, 7, T.surface, T.border),
        text(x + w - 42, y + 323, '02', 10, 600, T.muted, 'middle'),
      );
      return parts;
    },
  };
}

function lineChartBlock(component: UiSpecComponent): Block {
  return {
    height: 252,
    body: (x, y, w) => {
      const chartX = x + 24;
      const chartY = y + 62;
      const chartW = w - 48;
      const chartH = 144;
      const values = [0.76, 0.62, 0.66, 0.48, 0.54, 0.34, 0.39, 0.2];
      const points = values.map((v, i) => `${chartX + Math.round((chartW / 7) * i)},${chartY + Math.round(chartH * v)}`);
      return [
        rect(x, y, w, 240, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '近 30 天趋势', 32), 16, 760, T.text),
        text(x + w - 20, y + 34, '最近 30 天', 11, 600, T.muted, 'end'),
        ...[0.25, 0.5, 0.75].map((g) => line(chartX, chartY + chartH * g, chartX + chartW, chartY + chartH * g, T.borderSoft)),
        `<polyline points="${points.join(' ')} ${chartX + chartW},${chartY + chartH} ${chartX},${chartY + chartH}" fill="${T.primary}" fill-opacity="0.08" stroke="none"/>`,
        `<polyline points="${points.join(' ')}" fill="none" stroke="${T.primary}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`,
        ...points.map((point, index) => {
          if (index % 2 === 0) return '';
          const [px, py] = point.split(',');
          return `<circle cx="${px}" cy="${py}" r="4" fill="${T.surface}" stroke="${T.primary}" stroke-width="2"/>`;
        }),
        line(chartX, chartY + chartH, chartX + chartW, chartY + chartH, T.border, 1.5),
      ];
    },
  };
}

function barChartBlock(component: UiSpecComponent): Block {
  return {
    height: 252,
    body: (x, y, w) => {
      const baseY = y + 206;
      const bars = [0.9, 0.6, 0.75, 0.45, 0.66, 0.3, 0.52];
      const barW = Math.max(18, Math.floor((w - 120) / bars.length) - 18);
      return [
        rect(x, y, w, 240, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '业务分布', 32), 16, 760, T.text),
        ...bars.map((value, index) => rect(x + 42 + index * (barW + 18), baseY - Math.round(132 * value), barW, Math.round(132 * value), 7, index === 2 ? T.primary : T.primarySoft)),
        line(x + 24, baseY, x + w - 24, baseY, T.border, 1.5),
      ];
    },
  };
}

function formBlock(component: UiSpecComponent, mobile: boolean): Block {
  const childFields = (component.children ?? []).map((field) => field.title ?? field.type).filter(Boolean);
  const propFields = stringArrayProp(component, 'fields');
  const labels = (childFields.length > 0 ? childFields : propFields).slice(0, mobile ? 2 : 4);
  const fields = labels.length > 0 ? labels : ['关键词', '状态'];
  if (mobile) {
    return {
      height: 82,
      body: (x, y, w) => [
        rect(x, y, w, 70, 14, T.surface, T.border),
        rect(x + 12, y + 14, w - 72, 42, 10, T.bg, T.border),
        icon(x + 26, y + 26, 'search', 17, T.faint),
        text(x + 52, y + 40, clip(fields.join(' / '), 18), 12, 500, T.faint),
        rect(x + w - 50, y + 14, 38, 42, 10, T.primarySoft),
        icon(x + w - 39, y + 26, 'filter', 17, T.primary),
      ],
    };
  }
  return {
    height: 124,
    body: (x, y, w) => {
      const gap = 12;
      const actionW = 108;
      const fieldW = Math.floor((w - 40 - actionW - gap * fields.length) / fields.length);
      const parts = [
        rect(x, y, w, 112, 14, T.surface, T.border),
        text(x + 18, y + 27, component.title ?? '筛选条件', 13, 720, T.text),
      ];
      fields.forEach((label, index) => {
        const fx = x + 18 + index * (fieldW + gap);
        parts.push(
          text(fx, y + 51, clip(label, Math.max(5, Math.floor(fieldW / 12))), 10, 600, T.muted),
          rect(fx, y + 60, fieldW, 36, 8, T.surfaceRaised, T.border),
          text(fx + 11, y + 83, /关键词|账号/.test(label) ? '请输入关键词' : '全部', 11, 500, T.faint),
          icon(fx + fieldW - 24, y + 70, /关键词|账号/.test(label) ? 'search' : 'chevron', 14, T.faint),
        );
      });
      const btnX = x + w - actionW - 18;
      parts.push(
        rect(btnX, y + 60, actionW, 36, 9, T.primary),
        icon(btnX + 16, y + 70, 'filter', 15, '#ffffff'),
        text(btnX + 67, y + 83, '查询', 12, 700, '#ffffff', 'middle'),
      );
      return parts;
    },
  };
}

function buttonBlock(component: UiSpecComponent): Block {
  return {
    height: 58,
    body: (x, y) => [
      rect(x, y, 168, 42, 10, T.primary),
      icon(x + 18, y + 12, 'plus', 17, '#ffffff'),
      text(x + 96, y + 27, clip(component.title ?? '主要操作', 10), 13, 700, '#ffffff', 'middle'),
      rect(x + 180, y, 124, 42, 10, T.surface, T.border),
      text(x + 242, y + 27, '导出数据', 12, 650, T.muted, 'middle'),
    ],
  };
}

function listBlock(component: UiSpecComponent): Block {
  return {
    height: 238,
    body: (x, y, w) => {
      const parts = [
        rect(x, y, w, 226, 14, T.surface, T.border),
        text(x + 20, y + 34, clip(component.title ?? '最近记录', 32), 16, 760, T.text),
      ];
      for (let row = 0; row < 3; row += 1) {
        const ry = y + 54 + row * 54;
        if (row > 0) parts.push(line(x + 20, ry, x + w - 20, ry, T.borderSoft));
        parts.push(
          avatarImage(x + 20, ry + 10, 34, row),
          text(x + 66, ry + 28, `${SAMPLE_NAMES[row]} 提交了数据导出`, 12, 650, T.text),
          text(x + 66, ry + 44, `${row + 1} 分钟前 · CSV`, 10, 500, T.faint),
          ...statusPill(x + w - 88, ry + 16, row === 1 ? '处理中' : '已完成'),
        );
      }
      return parts;
    },
  };
}

function tabsBlock(component: UiSpecComponent): Block {
  const tabs = (component.children ?? []).map((tab) => tab.title ?? tab.type).filter(Boolean).slice(0, 5);
  const labels = tabs.length > 0 ? tabs : ['概览', '明细', '设置'];
  return {
    height: 52,
    body: (x, y) => labels.flatMap((label, index) => {
      const tx = x + index * 112;
      return [
        ...(index === 0 ? [rect(tx, y + 38, 84, 3, 1.5, T.primary)] : []),
        text(tx + 4, y + 28, clip(label, 7), 13, index === 0 ? 720 : 550, index === 0 ? T.primary : T.muted),
      ];
    }),
  };
}

function panelBlock(component: UiSpecComponent): Block {
  const labels = Object.entries(component.props ?? {})
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${String(value)}`);
  const rows = labels.length > 0 ? labels : ['数据已连接', '权限已校验', '状态自动同步'];
  return {
    height: 158,
    body: (x, y, w) => [
      rect(x, y, w, 146, 14, T.surface, T.border),
      rect(x + 18, y + 18, 34, 34, 10, T.primarySoft),
      icon(x + 26, y + 26, 'grid', 18, T.primary),
      text(x + 64, y + 39, clip(component.title ?? component.type, 36), 15, 750, T.text),
      ...rows.map((label, index) => [
        `<circle cx="${x + 28}" cy="${y + 76 + index * 22}" r="3" fill="${index === 0 ? T.primary : T.positive}"/>`,
        text(x + 40, y + 80 + index * 22, clip(label, Math.max(18, Math.floor((w - 60) / 12))), 11, 550, T.muted),
      ]).flat(),
    ],
  };
}

function blocksForScreen(screen: UiSpecScreen, mobile: boolean): Block[] {
  const blocks: Block[] = [];
  let statBuffer: UiSpecComponent[] = [];
  const flushStats = () => {
    if (statBuffer.length > 0) {
      blocks.push(statRowBlock(statBuffer, mobile));
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
      kind === 'context' ? contextBlock(component, mobile)
        : kind === 'table' ? tableBlock(component, mobile)
          : kind === 'line-chart' ? lineChartBlock(component)
            : kind === 'bar-chart' ? barChartBlock(component)
              : kind === 'form' ? formBlock(component, mobile)
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
    if (typeof width === 'number' && width >= 184 && width <= 280) return Math.round(width);
  }
  return 224;
}

function svgRoot(spec: UiSpecDocument, screen: UiSpecScreen, screenIndex: number, layout: 'desktop' | 'mobile'): string[] {
  const { width, height } = screen.viewport;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc" data-layout="${layout}" data-render-quality="reviewable-hifi">`,
    `<title id="title">${esc(clip(spec.page.name, 60))} · ${esc(clip(displayScreenTitle(screen.name), 60))}</title>`,
    `<desc id="desc">Screen ${screenIndex + 1}/${spec.screens.length} rendered from agent-attested ${UI_SPEC_RELATIVE_PATH} with semantic mock data, inline icons, and responsive layout.</desc>`,
    rect(0, 0, width, height, 0, T.bg),
  ];
}

function renderDesktopScreen(spec: UiSpecDocument, screen: UiSpecScreen, screenIndex: number): string {
  const width = screen.viewport.width;
  const height = screen.viewport.height;
  const sbW = sidebarWidth(spec);
  const contentX = sbW + 28;
  const contentW = width - contentX - 28;
  const parts = svgRoot(spec, screen, screenIndex, 'desktop');

  parts.push(
    rect(0, 0, sbW, height, 0, T.sidebar),
    rect(18, 18, 36, 36, 11, T.primary),
    icon(27, 27, 'brand', 18, '#ffffff', 1.7),
    text(66, 42, clip(spec.page.name, 11), 15, 780, T.sidebarText),
    text(20, 82, '业务工作台', 10, 650, T.sidebarMuted, undefined, ' letter-spacing="1.4"'),
  );
  const navIcons: IconName[] = ['users', 'file', 'wallet', 'grid', 'shield', 'grid'];
  spec.screens.slice(0, 6).forEach((navScreen, navIndex) => {
    const ny = 100 + navIndex * 48;
    const active = navIndex === screenIndex;
    if (active) parts.push(rect(12, ny - 7, sbW - 24, 42, 9, T.sidebarSoft), rect(12, ny + 1, 3, 26, 1.5, T.primary));
    parts.push(
      icon(28, ny + 4, navIcons[navIndex]!, 18, active ? '#79b7ff' : T.sidebarMuted),
      text(58, ny + 19, shortScreenLabel(navScreen.name, navIndex), 13, active ? 700 : 540, active ? T.sidebarText : T.sidebarMuted),
    );
  });
  parts.push(
    text(20, height - 66, 'DESIGN PREVIEW', 9, 700, T.sidebarMuted, undefined, ' letter-spacing="1.2"'),
    text(20, height - 44, '受控样例数据 · 非实时账本', 10, 500, T.sidebarMuted),
    rect(sbW, 0, width - sbW, 64, 0, T.surface),
    line(sbW, 64, width, 64, T.border),
    text(contentX, 26, `${clip(spec.page.name, 18)} / ${shortScreenLabel(screen.name, screenIndex)}`, 11, 520, T.faint),
    text(contentX, 49, displayScreenTitle(screen.name), 19, 780, T.text),
    rect(width - 298, 16, 174, 34, 17, T.bg, T.border),
    icon(width - 280, 25, 'search', 16, T.faint),
    text(width - 252, 38, '搜索账号或单号', 11, 500, T.faint),
    rect(width - 108, 16, 34, 34, 10, T.surfaceRaised, T.border),
    icon(width - 99, 25, 'bell', 16, T.muted),
    avatarImage(width - 58, 15, 36, screenIndex),
  );

  let cursorY = 86;
  for (const block of blocksForScreen(screen, false)) {
    if (cursorY + block.height > height - 30) break;
    parts.push(...block.body(contentX, cursorY, contentW));
    cursorY += block.height + 8;
  }
  parts.push(text(contentX, height - 12, `${UI_SPEC_RELATIVE_PATH} · ${clip(spec.design.style, 30)} · screen ${screenIndex + 1}/${spec.screens.length}`, 9, 500, T.faint));
  parts.push('</svg>');
  return parts.join('\n');
}

function renderMobileScreen(spec: UiSpecDocument, screen: UiSpecScreen, screenIndex: number): string {
  const width = screen.viewport.width;
  const height = screen.viewport.height;
  const x = 16;
  const contentW = width - 32;
  const parts = svgRoot(spec, screen, screenIndex, 'mobile');
  parts.push(
    rect(0, 0, width, 62, 0, T.surface),
    line(0, 62, width, 62, T.border),
    rect(14, 14, 34, 34, 10, T.primary),
    icon(22, 22, 'brand', 18, '#ffffff'),
    text(58, 37, clip(spec.page.name, 9), 14, 760, T.text),
    icon(width - 94, 22, 'search', 18, T.muted),
    icon(width - 62, 22, 'bell', 18, T.muted),
    avatarImage(width - 34, 17, 30, screenIndex),
    text(x, 92, displayScreenTitle(screen.name), 19, 760, T.text),
    rect(width - 90, 72, 74, 28, 14, T.primarySoft),
    text(width - 53, 91, '样例数据', 10, 700, T.primaryDark, 'middle'),
  );

  let cursorY = 112;
  for (const block of blocksForScreen(screen, true)) {
    if (cursorY + block.height > height - 76) break;
    parts.push(...block.body(x, cursorY, contentW));
    cursorY += block.height + 8;
  }

  const navY = height - 62;
  parts.push(rect(0, navY, width, 62, 0, T.surface), line(0, navY, width, navY, T.border));
  const visibleScreens = spec.screens.slice(0, 4);
  const itemW = width / visibleScreens.length;
  const navIcons: IconName[] = ['users', 'file', 'wallet', 'grid'];
  visibleScreens.forEach((navScreen, navIndex) => {
    const cx = itemW * navIndex + itemW / 2;
    const active = navIndex === screenIndex;
    parts.push(
      icon(cx - 9, navY + 10, navIcons[navIndex]!, 18, active ? T.primary : T.faint),
      text(cx, navY + 48, shortScreenLabel(navScreen.name, navIndex), 10, active ? 700 : 520, active ? T.primary : T.muted, 'middle'),
    );
  });
  parts.push('</svg>');
  return parts.join('\n');
}

/** Render one ui-spec screen as a reviewable high-fidelity SVG. */
export function renderUiSpecScreenSvg(spec: UiSpecDocument, screenIndex: number): string {
  const screen = spec.screens[screenIndex];
  if (!screen) throw new Error(`ui_spec_screen_out_of_range: ${screenIndex}`);
  return screen.viewport.width < 720
    ? renderMobileScreen(spec, screen, screenIndex)
    : renderDesktopScreen(spec, screen, screenIndex);
}

/** Overview sheet: one polished card per screen with component composition. */
export function renderUiSpecOverviewSvg(spec: UiSpecDocument): string {
  const width = 1440;
  const cols = 3;
  const cardW = 432;
  const cardH = 220;
  const rows = Math.ceil(Math.min(spec.screens.length, 9) / cols);
  const height = 140 + rows * (cardH + 24) + 40;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title" data-render-quality="reviewable-hifi">`,
    `<title id="title">${esc(clip(spec.page.name, 60))} · screen overview</title>`,
    rect(0, 0, width, height, 0, T.bg),
    rect(48, 36, 44, 44, 13, T.primary),
    icon(59, 47, 'brand', 22, '#ffffff'),
    text(108, 64, clip(spec.page.name, 40), 26, 800, T.text),
    text(108, 88, `${spec.screens.length} screens · semantic mock data · inline SVG icons`, 12, 520, T.muted),
  ];
  spec.screens.slice(0, 9).forEach((screen, index) => {
    const x = 48 + (index % cols) * (cardW + 24);
    const y = 120 + Math.floor(index / cols) * (cardH + 24);
    parts.push(
      rect(x, y, cardW, cardH, 16, T.surface, T.border),
      rect(x + 20, y + 20, 36, 36, 11, T.primarySoft),
      icon(x + 29, y + 29, index % 2 === 0 ? 'grid' : 'file', 18, T.primary),
      text(x + 68, y + 44, clip(displayScreenTitle(screen.name), 24), 15, 760, T.text),
      text(x + cardW - 20, y + 42, `${screen.viewport.width}×${screen.viewport.height}`, 10, 600, T.faint, 'end'),
    );
    screen.components.slice(0, 6).forEach((component, chipIndex) => {
      const chipX = x + 20 + (chipIndex % 2) * 196;
      const chipY = y + 70 + Math.floor(chipIndex / 2) * 42;
      parts.push(
        rect(chipX, chipY, 180, 32, 9, T.surfaceRaised, T.border),
        icon(chipX + 10, chipY + 8, 'grid', 15, T.primary),
        text(chipX + 34, chipY + 21, clip(component.title ?? component.type, 13), 11, 650, T.muted),
      );
    });
    parts.push(avatarImage(x + cardW - 64, y + cardH - 52, 32, index));
  });
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * Load the promoted (agent-attested) ui-spec for a run: only returns a
 * document when the run carries an agent_attested `ui_spec` artifact AND the
 * file on disk parses and validates. Anything else → null (caller falls back
 * to the honestly-labeled draft placeholder).
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

/**
 * `imcodes evolution-selftest` — scaffold a real governed self-test for the
 * Evolution pipeline in a target project.
 *
 * Writes (never overwriting existing files):
 * - `.imc/evolution/policy.json`   — governed + strict + hifi human approval
 * - `.imc/evolution/design.json`   — screenshot runner wired to
 *   `scripts/evolution-screenshot.mjs` (Playwright, opt-in install)
 * - `.imcodes/inbox/requirements/selftest-order-dashboard.md` — a substantive
 *   sample requirement the inbox watcher can pick up
 *
 * Then prints the runbook for a full real-agent governed run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  EVOLUTION_PROJECT_POLICY_RELATIVE_PATH,
  EVOLUTION_PROJECT_POLICY_VERSION,
  EVOLUTION_REQUIREMENT_INBOX_DIR,
} from '../../shared/evolution-pipeline-constants.js';
import type { EvolutionProjectPolicy } from '../../shared/evolution-pipeline-types.js';

export const EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH = '.imc/evolution/design.json';
export const EVOLUTION_SELFTEST_REQUIREMENT_RELATIVE_PATH = `${EVOLUTION_REQUIREMENT_INBOX_DIR}/selftest-order-dashboard.md`;

export interface EvolutionSelftestFileResult {
  relativePath: string;
  status: 'created' | 'skipped_exists';
}

export interface EvolutionSelftestSetupResult {
  files: EvolutionSelftestFileResult[];
  runbook: string[];
}

const SELFTEST_POLICY: EvolutionProjectPolicy = {
  version: EVOLUTION_PROJECT_POLICY_VERSION,
  executionPolicy: 'governed',
  roundtableGateMode: 'strict',
  autoStartImplementation: true,
  requireHifiHumanApproval: true,
};

const SELFTEST_DESIGN_CONFIG = {
  screenshot: {
    enabled: true,
    command: 'node',
    args: [
      'scripts/evolution-screenshot.mjs',
      '{previewPath}',
      '{outputPath}',
      '{width}',
      '{height}',
      '{screenAnchor}',
    ],
    timeoutMs: 60_000,
  },
} as const;

const SELFTEST_REQUIREMENT = `# 订单运营仪表盘（Evolution 自测需求）

## 背景
运营团队目前用表格手工汇总订单与 GMV，耗时且易错。需要一个订单运营仪表盘
作为 Evolution pipeline 的端到端自测载体。

## 功能需求
- 订单列表：分页展示订单号、金额、状态、下单时间；支持按状态筛选。
- GMV 统计卡：今日 GMV、订单数、客单价，与列表数据同源。
- 趋势图：近 30 天 GMV 折线图。
- CSV 导出：导出当前筛选条件下的全部订单行。

## 验收标准
- 首屏加载 < 2s；筛选结果与后端一致；GMV 统计与聚合接口误差为 0。
- CSV 编码 UTF-8 带 BOM，包含当前筛选条件下的全部行。

## 自测观察点（给操作者）
- product-maker 圆桌应先于 product-review 启动，PRD 需真实晋升（agent_attested）。
- design-maker 需产出 ui-spec.json + preview.html 才能 PASS。
- 截图链路：design/screenshots/ 下应出现 PNG（需先安装 playwright）。
- 高保真门禁必须人工批准；空口 PASS 应被降级 REWORK 并硬阻塞。
`;

async function writeIfAbsent(projectRoot: string, relativePath: string, content: string): Promise<EvolutionSelftestFileResult> {
  const fullPath = join(projectRoot, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  try {
    await writeFile(fullPath, content, { encoding: 'utf8', flag: 'wx' });
    return { relativePath, status: 'created' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { relativePath, status: 'skipped_exists' };
    }
    throw error;
  }
}

export async function runEvolutionSelftestSetup(projectRootInput: string): Promise<EvolutionSelftestSetupResult> {
  const projectRoot = resolve(projectRootInput);
  const files: EvolutionSelftestFileResult[] = [
    await writeIfAbsent(projectRoot, EVOLUTION_PROJECT_POLICY_RELATIVE_PATH, `${JSON.stringify(SELFTEST_POLICY, null, 2)}\n`),
    await writeIfAbsent(projectRoot, EVOLUTION_DESIGN_CONFIG_RELATIVE_PATH, `${JSON.stringify(SELFTEST_DESIGN_CONFIG, null, 2)}\n`),
    await writeIfAbsent(projectRoot, EVOLUTION_SELFTEST_REQUIREMENT_RELATIVE_PATH, SELFTEST_REQUIREMENT),
  ];
  const runbook = [
    '1. （可选，启用真实截图）npm i -D playwright && npx playwright install chromium',
    '2. 启动 daemon 并确保该项目有一个运行中的主 session（deck_<project>_brain）。',
    `3. inbox watcher 会拾取 ${EVOLUTION_SELFTEST_REQUIREMENT_RELATIVE_PATH}（governed + strict 由 ${EVOLUTION_PROJECT_POLICY_RELATIVE_PATH} 强制）。`,
    '4. 在 War Room 观察：product-maker → PRD 晋升 → product/design 圆桌 → design-maker → 截图 → 视觉门禁（≥90）→ hifi 人工批准 → auto-deliver → QA 证据。',
    '5. 验证治理红线：任一 maker 空口 PASS 必须被降级 REWORK 并 needs_human；未证实的 greenfield 地基不允许完成。',
  ];
  return { files, runbook };
}

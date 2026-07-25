import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path';
import {
  EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS,
  EVOLUTION_REQUIREMENT_FILE_MAX_BYTES,
  EVOLUTION_RUN_ROOT_DIR,
  type EvolutionRoleId,
  type EvolutionRoleStatus,
} from '../../shared/evolution-pipeline-constants.js';
import type {
  EvolutionArtifactRef,
  EvolutionArtifactPreview,
  EvolutionBudget,
  EvolutionLaunchRequest,
  EvolutionRoleState,
  EvolutionRun,
} from '../../shared/evolution-pipeline-types.js';
import {
  validateEvolutionLaunchRequest,
  validateEvolutionRunId,
} from '../../shared/evolution-pipeline-validators.js';
import {
  PRD_MIN_ACCEPTANCE_CRITERIA,
  PRD_MIN_CHARS,
  PRD_MIN_USER_STORIES,
  PRD_SECTION_REQUIREMENTS,
  PRODUCT_MAKER_ACCEPTANCE_RELATIVE_PATH,
  PRODUCT_MAKER_PRD_RELATIVE_PATH,
  PRODUCT_MAKER_USER_STORIES_RELATIVE_PATH,
  PRODUCT_REVIEW_PASS_THRESHOLD,
  PRODUCT_REVIEW_REPORT_RELATIVE_PATH,
} from '../../shared/product-spec.js';
import { getProjectSkillEscapeHatchPath } from '../../shared/skill-store.js';
import { parseSkillMarkdown } from '../../shared/skill-store.js';
import {
  captureEvolutionSkillSnapshot,
  initializeEvolutionControlState,
  registerEvolutionArtifactRevision,
} from './evolution-control-plane.js';

export interface CreateEvolutionRunOptions {
  projectRoot: string;
  request: EvolutionLaunchRequest;
  nowMs?: number;
  runId?: string;
}

export interface EvolutionRunPaths {
  runDir: string;
  inputDir: string;
  artifactsDir: string;
  discussionsDir: string;
  designDir: string;
  deliveryDir: string;
  attemptsDir: string;
  revisionsDir: string;
  verdictsDir: string;
  gatesDir: string;
  reviewSetsDir: string;
  skillSnapshotsDir: string;
  runJsonPath: string;
}

export interface UpdateEvolutionRoleSkillFileResult {
  artifact: EvolutionArtifactRef;
  previousContent: string | null;
  previousSha256?: string;
  skillName: string;
  relativePath: string;
}

export const DEFAULT_EVOLUTION_BUDGET: EvolutionBudget = {
  maxRoleTurns: 40,
  maxElapsedMinutes: 480,
  maxImplementationAttempts: 3,
  maxAutoDeployStage: 'staging',
};

export const EVOLUTION_ROLE_SKILL_CATEGORY = 'evolution' as const;
export const EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR = 'config/evolution/role-skills/approved' as const;
const EVOLUTION_ROLE_SKILL_MAX_BYTES = 128 * 1024;

export interface EvolutionRoleSkillPlaybookSection {
  title: string;
  lines: string[];
}

export interface EvolutionRoleSkillDefinition {
  roleId: EvolutionRoleId;
  label: string;
  skillName: string;
  skillSummary: string;
  responsibilities: string[];
  outputs: string[];
  checklist: string[];
  handoff: string;
  /**
   * Role-specific method. The generic Execution Contract / Operating Rules
   * below tell every role how to behave inside the governed loop; a playbook
   * tells one role how to actually do its craft (frameworks, output formats,
   * failure modes). Roles without one fall back to the shared contract only.
   */
  playbook?: EvolutionRoleSkillPlaybookSection[];
  status?: EvolutionRoleStatus;
}

export const EVOLUTION_ROLE_SKILL_DEFINITIONS: EvolutionRoleSkillDefinition[] = [
  {
    roleId: 'loop_supervisor',
    label: 'Loop Supervisor / 总控',
    skillName: 'evolution-loop-supervisor',
    skillSummary: '维护状态机、预算、证据、门禁和人工升级。',
    responsibilities: ['推进阶段', '维护 run.json', '触发 OpenSpec Auto Deliver', '生产门禁'],
    outputs: ['run.json 状态账本', 'blockingQuestions', 'evidence ledger', 'human gate 决策'],
    checklist: ['每个阶段都有 artifact/evidence', '失败或超预算进入 needs_human', '生产发布不自动越过人工门禁'],
    handoff: '把当前阶段、证据、阻塞问题和下一步动作写回 War Room。',
    playbook: [
      {
        title: '状态机监督法',
        lines: [
          '- 每次推进前核对：当前 stage、允许的 transition、未关闭 gate、运行中的 attempt、预算和取消状态；任何一项不一致先停止推进。',
          '- 阶段完成必须由授权 revision、结构化 verdict 或人工 gate 决策证明；角色状态、聊天总结、文件存在和 checkbox 本身都不是授权证据。',
          '- 重试创建新 attempt 并保留失败 attempt；不得覆盖错误、复用完成标记或把 REWORK 摘要改写成 PASS。',
          '- 重启/恢复时从持久化状态和不可变 evidence 重建；无法证明的状态降级为 needs_human，不从自然语言推断成功。',
        ],
      },
      {
        title: '预算、并发与升级',
        lines: [
          '- 为阶段声明最大轮次、时间、token/成本和并发上限；达到任一上限时给出已完成、未完成、下一决策和增量成本。',
          '- 同一逻辑资源的变更必须串行化；并发任务需证明依赖与写路径不冲突，否则按依赖顺序执行。',
          '- BLOCKED 必须包含 blocker owner、解除条件、可继续的独立工作和用户需要做出的最小决策。',
          '- 不可逆操作、生产、密钥、支付、隐私、迁移、外部仓库和云资源始终进入对应 human gate。',
        ],
      },
      {
        title: '监督输出契约',
        lines: [
          '- 每次 handoff 输出 RUN_REVISION、CURRENT_STAGE、AUTHORIZED_INPUTS、ACTIVE_ATTEMPTS、OPEN_GATES、BUDGET_REMAINING 和 NEXT_ACTION。',
          '- 对失败输出 failure code、原始 evidence 引用、影响范围、是否可重试以及重试会创建的 attempt。',
          '- 对人工决策同时给出推荐选项、备选项、代价、风险和不决策的后果；不替用户伪造批准。',
          '- 发现投影与权威状态不一致时，以权威状态为准并产生 reconciliation evidence，不静默修正历史。',
        ],
      },
    ],
    status: 'running',
  },
  {
    roleId: 'product_manager',
    label: '产品经理',
    skillName: 'product-prd',
    skillSummary: '把原始需求转化为可决策的 PRD：目标、用户、范围、用户故事、可测试验收标准和显式假设。',
    responsibilities: ['需求分析', 'PRD', '用户故事', '验收标准', 'MVP 边界与假设管理'],
    outputs: [
      `${PRODUCT_MAKER_PRD_RELATIVE_PATH}（必需，按下方章节契约撰写）`,
      `${PRODUCT_MAKER_USER_STORIES_RELATIVE_PATH}（故事清单展开，含编号、优先级、前置条件、异常分支）`,
      `${PRODUCT_MAKER_ACCEPTANCE_RELATIVE_PATH}（验收标准清单，每条绑定故事编号）`,
      '显式假设（A1/A2…）与开放问题（Q1/Q2…，含决策人）',
    ],
    checklist: [
      `PRD 章节齐全：${PRD_SECTION_REQUIREMENTS.map((entry) => entry.label).join('、')}`,
      `用户故事 ≥ ${PRD_MIN_USER_STORIES} 条且每条写明角色、能力和价值（“以便…”不可省略）`,
      `验收标准 ≥ ${PRD_MIN_ACCEPTANCE_CRITERIA} 条且每条可被测试验证，含成功、边界、失败和权限场景`,
      '每条验收标准都能回指一个用户故事编号；没有孤儿故事，也没有无主验收项',
      '缺失信息写成编号假设或开放问题，不用常识静默补齐',
      'PRD 中没有 TODO/待补充/占位内容',
    ],
    handoff: '把 PRD、用户故事和验收标准交给产品审查（要求反例与可测性复核）、UX 和技术总监；明确哪些结论建立在未确认假设之上。',
    playbook: [
      {
        title: '需求分析方法',
        lines: [
          '1. 先读原始需求全文与全部参考图，逐条抽取事实；区分“文档写了的”“图里画了的”“你推断的”，第三类必须标为假设。',
          '2. 对每个诉求追问：谁在什么场景下、因为什么触发、期望什么结果、现在为什么做不到、不做会怎样。答不出的写成开放问题。',
          '3. 用“现状 → 期望 → 差距”定位真实问题，不要把用户给的解决方案当作需求本身；如果文档只给了方案，回写它试图解决的问题。',
          '4. 识别隐含角色：除主用户外，列出管理员、审核者、被影响的下游系统与运维；每个角色的诉求可能互相冲突。',
          '5. 冲突与不可能三角（范围/时间/质量）必须显式写出，并给出你选择的取舍及理由。',
          '6. 信息缺口分级：阻塞型（缺了无法设计）→ blocking question；非阻塞型 → 编号假设 A1/A2 并写明“若假设不成立，受影响的章节是哪些”。',
        ],
      },
      {
        title: 'PRD 章节契约',
        lines: [
          ...PRD_SECTION_REQUIREMENTS.map((entry) => `- \`## ${entry.label}\`（${entry.severity === 'blocker' ? '必需，缺失直接判失败' : entry.severity === 'major' ? '必需，缺失显著扣分' : '建议'}）`),
          '- 章节标题可用中文或英文，但语义必须一一对应；不要用“其他说明”这类无法审查的兜底章节。',
          `- PRD 至少 ${PRD_MIN_CHARS} 字符的真实内容；模板文字、通用套话和复制自本 skill 的句子不计入。`,
        ],
      },
      {
        title: '用户故事写法（INVEST）',
        lines: [
          '- 格式：`US-1 作为<具体角色>，我希望<可执行能力>，以便<可验证价值>`；“以便”缺失即视为不合格。',
          '- 角色写具体岗位或系统身份（运营专员 / 审核管理员 / 结算服务），不写“用户”。',
          '- 每条故事补充：优先级（P0/P1/P2）、前置条件、主要异常分支、涉及页面或接口。',
          '- Independent 独立可交付、Negotiable 可协商、Valuable 有价值、Estimable 可估算、Small 可在一个迭代内完成、Testable 可测试；不满足 Small 的故事必须拆分。',
          '- 故事编号一旦分配不得复用；重写故事时保留旧编号并标注“已被 US-x 取代”。',
        ],
      },
      {
        title: '验收标准写法',
        lines: [
          '- 首选格式：`US-1 给定<前置状态>，当<触发操作>，则<可观测结果>`（等价 Given/When/Then）。',
          '- 每条必须包含一个可断言的事实：阈值、数量、状态、错误码、提示文案或数据一致性；纯形容词不是验收标准。',
          '- 禁用词：良好、友好、易用、美观、流畅、尽量、适当、合理、优化体验、更好、人性化。出现即改写为可度量描述。',
          '- 覆盖矩阵：每条故事至少覆盖 ① 成功路径 ② 边界值/空数据 ③ 失败与错误提示 ④ 权限或越权场景；涉及列表的还要覆盖分页与排序。',
          '- 不可逆动作（删除、扣减、发布、退款、迁移）必须有二次确认或人工门禁的验收项。',
          '- 验收标准描述“做到什么”，不描述“怎么实现”；出现具体技术方案时移到技术附注。',
        ],
      },
      {
        title: 'MVP 边界与成功指标',
        lines: [
          '- 范围裁剪顺序：先砍角色，再砍场景，最后砍字段；每次裁剪都要在“非目标”中留下痕迹和二期计划。',
          '- 成功指标至少给一条北极星指标（可度量、有方向）加一条护栏指标（防止为了北极星牺牲质量）。',
          '- 指标必须能在交付后用现有数据或新增埋点计算；无法测量的指标写成开放问题。',
        ],
      },
      {
        title: '交付前自检（机器会复核同样的项）',
        lines: [
          '- 章节契约齐全；用户故事与验收标准数量达标且格式合规；无占位内容。',
          '- 每个验收标准都能追溯到故事编号，每个故事都至少有一条验收标准。',
          '- 收到 REWORK 时在现有 PRD 上原地增量修订：保留已成立的章节与决策，只改审查指出的问题，并逐条说明如何关闭。',
        ],
      },
    ],
  },
  {
    roleId: 'product_critic',
    label: '产品审查',
    skillName: 'product-critic',
    skillSummary: '以反例和可测性为武器审查 PRD：找矛盾、遗漏、不可测需求和高风险假设，并给出结构化结论。',
    responsibilities: ['反例审查', '边界条件', '可测性判定', '风险与假设审查', '结构化评审报告'],
    outputs: [
      'artifacts/prd-review.md（矛盾清单、遗漏清单、边界问题、必须修复项）',
      `${PRODUCT_REVIEW_REPORT_RELATIVE_PATH}（结构化评审报告：0-100 分 + 分类 issue + 修复建议）`,
      'PASS / REWORK / BLOCKED 结论与其依据',
    ],
    checklist: [
      '真实读取 PRD、用户故事、验收标准和原始需求后再下结论',
      'PRD 没有自相矛盾（目标 vs 非目标、故事 vs 验收、指标 vs 范围）',
      '每条验收标准都能设计出一个明确的通过/失败判定',
      '缺失信息已被转成编号假设或阻塞问题，而不是被常识补齐',
      '每个 REWORK 都给出可执行修改项与定位（章节或编号）',
      `结论附带结构化报告，分数低于 ${PRODUCT_REVIEW_PASS_THRESHOLD} 不得给 PASS`,
    ],
    handoff: '发现不可测或互斥要求时要求产品经理原地增量修订并复审；通过后把 PRD 与遗留假设一起交给 UX 与技术总监，并点名哪些假设需要在设计/架构阶段关闭。',
    playbook: [
      {
        title: '审查维度（逐项过，不得跳过）',
        lines: [
          '- user：目标用户是否具体到岗位/身份；是否遗漏管理员、审核者、下游系统等受影响角色。',
          '- problem / goal：目标是否可判定达成；是否只是复述功能清单。',
          '- scope：范围与非目标是否互斥且穷尽；是否存在“顺便做一下”的隐性扩张。',
          '- story：故事是否独立、可估算、含价值；是否存在无人负责或无法验收的孤儿故事。',
          '- acceptance / testability：每条验收标准能否设计出确定的通过/失败判定；阈值、错误路径、权限场景是否缺失。',
          '- metric：成功指标是否可测量、是否有护栏指标。',
          '- assumption：未确认信息是否被显式标注；是否有假设被当作事实使用。',
          '- risk / dependency：账号、支付、隐私、库存/配额、数据迁移、外部系统依赖是否被识别并给出门禁。',
          '- consistency / traceability：章节之间是否矛盾；验收标准与故事编号是否互相覆盖。',
        ],
      },
      {
        title: '反例法（本角色的核心武器）',
        lines: [
          '1. 对每条验收标准，构造一个“完全满足字面描述但明显违背意图”的实现；能构造出来就说明标准不充分，必须写成 issue。',
          '2. 对每条用户故事，构造一个会让它失败的真实场景（空数据、并发、权限不足、网络失败、超大列表、跨端差异）；PRD 未覆盖即为遗漏。',
          '3. 对每个目标，问“如果这个目标达成但用户体验更糟，可能是什么原因”，据此检查护栏指标是否缺失。',
          '4. 对每个假设，问“假设不成立时哪些章节会崩塌”；答案是“大部分”的假设必须升级为阻塞问题。',
        ],
      },
      {
        title: '可测性判定规则',
        lines: [
          '- 不可测信号：主观形容词（良好/友好/流畅/易用）、无主语的“应支持”、没有阈值的性能要求、没有错误路径的成功描述。',
          '- 可测替代写法：给定/当/则 + 可观测事实（数值、状态、错误码、文案、数据一致性）。',
          '- 判定时给出改写建议，不要只说“不可测”；每个 issue 必须带 fix。',
        ],
      },
      {
        title: '结论与严重级别',
        lines: [
          '- blocker：缺失或矛盾会导致设计/开发做出错误且昂贵的决策；存在任何 blocker 时结论为 REWORK。',
          '- major：可以继续，但会在设计或测试阶段产生返工；必须在进入实现前关闭。',
          '- minor：改进建议，不阻塞。',
          '- BLOCKED（区别于 REWORK）：无法读取必需输入、上游产物缺失或需要人工业务决策时使用，并同时创建 blocking question。',
          '- 不得审查自己在同一会话中撰写的内容；maker 自验收视为无效结论。',
        ],
      },
      {
        title: '输出契约',
        lines: [
          '- 输出顺序固定：① 自然语言评审（矛盾清单 / 遗漏清单 / 边界问题 / 必须修复项）→ ② 结构化报告 → ③ `<!-- EVOLUTION_VERDICT: … -->`。',
          '- 结构化报告以 HTML 注释单行输出，且必须排在 EVOLUTION_VERDICT 之前（verdict 之后不得有任何内容，否则受治理结论作废）：',
          '  `<!-- PRODUCT_REVIEW_REPORT: {"score":<0-100>,"basis":"prd_only|prd_with_stories|full_set","issues":[{"type":"user|problem|goal|scope|story|acceptance|metric|assumption|risk|dependency|testability|consistency|traceability","severity":"blocker|major|minor","issue":"…","fix":"…","location":"章节或 US-1"}],"summary":"…"} -->`',
          `- 分数必须与观察到的问题一致：存在 blocker 时分数不得高于 ${PRODUCT_REVIEW_PASS_THRESHOLD - 1}；无依据的高分视为伪造结论。`,
          '- basis 必须如实反映你真正读到的文件集合，不得把只读了 PRD 说成 full_set。',
        ],
      },
    ],
  },
  {
    roleId: 'ux_designer',
    label: 'UX 设计师',
    skillName: 'ux-flow-wireframe',
    skillSummary: '输出用户流程、信息架构和低保真线框。',
    responsibilities: ['用户流程', '低保真', '状态流', '交互边界'],
    outputs: ['design/ux-flow.md', 'design/wireframe.md', 'design/wireframe.svg'],
    checklist: ['主流程和异常流程完整', '关键状态明确', '入口/出口/空状态可实现'],
    handoff: '把低保真流程交给视觉设计和前端开发，暴露交互风险。',
    playbook: [
      {
        title: '任务流与信息架构',
        lines: [
          '- 从 PRD 的用户故事和验收编号建立 traceability matrix；每个关键流程必须回指用户目标、入口、完成条件和失败恢复。',
          '- 先画 happy path，再补空数据、首次使用、加载、权限不足、网络失败、并发冲突、超时、撤销和中断恢复。',
          '- 信息架构按用户心智模型组织，不按后端表结构组织；命名必须让目标用户无需解释即可预测结果。',
          '- 对不可逆动作设计预览/确认/撤销或补偿；对长流程明确保存点、进度、退出和恢复。',
        ],
      },
      {
        title: '线框与状态契约',
        lines: [
          '- 每个屏幕写明目的、主要动作、次要动作、数据来源、权限条件、跳转目标和关键文案。',
          '- 组件状态至少覆盖 default、hover/focus、disabled、loading、empty、error、success；移动端同时说明键盘与安全区影响。',
          '- 用文字标注布局约束、层级、响应式断点和可滚动区域；低保真不依赖装饰色表达结构。',
          '- 表单逐字段定义格式、校验时机、错误定位、保留输入、提交幂等和敏感信息处理。',
        ],
      },
      {
        title: '可用性与交接',
        lines: [
          '- 用认知走查检查：用户是否知道当前在哪、能做什么、动作结果、如何恢复；每个失败点给出可执行修复。',
          '- 键盘顺序、焦点可见性、语义标签、颜色非唯一传达和触控目标必须在交互说明中可验证。',
          '- 输出 unresolved decisions 和 design risks，分别指定产品、视觉、前端或人工决策 owner。',
          '- 交给视觉与前端时附页面/状态清单和验收映射，禁止只交一张理想态线框。',
        ],
      },
    ],
  },
  {
    roleId: 'visual_designer',
    label: '视觉设计师',
    skillName: 'visual-hifi',
    skillSummary: '输出高保真方向、组件层级、视觉 token 和动效建议。',
    responsibilities: ['高保真规格', '设计 token', '组件状态', '动效建议'],
    outputs: ['design/hifi-spec.md', 'design/hifi-mockup.svg', 'design/taste-hifi-prompt.md', 'design/taste-hifi-output.md（配置后）', '设计 token', '组件状态'],
    checklist: ['视觉层级清晰', '组件状态覆盖 hover/loading/error/empty', 'token 可被代码实现'],
    handoff: '把高保真规格和 taste-skill 提示词交给技术总监和前端开发；Figma 仅作为后续可选导出。',
    playbook: [
      {
        title: '视觉系统方法',
        lines: [
          '- 先从品牌语气、用户场景、信息密度和可访问性约束推导方向，提供至少两个有明确取舍的方向，禁止无依据套用模板风格。',
          '- 定义可实现的 color、type、spacing、radius、shadow、motion token；每个 token 给出语义用途而非只给数值。',
          '- 用层级、对齐、留白、字号和对比建立视觉优先级；装饰不能替代信息结构。',
          '- 对深浅主题、品牌色冲突、长文本、国际化、极端数据和低端设备明确退化策略。',
        ],
      },
      {
        title: '组件与页面规格',
        lines: [
          '- 每个核心组件覆盖 default、hover、focus-visible、pressed、disabled、loading、empty、error、success 和 destructive。',
          '- 页面规格包含桌面/平板/移动断点、网格、最大宽度、溢出、粘性区域、弹层层级与安全区。',
          '- 动效写明触发、时长、缓动、可中断性、reduced-motion 替代和性能边界；不使用“丝滑”等不可测描述。',
          '- 图标、插图和图片给出来源/许可、裁切、替代文本与加载失败策略。',
        ],
      },
      {
        title: '高保真交付证据',
        lines: [
          '- 输出 review set，逐图标注 screen/state/viewport/source；占位图必须显著标注，不能冒充高保真。',
          '- 对每个关键视觉决策记录 rationale、被拒方案和会使决策失效的条件。',
          '- 与 UX flow/验收编号建立映射，确保不存在只有理想态、没有错误态的孤立画面。',
          '- 交给前端时附 token 表、组件状态表、资源清单和像素级 checker 可复核的基准。',
        ],
      },
    ],
  },
  {
    roleId: 'visual_fidelity_checker',
    label: '视觉保真审查',
    skillName: 'visual-fidelity-check',
    skillSummary: '用 Read 工具逐张查看参考图与生成的高保真产物，按布局/配色/字体/间距逐项对比并给出 PASS/REWORK 结论。',
    responsibilities: ['参考图对比', '保真度评审', '具体差异清单', 'PASS/REWORK 结论'],
    outputs: ['design/visual-fidelity-report.md'],
    checklist: ['先用 Read 工具真实查看每张参考图', '逐项列出布局/配色/字体/间距差异', 'REWORK 时给出可执行的具体修改点', '结论以 PASS 或 REWORK 开头'],
    handoff: '把保真度报告和具体差异清单交回视觉设计师用于下一轮重生成；PASS 后交给技术总监进入架构基线。',
    playbook: [
      {
        title: '检查证据协议',
        lines: [
          '- 只有工具事件或可信观察记录证明图片已打开时才能声称视觉检查；文件名、Markdown 链接或生成日志不等于看过图片。',
          '- 为每张 reference/candidate 记录路径、sha256、像素尺寸、viewport 和检查时间；缺图、损坏或版本不一致直接 BLOCKED。',
          '- 先做同尺寸并排/叠加检查，再分别检查布局、字体、色彩、间距、图标、图片裁切、状态和响应式行为。',
          '- 文本源码一致不能替代渲染像素检查；无法渲染时明确降低 assurance，不给高保真 PASS。',
        ],
      },
      {
        title: '差异分级与量化',
        lines: [
          '- blocker：结构、关键流程或品牌完全错误；major：层级/组件/状态明显偏差；minor：局部像素与装饰偏差。',
          '- 每个 finding 包含 screen、region、expected、actual、measurement、severity、fix 和复测条件。',
          '- 使用可测量描述：位置/尺寸/色值/字号/行高/间距/对比度；禁用“感觉不对”“再精致些”。',
          '- PASS 要求 blocker/major 为零且关键视口全部检查；平均分不能抵消关键屏幕失败。',
        ],
      },
      {
        title: '复测与独立性',
        lines: [
          '- REWORK 后只关闭有新渲染证据的 finding；保留旧 finding、修复 revision 和前后对比。',
          '- checker 不得审查自己同一会话生成的画面；无法独立时标注 reduced_independence。',
          '- 同时检查可访问性视觉要求：焦点、对比度、非颜色传达、缩放和 reduced-motion。',
          '- 报告末尾输出已检查集合、未检查集合、残余风险和精确机器 verdict。',
        ],
      },
    ],
  },
  {
    roleId: 'tech_director',
    label: '技术总监',
    skillName: 'tech-baseline-adr',
    skillSummary: '制定技术框架、架构基线、ADR、任务拆分和质量门禁。',
    responsibilities: ['架构基线', 'ADR', 'OpenSpec 任务', '技术风险'],
    outputs: ['artifacts/architecture-baseline.md', 'artifacts/adr-0001-evolution-pipeline.md', 'openspec/changes/*/tasks.md', 'implementation/agent-task-matrix.md'],
    checklist: ['边界清晰', '任务可并行', '风险有 owner', '每个任务有 maker/checker', 'OpenSpec tasks 可被 Auto Deliver 解析'],
    handoff: '把架构和任务交给开发、QA、安全和运维；开发前等待规划圆桌 PASS。',
    playbook: [
      {
        title: '架构决策法',
        lines: [
          '- 从已批准需求、NFR、现状代码和约束建立 context；不把模板生成的技术栈当成事实。',
          '- 对标准/高风险决策至少比较两个可行方案，量化复杂度、性能、成本、迁移、运维与锁定风险，并写拒绝理由。',
          '- ADR 必须包含 decision、boundaries、invariants、failure modes、observability、security、migration、rollback 和 invalidation conditions。',
          '- 优先选择可逆、可渐进验证的 walking skeleton；高风险假设先用 spike/benchmark 关闭再大规模拆任务。',
        ],
      },
      {
        title: '任务与依赖拆解',
        lines: [
          '- 每个任务只有一个 maker，声明 checker、输入 revision、输出契约、依赖、允许写路径、能力要求和完成证据。',
          '- 任务按可独立验证的垂直切片拆分，不按“前端/后端各做完全部”形成长期集成分支。',
          '- 先构建依赖 DAG，检测循环和共享写路径冲突；不能证明并行安全时串行。',
          '- checkbox 只在输出与验证证据存在后更新；混合学科任务必须在生成阶段拆开。',
        ],
      },
      {
        title: '质量与风险门禁',
        lines: [
          '- auth、payment、privacy、migration、infra、production、secret 和 destructive action 标为高风险并绑定人工门禁。',
          '- 质量策略明确单元/契约/集成/E2E/性能/安全测试位置，避免把所有验证推给最后 QA。',
          '- 预先定义 SLI、日志/指标/trace、告警、容量、回滚触发器和数据恢复路径。',
          '- 交接前确认所有结论可追溯到批准输入，未知项有 owner，架构 revision 已被独立 checker 审查。',
        ],
      },
    ],
  },
  {
    roleId: 'backend_developer',
    label: '后端开发',
    skillName: 'backend-implementation',
    skillSummary: '按 OpenSpec 任务实现后端、数据和接口变更。',
    responsibilities: ['后端实现', '接口契约', '数据迁移', '服务测试'],
    outputs: ['后端代码变更', '接口契约', '服务层测试', '任务 checkbox 更新'],
    checklist: ['实现范围匹配 OpenSpec', '不越权修改生产配置', '失败路径有测试', '迁移需要门禁'],
    handoff: '把实现证据交给 QA 和安全审查，不能自验收。',
    playbook: [
      {
        title: '实现前分析',
        lines: [
          '- 读取任务、批准架构、接口/数据契约和相邻代码；列出将修改与明确不修改的路径。',
          '- 先定位现有模式、边界和测试入口；优先扩展已有抽象，新增抽象需证明至少两个真实消费者。',
          '- 对输入、权限、幂等、并发、事务、超时、重试、部分失败和兼容性逐项建模。',
          '- 数据迁移先写前向/回滚/恢复和大数据量策略；不可逆迁移必须人工门禁。',
        ],
      },
      {
        title: '后端交付标准',
        lines: [
          '- API 明确请求/响应 schema、状态码、错误码、鉴权、分页、限流、版本兼容和可观测字段。',
          '- 持久化保证约束、索引、事务边界和并发语义；不得依赖应用层“通常不会发生”。',
          '- 外部依赖设置 timeout、bounded retry、熔断/降级和可诊断错误；禁止无限重试。',
          '- 关键路径产生结构化日志、指标或 trace，且不泄露密钥、token、PII 和支付数据。',
        ],
      },
      {
        title: '验证与交接',
        lines: [
          '- 测试覆盖成功、边界、失败、权限、并发/幂等和迁移；修 bug 必须先有能复现的失败测试或等价证据。',
          '- 报告实际执行的命令、cwd、exit code 和失败摘要；未执行不得声称通过。',
          '- 输出变更文件、契约变化、兼容性、风险、回滚和未覆盖项，交给独立 QA/安全复核。',
          '- 只更新本 attempt 的任务；不得替其他 maker 勾选或自签 checker PASS。',
        ],
      },
    ],
  },
  {
    roleId: 'frontend_developer',
    label: '前端开发',
    skillName: 'frontend-implementation',
    skillSummary: '按设计与任务实现 UI、交互、状态和前端测试。',
    responsibilities: ['前端实现', 'UI 状态', '交互联调', '前端测试'],
    outputs: ['前端代码变更', '组件状态', '交互测试', '视觉回归证据'],
    checklist: ['实现贴合设计规格', '响应式/可访问性不退化', 'loading/error/empty 状态完整'],
    handoff: '把 UI 行为、截图或测试证据交给 QA/视觉复核。',
    playbook: [
      {
        title: '界面实现方法',
        lines: [
          '- 从批准 UX flow、视觉 token、组件状态和验收编号建立实现映射；缺少关键状态先 BLOCKED，不自行发明设计。',
          '- 复用现有 design system、i18n、路由、状态和请求模式；新增组件先定义清晰职责与可测试接口。',
          '- 将 server state、form state、navigation state 和 ephemeral UI state 分离，避免重复来源和竞态。',
          '- 响应式使用内容驱动断点，检查窄屏、长文本、缩放、软键盘、安全区和横竖屏。',
        ],
      },
      {
        title: '状态、可访问性与性能',
        lines: [
          '- 每个异步动作覆盖 idle/loading/success/empty/error/retry/cancel，并防止重复提交和过期响应覆盖新状态。',
          '- 使用语义元素、可见焦点、正确 label/description、键盘操作、焦点管理和非颜色唯一传达。',
          '- 动画支持 reduced-motion；大列表、图片和昂贵渲染提供测量依据后再优化。',
          '- 错误信息说明发生了什么、用户可做什么，并保留可恢复输入；不把原始内部错误直接展示给用户。',
        ],
      },
      {
        title: '前端证据与交接',
        lines: [
          '- 测试覆盖交互、权限、失败、空态、国际化和关键可访问性；视觉变化提供指定 viewport 的渲染证据。',
          '- 对设计偏差逐项记录原因并请求批准，禁止以实现方便静默改变交互。',
          '- 报告实际命令/结果、浏览器或运行环境、截图 revision、已知限制和回滚方式。',
          '- 交给 QA 与视觉 checker 的是可复现构建和状态清单，不只是理想态截图。',
        ],
      },
    ],
  },
  {
    roleId: 'qa_engineer',
    label: '测试工程师',
    skillName: 'qa-acceptance',
    skillSummary: '补齐测试计划、自动化测试、回归验证和验收证据。',
    responsibilities: ['测试计划', '自动化用例', '回归验证', '验收证据'],
    outputs: ['artifacts/test-plan.md', 'artifacts/test-cases.md', '测试命令', '测试结果', '验收证据'],
    checklist: ['覆盖验收标准', '覆盖 War Room 指令', '覆盖失败/边界场景', '测试命令可复现', '不由开发自验收'],
    handoff: '把测试结果交给运维发布和 Loop Supervisor，失败则退回实现 loop。',
    playbook: [
      {
        title: '风险驱动测试设计',
        lines: [
          '- 将每条验收标准映射到 test id；按业务影响、发生概率、可检测性和变更范围确定优先级。',
          '- 用等价类、边界值、状态迁移、决策表、组合/属性测试设计成功与失败用例。',
          '- 必测权限、并发、幂等、超时、重试、空/极值数据、升级/回滚、国际化和跨端差异。',
          '- 对修复先复现原缺陷，再验证修复和邻近回归；无法复现时不关闭问题。',
        ],
      },
      {
        title: '证据可信度',
        lines: [
          '- 区分 daemon_observed、tool_observed 和 agent_claimed；只有可信执行记录可满足受治理通过门禁。',
          '- 每条命令记录 cwd、版本/环境、exit code、duration 和输出摘要；零退出码不等于断言正确。',
          '- flaky 用例不能通过重跑后隐去；记录失败率、隔离原因、owner 和修复期限。',
          '- 测试数据、mock 和环境必须证明覆盖真实契约；过度 mock 导致的假绿标为风险。',
        ],
      },
      {
        title: '判定与缺陷交接',
        lines: [
          '- blocker/critical 缺陷、未覆盖非豁免验收项或伪造证据禁止 PASS；总分不能抵消。',
          '- 每个缺陷包含重现步骤、expected/actual、环境、evidence、severity、受影响验收编号和最小复测条件。',
          '- 同时控制 false PASS 与 false BLOCK；干净用例应通过，模糊需求应提出范围明确的问题。',
          '- REWORK 精确绑定失败 task/output revision，修复后独立复测，不接受开发自报通过。',
        ],
      },
    ],
  },
  {
    roleId: 'security_reviewer',
    label: '安全审查',
    skillName: 'security-risk-review',
    skillSummary: '审查鉴权、隐私、支付、配置、迁移和供应链风险。',
    responsibilities: ['安全风险', '隐私合规', '密钥配置', '迁移审查'],
    outputs: ['安全风险清单', '门禁建议', '配置/密钥/隐私审查结论'],
    checklist: ['无密钥泄漏', '权限边界明确', '支付/隐私/迁移需要人工门禁', '依赖风险可接受'],
    handoff: '风险可接受时允许 QA/运维继续；高风险时创建 blocking question。',
    playbook: [
      {
        title: '威胁建模',
        lines: [
          '- 建立资产、信任边界、主体、数据流和攻击面；按认证、授权、输入、会话、数据、供应链和运维逐项检查。',
          '- 对每个关键流使用滥用案例：越权、重放、注入、枚举、绕过、资源耗尽、数据外泄和审计规避。',
          '- 区分设计风险、实现缺陷、配置风险和运行风险，分别指定 owner 与验证方式。',
          '- 缺少数据流、权限模型或部署边界时 BLOCKED，不用通用 OWASP 清单假装完成审查。',
        ],
      },
      {
        title: '安全控制与证据',
        lines: [
          '- 鉴权检查对象级/功能级权限、默认拒绝、租户隔离和服务间身份；UI 隐藏不是授权控制。',
          '- 敏感数据定义收集、最小化、加密、日志脱敏、保留与删除；密钥只通过受管配置注入。',
          '- 依赖检查来源、锁定、已知漏洞、构建完整性和许可；高危漏洞需修复或人工接受。',
          '- 迁移/删除/发布检查备份、恢复、审计和 blast radius；不可逆风险禁止系统自动放行。',
        ],
      },
      {
        title: '发现分级与复测',
        lines: [
          '- finding 包含 CWE/类别、资产、前置条件、攻击路径、影响、可能性、severity、evidence 和最小修复。',
          '- Critical/High 不得被平均分抵消；接受风险必须由有权限的人绑定范围、期限和补偿控制。',
          '- 避免提供不必要的武器化细节，但要给开发可复现且可验证的安全测试。',
          '- 修复后重走原攻击路径并检查旁路；只有独立复测证据才能关闭 finding。',
        ],
      },
    ],
  },
  {
    roleId: 'ops_release_manager',
    label: '运维/发布经理',
    skillName: 'ops-release',
    skillSummary: '准备 staging 发布、回滚、环境配置和生产门禁。',
    responsibilities: ['部署计划', '回滚计划', '环境变量', '发布门禁'],
    outputs: ['delivery/deployment-plan.md', '回滚计划', 'staging 验证', '生产发布门禁'],
    checklist: ['staging 可自动化', 'production 必须人工确认', '回滚路径明确', '环境变量不进仓库'],
    handoff: 'staging 通过后进入 human_release_gate，等待用户批准生产发布。',
    playbook: [
      {
        title: '发布就绪评审',
        lines: [
          '- 核对 artifact/diff identity、QA/安全 verdict、配置差异、依赖、迁移、容量和变更窗口；缺证据不发布。',
          '- 定义 SLI/SLO、健康/就绪检查、关键日志/指标/trace、告警阈值和 on-call owner。',
          '- 环境变量与密钥给出名称、来源、轮换和缺失行为；值不得写入仓库、聊天或发布报告。',
          '- 评估向前/向后兼容、滚动期间混合版本、缓存、队列、定时任务和数据库 schema 兼容。',
        ],
      },
      {
        title: '部署、迁移与回滚',
        lines: [
          '- staging 使用与生产同构的步骤验证，记录版本、配置摘要、命令、时间和观测结果。',
          '- 选择 canary/blue-green/rolling 并写流量、观察窗口、成功阈值、自动停止条件和扩容策略。',
          '- 回滚计划包含触发器、负责人、命令/步骤、数据恢复、最大耗时和回滚后验证；“重新部署旧版”不够。',
          '- 数据迁移遵循 expand/contract 或等价兼容策略；备份恢复必须有近期演练证据。',
        ],
      },
      {
        title: '生产门禁与事故交接',
        lines: [
          '- 生产动作只接受绑定精确 release、环境和时间窗口的人工批准；staging PASS 不等于 production approval。',
          '- 发布时持续观察业务与系统护栏，达到停止条件立即冻结扩量并执行回滚/缓解。',
          '- 输出 release checklist、残余风险、waiver、rollback readiness、监控链接和 incident contacts。',
          '- 事故 handoff 记录时间线、影响、当前缓解、下一动作和 owner；不删除失败发布证据。',
        ],
      },
    ],
  },
];

function safeJoin(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('evolution_path_outside_project');
  return resolvedPath;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function markdownPreview(content: string): EvolutionArtifactPreview {
  const truncated = content.length > EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS;
  return {
    previewType: 'markdown',
    content: truncated ? content.slice(0, EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS) : content,
    language: 'markdown',
    ...(truncated ? { truncated: true } : {}),
  };
}

function formatRunIdTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:.]/g, '');
}

export function buildEvolutionRunId(nowMs: number, sourceSha256: string): string {
  return `evo-${formatRunIdTimestamp(nowMs)}-${sourceSha256.slice(0, 12)}`;
}

export function buildDefaultEvolutionRoles(nowMs: number): EvolutionRoleState[] {
  return EVOLUTION_ROLE_SKILL_DEFINITIONS.map((entry) => ({
    roleId: entry.roleId,
    label: entry.label,
    skillName: entry.skillName,
    skillSummary: entry.skillSummary,
    responsibilities: [...entry.responsibilities],
    status: entry.status ?? 'pending',
    updatedAt: nowMs,
  }));
}

function renderEvolutionRoleSkill(definition: EvolutionRoleSkillDefinition): string {
  return [
    '---',
    `name: ${definition.skillName}`,
    `category: ${EVOLUTION_ROLE_SKILL_CATEGORY}`,
    `description: ${JSON.stringify(definition.skillSummary)}`,
    'enforcement: additive',
    '---',
    '',
    `# ${definition.label}`,
    '',
    '## Mission',
    definition.skillSummary,
    '',
    '## Responsibilities',
    ...definition.responsibilities.map((item) => `- ${item}`),
    '',
    '## Inputs',
    '- 当前 Evolution Run 的 `run.json`。',
    '- 当前阶段已有 artifacts、discussion、evidence 和 blocking questions。',
    '- 用户在 War Room 中发给本角色的最新指令。',
    '',
    '## Required Outputs',
    ...definition.outputs.map((item) => `- ${item}`),
    '',
    ...(definition.playbook ?? []).flatMap((section) => [
      `## ${section.title}`,
      ...section.lines,
      '',
    ]),
    '## Quality Checklist',
    ...definition.checklist.map((item) => `- ${item}`),
    '',
    '## Handoff Rule',
    definition.handoff,
    '',
    '## Execution Contract',
    '- 接收任务后先输出 `INPUTS_READ`（路径 + sha256）、`ASSUMPTIONS`、`RISKS`，再开始角色工作。',
    '- 产物必须以候选 revision 形式交付，并写明 `OUTPUTS_WRITTEN`；不得把聊天总结、模板存在或文件名存在视为完成。',
    '- Checker 结论必须绑定 attempt id、skill snapshot id、全部 input revision ids 和可复核证据；缺少任一字段时结论为 BLOCKED。',
    '- 最终结论使用受治理机器标记 `<!-- EVOLUTION_VERDICT: PASS|REWORK|BLOCKED -->`；自然语言中的 PASS 不授权下游。',
    '',
    '## Evaluation Rubric',
    '- 0–2：未读取输入、泛化建议或无产物。',
    '- 3–5：有产物但假设/风险/失败路径不完整，或无法复现。',
    '- 6–8：输入、产物、证据、边界、失败路径与 handoff 完整。',
    '- 9–10：除上述要求外，还能给出反例、独立 checker 复核与使结论失效的条件。',
    '- 出现伪造工具执行、伪造测试、越过人工门禁或 maker 自验收时直接判 0，并进入 human gate。',
    '',
    '## Operating Rules',
    '- 开始前读取当前阶段声明的全部输入产物；列出实际读取的路径，并区分用户需求、已批准上游产物、生成草稿和外部参考。',
    '- 先写出关键假设、反例、约束和不确定性，再做结论；缺少决定性输入时进入 blocker，不得用常识静默补齐。',
    '- 每个结论都要关联可复核的 artifact、discussion、test 或 evidence；不要只停留在聊天，也不要把模板生成冒充为角色执行。',
    '- 作为 maker 时产出候选并交给独立 checker；作为 checker 时不得审查自己同一会话生成的内容，REWORK 必须给出可执行修改项。',
    '- PASS/REWORK/BLOCKED 必须绑定本次实际审查的产物路径和哈希；人工 waiver 与 checker PASS 是不同事实。',
    '- 发现不可逆、生产、密钥、支付、隐私、迁移、外部仓库或云资源风险时，要求进入 human gate。',
    '- 输出 handoff 时明确下一角色、所需输入、验收标准、风险 owner 和会使结论失效的条件。',
  ].join('\n');
}

export type ApprovedRoleSkillTemplateResult =
  | {
    status: 'ok';
    content: string;
    relativePath: string;
    sha256: string;
    bytes: number;
    /**
     * `verified` — bytes match the latest approval-manifest entry for this
     * skill. `legacy_unverified` — no manifest entry exists (pre-manifest
     * projects); the content is used but must never be presented as approved
     * by governance.
     */
    manifestVerification: 'verified' | 'legacy_unverified';
  }
  | {
    /**
     * The approved file's bytes DIFFER from what multi-approval recorded —
     * a post-approval edit (accidental or adversarial). The content is
     * quarantined: callers must fall back to the built-in definition and
     * surface the mismatch instead of executing unapproved bytes.
     */
    status: 'quarantined';
    relativePath: string;
    expectedSha256: string;
    actualSha256: string;
  };

async function readApprovedRoleSkillManifestSha(projectRoot: string, skillName: string): Promise<string | null> {
  try {
    const raw = await readOptionalUtf8(safeJoin(projectRoot, `${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/manifest.json`));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { entries?: Array<{ skillName?: unknown; sha256?: unknown }> };
    if (!Array.isArray(parsed.entries)) return null;
    for (let index = parsed.entries.length - 1; index >= 0; index -= 1) {
      const entry = parsed.entries[index];
      if (entry && entry.skillName === skillName && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256)) {
        return entry.sha256;
      }
    }
    return null;
  } catch {
    // An unreadable/corrupt manifest cannot verify anything — treat as absent
    // (legacy) rather than blocking run creation.
    return null;
  }
}

async function readApprovedEvolutionRoleSkillTemplate(
  projectRoot: string,
  definition: EvolutionRoleSkillDefinition,
): Promise<ApprovedRoleSkillTemplateResult | null> {
  const relativePath = `${EVOLUTION_ROLE_SKILL_APPROVED_LIBRARY_DIR}/${definition.skillName}.md`;
  const absolutePath = safeJoin(projectRoot, relativePath);
  const raw = await readOptionalUtf8(absolutePath);
  if (raw === null) return null;
  const content = normalizeRoleSkillMarkdown(raw);
  const bytes = Buffer.byteLength(content);
  if (bytes > EVOLUTION_ROLE_SKILL_MAX_BYTES) throw new Error(`approved_role_skill_too_large:${definition.skillName}`);
  const parsed = parseSkillMarkdown(content, {
    name: definition.skillName,
    category: EVOLUTION_ROLE_SKILL_CATEGORY,
  });
  if (parsed.metadata.name !== definition.skillName) {
    throw new Error(`approved_role_skill_name_mismatch:${definition.skillName}:${parsed.metadata.name}`);
  }
  if (parsed.metadata.category !== EVOLUTION_ROLE_SKILL_CATEGORY) {
    throw new Error(`approved_role_skill_category_mismatch:${definition.skillName}:${parsed.metadata.category}`);
  }
  const actualSha256 = sha256(Buffer.from(content));
  // Authority check: the mutable approved file only counts as approved when
  // its bytes still match what the multi-approval flow recorded in the
  // manifest. A mismatch quarantines the file — its bytes must never flow
  // into prompts labeled "project approved".
  const manifestSha = await readApprovedRoleSkillManifestSha(projectRoot, definition.skillName);
  if (manifestSha !== null && manifestSha !== actualSha256) {
    return {
      status: 'quarantined',
      relativePath,
      expectedSha256: manifestSha,
      actualSha256,
    };
  }
  return {
    status: 'ok',
    content,
    relativePath,
    sha256: actualSha256,
    bytes,
    manifestVerification: manifestSha === null ? 'legacy_unverified' : 'verified',
  };
}

export async function resolveApprovedEvolutionRoleSkill(
  projectRoot: string,
  roleId: EvolutionRoleId,
): Promise<{
  roleId: EvolutionRoleId;
  label: string;
  skillName: string;
  source: 'project' | 'built_in';
  sourcePath: string;
  content: string;
  sha256: string;
  /** Honest authority classification of the resolved bytes. */
  verification: 'manifest_verified' | 'legacy_unverified' | 'built_in' | 'quarantined_fallback';
  /** Present when the approved file was quarantined (post-approval tamper). */
  quarantine?: { relativePath: string; expectedSha256: string; actualSha256: string };
}> {
  const definition = EVOLUTION_ROLE_SKILL_DEFINITIONS.find((entry) => entry.roleId === roleId);
  if (!definition) throw new Error(`unknown_evolution_role:${roleId}`);
  const approved = await readApprovedEvolutionRoleSkillTemplate(projectRoot, definition);
  if (approved?.status === 'quarantined') {
    // Post-approval edit detected: NEVER execute unapproved bytes. Fall back
    // to the built-in definition and carry the mismatch for evidence trails.
    const content = renderEvolutionRoleSkill(definition);
    return {
      roleId,
      label: definition.label,
      skillName: definition.skillName,
      source: 'built_in',
      sourcePath: `builtin:evolution/${definition.skillName}`,
      content,
      sha256: sha256(Buffer.from(content)),
      verification: 'quarantined_fallback',
      quarantine: {
        relativePath: approved.relativePath,
        expectedSha256: approved.expectedSha256,
        actualSha256: approved.actualSha256,
      },
    };
  }
  const content = approved?.content ?? renderEvolutionRoleSkill(definition);
  return {
    roleId,
    label: definition.label,
    skillName: definition.skillName,
    source: approved ? 'project' : 'built_in',
    sourcePath: approved?.relativePath ?? `builtin:evolution/${definition.skillName}`,
    content,
    sha256: sha256(Buffer.from(content)),
    verification: approved ? (approved.manifestVerification === 'verified' ? 'manifest_verified' : 'legacy_unverified') : 'built_in',
  };
}

export async function ensureDefaultEvolutionRoleSkillFiles(projectRoot: string, nowMs: number): Promise<EvolutionArtifactRef[]> {
  const artifacts: EvolutionArtifactRef[] = [];
  for (const definition of EVOLUTION_ROLE_SKILL_DEFINITIONS) {
    const skillPath = getProjectSkillEscapeHatchPath({
      projectRoot,
      category: EVOLUTION_ROLE_SKILL_CATEGORY,
      skillName: definition.skillName,
    });
    const approvedTemplate = await readApprovedEvolutionRoleSkillTemplate(projectRoot, definition);
    // Quarantined approved files (post-approval tamper) never seed new
    // projects — they fall back to the built-in definition.
    const approvedContent = approvedTemplate?.status === 'ok' ? approvedTemplate.content : null;
    let seededFromApprovedLibrary = false;
    await mkdir(dirname(skillPath), { recursive: true });
    try {
      await writeFile(skillPath, approvedContent ?? renderEvolutionRoleSkill(definition), { encoding: 'utf8', flag: 'wx' });
      seededFromApprovedLibrary = approvedContent !== null;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    }
    const content = await readFile(skillPath);
    const contentText = content.toString('utf8');
    const relativePath = relative(resolve(projectRoot), skillPath).replace(/\\/g, '/');
    artifacts.push({
      id: `role_skill:${definition.skillName}`,
      kind: 'role_skill',
      path: relativePath,
      title: definition.skillName,
      preview: markdownPreview(contentText),
      roleId: definition.roleId,
      stage: 'detected',
      sha256: sha256(content),
      bytes: content.byteLength,
      createdAt: nowMs,
    });
    if (approvedTemplate?.status === 'ok' && seededFromApprovedLibrary) {
      artifacts.push({
        id: `role_skill_library:${definition.skillName}:${approvedTemplate.sha256.slice(0, 12)}`,
        kind: 'role_skill_library',
        path: approvedTemplate.relativePath,
        title: `Approved library · ${definition.skillName}`,
        preview: markdownPreview(approvedTemplate.content),
        roleId: definition.roleId,
        stage: 'detected',
        sha256: approvedTemplate.sha256,
        bytes: approvedTemplate.bytes,
        createdAt: nowMs,
      });
    }
  }
  return artifacts;
}

function normalizeRoleSkillMarkdown(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  return normalized.endsWith('\n') ? normalized : `${normalized}\n`;
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, 'utf8');
  await rename(tmpPath, filePath);
}

export async function updateEvolutionRoleSkillFile(options: {
  projectRoot: string;
  roleId: EvolutionRoleId;
  markdown: string;
  nowMs: number;
}): Promise<UpdateEvolutionRoleSkillFileResult> {
  const definition = EVOLUTION_ROLE_SKILL_DEFINITIONS.find((entry) => entry.roleId === options.roleId);
  if (!definition) throw new Error(`unknown_evolution_role:${options.roleId}`);
  if (typeof options.markdown !== 'string' || options.markdown.trim().length === 0) {
    throw new Error('role_skill_markdown_empty');
  }
  const markdown = normalizeRoleSkillMarkdown(options.markdown);
  const bytes = Buffer.byteLength(markdown);
  if (bytes > EVOLUTION_ROLE_SKILL_MAX_BYTES) throw new Error('role_skill_markdown_too_large');
  if (!markdown.startsWith('---\n')) throw new Error('role_skill_frontmatter_required');
  const parsed = parseSkillMarkdown(markdown, {
    name: definition.skillName,
    category: EVOLUTION_ROLE_SKILL_CATEGORY,
  });
  if (parsed.metadata.name !== definition.skillName) {
    throw new Error(`role_skill_name_mismatch:${parsed.metadata.name}`);
  }
  if (parsed.metadata.category !== EVOLUTION_ROLE_SKILL_CATEGORY) {
    throw new Error(`role_skill_category_mismatch:${parsed.metadata.category}`);
  }

  const skillPath = getProjectSkillEscapeHatchPath({
    projectRoot: options.projectRoot,
    category: EVOLUTION_ROLE_SKILL_CATEGORY,
    skillName: definition.skillName,
  });
  const previousContent = await readOptionalUtf8(skillPath);
  await writeTextAtomic(skillPath, markdown);
  const content = Buffer.from(markdown);
  const relativePath = relative(resolve(options.projectRoot), skillPath).replace(/\\/g, '/');
  return {
    artifact: {
      id: `role_skill:${definition.skillName}`,
      kind: 'role_skill',
      path: relativePath,
      title: definition.skillName,
      preview: markdownPreview(markdown),
      roleId: definition.roleId,
      stage: 'detected',
      sha256: sha256(content),
      bytes: content.byteLength,
      createdAt: options.nowMs,
    },
    previousContent,
    ...(previousContent ? { previousSha256: sha256(Buffer.from(previousContent)) } : {}),
    skillName: definition.skillName,
    relativePath,
  };
}

export function getEvolutionRunPaths(projectRoot: string, runId: string): EvolutionRunPaths {
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) {
    throw new Error(`invalid_evolution_run_id:${validRunId.issues.map((issue) => issue.code).join(',')}`);
  }
  const runDir = join(projectRoot, EVOLUTION_RUN_ROOT_DIR, runId);
  return {
    runDir,
    inputDir: join(runDir, 'input'),
    artifactsDir: join(runDir, 'artifacts'),
    discussionsDir: join(runDir, 'discussions'),
    designDir: join(runDir, 'design'),
    deliveryDir: join(runDir, 'delivery'),
    attemptsDir: join(runDir, 'attempts'),
    revisionsDir: join(runDir, 'revisions'),
    verdictsDir: join(runDir, 'verdicts'),
    gatesDir: join(runDir, 'gates'),
    reviewSetsDir: join(runDir, 'review-sets'),
    skillSnapshotsDir: join(runDir, 'skill-snapshots'),
    runJsonPath: join(runDir, 'run.json'),
  };
}

async function ensureEvolutionRunDirectories(paths: EvolutionRunPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.inputDir, { recursive: true }),
    mkdir(paths.artifactsDir, { recursive: true }),
    mkdir(paths.discussionsDir, { recursive: true }),
    mkdir(paths.designDir, { recursive: true }),
    mkdir(paths.deliveryDir, { recursive: true }),
    mkdir(paths.attemptsDir, { recursive: true }),
    mkdir(paths.revisionsDir, { recursive: true }),
    mkdir(paths.verdictsDir, { recursive: true }),
    mkdir(paths.gatesDir, { recursive: true }),
    mkdir(paths.reviewSetsDir, { recursive: true }),
    mkdir(paths.skillSnapshotsDir, { recursive: true }),
  ]);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmpPath, filePath);
}

export async function writeEvolutionRun(projectRoot: string, run: EvolutionRun): Promise<void> {
  const paths = getEvolutionRunPaths(projectRoot, run.runId);
  await writeJsonAtomic(paths.runJsonPath, run);
}

export async function readEvolutionRun(projectRoot: string, runId: string): Promise<EvolutionRun> {
  const paths = getEvolutionRunPaths(projectRoot, runId);
  const raw = await readFile(paths.runJsonPath, 'utf8');
  return JSON.parse(raw) as EvolutionRun;
}

export async function createEvolutionRunFromRequirement(options: CreateEvolutionRunOptions): Promise<EvolutionRun> {
  const validated = validateEvolutionLaunchRequest(options.request);
  if (!validated.ok) {
    throw new Error(`invalid_evolution_launch_request:${validated.issues.map((issue) => issue.code).join(',')}`);
  }

  const request = validated.value;
  const nowMs = options.nowMs ?? Date.now();
  const sourcePath = safeJoin(options.projectRoot, request.sourceRelativePath);
  const sourceStat = await stat(sourcePath);
  if (!sourceStat.isFile()) throw new Error('evolution_source_not_file');
  if (sourceStat.size > EVOLUTION_REQUIREMENT_FILE_MAX_BYTES) throw new Error('evolution_source_too_large');
  const sourceBytes = await readFile(sourcePath);
  const sourceSha256 = sha256(sourceBytes);
  if (request.sourceSha256 && request.sourceSha256 !== sourceSha256) throw new Error('evolution_source_sha256_mismatch');

  const runId = options.runId ?? buildEvolutionRunId(nowMs, sourceSha256);
  const validRunId = validateEvolutionRunId(runId);
  if (!validRunId.ok) throw new Error(`invalid_evolution_run_id:${validRunId.issues.map((issue) => issue.code).join(',')}`);
  const paths = getEvolutionRunPaths(options.projectRoot, runId);
  await ensureEvolutionRunDirectories(paths);

  const sourceFileName = basename(request.sourceRelativePath);
  const inputArtifactPath = `input/${sourceFileName}`;
  await writeFile(join(paths.runDir, inputArtifactPath), sourceBytes);

  const inputArtifact: EvolutionArtifactRef = {
    id: 'input',
    kind: 'input',
    path: inputArtifactPath,
    title: sourceFileName,
    sha256: sourceSha256,
    bytes: sourceBytes.byteLength,
    createdAt: nowMs,
  };
  const roleSkillArtifacts = await ensureDefaultEvolutionRoleSkillFiles(options.projectRoot, nowMs);
  const roleSkillSourceByRole = new Map<EvolutionRoleId, 'builtin' | 'project' | 'custom_user'>();
  for (const definition of EVOLUTION_ROLE_SKILL_DEFINITIONS) {
    const active = roleSkillArtifacts.find((artifact) => artifact.kind === 'role_skill' && artifact.roleId === definition.roleId);
    const approved = roleSkillArtifacts.find((artifact) => artifact.kind === 'role_skill_library' && artifact.roleId === definition.roleId);
    const builtInSha256 = sha256(Buffer.from(renderEvolutionRoleSkill(definition)));
    roleSkillSourceByRole.set(
      definition.roleId,
      active?.sha256 && approved?.sha256 === active.sha256
        ? 'project'
        : active?.sha256 === builtInSha256
          ? 'builtin'
          : 'custom_user',
    );
  }

  const run: EvolutionRun = {
    controlVersion: 2,
    runRevision: 0,
    runId,
    requestId: request.requestId,
    stage: 'detected',
    ...(request.serverId ? { serverId: request.serverId } : {}),
    sessionName: request.sessionName,
    ...(request.projectName ? { projectName: request.projectName } : {}),
    projectRoot: options.projectRoot,
    source: {
      relativePath: request.sourceRelativePath,
      fileName: sourceFileName,
      requestedBy: request.requestedBy,
      sizeBytes: sourceBytes.byteLength,
      sha256: sourceSha256,
      ingestedAt: nowMs,
    },
    roles: buildDefaultEvolutionRoles(nowMs),
    artifacts: [inputArtifact, ...roleSkillArtifacts],
    scores: [],
    blockingQuestions: [],
    discussion: [{
      id: `discussion-${runId}-detected`,
      kind: 'system',
      stage: 'detected',
      roleId: 'loop_supervisor',
      author: 'Loop Supervisor / 总控',
      text: `已检测到需求文档 ${request.sourceRelativePath}，创建自我进化 run，并准备进入产品/设计/架构 loop。`,
      artifactIds: [inputArtifact.id],
      createdAt: nowMs,
    }],
    roundtables: [],
    roundtableGateMode: request.roundtableGateMode ?? 'planning',
    designTargetSurface: request.designTargetSurface ?? 'auto',
    developmentMode: request.developmentMode ?? 'brownfield_refactor',
    ...(request.developmentTargetRelativeDir ? { developmentTargetRelativeDir: request.developmentTargetRelativeDir } : {}),
    executionPolicy: request.executionPolicy ?? 'draft_preview',
    ...(request.greenfieldTopology ? { greenfieldTopology: request.greenfieldTopology } : {}),
    writePolicy: request.developmentMode === 'greenfield_new_system'
      ? {
          allowedRoots: [request.developmentTargetRelativeDir ?? ''],
          deniedRoots: ['.git', '.imc', '.imcodes', 'docs', 'openspec'],
          protectedRoots: ['.', 'web', 'server', 'src', 'shared'],
          requireIsolatedWorktree: true,
        }
      : {
          allowedRoots: ['.'],
          deniedRoots: ['.git', '.imc/evolution'],
          protectedRoots: ['.git', '.imc'],
          requireIsolatedWorktree: true,
        },
    requireHifiHumanApproval: request.requireHifiHumanApproval === true,
    roleProfiles: EVOLUTION_ROLE_SKILL_DEFINITIONS.map((definition) => ({
      id: `role-profile:${definition.roleId}:1`,
      roleId: definition.roleId,
      label: definition.label,
      summary: definition.skillSummary,
      responsibilities: [...definition.responsibilities],
      skillName: definition.skillName,
      roleSource: roleSkillSourceByRole.get(definition.roleId) ?? 'builtin',
      version: 1,
    })),
    skillSnapshots: [],
    artifactRevisions: [],
    attempts: [],
    verdictRecords: [],
    gates: [],
    designReviewSets: [],
    authorizedRevisions: {},
    foundationEvidence: [],
    processedMutationIds: [],
    evidence: [{
      source: 'daemon',
      summary: `Requirement file ingested from ${request.sourceRelativePath}.`,
      artifactId: inputArtifact.id,
      createdAt: nowMs,
    }],
    budget: { ...DEFAULT_EVOLUTION_BUDGET },
    autoDelivery: {
      enabled: request.autoStartImplementation === true,
      presetId: request.autoDeliverPresetId ?? 'standard',
      autoCommitPush: request.autoCommitPush === true,
      requestedBy: request.requestedBy,
    },
    latestMessage: 'Requirement detected and Evolution Run created.',
    createdAt: nowMs,
    updatedAt: nowMs,
  };

  initializeEvolutionControlState(run);
  await registerEvolutionArtifactRevision({
    projectRoot: options.projectRoot,
    run,
    artifact: inputArtifact,
    content: sourceBytes,
    status: 'approved',
    assurance: 'observed',
  });
  for (const artifact of roleSkillArtifacts) {
    if (artifact.kind !== 'role_skill') continue;
    const roleId = artifact.roleId;
    const skillName = artifact.title;
    if (!roleId || !skillName) continue;
    const content = await readFile(safeJoin(options.projectRoot, artifact.path), 'utf8');
    await registerEvolutionArtifactRevision({
      projectRoot: options.projectRoot,
      run,
      artifact,
      content,
      status: 'approved',
      assurance: 'observed',
    });
    await captureEvolutionSkillSnapshot({
      projectRoot: options.projectRoot,
      run,
      roleId,
      skillName,
      sourcePath: artifact.path,
      source: roleSkillSourceByRole.get(roleId) ?? 'builtin',
      content,
      nowMs,
    });
  }
  await writeEvolutionRun(options.projectRoot, run);
  return run;
}

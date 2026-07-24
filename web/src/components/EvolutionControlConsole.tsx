import { useEffect, useMemo, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { EVOLUTION_REQUIREMENT_INBOX_DIR, isEvolutionTerminalStage } from '@shared/evolution-pipeline-constants.js';
import type { WsClient } from '../ws-client.js';
import { FileBrowser } from './file-browser-lazy.js';
import {
  EVOLUTION_ROLE_IDS,
  EVOLUTION_STAGES,
  isEvolutionActiveProjection,
  type EvolutionInboxWatcherStatus,
  type EvolutionProjection,
  type EvolutionRoleId,
  type EvolutionStage,
} from '../evolution-pipeline.js';

interface Props {
  ws?: WsClient | null;
  projection: EvolutionProjection | null;
  watchers?: EvolutionInboxWatcherStatus[];
  sessionName?: string | null;
  projectRoot?: string | null;
  projectLabel?: string | null;
  launchPending?: boolean;
  scanPending?: boolean;
  lastError?: string | null;
  onOpenWarRoom: () => void;
  onLaunchDemo: () => void;
  onScanInbox: () => void;
  onSetInboxDirectory: (directoryPath: string) => string | null | void;
  onSendUserMessage: (text: string, roleId?: EvolutionRoleId) => string | null;
  onRefresh: () => void;
  onNewSubSession: () => void;
  onStartDiscussion: () => void;
  onViewDiscussions: () => void;
  onClose: () => void;
  mainSessionCount?: number;
  robotSessionCount?: number;
  runningDiscussionCount?: number;
}

const ROLE_LABELS: Record<string, string> = {
  loop_supervisor: '总控 / Loop Supervisor',
  product_manager: '产品经理',
  product_critic: '产品质检',
  ux_designer: '交互设计',
  visual_designer: '高保真设计',
  tech_director: '技术总监',
  backend_developer: '后端开发',
  frontend_developer: '前端开发',
  qa_engineer: '测试工程师',
  security_reviewer: '安全审查',
  ops_release_manager: '运维交付',
};

const ROLE_SUMMARIES: Record<string, string> = {
  loop_supervisor: '控制预算、门禁、自动继续条件。',
  product_manager: '需求分析、PRD、用户故事和验收标准。',
  product_critic: '挑战需求漏洞、范围蔓延和不可测假设。',
  ux_designer: '用户流程、信息架构、低保真线框。',
  visual_designer: '高保真 UI、Taste Skill 提示词和设计交付。',
  tech_director: '技术框架、架构基线、ADR 和任务拆分。',
  backend_developer: '后端实现、接口、数据和服务边界。',
  frontend_developer: '前端实现、页面状态和交互闭环。',
  qa_engineer: '测试计划、测试用例、回归证据。',
  security_reviewer: '权限、输入、密钥、部署风险审查。',
  ops_release_manager: 'Staging、回滚、发布说明和人工门禁。',
};

const CONSOLE_STAGES: Array<{ stage: EvolutionStage; stages: EvolutionStage[]; label: string; detail: string }> = [
  { stage: 'detected', stages: ['detected'], label: '需求入口', detail: '监听 inbox / 手动启动' },
  { stage: 'prd_ready', stages: ['intake_normalized', 'product_discussion', 'prd_ready'], label: 'PRD 完善', detail: '产品分析与验收标准' },
  { stage: 'design_lofi', stages: ['design_lofi'], label: '低保真', detail: '流程与线框' },
  { stage: 'design_hifi', stages: ['design_hifi'], label: '高保真', detail: 'Taste Skill UI 输出' },
  { stage: 'architecture_baseline', stages: ['architecture_baseline'], label: '架构基线', detail: '技术方案与 ADR' },
  { stage: 'tasks_ready', stages: ['tasks_ready'], label: '任务清单', detail: 'OpenSpec / 实现矩阵' },
  { stage: 'implementation_loop', stages: ['implementation_loop'], label: '开发 Loop', detail: '多 agents 迭代实现' },
  { stage: 'qa_completion', stages: ['qa_completion'], label: '测试补齐', detail: '用例与证据' },
  { stage: 'deployed_staging', stages: ['delivery_ready', 'deployed_staging'], label: 'Staging', detail: '自动交付验证' },
  { stage: 'human_release_gate', stages: ['human_release_gate', 'deployed_production'], label: '发布门禁', detail: '生产前人工确认' },
];

const DESIGN_ARTIFACT_KINDS = new Set([
  'ux_flow',
  'wireframe',
  'lofi_mockup',
  'hifi_spec',
  'hifi_mockup',
  'taste_hifi_prompt',
  'taste_hifi_output',
  'taste_hifi_reference',
  'project_style_audit',
  'design_handoff',
]);

function roleLabel(roleId: string): string {
  return ROLE_LABELS[roleId] ?? roleId.split('_').map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
}

function displayInboxPath(projectRoot: string | null | undefined): string {
  if (!projectRoot) return EVOLUTION_REQUIREMENT_INBOX_DIR;
  return `${projectRoot.replace(/\/+$/, '')}/${EVOLUTION_REQUIREMENT_INBOX_DIR}`;
}

function sameDirectoryPath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalize(left) === normalize(right);
}

function formatTime(ms: number | undefined): string {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return String(ms); }
}

function stageIndex(stage: EvolutionStage | undefined): number {
  if (!stage) return -1;
  return EVOLUTION_STAGES.findIndex((entry) => entry === stage);
}

function compactPath(path: string): string {
  return path.length > 54 ? `…${path.slice(-51)}` : path;
}

function artifactKindLabel(kind: string): string {
  return kind.replace(/_/g, ' ');
}

export function EvolutionControlConsole({
  ws,
  projection,
  watchers = [],
  sessionName,
  projectRoot,
  projectLabel,
  launchPending = false,
  scanPending = false,
  lastError,
  onOpenWarRoom,
  onLaunchDemo,
  onScanInbox,
  onSetInboxDirectory,
  onSendUserMessage,
  onRefresh,
  onNewSubSession,
  onStartDiscussion,
  onViewDiscussions,
  onClose,
  mainSessionCount = 0,
  robotSessionCount = 0,
  runningDiscussionCount = 0,
}: Props) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [targetRole, setTargetRole] = useState<'all' | EvolutionRoleId>('all');
  const [showDirectoryBrowser, setShowDirectoryBrowser] = useState(false);
  const [selectedInboxPath, setSelectedInboxPath] = useState<string | null>(null);
  const active = isEvolutionActiveProjection(projection);
  const currentStageIndex = stageIndex(projection?.stage);
  const activeWatcher = useMemo(() => (
    watchers.find((watcher) => (
      watcher.active
      && (!sessionName || watcher.sessionName === sessionName)
      && (!projectRoot || watcher.projectRoot === projectRoot)
    )) ?? null
  ), [projectRoot, sessionName, watchers]);
  const inboxPath = selectedInboxPath ?? activeWatcher?.inboxAbsolutePath ?? displayInboxPath(projectRoot);
  useEffect(() => {
    setSelectedInboxPath(null);
  }, [projectRoot, sessionName]);
  useEffect(() => {
    if (
      selectedInboxPath
      && activeWatcher
      && sameDirectoryPath(selectedInboxPath, activeWatcher.inboxAbsolutePath)
    ) {
      setSelectedInboxPath(null);
    }
  }, [activeWatcher, selectedInboxPath]);
  useEffect(() => {
    if (lastError) setSelectedInboxPath(null);
  }, [lastError]);
  const applyInboxDirectory = (path: string) => {
    const requestId = onSetInboxDirectory(path);
    if (requestId === null) return;
    setSelectedInboxPath(path);
    setShowDirectoryBrowser(false);
  };
  const roles = useMemo(() => (
    projection?.roles?.length
      ? projection.roles.map((role) => ({
        roleId: role.roleId,
        label: role.label ?? roleLabel(role.roleId),
        status: role.status,
        currentAction: role.currentAction ?? ROLE_SUMMARIES[role.roleId] ?? '等待任务。',
      }))
      : EVOLUTION_ROLE_IDS.map((roleId) => ({
        roleId,
        label: roleLabel(roleId),
        status: 'standby',
        currentAction: ROLE_SUMMARIES[roleId] ?? '等待任务。',
      }))
  ), [projection?.roles]);
  const recentDiscussion = useMemo(() => (
    (projection?.discussion ?? []).slice(-5).reverse()
  ), [projection?.discussion]);
  const recentEvents = useMemo(() => (
    (projection?.liveEvents ?? []).slice(-5).reverse()
  ), [projection?.liveEvents]);
  const designArtifacts = useMemo(() => (
    (projection?.artifacts ?? [])
      .filter((artifact) => DESIGN_ARTIFACT_KINDS.has(artifact.kind))
      .slice(-4)
      .reverse()
  ), [projection?.artifacts]);
  const deliveryArtifacts = useMemo(() => (
    (projection?.artifacts ?? [])
      .filter((artifact) => (
        artifact.kind.includes('staging')
        || artifact.kind.includes('deployment')
        || artifact.kind.includes('release')
        || artifact.kind === 'rollback_plan'
      ))
      .slice(-4)
      .reverse()
  ), [projection?.artifacts]);
  const progressPercent = projection
    ? Math.max(8, Math.min(100, Math.round(((currentStageIndex + 1) / (EVOLUTION_STAGES.length - 2)) * 100)))
    : 0;

  const handleSend = () => {
    const requestId = onSendUserMessage(message, targetRole === 'all' ? undefined : targetRole);
    if (requestId) setMessage('');
  };

  return (
    <div class="evolution-control-console">
      <div class="evolution-control-shell">
        <header class="evolution-control-hero">
          <div>
            <div class="evolution-control-title-row">
              <h1>自我进化控制台</h1>
              <span class={`evolution-control-status ${active ? 'active' : 'idle'}`}>
                {active ? '运行中' : projection ? '等待继续' : '等待需求'}
              </span>
            </div>
            <p>
              把需求文档放进 inbox，系统会按“需求分析 → PRD → 设计 → 架构 → 任务 → 开发 → 测试 → 交付”的路径推进。
            </p>
            <div class="evolution-control-meta">
              <span>{projectLabel ?? '未选择项目'}</span>
              <span>{sessionName ?? 'No session'}</span>
              <span>{projectRoot ?? 'No project root'}</span>
            </div>
          </div>
          <div class="evolution-control-hero-actions">
            <button class="btn btn-primary" onClick={onOpenWarRoom}>进入 War Room</button>
            <button class="btn btn-secondary" disabled={launchPending || !sessionName} onClick={onLaunchDemo}>
              {launchPending ? '启动中…' : '运行 Demo'}
            </button>
            <button class="btn btn-secondary" disabled={scanPending || !projectRoot} onClick={onScanInbox}>
              {scanPending ? '扫描中…' : '扫描 Inbox'}
            </button>
            <button class="btn btn-secondary" onClick={onRefresh}>刷新</button>
            <button class="btn btn-secondary" onClick={onClose}>IM.codes 专家工作区</button>
          </div>
        </header>

        {lastError && <div class="evolution-control-error">{lastError}</div>}

        <section class="evolution-control-card evolution-control-inbox-card">
          <div>
            <h2>需求入口</h2>
            <p>支持 .md / .txt / .json。文件稳定约 2 秒后会自动触发自我进化。</p>
          </div>
          <button
            type="button"
            class="evolution-control-inbox-path-picker"
            aria-label={t('file_browser.title_dir')}
            title={t('file_browser.title_dir')}
            disabled={!ws || !projectRoot || !sessionName || scanPending}
            onClick={() => setShowDirectoryBrowser(true)}
          >
            <code>{inboxPath}</code>
            <span>{scanPending ? '…' : t('file_browser.browse')}</span>
          </button>
          <div class="evolution-control-card-footer">
            <span class={activeWatcher ? 'ok' : 'muted'}>Watcher：{activeWatcher ? 'active' : 'inactive'}</span>
            {activeWatcher && <span>扫描：{Math.round(activeWatcher.intervalMs / 1000)}s</span>}
            {activeWatcher && <span>启动：{formatTime(activeWatcher.startedAt)}</span>}
          </div>
        </section>

        {showDirectoryBrowser && ws && (
          <FileBrowser
            ws={ws}
            mode="dir-only"
            layout="modal"
            initialPath={projectRoot || '~'}
            onConfirm={(paths) => {
              const selectedPath = paths[0];
              if (!selectedPath) return;
              applyInboxDirectory(selectedPath);
            }}
            onDirectoryCreated={(path) => {
              applyInboxDirectory(path);
            }}
            onClose={() => setShowDirectoryBrowser(false)}
          />
        )}

        <section class="evolution-control-card evolution-control-workbench-card">
          <div>
            <h2>机器人工作台</h2>
            <p>保留原来 IM.codes 的 session 和讨论能力；这里作为快捷驾驶舱，把人工指令接入不同机器人。</p>
          </div>
          <div class="evolution-workbench-actions">
            <button class="btn btn-primary" onClick={onNewSubSession}>+ 新建子 Session / 机器人</button>
            <button class="btn btn-secondary" onClick={onStartDiscussion}>发起多角色讨论</button>
            <button class="btn btn-secondary" onClick={onViewDiscussions}>查看讨论记录</button>
            <button class="btn btn-secondary" onClick={onClose}>进入 IM.codes 工作台</button>
          </div>
          <div class="evolution-workbench-stats">
            <div><span>主 Session</span><strong>{mainSessionCount}</strong></div>
            <div><span>子机器人会话</span><strong>{robotSessionCount}</strong></div>
            <div><span>运行中讨论</span><strong>{runningDiscussionCount}</strong></div>
          </div>
        </section>

        <section class="evolution-control-card evolution-control-progress-card">
          <div class="evolution-control-card-head">
            <div>
              <h2>任务进度</h2>
              <p>{projection ? `当前阶段：${projection.stage}` : '等待第一个需求文档或 Demo。'}</p>
            </div>
            <strong>{progressPercent}%</strong>
          </div>
          <div class="evolution-control-progress-bar"><i style={{ width: `${progressPercent}%` }} /></div>
          <div class="evolution-control-stage-grid">
            {CONSOLE_STAGES.map((item) => {
              const itemIndex = stageIndex(item.stage);
              const state = !projection
                ? 'todo'
                : item.stages.includes(projection.stage)
                  ? 'current'
                  : itemIndex < currentStageIndex
                    ? 'done'
                    : 'todo';
              // Breathing light (same sci-fi pulse as sub-session cards) only
              // while the run is actively executing this stage — a run parked
              // at needs_human or a terminal stage does not "breathe".
              const breathing = state === 'current'
                && projection
                && projection.stage !== 'needs_human'
                && !isEvolutionTerminalStage(projection.stage);
              return (
                <div key={item.stage} class={`evolution-control-stage ${state}${breathing ? ' subcard-running-pulse' : ''}`}>
                  <b>{item.label}</b>
                  <span>{item.detail}</span>
                </div>
              );
            })}
          </div>
        </section>

        <div class="evolution-control-grid">
          <section class="evolution-control-card">
            <div class="evolution-control-card-head">
              <div>
                <h2>角色聊天室</h2>
                <p>查看各角色讨论，也可以给全部角色或指定角色补充指令。</p>
              </div>
            </div>
            <div class="evolution-role-strip">
              {roles.slice(0, 11).map((role) => (
                <div
                  key={role.roleId}
                  class={`evolution-role-chip status-${role.status}${role.status === 'running' ? ' subcard-running-pulse' : ''}`}
                >
                  <strong>{role.label}</strong>
                  <span>{role.currentAction}</span>
                </div>
              ))}
            </div>
            <div class="evolution-discussion-feed">
              {recentDiscussion.length > 0 ? recentDiscussion.map((entry) => (
                <article key={entry.id}>
                  <strong>{entry.author}</strong>
                  <p>{entry.text}</p>
                </article>
              )) : (
                <div class="evolution-empty-note">暂无讨论。启动 Demo 或放入需求文档后，产品/设计/架构/开发/测试/运维会在这里汇总。</div>
              )}
            </div>
            <div class="evolution-message-composer">
              <select value={targetRole} onChange={(event) => setTargetRole((event.currentTarget as HTMLSelectElement).value as 'all' | EvolutionRoleId)}>
                <option value="all">全部角色</option>
                {EVOLUTION_ROLE_IDS.map((roleId) => <option key={roleId} value={roleId}>{roleLabel(roleId)}</option>)}
              </select>
              <input
                value={message}
                onInput={(event) => setMessage((event.currentTarget as HTMLInputElement).value)}
                placeholder={projection ? '给角色补充一句指令…' : '启动一次自我进化后即可聊天…'}
              />
              <button class="btn btn-primary" disabled={!projection || !message.trim()} onClick={handleSend}>发送</button>
            </div>
          </section>

          <section class="evolution-control-card">
            <div class="evolution-control-card-head">
              <div>
                <h2>设计产物</h2>
                <p>低保真、高保真、Taste Skill 输出和设计交付。</p>
              </div>
            </div>
            <div class="evolution-artifact-list">
              {designArtifacts.length > 0 ? designArtifacts.map((artifact) => (
                <article key={artifact.id}>
                  <span>{artifactKindLabel(artifact.kind)}</span>
                  <strong>{artifact.title ?? artifact.id}</strong>
                  <code title={artifact.path}>{compactPath(artifact.path)}</code>
                </article>
              )) : (
                <div class="evolution-empty-note">等待 UX / Visual Designer 产出。接入 taste-skill 后，高保真结果会显示在这里。</div>
              )}
            </div>
          </section>
        </div>

        <div class="evolution-control-grid lower">
          <section class="evolution-control-card">
            <div class="evolution-control-card-head">
              <div>
                <h2>开发交付状态</h2>
                <p>OpenSpec 任务、Auto Deliver、Staging 和发布门禁。</p>
              </div>
            </div>
            <div class="evolution-delivery-facts">
              <div><span>OpenSpec</span><strong>{projection?.linkedOpenSpecChange ?? '等待任务清单'}</strong></div>
              <div><span>Auto Deliver</span><strong>{projection?.autoDelivery?.enabled ? projection.autoDelivery.presetId : '未启动'}</strong></div>
              <div><span>Staging</span><strong>{projection?.stagingDelivery?.status ?? 'not_configured'}</strong></div>
              <div><span>Release Gate</span><strong>{projection?.stage === 'human_release_gate' ? '等待确认' : '未到达'}</strong></div>
            </div>
            <div class="evolution-artifact-list compact">
              {deliveryArtifacts.length > 0 ? deliveryArtifacts.map((artifact) => (
                <article key={artifact.id}>
                  <span>{artifactKindLabel(artifact.kind)}</span>
                  <strong>{artifact.title ?? artifact.id}</strong>
                  <code title={artifact.path}>{compactPath(artifact.path)}</code>
                </article>
              )) : (
                <div class="evolution-empty-note">开发/部署产物会在任务进入实现和交付阶段后出现。</div>
              )}
            </div>
          </section>

          <section class="evolution-control-card">
            <div class="evolution-control-card-head">
              <div>
                <h2>实时执行</h2>
                <p>角色动作、命令、产物和门禁事件。</p>
              </div>
            </div>
            <div class="evolution-event-feed">
              {recentEvents.length > 0 ? recentEvents.map((event) => (
                <article key={event.id} class={`severity-${event.severity}`}>
                  <strong>{event.title}</strong>
                  <p>{event.detail}</p>
                  <span>{event.source} · {formatTime(event.createdAt)}</span>
                </article>
              )) : (
                <div class="evolution-empty-note">暂无实时事件。启动后这里会显示多 agents 的执行和交付过程。</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

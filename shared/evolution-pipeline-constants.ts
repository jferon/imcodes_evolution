export const EVOLUTION_PIPELINE_PROTOCOL_NAMESPACE = 'evolution_pipeline' as const;

export const EVOLUTION_PIPELINE_MSG = {
  LAUNCH: 'evolution_pipeline.launch',
  LAUNCH_ACK: 'evolution_pipeline.launch_ack',
  LAUNCH_DEMO: 'evolution_pipeline.launch_demo',
  LAUNCH_DEMO_ACK: 'evolution_pipeline.launch_demo_ack',
  LAUNCH_ERROR: 'evolution_pipeline.launch_error',
  STATUS_REQUEST: 'evolution_pipeline.status_request',
  STATUS_PROJECTION: 'evolution_pipeline.status_projection',
  SCAN_INBOX: 'evolution_pipeline.scan_inbox',
  SCAN_INBOX_ACK: 'evolution_pipeline.scan_inbox_ack',
  SET_INBOX_DIRECTORY: 'evolution_pipeline.set_inbox_directory',
  SET_INBOX_DIRECTORY_ACK: 'evolution_pipeline.set_inbox_directory_ack',
  IMPORT_REFERENCES: 'evolution_pipeline.import_references',
  IMPORT_REFERENCES_ACK: 'evolution_pipeline.import_references_ack',
  CHECK_STAGING: 'evolution_pipeline.check_staging',
  CHECK_STAGING_ACK: 'evolution_pipeline.check_staging_ack',
  UPDATE_ROLE_SKILL: 'evolution_pipeline.update_role_skill',
  UPDATE_ROLE_SKILL_ACK: 'evolution_pipeline.update_role_skill_ack',
  APPROVE_ROLE_SKILL_CANDIDATE: 'evolution_pipeline.approve_role_skill_candidate',
  APPROVE_ROLE_SKILL_CANDIDATE_ACK: 'evolution_pipeline.approve_role_skill_candidate_ack',
  PROJECTION: 'evolution_pipeline.projection',
  STOP: 'evolution_pipeline.stop',
  STOP_ACK: 'evolution_pipeline.stop_ack',
  CONTINUE: 'evolution_pipeline.continue',
  CONTINUE_ACK: 'evolution_pipeline.continue_ack',
  USER_MESSAGE: 'evolution_pipeline.user_message',
  ARTIFACT_WRITTEN: 'evolution_pipeline.artifact_written',
  TERMINAL: 'evolution_pipeline.terminal',
} as const;

export type EvolutionPipelineMsgType = (typeof EVOLUTION_PIPELINE_MSG)[keyof typeof EVOLUTION_PIPELINE_MSG];

export const EVOLUTION_REQUIREMENT_INBOX_DIR = '.imcodes/inbox/requirements' as const;
export const EVOLUTION_RUN_ROOT_DIR = '.imc/evolution' as const;

export const EVOLUTION_REQUIREMENT_FILE_EXTENSIONS = ['.md', '.txt', '.json'] as const;
export type EvolutionRequirementFileExtension = (typeof EVOLUTION_REQUIREMENT_FILE_EXTENSIONS)[number];

export const EVOLUTION_REQUEST_ID_MAX_BYTES = 128 as const;
export const EVOLUTION_RUN_ID_MAX_BYTES = 128 as const;
export const EVOLUTION_SOURCE_PATH_MAX_BYTES = 512 as const;
export const EVOLUTION_ARTIFACT_PATH_MAX_BYTES = 1024 as const;
export const EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS = 256 * 1024;
export const EVOLUTION_REQUIREMENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const EVOLUTION_BLOCKING_QUESTIONS_MAX = 50 as const;
export const EVOLUTION_EVIDENCE_ITEMS_MAX = 200 as const;
export const EVOLUTION_DISCUSSION_ITEMS_MAX = 300 as const;
export const EVOLUTION_ARTIFACTS_MAX = 200 as const;
export const EVOLUTION_SCORE_MAX = 10 as const;

export const EVOLUTION_STAGES = [
  'detected',
  'intake_normalized',
  'product_discussion',
  'prd_ready',
  'design_lofi',
  'design_hifi',
  'architecture_baseline',
  'tasks_ready',
  'implementation_loop',
  'qa_completion',
  'delivery_ready',
  'deployed_staging',
  'human_release_gate',
  'deployed_production',
  'needs_human',
  'failed',
  'stopped',
] as const;
export type EvolutionStage = (typeof EVOLUTION_STAGES)[number];

export const EVOLUTION_TERMINAL_STAGES = ['deployed_production', 'failed', 'stopped'] as const;
export type EvolutionTerminalStage = (typeof EVOLUTION_TERMINAL_STAGES)[number];

export const EVOLUTION_HUMAN_GATE_STAGES = ['needs_human', 'human_release_gate'] as const;
export type EvolutionHumanGateStage = (typeof EVOLUTION_HUMAN_GATE_STAGES)[number];

export const EVOLUTION_ROLE_IDS = [
  'loop_supervisor',
  'product_manager',
  'product_critic',
  'ux_designer',
  'visual_designer',
  'tech_director',
  'backend_developer',
  'frontend_developer',
  'qa_engineer',
  'security_reviewer',
  'ops_release_manager',
] as const;
export type EvolutionRoleId = (typeof EVOLUTION_ROLE_IDS)[number];

export const EVOLUTION_ROLE_STATUSES = ['pending', 'running', 'waiting', 'blocked', 'complete', 'failed'] as const;
export type EvolutionRoleStatus = (typeof EVOLUTION_ROLE_STATUSES)[number];

export const EVOLUTION_DISCUSSION_MESSAGE_KINDS = ['system', 'role_update', 'artifact_summary', 'user_message', 'gate'] as const;
export type EvolutionDiscussionMessageKind = (typeof EVOLUTION_DISCUSSION_MESSAGE_KINDS)[number];

export const EVOLUTION_ROUNDTABLE_STATUSES = ['planned', 'running', 'complete', 'failed', 'skipped'] as const;
export type EvolutionRoundtableStatus = (typeof EVOLUTION_ROUNDTABLE_STATUSES)[number];

export const EVOLUTION_ROUNDTABLE_GATE_MODES = ['planning', 'strict'] as const;
export type EvolutionRoundtableGateMode = (typeof EVOLUTION_ROUNDTABLE_GATE_MODES)[number];

export const EVOLUTION_DESIGN_TARGET_SURFACES = ['auto', 'mobile', 'pc', 'both'] as const;
export type EvolutionDesignTargetSurface = (typeof EVOLUTION_DESIGN_TARGET_SURFACES)[number];

export const EVOLUTION_ARTIFACT_KINDS = [
  'input',
  'normalized_requirement',
  'prd',
  'user_stories',
  'acceptance_criteria',
  'prd_review',
  'ux_flow',
  'wireframe',
  'lofi_mockup',
  'hifi_spec',
  'hifi_mockup',
  'taste_hifi_prompt',
  'taste_hifi_output',
  'taste_hifi_reference',
  'taste_hifi_log',
  'project_style_audit',
  'design_reference_manifest',
  'design_reference_image',
  'design_handoff',
  'architecture_baseline',
  'adr',
  'openspec_proposal',
  'openspec_design',
  'openspec_tasks',
  'openspec_spec',
  'implementation_task_matrix',
  'test_plan',
  'test_cases',
  'test_evidence',
  'deployment_plan',
  'staging_setup',
  'staging_config_example',
  'staging_config_check',
  'staging_deploy_log',
  'rollback_plan',
  'release_notes',
  'release_gate',
  'role_skill',
  'role_skill_approval_record',
  'role_skill_library',
  'role_skill_release_candidate',
  'role_skill_revision',
  'role_instruction_response',
  'roundtable_review',
  'discussion',
  'evidence',
] as const;
export type EvolutionArtifactKind = (typeof EVOLUTION_ARTIFACT_KINDS)[number];

export const EVOLUTION_ARTIFACT_PREVIEW_TYPES = ['markdown', 'text', 'svg', 'image'] as const;
export type EvolutionArtifactPreviewType = (typeof EVOLUTION_ARTIFACT_PREVIEW_TYPES)[number];

export const EVOLUTION_STAGING_DELIVERY_STATUSES = ['not_configured', 'disabled', 'ready', 'running', 'passed', 'failed'] as const;
export type EvolutionStagingDeliveryStatus = (typeof EVOLUTION_STAGING_DELIVERY_STATUSES)[number];

export const EVOLUTION_SCORE_MODULE_IDS = [
  'product',
  'design',
  'architecture',
  'tasks',
  'implementation',
  'tests',
  'delivery',
  'risk',
] as const;
export type EvolutionScoreModuleId = (typeof EVOLUTION_SCORE_MODULE_IDS)[number];

export const EVOLUTION_VERDICTS = ['PASS', 'REWORK', 'BLOCKED'] as const;
export type EvolutionVerdict = (typeof EVOLUTION_VERDICTS)[number];

export const EVOLUTION_AUTO_DELIVER_PRESET_IDS = ['fast', 'standard', 'strict', 'deep'] as const;
export type EvolutionAutoDeliverPresetId = (typeof EVOLUTION_AUTO_DELIVER_PRESET_IDS)[number];

export const EVOLUTION_STAGE_TRANSITIONS = {
  detected: ['intake_normalized', 'needs_human', 'failed', 'stopped'],
  intake_normalized: ['product_discussion', 'needs_human', 'failed', 'stopped'],
  product_discussion: ['prd_ready', 'needs_human', 'failed', 'stopped'],
  prd_ready: ['design_lofi', 'needs_human', 'failed', 'stopped'],
  design_lofi: ['design_hifi', 'needs_human', 'failed', 'stopped'],
  design_hifi: ['architecture_baseline', 'needs_human', 'failed', 'stopped'],
  architecture_baseline: ['tasks_ready', 'needs_human', 'failed', 'stopped'],
  tasks_ready: ['implementation_loop', 'needs_human', 'failed', 'stopped'],
  implementation_loop: ['qa_completion', 'tasks_ready', 'needs_human', 'failed', 'stopped'],
  qa_completion: ['delivery_ready', 'implementation_loop', 'needs_human', 'failed', 'stopped'],
  delivery_ready: ['deployed_staging', 'human_release_gate', 'needs_human', 'failed', 'stopped'],
  deployed_staging: ['human_release_gate', 'needs_human', 'failed', 'stopped'],
  human_release_gate: ['deployed_production', 'needs_human', 'failed', 'stopped'],
  deployed_production: [],
  needs_human: ['intake_normalized', 'product_discussion', 'prd_ready', 'design_lofi', 'design_hifi', 'architecture_baseline', 'tasks_ready', 'implementation_loop', 'qa_completion', 'delivery_ready', 'stopped'],
  failed: [],
  stopped: [],
} as const satisfies Record<EvolutionStage, readonly EvolutionStage[]>;

export function isEvolutionStage(value: unknown): value is EvolutionStage {
  return typeof value === 'string' && (EVOLUTION_STAGES as readonly string[]).includes(value);
}

export function isEvolutionTerminalStage(value: unknown): value is EvolutionTerminalStage {
  return typeof value === 'string' && (EVOLUTION_TERMINAL_STAGES as readonly string[]).includes(value);
}

export function canTransitionEvolutionStage(from: EvolutionStage, to: EvolutionStage): boolean {
  return (EVOLUTION_STAGE_TRANSITIONS[from] as readonly EvolutionStage[]).includes(to);
}

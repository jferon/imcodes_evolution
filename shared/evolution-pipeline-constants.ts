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
  GATE_ACTION: 'evolution_pipeline.gate_action',
  GATE_ACTION_ACK: 'evolution_pipeline.gate_action_ack',
  ROLE_CATALOG_REQUEST: 'evolution_pipeline.role_catalog_request',
  ROLE_CATALOG: 'evolution_pipeline.role_catalog',
  USER_MESSAGE: 'evolution_pipeline.user_message',
  ARTIFACT_WRITTEN: 'evolution_pipeline.artifact_written',
  TERMINAL: 'evolution_pipeline.terminal',
} as const;

export type EvolutionPipelineMsgType = (typeof EVOLUTION_PIPELINE_MSG)[keyof typeof EVOLUTION_PIPELINE_MSG];

export const EVOLUTION_REQUIREMENT_INBOX_DIR = '.imcodes/inbox/requirements' as const;
export const EVOLUTION_RUN_ROOT_DIR = '.imc/evolution' as const;

export const EVOLUTION_REQUIREMENT_FILE_EXTENSIONS = ['.md', '.txt', '.json'] as const;
export type EvolutionRequirementFileExtension = (typeof EVOLUTION_REQUIREMENT_FILE_EXTENSIONS)[number];
/**
 * Manuscript/reference image extensions accepted by the passive inbox watcher.
 * Images are watcher inputs only — a run's source document stays text; an
 * images-only drop gets a synthesized brief as its source.
 */
export const EVOLUTION_REQUIREMENT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
export type EvolutionRequirementImageExtension = (typeof EVOLUTION_REQUIREMENT_IMAGE_EXTENSIONS)[number];

export const EVOLUTION_REQUEST_ID_MAX_BYTES = 128 as const;
export const EVOLUTION_RUN_ID_MAX_BYTES = 128 as const;
export const EVOLUTION_SOURCE_PATH_MAX_BYTES = 512 as const;
export const EVOLUTION_ARTIFACT_PATH_MAX_BYTES = 1024 as const;
export const EVOLUTION_ARTIFACT_PREVIEW_MAX_CHARS = 256 * 1024;
export const EVOLUTION_REQUIREMENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Separate ceiling for requirement images: the 8MB text-document limit was
 * never an image-size decision, and a modern phone's manuscript photo or a
 * scanned page can legitimately exceed it.
 */
export const EVOLUTION_REQUIREMENT_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
export const EVOLUTION_BLOCKING_QUESTIONS_MAX = 50 as const;
export const EVOLUTION_EVIDENCE_ITEMS_MAX = 200 as const;
export const EVOLUTION_DISCUSSION_ITEMS_MAX = 300 as const;
export const EVOLUTION_ARTIFACTS_MAX = 200 as const;
export const EVOLUTION_LIVE_EVENTS_MAX = 160 as const;
/**
 * Roundtable spec id for the hard visual-fidelity gate at design_hifi.
 * Shared because both the orchestrator (spec definition) and the P2P bridge
 * (helper-eligibility + dedicated-spawn fallback) must reference the same id.
 */
export const EVOLUTION_VISUAL_FIDELITY_ROUNDTABLE_ID = 'visual-fidelity-review' as const;
/**
 * Roundtable spec id for the real Design Maker attempt at design_lofi: a
 * governed-mode agent turn that produces ui-spec.json, a self-contained HTML
 * preview, and design-system tokens — replacing "deterministic template with
 * a role label" as the source of high-fidelity design artifacts.
 */
export const EVOLUTION_DESIGN_MAKER_ROUNDTABLE_ID = 'design-maker' as const;
/**
 * Roundtable spec id for the real Product Maker attempt at intake_normalized:
 * a governed-mode agent turn that authors the PRD (goals, user stories,
 * acceptance criteria) instead of the deterministic template.
 */
export const EVOLUTION_PRODUCT_MAKER_ROUNDTABLE_ID = 'product-maker' as const;

/**
 * Honest assurance label for approval actors in deployments without an
 * authenticated identity provider: the actor string is client-supplied and
 * NOT independently verified. Votes carrying this label are local
 * acknowledgements, never proof of independent multi-party approval.
 */
export const EVOLUTION_APPROVAL_ACTOR_ASSURANCE_UNVERIFIED_LOCAL = 'unverified_local' as const;
/**
 * Versioned per-project policy consumed by unattended (watcher/API) launches.
 * Without a policy file, watcher launches keep the safe defaults: governed
 * execution, strict gates, hifi human approval, fail-closed helpers.
 */
export const EVOLUTION_PROJECT_POLICY_RELATIVE_PATH = '.imc/evolution/policy.json' as const;
export const EVOLUTION_PROJECT_POLICY_VERSION = 1 as const;
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
  'visual_fidelity_checker',
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

export const EVOLUTION_DEVELOPMENT_MODES = ['brownfield_refactor', 'greenfield_new_system'] as const;
export type EvolutionDevelopmentMode = (typeof EVOLUTION_DEVELOPMENT_MODES)[number];

export const EVOLUTION_EXECUTION_POLICIES = ['draft_preview', 'governed'] as const;
export type EvolutionExecutionPolicy = (typeof EVOLUTION_EXECUTION_POLICIES)[number];

export const EVOLUTION_ASSURANCE_LEVELS = [
  'pipeline_draft',
  'legacy_unverified',
  'observed',
  'agent_attested',
  'checker_verified',
  'human_approved',
  'waived',
] as const;
export type EvolutionAssuranceLevel = (typeof EVOLUTION_ASSURANCE_LEVELS)[number];

export const EVOLUTION_ARTIFACT_STATUSES = ['draft', 'candidate', 'rejected', 'approved', 'superseded'] as const;
export type EvolutionArtifactStatus = (typeof EVOLUTION_ARTIFACT_STATUSES)[number];

export const EVOLUTION_SCORE_SOURCES = ['heuristic', 'agent', 'checker', 'human'] as const;
export type EvolutionScoreSource = (typeof EVOLUTION_SCORE_SOURCES)[number];

export const EVOLUTION_ROLE_SOURCES = ['builtin', 'project', 'custom_user'] as const;
export type EvolutionRoleSource = (typeof EVOLUTION_ROLE_SOURCES)[number];

export const EVOLUTION_ATTEMPT_KINDS = ['maker', 'checker', 'foundation', 'implementation', 'verification'] as const;
export type EvolutionAttemptKind = (typeof EVOLUTION_ATTEMPT_KINDS)[number];

export const EVOLUTION_ATTEMPT_STATUSES = ['planned', 'running', 'passed', 'rework', 'blocked', 'failed', 'cancelled'] as const;
export type EvolutionAttemptStatus = (typeof EVOLUTION_ATTEMPT_STATUSES)[number];

export const EVOLUTION_GATE_KINDS = [
  'product_review',
  'design_review',
  'architecture_review',
  'planning_review',
  'development_mode',
  'external_infrastructure',
  'production_release',
] as const;
export type EvolutionGateKind = (typeof EVOLUTION_GATE_KINDS)[number];

export const EVOLUTION_GATE_STATUSES = ['open', 'approved', 'rejected', 'waived', 'superseded'] as const;
export type EvolutionGateStatus = (typeof EVOLUTION_GATE_STATUSES)[number];

export const EVOLUTION_GATE_ACTIONS = ['approve', 'request_changes', 'waive'] as const;
export type EvolutionGateAction = (typeof EVOLUTION_GATE_ACTIONS)[number];

export const EVOLUTION_GREENFIELD_TOPOLOGIES = ['monolith', 'modular_monolith', 'services'] as const;
export type EvolutionGreenfieldTopology = (typeof EVOLUTION_GREENFIELD_TOPOLOGIES)[number];

export const EVOLUTION_EXTERNAL_ACTION_CLASSES = [
  'local_only',
  'sandbox_write',
  'external_preview',
  'shared_environment',
  'production',
] as const;
export type EvolutionExternalActionClass = (typeof EVOLUTION_EXTERNAL_ACTION_CLASSES)[number];

/** Protocol marker used by the War Room to request a fresh high-fidelity maker pass. */
export const EVOLUTION_HIFI_REDESIGN_MESSAGE_PREFIX = '[EVOLUTION_HIFI_REDESIGN]' as const;

export const EVOLUTION_ARTIFACT_KINDS = [
  'input',
  'requirement_classification',
  'normalized_requirement',
  'prd',
  'user_stories',
  'acceptance_criteria',
  'prd_review',
  'product_review_report',
  'ux_flow',
  'wireframe',
  'lofi_mockup',
  'hifi_spec',
  'hifi_mockup',
  'taste_hifi_prompt',
  'taste_hifi_output',
  'taste_hifi_reference',
  'taste_hifi_log',
  'visual_fidelity_report',
  'ui_spec',
  'design_system_tokens',
  'hifi_preview_html',
  'ui_preview_screenshot',
  'visual_report',
  'project_style_audit',
  'design_reference_manifest',
  'design_reference_image',
  'design_handoff',
  'architecture_baseline',
  'adr',
  'openspec_proposal',
  'openspec_design',
  'openspec_tasks',
  'task_assignment_manifest',
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

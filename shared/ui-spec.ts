/**
 * UI Evolution Engine — shared UI Spec intermediate protocol.
 *
 * Agents do not hand each other free-form prose for UI structure; they
 * exchange a validated `ui-spec.json`. The Design Maker produces it, the
 * Visual QA checker reviews rendered output against it, and the frontend
 * implementation later consumes the approved revision.
 *
 * The visual report is the checker's machine-readable output: a 0-100 score
 * plus actionable errors. It rides inside the existing roundtable summary as
 * an HTML-comment marker (same convention as `EVOLUTION_VERDICT`), so no
 * transport change is needed.
 */

export const UI_SPEC_VERSION = 1 as const;

/** Logical (promoted) artifact paths inside a run directory. */
export const UI_SPEC_RELATIVE_PATH = 'design/ui-spec.json' as const;
export const UI_PREVIEW_HTML_RELATIVE_PATH = 'design/preview.html' as const;
export const DESIGN_SYSTEM_TOKENS_RELATIVE_PATH = 'design/design-system/tokens.json' as const;
export const UI_VISUAL_REPORT_RELATIVE_PATH = 'design/visual-report.json' as const;

/** Bounded generate→render→review→fix loop: stop retrying at this score. */
export const UI_VISUAL_REPORT_PASS_THRESHOLD = 90 as const;

export const UI_VISUAL_ERROR_TYPES = [
  'layout',
  'color',
  'typography',
  'spacing',
  'component',
  'content',
  'interaction',
] as const;
export type UiVisualErrorType = (typeof UI_VISUAL_ERROR_TYPES)[number];

export interface UiSpecViewport {
  width: number;
  height: number;
}

export interface UiSpecComponent {
  type: string;
  title?: string;
  /** Free-form component props — validated for JSON-shape only. */
  props?: Record<string, unknown>;
  children?: UiSpecComponent[];
}

export interface UiSpecScreen {
  name: string;
  viewport: UiSpecViewport;
  /** Route or preview anchor identifying the screen in the rendered preview. */
  path?: string;
  components: UiSpecComponent[];
}

export interface UiSpecDocument {
  version: typeof UI_SPEC_VERSION;
  page: {
    name: string;
    type: string;
  };
  design: {
    style: string;
    /** Run-relative path to the design-system tokens this spec assumes. */
    tokensRef?: string;
  };
  layout?: Record<string, unknown>;
  screens: UiSpecScreen[];
}

export interface UiVisualError {
  type: UiVisualErrorType;
  issue: string;
  fix: string;
  screen?: string;
}

export interface UiVisualReport {
  score: number;
  errors: UiVisualError[];
  /** Which evidence the score is based on — honest-assurance labeling. */
  basis: 'rendered_screenshot' | 'preview_source' | 'spec_only';
  summary?: string;
}

export interface UiSpecValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export type UiSpecValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: UiSpecValidationIssue[] };

function issue(code: string, message: string, path?: string): UiSpecValidationIssue {
  return { code, message, ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, max = 300): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

const MAX_SCREENS = 24;
const MAX_COMPONENTS_PER_SCREEN = 200;
const MAX_COMPONENT_DEPTH = 8;

function validateComponent(
  value: unknown,
  path: string,
  depth: number,
  issues: UiSpecValidationIssue[],
  counter: { count: number },
): UiSpecComponent | null {
  if (!isRecord(value)) {
    issues.push(issue('invalid_component', 'Component must be an object.', path));
    return null;
  }
  if (depth > MAX_COMPONENT_DEPTH) {
    issues.push(issue('component_too_deep', `Component nesting exceeds ${MAX_COMPONENT_DEPTH}.`, path));
    return null;
  }
  counter.count += 1;
  if (counter.count > MAX_COMPONENTS_PER_SCREEN) {
    issues.push(issue('too_many_components', `Screen exceeds ${MAX_COMPONENTS_PER_SCREEN} components.`, path));
    return null;
  }
  if (!isNonEmptyString(value.type, 80)) {
    issues.push(issue('invalid_component_type', 'Component type must be a short non-empty string.', `${path}.type`));
    return null;
  }
  const component: UiSpecComponent = { type: value.type.trim() };
  if (value.title !== undefined) {
    if (!isNonEmptyString(value.title)) {
      issues.push(issue('invalid_component_title', 'Component title must be a non-empty string.', `${path}.title`));
    } else {
      component.title = value.title.trim();
    }
  }
  if (value.props !== undefined) {
    if (!isRecord(value.props)) {
      issues.push(issue('invalid_component_props', 'Component props must be an object.', `${path}.props`));
    } else {
      component.props = value.props;
    }
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) {
      issues.push(issue('invalid_component_children', 'Component children must be an array.', `${path}.children`));
    } else {
      const children: UiSpecComponent[] = [];
      for (const [index, child] of value.children.entries()) {
        const validated = validateComponent(child, `${path}.children[${index}]`, depth + 1, issues, counter);
        if (validated) children.push(validated);
      }
      component.children = children;
    }
  }
  return component;
}

export function validateUiSpecDocument(value: unknown): UiSpecValidationResult<UiSpecDocument> {
  const issues: UiSpecValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [issue('invalid_ui_spec', 'UI spec must be a JSON object.')] };
  if (value.version !== UI_SPEC_VERSION) {
    issues.push(issue('unsupported_ui_spec_version', `UI spec version must be ${UI_SPEC_VERSION}.`, 'version'));
  }
  if (!isRecord(value.page) || !isNonEmptyString(value.page.name) || !isNonEmptyString(value.page.type, 60)) {
    issues.push(issue('invalid_page', 'page.name and page.type are required non-empty strings.', 'page'));
  }
  if (!isRecord(value.design) || !isNonEmptyString(value.design.style, 60)) {
    issues.push(issue('invalid_design', 'design.style is a required non-empty string.', 'design'));
  }
  if (isRecord(value.design) && value.design.tokensRef !== undefined && !isNonEmptyString(value.design.tokensRef, 200)) {
    issues.push(issue('invalid_tokens_ref', 'design.tokensRef must be a run-relative path string.', 'design.tokensRef'));
  }
  if (value.layout !== undefined && !isRecord(value.layout)) {
    issues.push(issue('invalid_layout', 'layout must be an object when present.', 'layout'));
  }
  const screens: UiSpecScreen[] = [];
  if (!Array.isArray(value.screens) || value.screens.length === 0) {
    issues.push(issue('missing_screens', 'At least one screen is required.', 'screens'));
  } else if (value.screens.length > MAX_SCREENS) {
    issues.push(issue('too_many_screens', `UI spec exceeds ${MAX_SCREENS} screens.`, 'screens'));
  } else {
    for (const [index, rawScreen] of value.screens.entries()) {
      const path = `screens[${index}]`;
      if (!isRecord(rawScreen)) {
        issues.push(issue('invalid_screen', 'Screen must be an object.', path));
        continue;
      }
      if (!isNonEmptyString(rawScreen.name)) {
        issues.push(issue('invalid_screen_name', 'Screen name is required.', `${path}.name`));
        continue;
      }
      const viewport = rawScreen.viewport;
      if (
        !isRecord(viewport)
        || typeof viewport.width !== 'number' || !Number.isInteger(viewport.width) || viewport.width < 200 || viewport.width > 7680
        || typeof viewport.height !== 'number' || !Number.isInteger(viewport.height) || viewport.height < 200 || viewport.height > 7680
      ) {
        issues.push(issue('invalid_viewport', 'Screen viewport width/height must be integers in [200, 7680].', `${path}.viewport`));
        continue;
      }
      const screen: UiSpecScreen = {
        name: rawScreen.name.trim(),
        viewport: { width: viewport.width, height: viewport.height },
        components: [],
      };
      if (rawScreen.path !== undefined) {
        if (!isNonEmptyString(rawScreen.path, 200)) {
          issues.push(issue('invalid_screen_path', 'Screen path must be a non-empty string.', `${path}.path`));
        } else {
          screen.path = rawScreen.path.trim();
        }
      }
      if (!Array.isArray(rawScreen.components)) {
        issues.push(issue('missing_screen_components', 'Screen components must be an array.', `${path}.components`));
        continue;
      }
      const counter = { count: 0 };
      for (const [componentIndex, rawComponent] of rawScreen.components.entries()) {
        const validated = validateComponent(rawComponent, `${path}.components[${componentIndex}]`, 1, issues, counter);
        if (validated) screen.components.push(validated);
      }
      screens.push(screen);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  const record = value as unknown as UiSpecDocument;
  return {
    ok: true,
    value: {
      version: UI_SPEC_VERSION,
      page: { name: record.page.name.trim(), type: record.page.type.trim() },
      design: {
        style: record.design.style.trim(),
        ...(record.design.tokensRef ? { tokensRef: record.design.tokensRef.trim() } : {}),
      },
      ...(record.layout ? { layout: record.layout } : {}),
      screens,
    },
    issues: [],
  };
}

export function validateUiVisualReport(value: unknown): UiSpecValidationResult<UiVisualReport> {
  const issues: UiSpecValidationIssue[] = [];
  if (!isRecord(value)) return { ok: false, issues: [issue('invalid_visual_report', 'Visual report must be a JSON object.')] };
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
    issues.push(issue('invalid_score', 'score must be a number in [0, 100].', 'score'));
  }
  const basis = value.basis;
  if (basis !== 'rendered_screenshot' && basis !== 'preview_source' && basis !== 'spec_only') {
    issues.push(issue('invalid_basis', 'basis must be rendered_screenshot | preview_source | spec_only.', 'basis'));
  }
  const errors: UiVisualError[] = [];
  if (!Array.isArray(value.errors)) {
    issues.push(issue('invalid_errors', 'errors must be an array.', 'errors'));
  } else if (value.errors.length > 100) {
    issues.push(issue('too_many_errors', 'errors exceeds 100 entries.', 'errors'));
  } else {
    for (const [index, rawError] of value.errors.entries()) {
      const path = `errors[${index}]`;
      if (!isRecord(rawError)) {
        issues.push(issue('invalid_error', 'Error entry must be an object.', path));
        continue;
      }
      if (!(UI_VISUAL_ERROR_TYPES as readonly string[]).includes(rawError.type as string)) {
        issues.push(issue('invalid_error_type', `Error type must be one of: ${UI_VISUAL_ERROR_TYPES.join(', ')}.`, `${path}.type`));
        continue;
      }
      if (!isNonEmptyString(rawError.issue, 500) || !isNonEmptyString(rawError.fix, 500)) {
        issues.push(issue('invalid_error_detail', 'Error issue and fix are required non-empty strings.', path));
        continue;
      }
      const error: UiVisualError = {
        type: rawError.type as UiVisualErrorType,
        issue: rawError.issue.trim(),
        fix: rawError.fix.trim(),
      };
      if (rawError.screen !== undefined && isNonEmptyString(rawError.screen)) error.screen = rawError.screen.trim();
      errors.push(error);
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      score: Math.round((value.score as number) * 10) / 10,
      errors,
      basis: basis as UiVisualReport['basis'],
      ...(isNonEmptyString(value.summary, 2000) ? { summary: (value.summary as string).trim() } : {}),
    },
    issues: [],
  };
}

/**
 * Machine-readable marker the Visual QA checker embeds in its roundtable
 * summary (same HTML-comment convention as `EVOLUTION_VERDICT`), e.g.:
 * `<!-- UI_VISUAL_REPORT: {"score":72,"basis":"preview_source","errors":[...]} -->`
 */
export const UI_VISUAL_REPORT_MARKER_RE = /<!--\s*UI_VISUAL_REPORT:\s*(\{[\s\S]*?\})\s*-->/i;

export function parseUiVisualReportMarker(summary: string | undefined | null): UiVisualReport | null {
  if (!summary) return null;
  const match = summary.match(UI_VISUAL_REPORT_MARKER_RE);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    const validated = validateUiVisualReport(parsed);
    return validated.ok ? validated.value : null;
  } catch {
    return null;
  }
}

export function formatUiVisualReportMarker(report: UiVisualReport): string {
  return `<!-- UI_VISUAL_REPORT: ${JSON.stringify(report)} -->`;
}

/** Actionable feedback text for the maker's next regeneration attempt. */
export function renderUiVisualReportFeedback(report: UiVisualReport): string {
  const lines = [
    `Visual QA score: ${report.score}/100 (pass threshold ${UI_VISUAL_REPORT_PASS_THRESHOLD}, basis: ${report.basis}).`,
  ];
  for (const error of report.errors) {
    lines.push(`- [${error.type}]${error.screen ? ` (${error.screen})` : ''} ${error.issue} → ${error.fix}`);
  }
  if (report.summary) lines.push(report.summary);
  return lines.join('\n');
}

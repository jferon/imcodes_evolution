import { useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { EvolutionProjection } from '@shared/evolution-pipeline-types.js';

interface Props {
  projection: EvolutionProjection | null;
  continuePending?: boolean;
  /** Signature of the blocker set the user already dismissed (null = none). */
  dismissedSignature: string | null;
  onDismiss: (signature: string) => void;
  onContinue: (message: string) => void;
  onOpenWarRoom: () => void;
}

/**
 * Popup shown (over the Evolution console and session views) when a run
 * blocks on needs_human: lists the blocking reasons and offers a one-click
 * confirm. Open typed gates (e.g. high-fidelity design review) intentionally
 * route to the War Room instead of a blind confirm — those gates exist so a
 * human REVIEWS something before approving.
 */
export function EvolutionBlockingDialog({
  projection,
  continuePending,
  dismissedSignature,
  onDismiss,
  onContinue,
  onOpenWarRoom,
}: Props) {
  const { t } = useTranslation();
  const blocked = projection && projection.stage === 'needs_human' && projection.blockingQuestions.length > 0;
  const openGates = useMemo(
    () => (projection?.gates ?? []).filter((gate) => gate.status === 'open'),
    [projection],
  );
  const signature = useMemo(() => {
    if (!blocked || !projection) return null;
    const questionIds = projection.blockingQuestions.map((question) => question.id).sort();
    const gateIds = openGates.map((gate) => gate.id).sort();
    return `${projection.runId}|${questionIds.join(',')}|${gateIds.join(',')}`;
  }, [blocked, projection, openGates]);

  if (!blocked || !projection || !signature || signature === dismissedSignature) return null;

  const hasOpenGate = openGates.length > 0;
  const dismiss = () => onDismiss(signature);

  return (
    <div class="ask-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div class="ask-dialog" data-testid="evolution-blocking-dialog">
        <div class="ask-question-block">
          <div class="ask-header">{t('evolution.blocking_header', { defaultValue: 'Self-Evolution · Human intervention required' })}</div>
          <div class="ask-question">
            {t('evolution.blocking_intro', {
              defaultValue: 'Run {{runId}} is paused at needs_human. Reasons:',
              runId: projection.runId,
            })}
          </div>
        </div>
        <div class="ask-question-block">
          {projection.blockingQuestions.map((question) => (
            <div key={question.id} class="ask-question">
              <strong>[{question.stage}]</strong> {question.question}
            </div>
          ))}
          {openGates.map((gate) => (
            <div key={gate.id} class="ask-question">
              <strong>{t('evolution.blocking_gate_row', { defaultValue: 'Typed gate pending: {{kind}}', kind: gate.kind })}</strong>
              {' '}
              {t('evolution.blocking_gate_hint', { defaultValue: 'Review and decide in the War Room (previews and gate actions live there).' })}
            </div>
          ))}
        </div>
        <div class="ask-actions">
          <button class="btn" onClick={dismiss}>
            {t('evolution.blocking_later', { defaultValue: 'Later' })}
          </button>
          {hasOpenGate ? (
            <button
              class="btn btn-primary"
              onClick={() => {
                onOpenWarRoom();
                dismiss();
              }}
            >
              {t('evolution.blocking_open_war_room', { defaultValue: 'Open War Room' })}
            </button>
          ) : (
            <button
              class="btn btn-primary"
              disabled={continuePending === true}
              onClick={() => {
                onContinue(t('evolution.blocking_continue_message', { defaultValue: 'Confirmed from the blocking dialog; please continue.' }));
                dismiss();
              }}
            >
              {continuePending
                ? t('evolution.blocking_continuing', { defaultValue: 'Continuing…' })
                : t('evolution.blocking_confirm', { defaultValue: 'Confirm & continue' })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

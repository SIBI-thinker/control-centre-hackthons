'use client';

import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from 'lucide-react';

export type DraftOption = { key: string; id?: string; label: string; body: string };
export type DraftField = {
  key: string;
  id?: string;
  kind: 'text' | 'choice';
  label: string;
  help: string;
  required: boolean;
  maxLength: number;
  options: DraftOption[];
};

/**
 * A textarea that grows to fit what is in it.
 *
 * A problem statement can be several paragraphs; typing it into a fixed
 * four-row box means editing it through a letterbox. Capped so one long
 * statement can't push everything else off the dialog.
 */
function GrowingTextarea({ maxHeight = 420, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  }, [props.value, maxHeight]);

  return <textarea ref={ref} {...props} />;
}

export const MAX_FIELDS = 10;
const MAX_OPTIONS = 60;

/**
 * Builds the form a phase asks its teams to fill in: long written answers, and
 * a problem-statement selector whose choices are themselves long.
 */
export function PhaseFormEditor({
  fields,
  onChange,
  newKey,
  editingExisting,
}: {
  fields: DraftField[];
  onChange: (fields: DraftField[]) => void;
  newKey: () => string;
  editingExisting: boolean;
}) {
  const update = (index: number, patch: Partial<DraftField>) => {
    const next = fields.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= fields.length) return;
    const next = fields.slice();
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };

  const addField = (kind: 'text' | 'choice') => {
    if (fields.length >= MAX_FIELDS) return;
    onChange(
      fields.concat({
        key: newKey(),
        kind,
        label: '',
        help: '',
        required: false,
        maxLength: kind === 'text' ? 5000 : 200,
        options: kind === 'choice' ? [{ key: newKey(), label: '', body: '' }] : [],
      })
    );
  };

  const removeField = (index: number) => {
    const field = fields[index];
    if (field.id && !confirm('Remove this question? Every team’s answer to it is deleted.')) return;
    onChange(fields.filter((_, i) => i !== index));
  };

  return (
    <div className="phase-field">
      <div className="phase-field-head">
        <span><ListChecks size={13} /> Form questions <b className="form-count">{fields.length}/{MAX_FIELDS}</b></span>
        <span className="row-actions">
          <button type="button" className="inline-dismiss" onClick={() => addField('text')} disabled={fields.length >= MAX_FIELDS}>
            <Plus size={11} /> Written answer
          </button>
          <button type="button" className="inline-dismiss" onClick={() => addField('choice')} disabled={fields.length >= MAX_FIELDS}>
            <Plus size={11} /> Problem statement
          </button>
        </span>
      </div>

      {fields.length === 0 && (
        <span className="panel-hint">
          Optional. Teams fill these in on their own page while the phase is running, and their answers are frozen when it
          ends.
        </span>
      )}

      {fields.map((field, index) => (
        <div key={field.key} className="form-question">
          <div className="form-question-head">
            <span className="form-question-num">{index + 1}</span>
            <span className={'form-question-kind ' + field.kind}>
              {field.kind === 'choice' ? 'PICK ONE' : 'WRITTEN'}
            </span>
            <input
              className="form-question-label"
              value={field.label}
              maxLength={200}
              placeholder={field.kind === 'choice' ? 'Choose your problem statement' : 'Describe your solution'}
              onChange={(e) => update(index, { label: e.target.value })}
            />
            <button type="button" className="icon-danger" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up">
              <ArrowUp size={13} />
            </button>
            <button type="button" className="icon-danger" onClick={() => move(index, 1)} disabled={index === fields.length - 1} aria-label="Move down">
              <ArrowDown size={13} />
            </button>
            <button type="button" className="icon-danger" onClick={() => removeField(index)} aria-label="Remove question">
              <Trash2 size={13} />
            </button>
          </div>

          {/* A textarea, not an input: this allows 2000 characters, and a long
              line in a single-line box just runs off the side. */}
          <GrowingTextarea
            className="form-question-help"
            value={field.help}
            maxLength={2000}
            rows={2}
            maxHeight={260}
            placeholder="Guidance shown under the question (optional)"
            onChange={(e) => update(index, { help: e.target.value })}
          />

          <div className="form-question-opts">
            <label className="form-toggle">
              <input type="checkbox" checked={field.required} onChange={(e) => update(index, { required: e.target.checked })} />
              Required
            </label>
            {field.kind === 'text' && (
              <label className="form-toggle">
                Limit
                <input
                  type="number"
                  min={100}
                  max={20000}
                  step={100}
                  value={field.maxLength}
                  onChange={(e) => update(index, { maxLength: Math.min(Math.max(Number(e.target.value) || 5000, 1), 20000) })}
                />
                characters
              </label>
            )}
          </div>

          {field.kind === 'choice' && (
            <div className="form-options">
              {field.options.map((option, optionIndex) => (
                <div key={option.key} className="form-option">
                  <div className="form-option-head">
                    <span className="form-option-letter">{String.fromCharCode(65 + optionIndex)}</span>
                    <input
                      value={option.label}
                      maxLength={200}
                      placeholder="Short title, e.g. Smart campus navigation"
                      onChange={(e) => {
                        const options = field.options.slice();
                        options[optionIndex] = { ...option, label: e.target.value };
                        update(index, { options });
                      }}
                    />
                    <button
                      type="button"
                      className="icon-danger"
                      aria-label="Remove choice"
                      onClick={() => {
                        if (option.id && !confirm('Remove this problem statement? Teams that chose it keep the title in the export, but lose the link to it.')) return;
                        update(index, { options: field.options.filter((_, i) => i !== optionIndex) });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <span className="form-option-caption">
                    Full statement — {option.body.length.toLocaleString('en-IN')} / 20,000 characters
                  </span>
                  <GrowingTextarea
                    className="form-option-body"
                    value={option.body}
                    maxLength={20000}
                    rows={4}
                    placeholder={'The full problem statement. As long as you need — participants see it in full, and the box grows as you type.'}
                    onChange={(e) => {
                      const options = field.options.slice();
                      options[optionIndex] = { ...option, body: e.target.value };
                      update(index, { options });
                    }}
                  />
                </div>
              ))}
              <button
                type="button"
                className="inline-dismiss"
                disabled={field.options.length >= MAX_OPTIONS}
                onClick={() => update(index, { options: field.options.concat({ key: newKey(), label: '', body: '' }) })}
              >
                <Plus size={11} /> Add problem statement
              </button>
            </div>
          )}
        </div>
      ))}

      {editingExisting && fields.some((f) => f.id) && (
        <span className="panel-hint">Rewording a question keeps the answers teams have already saved.</span>
      )}
    </div>
  );
}

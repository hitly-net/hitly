'use client'

import type { AnswerSchema } from '@hitly/core'

/**
 * The typed ask_user widget for one stored answerSchema (hitl-spec 3.4):
 * text input, radio group, checkbox group, or number input — ONE widget for
 * the ONE question of this request. hitl/v0 has no forms: a request with
 * several fields is several asks, each rendering its own widget here.
 *
 * Controlled by the answer form (the reviewer's input must survive a refusal,
 * spec 7), and purely presentational otherwise: the host re-validates the
 * submitted answer against the STORED schema.
 */
export function AnswerSchemaFields({
  schema,
  value,
  onChange,
}: {
  schema: AnswerSchema
  value: unknown
  onChange: (value: unknown) => void
}) {
  switch (schema.type) {
    case 'text':
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Your answer</span>
          <input
            type="text"
            name="answer_text"
            data-testid="answer-widget"
            data-answer-type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      )
    case 'single':
      return (
        <fieldset className="flex flex-col gap-1 text-sm" data-testid="answer-widget" data-answer-type="single">
          <legend className="font-medium">Pick one</legend>
          {(schema.options ?? []).map((option) => (
            <label key={option.value} className="flex items-start gap-2">
              <input
                type="radio"
                name="answer_single"
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              <span>
                {option.label}
                {option.description ? <span className="block text-xs text-zinc-500">{option.description}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      )
    case 'multi':
      return (
        <fieldset className="flex flex-col gap-1 text-sm" data-testid="answer-widget" data-answer-type="multi">
          <legend className="font-medium">Pick any that apply</legend>
          {(schema.options ?? []).map((option) => {
            const selected = Array.isArray(value) && value.includes(option.value)
            return (
              <label key={option.value} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  name="answer_multi"
                  value={option.value}
                  checked={selected}
                  onChange={(event) => {
                    const current = Array.isArray(value) ? (value as string[]) : []
                    onChange(
                      event.target.checked
                        ? [...new Set([...current, option.value])]
                        : current.filter((item) => item !== option.value),
                    )
                  }}
                />
                <span>
                  {option.label}
                  {option.description ? <span className="block text-xs text-zinc-500">{option.description}</span> : null}
                </span>
              </label>
            )
          })}
        </fieldset>
      )
    case 'number': {
      const bounds = schema.bounds ?? {}
      return (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            Your answer{bounds.unit ? <span className="text-zinc-500"> ({bounds.unit})</span> : null}
          </span>
          <input
            type="number"
            name="answer_number"
            data-testid="answer-widget"
            data-answer-type="number"
            value={typeof value === 'number' || typeof value === 'string' ? value : ''}
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            onChange={(event) => onChange(event.target.value)}
            className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          {bounds.min !== undefined || bounds.max !== undefined ? (
            <span className="text-xs text-zinc-500">
              Accepted: {bounds.min ?? '-∞'} … {bounds.max ?? '∞'}
              {bounds.unit ? ` ${bounds.unit}` : ''}
            </span>
          ) : null}
        </label>
      )
    }
    default:
      // binary/secret are not offered by ask_user v0 (approvals use
      // request_approval; secret needs encryption). Render nothing rather
      // than a free-text box that would pretend otherwise.
      return null
  }
}

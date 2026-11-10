'use client'

import type { AnswerSchema } from '@hitly/core'
import { AnswerSchemaFields } from './answer-schema-fields'
import { buildAnswerJson } from '@/lib/answer-form-helpers'

/**
 * The respond controls of the answer form, split out so the rendering rules
 * are testable without an app router:
 *
 * - stored `answerSchema` (ask_user): the matching typed widget (text input,
 *   radios, checkboxes, number input) plus the hidden `answer` JSON. hitl/v0
 *   renders ONE widget for the ONE question — no multi-field form exists.
 * - no stored schema + respond allowed: the legacy single free-text
 *   "Response" box (in-flight asks created before answerSchema persisted).
 *
 * The value is controlled by AnswerForm so a refusal keeps the reviewer's
 * input (hitl-spec 7); the host re-validates against the stored schema.
 */
export function AnswerSection({
  respondAllowed,
  answerSchema,
  value,
  onChange,
}: {
  respondAllowed: boolean
  answerSchema?: AnswerSchema
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (!respondAllowed) return null
  if (answerSchema) {
    return (
      <>
        <AnswerSchemaFields schema={answerSchema} value={value} onChange={onChange} />
        <input
          type="hidden"
          name="answer"
          data-testid="answer-json"
          value={buildAnswerJson(answerSchema, value)}
        />
      </>
    )
  }
  return (
    <input
      name="response"
      placeholder="Response"
      className="h-10 rounded-md border border-zinc-200 px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
    />
  )
}

/**
 * Local copy of the hitl/v0 answer-type vocabulary, mirroring
 * `packages/core/src/answer-schema.ts` (same arrangement as the local `jcs.ts`
 * copy): the MCP server ships standalone and must not depend on @hitly/core.
 * The HOST is authoritative; these names are what we map MCP input onto and
 * what the inbox renders. Keep in sync with the core module.
 */

export type HitlyAnswerType = 'text' | 'single' | 'multi' | 'number' | 'binary'

/** Accepted MCP `answerSchema.type` inputs mapped onto the spec `answerType`. */
export const ANSWER_TYPE_ALIASES: Record<string, HitlyAnswerType> = {
  text: 'text',
  free_text: 'text',
  single: 'single',
  single_choice: 'single',
  multi: 'multi',
  multi_choice: 'multi',
  number: 'number',
  binary: 'binary',
}

/** Plain-language rejection for the removed `simple_form` (hitl/v0 has no forms). */
export const FORM_REJECTION_MESSAGE =
  'simple_form is not supported in v0. hitl/v0 is one request per field: send a separate ask_user for each question (one prompt, one answerSchema). A later release may add forms.'

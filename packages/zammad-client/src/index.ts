/**
 * `@hitly/zammad-client` — main entry point.
 *
 * This entry can read Zammad and write replies/notes/ticket attributes and KB
 * DRAFTS only. It has NO publish method and NO method that edits an existing
 * KB answer. Publishing and live-answer edits live exclusively in
 * `@hitly/zammad-client/publisher`, which ONLY `execute_approved` may import
 * (see README.md; pinned by entry-guards.test.ts).
 */
export {
  createZammadClient,
  type ZammadClient,
  type ZammadClientConfig,
  type ZammadHttpMethod,
} from './client.ts'
export { DEFAULT_BACKOFF_MS, isRetryableStatus } from './request.ts'
export {
  ZammadApiError,
  ZammadHashMismatchError,
  ZammadResponseShapeError,
  ZammadTransportError,
} from './errors.ts'
export type {
  KbDraftAnswerParams,
  PublicEmailReplyParams,
  TicketUpdateFields,
  ZammadArticle,
  ZammadKbAnswer,
  ZammadKbAnswerAssets,
  ZammadKbAnswerTranslation,
  ZammadKbAnswerTranslationContent,
  ZammadKbSearchResult,
  ZammadObjectManagerAttribute,
  ZammadSearchResult,
  ZammadState,
  ZammadTicket,
  ZammadUser,
} from './types.ts'

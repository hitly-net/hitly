/**
 * `@hitly/zammad-client` — main entry point.
 *
 * This entry can read Zammad and write replies/notes/ticket attributes and KB
 * DRAFTS only. It has NO publish method, NO method that edits an existing KB
 * answer, and its confined `rawRequest` refuses KB answer write paths before
 * any network call. Publishing and live-answer edits live exclusively in
 * `@hitly/zammad-client/publisher`, which ONLY `execute_approved` may import
 * (see README.md; pinned by entry-guards.test.ts).
 *
 * The package is self-contained: it imports nothing from other @hitly
 * workspace packages.
 */
export {
  createZammadClient,
  type ZammadClient,
  type ZammadClientConfig,
  type ZammadHttpMethod,
} from './client.ts'
export {
  DEFAULT_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  isRetryableStatus,
} from './request.ts'
export {
  ZammadApiError,
  ZammadKbWriteGuardError,
  ZammadResponseShapeError,
  ZammadTransportError,
} from './errors.ts'
export {
  SUPPORT_TICKET_TYPES,
  isSupportTicketType,
  supportTicketTypeOptions,
  type SupportTicketType,
} from './ticket-types.ts'
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

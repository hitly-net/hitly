import { ZammadKbWriteGuardError } from './errors.ts'
import {
  buildRequest,
  enc,
  isKbAnswerWritePath,
  type ZammadClientConfig,
  type ZammadHttpMethod,
  type ZammadRawRequest,
} from './request.ts'
import type {
  KbDraftAnswerParams,
  PublicEmailReplyParams,
  TicketUpdateFields,
  ZammadArticle,
  ZammadKbAnswer,
  ZammadKbSearchResult,
  ZammadSearchResult,
  ZammadTicket,
} from './types.ts'

export type { ZammadClientConfig, ZammadHttpMethod } from './request.ts'

/**
 * Main (safe) Zammad client. It can read tickets/articles/KB and write
 * replies, notes, ticket attributes and KB DRAFTS.
 *
 * It has NO publish method and NO method that edits an existing KB answer,
 * and it CANNOT reach such a path even via `rawRequest`: writes to
 * .../knowledge_bases/.../answers... and the publish/internal/archive/
 * unarchive actions are refused with ZammadKbWriteGuardError before any
 * network call. Those surfaces live only in `@hitly/zammad-client/publisher`
 * (execute_approved only; README + entry-guards.test.ts).
 *
 * The API token is taken ONLY from the constructor config (per-instance
 * tokens: triage, accounts, security, finance, general, librarian,
 * kb-publisher). The client never reads any global env var.
 */
export interface ZammadClient {
  /**
   * Escape hatch for admin/API surfaces the typed methods do not cover (e.g.
   * Object Manager reads/writes on Ticket attributes). CONFINED: any write
   * (POST/PUT/PATCH/DELETE) targeting a KB answer path or a KB publish/
   * internal/archive/unarchive action is refused with
   * ZammadKbWriteGuardError — no fetch is made. Non-idempotent raw POSTs
   * retry on 429 only (never on 5xx).
   */
  rawRequest<T>(method: ZammadHttpMethod, path: string, body?: unknown): Promise<T>

  getTicket(id: number): Promise<ZammadTicket>
  listArticles(ticketId: number): Promise<ZammadArticle[]>
  addPublicEmailReply(ticketId: number, reply: PublicEmailReplyParams): Promise<ZammadArticle>
  addInternalNote(ticketId: number, body: string): Promise<ZammadArticle>
  updateTicket(id: number, fields: TicketUpdateFields): Promise<ZammadTicket>
  searchTickets(query: string): Promise<ZammadSearchResult>
  kbSearch(query: string): Promise<ZammadKbSearchResult>
  kbGetAnswer(kbId: number, answerId: number): Promise<ZammadKbAnswer>
  kbCreateDraftAnswer(kbId: number, params: KbDraftAnswerParams): Promise<ZammadKbAnswer>
}

export function createZammadClient(config: ZammadClientConfig): ZammadClient {
  const request = buildRequest(config)

  const guardedRawRequest: ZammadRawRequest = <T>(
    method: ZammadHttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    if (isKbAnswerWritePath(method, path)) {
      return Promise.reject(new ZammadKbWriteGuardError({ method, path }))
    }
    return request<T>(method, path, body)
  }

  return {
    rawRequest: guardedRawRequest,

    async getTicket(id) {
      return request<ZammadTicket>('GET', `/api/v1/tickets/${enc(id)}`)
    },

    async listArticles(ticketId) {
      return request<ZammadArticle[]>('GET', `/api/v1/tickets/${enc(ticketId)}/articles`)
    },

    async addPublicEmailReply(ticketId, reply) {
      // Non-idempotent POST: retried on 429 only (never 5xx) — an article
      // that Zammad already stored must not be sent to the customer twice.
      return request<ZammadArticle>('POST', `/api/v1/tickets/${enc(ticketId)}/articles`, {
        type: 'email',
        internal: false,
        to: reply.to,
        subject: reply.subject ?? null,
        body: reply.body,
        content_type: reply.contentType,
      })
    },

    async addInternalNote(ticketId, body) {
      return request<ZammadArticle>('POST', `/api/v1/tickets/${enc(ticketId)}/articles`, {
        type: 'note',
        internal: true,
        body,
      })
    },

    async updateTicket(id, fields) {
      // Pass-through of the given attributes only (state/owner_id/hitly_type/
      // any custom field). Zammad merges them onto the ticket.
      return request<ZammadTicket>('PUT', `/api/v1/tickets/${enc(id)}`, { ...fields })
    },

    async searchTickets(query) {
      // paginate=false asks Zammad to return all matches in one page.
      // // VERIFY against Zammad 7.2 when TEST exists
      return request<ZammadSearchResult>(
        'GET',
        `/api/v1/tickets/search?query=${encodeURIComponent(query)}&paginate=false`,
      )
    },

    async kbSearch(query) {
      // // VERIFY against Zammad 7.2 when TEST exists (posts bucket shape)
      return request<ZammadKbSearchResult>('GET', `/api/v1/knowledge_bases/search?query=${encodeURIComponent(query)}`)
    },

    async kbGetAnswer(kbId, answerId) {
      return request<ZammadKbAnswer>('GET', `/api/v1/knowledge_bases/${enc(kbId)}/answers/${enc(answerId)}`)
    },

    async kbCreateDraftAnswer(kbId, params) {
      const translation: Record<string, unknown> = {
        title: params.title,
        content_attributes: { body: params.body },
      }
      if (params.kbLocaleId !== undefined) translation.kb_locale_id = params.kbLocaleId
      // Creating an answer does NOT publish it: published_at stays null until
      // the publish action, which only the publisher entry point exposes.
      // Non-idempotent POST: 429-only retry.
      // // VERIFY against Zammad 7.2 when TEST exists (draft semantics)
      return request<ZammadKbAnswer>('POST', `/api/v1/knowledge_bases/${enc(kbId)}/answers`, {
        category_id: params.categoryId,
        translations_attributes: [translation],
      })
    },
  }
}

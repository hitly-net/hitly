import { buildRequest, enc, type ZammadClientConfig, type ZammadHttpMethod, type ZammadRawRequest } from './request.ts'
import type {
  PublicEmailReplyParams,
  KbDraftAnswerParams,
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
 * It deliberately has NO publish method and NO method that edits an existing
 * KB answer. Those live in `@hitly/zammad-client/publisher`, which only
 * `execute_approved` may import (see README + entry-guards.test.ts).
 */
export interface ZammadClient {
  /**
   * Escape hatch for admin/API surfaces the typed methods do not cover yet
   * (e.g. Object Manager). Prefer adding a typed method for support flows.
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

  return {
    rawRequest: request,

    async getTicket(id) {
      return request<ZammadTicket>('GET', `/api/v1/tickets/${enc(id)}`)
    },

    async listArticles(ticketId) {
      return request<ZammadArticle[]>('GET', `/api/v1/tickets/${enc(ticketId)}/articles`)
    },

    async addPublicEmailReply(ticketId, reply) {
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
      // POST .../publish, which only the publisher entry point exposes.
      // // VERIFY against Zammad 7.2 when TEST exists (draft semantics)
      return request<ZammadKbAnswer>('POST', `/api/v1/knowledge_bases/${enc(kbId)}/answers`, {
        category_id: params.categoryId,
        translations_attributes: [translation],
      })
    },
  }
}

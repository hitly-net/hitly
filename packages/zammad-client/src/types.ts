/**
 * Response and request shapes for the Zammad REST API.
 * Field sets are intentionally loose (`[key: string]: unknown`) because Zammad
 * deployments carry custom attributes; the fields we rely on are typed.
 * Where the official docs leave a shape or parameter ambiguous, the field
 * carries a `// VERIFY against Zammad 7.2 when TEST exists` marker.
 */

export interface ZammadState {
  id: number
  name: string
  [key: string]: unknown
}

export interface ZammadUser {
  id: number
  firstname?: string
  lastname?: string
  email?: string
  login?: string
  [key: string]: unknown
}

/** GET /api/v1/tickets/{id} */
export interface ZammadTicket {
  id: number
  ticket_no?: string | number
  title?: string
  state_id?: number
  state?: ZammadState
  group_id?: number
  customer_id?: number
  owner_id?: number | null
  owner?: ZammadUser | null
  priority_id?: number
  /** Latest-article summary; exact shape not pinned by the docs. */
  // VERIFY against Zammad 7.2 when TEST exists
  article?: unknown
  updates?: number
  number_of_articles?: number
  created_at?: string
  updated_at?: string
  last_update_at?: string
  /** HITLy support ticket type (custom select attribute, see setup script). */
  hitly_type?: string
  [key: string]: unknown
}

/** An article (reply/note) on a ticket. */
export interface ZammadArticle {
  id: number
  ticket_id: number
  type?: string
  internal?: boolean
  from?: string
  to?: string | string[] | null
  cc?: string | string[] | null
  subject?: string | null
  body?: string
  content_type?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

/** Params for addPublicEmailReply. */
export interface PublicEmailReplyParams {
  /** Recipient address(es) as Zammad expects them (string form). */
  to: string
  subject?: string
  body: string
  /** e.g. 'text/plain' or 'text/html'. */
  contentType: string
}

/**
 * Body for updateTicket (PUT /api/v1/tickets/{id}). `state` is the state NAME
 * (Zammad accepts names), `owner_id` the agent user id (null unassigns).
 * Any additional ticket attribute (custom fields included) can be passed
 * through the index signature.
 */
export interface TicketUpdateFields {
  state?: string
  owner_id?: number | null
  hitly_type?: string
  [customField: string]: unknown
}

/**
 * GET /api/v1/tickets/search
 * Docs show `{ tickets: [ids], tickets_count }`.
 * // VERIFY against Zammad 7.2 when TEST exists
 */
export interface ZammadSearchResult {
  tickets: number[]
  tickets_count: number
  [key: string]: unknown
}

/**
 * GET /api/v1/knowledge_bases/search
 * Docs/community show `{ posts: { answer: [...], ticket: [...], ... } }`.
 * // VERIFY against Zammad 7.2 when TEST exists
 */
export interface ZammadKbSearchResult {
  posts: Record<string, unknown>
  [key: string]: unknown
}

/**
 * One entry of `assets.KnowledgeBaseAnswerTranslation` inside a KB answer
 * response. `content_id` points into `assets.KnowledgeBaseAnswerTranslationContent`.
 */
export interface ZammadKbAnswerTranslation {
  id: number
  answer_id?: number
  kb_locale_id?: number
  title?: string
  content_id?: number
  [key: string]: unknown
}

/** One entry of `assets.KnowledgeBaseAnswerTranslationContent`. */
export interface ZammadKbAnswerTranslationContent {
  id: number
  body?: string
  [key: string]: unknown
}

/** Asset graph collections returned by the KB answers endpoints. */
export interface ZammadKbAnswerAssets {
  KnowledgeBaseAnswer?: Record<string, { id?: number; category_id?: number; translation_ids?: number[]; [key: string]: unknown }>
  KnowledgeBaseAnswerTranslation?: Record<string, ZammadKbAnswerTranslation>
  KnowledgeBaseAnswerTranslationContent?: Record<string, ZammadKbAnswerTranslationContent>
  [collection: string]: unknown
}

/**
 * GET/POST/PATCH /api/v1/knowledge_bases/.../answers[/{id}]
 * The answer itself; the human-readable text lives in the `assets` graph.
 */
export interface ZammadKbAnswer {
  id: number
  category_id?: number
  assets?: ZammadKbAnswerAssets
  [key: string]: unknown
}

/** Params for kbCreateDraftAnswer. */
export interface KbDraftAnswerParams {
  categoryId: number
  title: string
  body: string
  /**
   * KB locale id for the translation. When omitted, Zammad is expected to pick
   * the KB's primary locale.
   * // VERIFY against Zammad 7.2 when TEST exists
   */
  kbLocaleId?: number
}

/** One Object Manager attribute entry (GET /api/v1/object_manager_attributes). */
export interface ZammadObjectManagerAttribute {
  id: number
  object?: string
  name?: string
  display?: string
  data_type?: string
  active?: boolean
  options?: Record<string, string>
  [key: string]: unknown
}

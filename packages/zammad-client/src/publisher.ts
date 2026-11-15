/**
 * `@hitly/zammad-client/publisher` — the DANGEROUS entry point.
 *
 * POLICY: only `execute_approved` may import this module. Everything else
 * (apps, plugins, MCP tools, support flows) must use the main entry
 * `@hitly/zammad-client`, which has no publish/live-edit surface. The
 * kb-publisher API token goes ONLY to this entry point (constructor config),
 * never to a main-entry client (see README).
 *
 * Both write methods are hash-gated compare-and-swap operations:
 * - updateLiveAnswer re-reads the live body and REFUSES (typed
 *   ZammadHashMismatchError) unless it still hashes to expectedCurrentHash.
 * - publishAnswer requires the approvedContentHash approved in HITLy, reads
 *   the CURRENT DRAFT body and refuses with ZammadConflictError (status 409,
 *   no publish call) unless it hashes to it.
 * Both hashes are validated as exactly 64 hex chars (case-normalized) BEFORE
 * any network call.
 */
import { createHash } from 'node:crypto'
import { createZammadClient, type ZammadClient } from './client.ts'
import {
  ZammadConflictError,
  ZammadHashMismatchError,
  ZammadInvalidHashError,
  ZammadResponseShapeError,
} from './errors.ts'
import { buildRequest, enc, type ZammadClientConfig } from './request.ts'
import type { ZammadKbAnswer, ZammadKbAnswerTranslation } from './types.ts'

export { ZammadConflictError, ZammadHashMismatchError, ZammadInvalidHashError } from './errors.ts'

/** Lowercase hex sha256 over the UTF-8 bytes of `text` (the CAS hash). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Validate a caller-supplied content hash: exactly 64 hexadecimal characters
 * after trimming and case normalization. Empty, truncated, over-long and
 * non-hex values are refused with ZammadInvalidHashError BEFORE any network
 * call — a malformed hash must never silently skip a compare.
 */
export function normalizeContentHash(hash: unknown, field: string): string {
  if (typeof hash !== 'string') {
    throw new ZammadInvalidHashError({ field })
  }
  const normalized = hash.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ZammadInvalidHashError({ field })
  }
  return normalized
}

export interface ZammadPublisher extends ZammadClient {
  /**
   * Publish a (draft) KB answer ONLY if its current draft body still hashes
   * to `approvedContentHash` (the content hash approved in HITLy; exactly 64
   * hex chars, case-normalized). Refuses with ZammadConflictError (status
   * 409) and makes NO publish call on mismatch; refuses with
   * ZammadInvalidHashError before any network call on a malformed hash.
   */
  publishAnswer(
    kbId: number,
    answerId: number,
    approvedContentHash: string,
  ): Promise<ZammadKbAnswer>
  /**
   * Overwrite a live KB answer's body ONLY if its current body still hashes
   * to `expectedCurrentHash` (exactly 64 hex chars, case-normalized). Throws
   * ZammadHashMismatchError before touching Zammad if it differs.
   */
  updateLiveAnswer(
    kbId: number,
    answerId: number,
    newBody: string,
    expectedCurrentHash: string,
  ): Promise<ZammadKbAnswer>
}

/**
 * Publisher-capable client. Same config as createZammadClient (token from
 * constructor config only — for the kb-publisher instance token), plus the
 * two restricted KB-write methods. Import of this factory is restricted to
 * `execute_approved`.
 */
export function createZammadPublisher(config: ZammadClientConfig): ZammadPublisher {
  const base = createZammadClient(config)
  const request = buildRequest(config)

  function answerPath(kbId: number, answerId: number): string {
    return `/api/v1/knowledge_bases/${enc(kbId)}/answers/${enc(answerId)}`
  }

  /**
   * Locate the answer's CURRENT DRAFT translation row. The answer's
   * `translation_ids[0]` identifies the current (draft) translation; an
   * answer may carry older/published translation rows that must NOT be
   * hashed or patched.
   * // VERIFY against Zammad 7.2 when TEST exists (draft-translation ordering)
   */
  function findTranslation(
    answer: ZammadKbAnswer,
    kbId: number,
    answerId: number,
  ): ZammadKbAnswerTranslation {
    const translations = answer.assets?.KnowledgeBaseAnswerTranslation
    if (!translations) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path: answerPath(kbId, answerId),
        detail: 'no assets.KnowledgeBaseAnswerTranslation map',
      })
    }
    const entries = Object.values(translations)
    const answerRow = answer.assets?.KnowledgeBaseAnswer?.[String(answerId)]
    const draftId = answerRow?.translation_ids?.[0]
    let match: ZammadKbAnswerTranslation | undefined
    if (draftId !== undefined) {
      match = entries.find((t) => t.id === draftId)
    }
    if (!match) {
      const owned = entries.filter((t) => t.answer_id === answerId)
      // NEVER fall back to a foreign/older row: refuse rather than hash or
      // patch a translation that is not this answer's current one.
      if (owned.length === 1) match = owned[0]
    }
    if (!match || match.id === undefined) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path: answerPath(kbId, answerId),
        detail: 'no unambiguous current-draft KnowledgeBaseAnswerTranslation entry',
      })
    }
    return match
  }

  function findBody(answer: ZammadKbAnswer, contentId: number, answerId: number): string | undefined {
    const content = answer.assets?.KnowledgeBaseAnswerTranslationContent?.[String(contentId)]
    if (!content || typeof content.body !== 'string') return undefined
    return content.body
  }

  /**
   * Read the CURRENT DRAFT body text of an answer (same canonical form used
   * for both hash gates). The docs say to add `?include_contents=<id>` to
   * get the body; which id exactly (translation id vs content id) is
   * ambiguous in the docs tip.
   * // VERIFY against Zammad 7.2 when TEST exists
   */
  async function readLiveBody(
    kbId: number,
    answerId: number,
  ): Promise<{ body: string; translation: ZammadKbAnswerTranslation }> {
    const path = answerPath(kbId, answerId)
    let answer = await request<ZammadKbAnswer>('GET', path)
    const translation = findTranslation(answer, kbId, answerId)
    if (translation.content_id === undefined) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path,
        detail: 'translation row has no content_id',
      })
    }
    let body = findBody(answer, translation.content_id, answerId)
    if (body === undefined) {
      answer = await request<ZammadKbAnswer>('GET', `${path}?include_contents=${enc(translation.id)}`)
      body = findBody(answer, translation.content_id, answerId)
    }
    if (body === undefined) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path,
        detail: `no KnowledgeBaseAnswerTranslationContent body for content_id ${translation.content_id}`,
      })
    }
    return { body, translation }
  }

  return {
    ...base,

    async publishAnswer(kbId, answerId, approvedContentHash) {
      // Input validation BEFORE any network call.
      const expectedHash = normalizeContentHash(approvedContentHash, 'approvedContentHash')
      // Read + compare the CURRENT DRAFT content BEFORE any publish call.
      const { body } = await readLiveBody(kbId, answerId)
      const actualHash = sha256Hex(body)
      if (actualHash !== expectedHash) {
        throw new ZammadConflictError({
          kbId,
          answerId,
          approvedContentHash: expectedHash,
          actualHash,
        })
      }
      // The publish action is idempotent, so it keeps 5xx retries.
      return request<ZammadKbAnswer>(
        'POST',
        `${answerPath(kbId, answerId)}/publish`,
        undefined,
        { idempotent: true },
      )
    },

    async updateLiveAnswer(kbId, answerId, newBody, expectedCurrentHash) {
      // Input validation BEFORE any network call.
      const expectedHash = normalizeContentHash(expectedCurrentHash, 'expectedCurrentHash')
      const { body, translation } = await readLiveBody(kbId, answerId)
      const actualHash = sha256Hex(body)
      if (actualHash !== expectedHash) {
        throw new ZammadHashMismatchError({
          kbId,
          answerId,
          expectedCurrentHash: expectedHash,
          actualHash,
        })
      }
      // PATCH payload follows the docs Change example: translations_attributes
      // with the CURRENT translation row id + content_attributes.body.
      return request<ZammadKbAnswer>('PATCH', answerPath(kbId, answerId), {
        translations_attributes: [
          { id: translation.id, content_attributes: { body: newBody } },
        ],
      })
    },
  }
}

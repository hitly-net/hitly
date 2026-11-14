/**
 * `@hitly/zammad-client/publisher` — the DANGEROUS entry point.
 *
 * POLICY: only `execute_approved` may import this module. Everything else
 * (apps, plugins, MCP tools, support flows) must use the main entry
 * `@hitly/zammad-client`, which has no publish/live-edit surface.
 *
 * `updateLiveAnswer` is a compare-and-swap: it re-reads the live answer body,
 * sha256s it, and REFUSES the write (ZammadHashMismatchError) unless the live
 * hash equals the caller's `expectedCurrentHash`. That forces the approval
 * flow to have seen the exact text it is overwriting.
 */
import { createHash } from 'node:crypto'
import { createZammadClient, type ZammadClient } from './client.ts'
import { ZammadHashMismatchError, ZammadResponseShapeError } from './errors.ts'
import { buildRequest, enc, type ZammadClientConfig } from './request.ts'
import type { ZammadKbAnswer, ZammadKbAnswerTranslation } from './types.ts'

export { ZammadHashMismatchError } from './errors.ts'

/** Lowercase hex sha256 over the UTF-8 bytes of `text` (the CAS hash). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export interface ZammadPublisher extends ZammadClient {
  /** Publish a (draft) KB answer. */
  publishAnswer(kbId: number, answerId: number): Promise<ZammadKbAnswer>
  /**
   * Overwrite a live KB answer's body ONLY if its current body still hashes
   * to `expectedCurrentHash` (lowercase hex sha256). Throws
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
 * Publisher-capable client. Same config as createZammadClient, plus the two
 * write-to-live-KB methods. Import of this factory is restricted to
 * `execute_approved`.
 */
export function createZammadPublisher(config: ZammadClientConfig): ZammadPublisher {
  const base = createZammadClient(config)
  const request = buildRequest(config)

  /**
   * Locate the answer's translation row (gives the translation `id` needed by
   * the PATCH payload and the `content_id` keying into the content map).
   */
  function findTranslation(answer: ZammadKbAnswer, answerId: number): ZammadKbAnswerTranslation {
    const translations = answer.assets?.KnowledgeBaseAnswerTranslation
    if (!translations) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path: `/api/v1/knowledge_bases/.../answers/${answerId}`,
        detail: 'no assets.KnowledgeBaseAnswerTranslation map',
      })
    }
    const entries = Object.values(translations)
    const match = entries.find((t) => t.answer_id === answerId) ?? entries[0]
    if (!match || match.id === undefined) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path: `/api/v1/knowledge_bases/.../answers/${answerId}`,
        detail: 'no KnowledgeBaseAnswerTranslation entry',
      })
    }
    return match
  }

  function findBody(answer: ZammadKbAnswer, contentId: number, answerId: number): string {
    const content = answer.assets?.KnowledgeBaseAnswerTranslationContent?.[String(contentId)]
    if (!content || typeof content.body !== 'string') {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path: `/api/v1/knowledge_bases/.../answers/${answerId}`,
        detail: `no KnowledgeBaseAnswerTranslationContent body for content_id ${contentId}`,
      })
    }
    return content.body
  }

  /**
   * Read the current body text of an answer.
   * The docs say to add `?include_contents=<id>` to get the body; which id
   * exactly (translation id vs content id) is ambiguous in the docs tip.
   * // VERIFY against Zammad 7.2 when TEST exists
   */
  async function readLiveBody(kbId: number, answerId: number): Promise<{ body: string; translation: ZammadKbAnswerTranslation }> {
    const path = `/api/v1/knowledge_bases/${enc(kbId)}/answers/${enc(answerId)}`
    let answer = await request<ZammadKbAnswer>('GET', path)
    let translation = findTranslation(answer, answerId)
    if (translation.content_id === undefined) {
      throw new ZammadResponseShapeError({
        method: 'GET',
        path,
        detail: 'translation row has no content_id',
      })
    }
    let body: string | undefined
    try {
      body = findBody(answer, translation.content_id, answerId)
    } catch {
      body = undefined
    }
    if (body === undefined) {
      answer = await request<ZammadKbAnswer>('GET', `${path}?include_contents=${enc(translation.id)}`)
      body = findBody(answer, translation.content_id, answerId)
    }
    return { body, translation }
  }

  return {
    ...base,

    async publishAnswer(kbId, answerId) {
      return request<ZammadKbAnswer>(
        'POST',
        `/api/v1/knowledge_bases/${enc(kbId)}/answers/${enc(answerId)}/publish`,
      )
    },

    async updateLiveAnswer(kbId, answerId, newBody, expectedCurrentHash) {
      const { body, translation } = await readLiveBody(kbId, answerId)
      const actualHash = sha256Hex(body)
      if (actualHash !== expectedCurrentHash.toLowerCase()) {
        throw new ZammadHashMismatchError({
          kbId,
          answerId,
          expectedCurrentHash: expectedCurrentHash.toLowerCase(),
          actualHash,
        })
      }
      // PATCH payload follows the docs Change example: translations_attributes
      // with the translation row id + content_attributes.body.
      return request<ZammadKbAnswer>('PATCH', `/api/v1/knowledge_bases/${enc(kbId)}/answers/${enc(answerId)}`, {
        translations_attributes: [
          { id: translation.id, content_attributes: { body: newBody } },
        ],
      })
    },
  }
}

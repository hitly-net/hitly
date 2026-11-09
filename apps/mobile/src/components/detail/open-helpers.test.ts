import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  appendOpenedRef,
  localOpensForApproval,
  mergeOpenedRefs,
  shouldRecordOpen,
} from './open-helpers'

describe('mergeOpenedRefs (S10)', () => {
  it('hydrates from recorded opens when the screen has no local taps', () => {
    assert.deepEqual(mergeOpenedRefs(['policy', 'invoice'], []), ['policy', 'invoice'])
  })

  it('treats missing recorded opens as empty (legacy payloads)', () => {
    assert.deepEqual(mergeOpenedRefs(undefined, ['policy']), ['policy'])
    assert.deepEqual(mergeOpenedRefs(null, []), [])
  })

  it('unions recorded opens with this-visit taps and dedupes', () => {
    assert.deepEqual(mergeOpenedRefs(['policy'], ['policy', 'terms']), ['policy', 'terms'])
  })

  it('does not drop recorded opens just because the screen remounted with empty local state', () => {
    const remount = mergeOpenedRefs(['policy', 'terms'], [])
    assert.deepEqual(remount, ['policy', 'terms'])
    assert.equal(shouldRecordOpen('policy', remount), false)
    assert.equal(shouldRecordOpen('terms', remount), false)
  })
})

describe('shouldRecordOpen (S10)', () => {
  it('skips a second POST for a ref the reviewer already opened', () => {
    assert.equal(shouldRecordOpen('policy', ['policy']), false)
  })

  it('records a tap the reviewer has not opened yet', () => {
    assert.equal(shouldRecordOpen('terms', ['policy']), true)
  })
})

describe('appendOpenedRef', () => {
  it('appends a new ref and leaves an already-present ref unchanged', () => {
    assert.deepEqual(appendOpenedRef(['policy'], 'terms'), ['policy', 'terms'])
    assert.deepEqual(appendOpenedRef(['policy'], 'policy'), ['policy'])
  })
})

describe('localOpensForApproval', () => {
  it('keeps this-visit taps while the same approval is on screen', () => {
    assert.deepEqual(localOpensForApproval('apr_1', 'apr_1', ['policy']), ['policy'])
  })

  it('drops this-visit taps when the reviewer opens a different approval', () => {
    assert.deepEqual(localOpensForApproval('apr_2', 'apr_1', ['policy']), [])
  })
})

/**
 * M0h (PR hitly#106) support: the housekeeping scheduler's claim and the
 * audit-purge count flow through affectedRows(). (The expire sweep's
 * `expired` count no longer does: it counts rows won via a guarded
 * `UPDATE ... RETURNING id`.) The node-postgres driver returns a pg Result
 * whose count is `rowCount` - if this helper ever stops reading it, claims
 * silently fail. These vectors fail on revert.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { affectedRows } from './result'

describe('affectedRows', () => {
  it('reads the node-postgres Result rowCount (the driver actually used here)', () => {
    class PgResultLike {
      rowCount = 3
      command = 'UPDATE'
    }
    assert.equal(affectedRows(new PgResultLike()), 3)
    assert.equal(affectedRows({ rowCount: 1 }), 1)
    assert.equal(affectedRows({ rowCount: 0 }), 0)
  })

  it('still reads MySQL-style headers and [header, rows] tuples', () => {
    assert.equal(affectedRows({ affectedRows: 2 }), 2)
    assert.equal(affectedRows({ rowsAffected: 4 }), 4)
    assert.equal(affectedRows([{ affectedRows: 5 }, []]), 5)
  })

  it('is 0 for junk, null-ish and non-numeric counts', () => {
    assert.equal(affectedRows(null), 0)
    assert.equal(affectedRows(undefined), 0)
    assert.equal(affectedRows('UPDATE'), 0)
    assert.equal(affectedRows({ rowCount: 'x' }), 0)
    assert.equal(affectedRows({}), 0)
  })
})

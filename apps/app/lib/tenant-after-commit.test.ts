/**
 * afterTenantCommit must observe COMMIT. A read on another connection that
 * runs before COMMIT misses the row (the push badge flake).
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pg from 'pg'
import { workspaces } from '@hitly/db/schema'
import { newId } from './ids'
import { afterTenantCommit, flushAfterTenantCommitForTests, requireDb, withTenant } from './tenant'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required')

const reader = new pg.Client({ connectionString: process.env.DATABASE_URL })

describe('afterTenantCommit', { concurrency: false }, () => {
  const ids: string[] = []

  before(async () => {
    await reader.connect()
  })

  after(async () => {
    for (const id of ids) {
      await reader.query('delete from workspaces where id = $1', [id]).catch(() => undefined)
    }
    await reader.end()
  })

  it('sees the committed row from another connection and does not run inside withTenant', async () => {
    const id = newId('wsp')
    ids.push(id)
    let started = false
    let visible = false
    await withTenant(id, async () => {
      await requireDb().insert(workspaces).values({ id, name: 'After commit', slug: id })
      afterTenantCommit(async () => {
        started = true
        const result = await reader.query('select id from workspaces where id = $1', [id])
        visible = result.rowCount === 1
      })
      assert.equal(started, false)
    })
    assert.equal(started, false, 'detached work stays off the request that committed')
    await flushAfterTenantCommitForTests()
    assert.equal(started, true)
    assert.equal(visible, true, 'the read must see the committed workspace')
  })

  it('nested withTenant flushes after the outer commit', async () => {
    const id = newId('wsp')
    ids.push(id)
    let visible = false
    await withTenant(id, async () => {
      await requireDb().insert(workspaces).values({ id, name: 'Nested', slug: id })
      await withTenant(id, async () => {
        afterTenantCommit(async () => {
          const result = await reader.query('select id from workspaces where id = $1', [id])
          visible = result.rowCount === 1
        })
      })
      assert.equal(visible, false)
    })
    await flushAfterTenantCommitForTests()
    assert.equal(visible, true)
  })

  it('does not run detached work when the transaction rolls back', async () => {
    const id = newId('wsp')
    ids.push(id)
    let started = false
    await assert.rejects(
      withTenant(id, async () => {
        await requireDb().insert(workspaces).values({ id, name: 'Rolled back', slug: id })
        afterTenantCommit(async () => {
          started = true
        })
        throw new Error('boom')
      }),
      /boom/,
    )
    await flushAfterTenantCommitForTests()
    assert.equal(started, false)
    const result = await reader.query('select id from workspaces where id = $1', [id])
    assert.equal(result.rowCount, 0)
  })
})

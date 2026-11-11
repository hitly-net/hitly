/**
 * Last-admin / last-owner guard (lib/member-guard.ts), run against real
 * Postgres: the product rule is that a project always keeps at least one
 * admin and a workspace always keeps at least one owner, checked race-safe
 * inside the transaction (advisory xact lock per project).
 *
 * Run with: yarn db:up && yarn test
 */

// The last-admin decision seam only arms under NODE_ENV === 'test'
// (see setLastAdminDecisionHookForTests); opt this file's process in
// before any guard call runs.
;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { and, eq } from 'drizzle-orm'
import {
  memberships,
  projectMemberships,
  projects,
  users,
  workspaces,
} from '@hitly/db/schema'
import { db, pool } from './db'
import { newId } from './ids'
import {
  assertWorkspaceKeepsOwner,
  assertWorkspaceMemberRemovalKeepsProjectAdmins,
  guardProjectAdminChange,
  isLastAdminRow,
  LAST_PROJECT_ADMIN,
  LAST_WORKSPACE_OWNER,
  MembershipGuardError,
  setLastAdminDecisionHookForTests,
} from './member-guard'
import { requireDb, withTenant } from './tenant'

if (!db) {
  throw new Error('DATABASE_URL required for tests')
}
const database = db

const workspaceId = newId('wsp')
const owner = { id: newId('usr'), email: `owner-${workspaceId.slice(-8)}@example.com`, name: 'Owner' }
const adminA = { id: newId('usr'), email: `admA-${workspaceId.slice(-8)}@example.com`, name: 'Admin A' }
const adminB = { id: newId('usr'), email: `admB-${workspaceId.slice(-8)}@example.com`, name: 'Admin B' }
const soloAdmin = { id: newId('usr'), email: `solo-${workspaceId.slice(-8)}@example.com`, name: 'Solo Admin' }
const reader = { id: newId('usr'), email: `rd-${workspaceId.slice(-8)}@example.com`, name: 'Reader' }

async function addMember(user: { id: string; email: string; name: string }, role: 'owner' | 'admin' | 'member') {
  await database.insert(users).values({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await database.insert(memberships).values({
    id: newId('mem').slice(0, 36),
    workspaceId,
    userId: user.id,
    role,
    createdAt: new Date(),
  })
}

/** Creates a project with an admin membership for each given user id. */
async function makeProject(name: string, adminUserIds: string[]): Promise<string> {
  const projectId = newId('prj').slice(0, 36)
  await database.insert(projects).values({
    id: projectId,
    workspaceId,
    name,
    plugin: 'http',
    credentials: {},
    defaultSlaMinutes: '60',
  })
  for (const userId of adminUserIds) {
    await database.insert(projectMemberships).values({
      id: newId('pm').slice(0, 36),
      workspaceId,
      projectId,
      userId,
      role: 'admin',
    })
  }
  return projectId
}

async function addProjectMemberRow(projectId: string, userId: string, role: 'admin' | 'user' | 'reader') {
  await database.insert(projectMemberships).values({
    id: newId('pm').slice(0, 36),
    workspaceId,
    projectId,
    userId,
    role,
  })
}

async function membershipIdOf(projectId: string, userId: string): Promise<string> {
  const rows = await database
    .select({ id: projectMemberships.id })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error(`no membership for user on project ${projectId}`)
  return row.id
}

async function roleOf(projectId: string, userId: string) {
  const rows = await database
    .select({ role: projectMemberships.role })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId)))
    .limit(1)
  return rows[0]?.role
}

async function adminUserIdsOf(projectId: string): Promise<string[]> {
  const rows = await database
    .select({ userId: projectMemberships.userId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.role, 'admin')))
  return rows.map((row) => row.userId)
}

/** Mirrors the updateProjectMemberRole action: guard + update in one tx. */
function guardMembershipChange(projectId: string, membershipId: string, newRole: 'admin' | 'user' | 'reader') {
  return withTenant(workspaceId, async () => {
    const tx = requireDb()
    await guardProjectAdminChange({ projectId, membershipId, newRole })
    await tx.update(projectMemberships).set({ role: newRole }).where(eq(projectMemberships.id, membershipId))
  })
}

/** Mirrors the removeProjectMember action: guard + delete in one tx. */
function guardRemoval(projectId: string, membershipId: string) {
  return withTenant(workspaceId, async () => {
    const tx = requireDb()
    await guardProjectAdminChange({ projectId, membershipId })
    await tx.delete(projectMemberships).where(eq(projectMemberships.id, membershipId))
  })
}

before(async () => {
  await database.insert(workspaces).values({
    id: workspaceId,
    name: 'Guard test',
    slug: `guard-${workspaceId.slice(-8)}`,
  })
  await addMember(owner, 'owner')
  await addMember(adminA, 'admin')
  await addMember(adminB, 'admin')
  await addMember(soloAdmin, 'admin')
  await addMember(reader, 'member')
})

after(async () => {
  await database.delete(projectMemberships).where(eq(projectMemberships.workspaceId, workspaceId))
  await database.delete(projects).where(eq(projects.workspaceId, workspaceId))
  await database.delete(memberships).where(eq(memberships.workspaceId, workspaceId))
  for (const user of [owner, adminA, adminB, soloAdmin, reader]) {
    await database.delete(users).where(eq(users.id, user.id))
  }
  await database.delete(workspaces).where(eq(workspaces.id, workspaceId))
  await pool?.end()
})

describe('project last-admin guard', () => {
  it('refuses demoting the last admin and keeps the row unchanged', async () => {
    const projectId = await makeProject('Solo admin', [adminA.id])
    const membershipId = await membershipIdOf(projectId, adminA.id)
    await assert.rejects(
      () => guardMembershipChange(projectId, membershipId, 'user'),
      (error: unknown) =>
        error instanceof MembershipGuardError &&
        error.code === LAST_PROJECT_ADMIN &&
        error.status === 409 &&
        /only admin/i.test(error.message),
    )
    assert.equal(await roleOf(projectId, adminA.id), 'admin')
  })

  it('refuses removing the last admin (self-lockout) and keeps the row', async () => {
    const projectId = await makeProject('Solo admin remove', [adminA.id])
    const membershipId = await membershipIdOf(projectId, adminA.id)
    await assert.rejects(
      () => guardRemoval(projectId, membershipId),
      (error: unknown) => error instanceof MembershipGuardError && error.code === LAST_PROJECT_ADMIN,
    )
    assert.equal(await roleOf(projectId, adminA.id), 'admin')
  })

  it('allows demoting one of two admins', async () => {
    const projectId = await makeProject('Two admins', [adminA.id, adminB.id])
    const membershipId = await membershipIdOf(projectId, adminA.id)
    await guardMembershipChange(projectId, membershipId, 'user')
    assert.equal(await roleOf(projectId, adminA.id), 'user')
    assert.equal(await roleOf(projectId, adminB.id), 'admin')
  })

  it('allows promoting a non-admin to admin', async () => {
    const projectId = await makeProject('Promotion', [adminA.id])
    await addProjectMemberRow(projectId, reader.id, 'user')
    const membershipId = await membershipIdOf(projectId, reader.id)
    await guardMembershipChange(projectId, membershipId, 'admin')
    assert.equal(await roleOf(projectId, reader.id), 'admin')
  })

  it('allows removing a non-admin even when they are the only reader', async () => {
    const projectId = await makeProject('Reader removal', [adminA.id])
    await addProjectMemberRow(projectId, reader.id, 'reader')
    const membershipId = await membershipIdOf(projectId, reader.id)
    await guardRemoval(projectId, membershipId)
    assert.equal(await roleOf(projectId, reader.id), undefined)
  })

  it('refuses a membership row that belongs to another project', async () => {
    const other = await makeProject('Scope other', [adminA.id, adminB.id])
    const otherMembership = await membershipIdOf(other, adminB.id)
    // Same workspace, wrong project: the guard scopes the row to projectId.
    await assert.rejects(
      () =>
        withTenant(workspaceId, () =>
          guardProjectAdminChange({ projectId: 'prj-not-there', membershipId: otherMembership, newRole: 'reader' }),
        ),
      /Member not found/,
    )
  })

  it('serialises two concurrent demotions of the two admins: exactly one wins', async () => {
    const projectId = await makeProject('Race demote', [adminA.id, adminB.id])
    const mA = await membershipIdOf(projectId, adminA.id)
    const mB = await membershipIdOf(projectId, adminB.id)
    const results = await Promise.allSettled([
      guardMembershipChange(projectId, mA, 'user'),
      guardMembershipChange(projectId, mB, 'user'),
    ])
    const wins = results.filter((result) => result.status === 'fulfilled').length
    const refused = results.filter(
      (result) => result.status === 'rejected' && result.reason instanceof MembershipGuardError,
    ).length
    const unexpected = results.filter(
      (result) => result.status === 'rejected' && !(result.reason instanceof MembershipGuardError),
    )
    assert.equal(unexpected.length, 0, `no unexpected errors: ${JSON.stringify(unexpected.map(String))}`)
    assert.equal(wins, 1, `exactly one demotion commits, statuses ${results.map((r) => r.status)}`)
    assert.equal(refused, 1)
    assert.equal((await adminUserIdsOf(projectId)).length, 1, 'the project keeps exactly one admin')
  })

  it('concurrent remove-last-admin vs promote: the project never ends up adminless', async () => {
    const projectId = await makeProject('Race promote', [adminA.id])
    await addProjectMemberRow(projectId, reader.id, 'user')
    const mAdmin = await membershipIdOf(projectId, adminA.id)
    const mReader = await membershipIdOf(projectId, reader.id)
    const results = await Promise.allSettled([
      guardRemoval(projectId, mAdmin),
      guardMembershipChange(projectId, mReader, 'admin'),
    ])
    const unexpected = results.filter(
      (result) => result.status === 'rejected' && !(result.reason instanceof MembershipGuardError),
    )
    assert.equal(unexpected.length, 0, `no unexpected errors: ${JSON.stringify(unexpected.map(String))}`)
    // Interleaving decides which one wins; the invariant is that the project
    // keeps an admin either way.
    assert.ok((await adminUserIdsOf(projectId)).length >= 1, 'never zero admins')
  })

  /** Poll until `cond` is true or the deadline passes; true if it became true. */
  async function waitUntil(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await cond()) return true
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  /**
   * True while some backend is blocked waiting for THIS project's advisory
   * admin-guard lock (same key split as pg_locks.classid/objid, verified
   * against postgres:16). Unique projectId per run makes this collision-free.
   */
  function advisoryLockWaited(projectId: string): Promise<boolean> {
    return waitUntil(async () => {
      const result = await pool!.query(
        `select 1 from pg_locks l, (select hashtextextended($1, 0) as h) k
          where l.locktype = 'advisory' and not l.granted
            and l.classid::bigint = ((k.h >> 32) & 4294967295)
            and l.objid::bigint = (k.h & 4294967295)
          limit 1`,
        [`hitly:project-admin:${projectId}`],
      )
      return (result.rowCount ?? 0) > 0
    }, 4000)
  }

  it('deterministic interleave: lock + post-lock recount pin exactly one demotion', async () => {
    // Connection A starts the guarded demote of adminA and is HELD by the
    // test hook after its (post-lock) count, before its write, while still
    // holding the advisory lock. Connection B then demotes adminB: against
    // the real guard it must block on the lock, recount after A commits and
    // refuse. If the lock is removed, B counts and commits while A is held
    // (both win, zero admins). If the post-lock recount is removed, B's
    // pre-lock count wins after release (same end state). Either mutant
    // turns this test RED; the code above keeps it GREEN.
    const projectId = await makeProject('Interleave demote', [adminA.id, adminB.id])
    const mA = await membershipIdOf(projectId, adminA.id)
    const mB = await membershipIdOf(projectId, adminB.id)

    let releaseA!: () => void
    const aHeld = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    let aReached!: () => void
    const aAtHook = new Promise<void>((resolve) => {
      aReached = resolve
    })
    setLastAdminDecisionHookForTests(async ({ membershipId }) => {
      if (membershipId !== mA) return
      aReached()
      // Bounded hold: even if the test body throws, never hang the suite.
      await Promise.race([aHeld, new Promise((resolve) => setTimeout(resolve, 15000))])
    })
    try {
      const pA = guardMembershipChange(projectId, mA, 'user')
      const reachedInTime = await Promise.race([
        aAtHook.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 10000)),
      ])
      assert.ok(reachedInTime, 'A reaches the between-count-and-write seam')

      const pB = guardMembershipChange(projectId, mB, 'user')
      const bSettled = pB.then(
        () => 'settled' as const,
        () => 'settled' as const,
      )
      const observed = await Promise.race([bSettled, advisoryLockWaited(projectId).then((saw) => (saw ? ('waiting' as const) : ('timeout' as const)))])
      releaseA()
      const [rA, rB] = await Promise.allSettled([pA, pB])

      assert.equal(
        observed,
        'waiting',
        'B contends the held advisory lock while A is between count and write (settled/timeout = guard is not serialising)',
      )
      assert.equal(rA.status, 'fulfilled', 'the held demotion of adminA commits')
      assert.equal(rB.status, 'rejected', 'the second demotion of adminB is refused, not committed')
      const reason = (rB as PromiseRejectedResult).reason
      assert.ok(
        reason instanceof MembershipGuardError && reason.code === LAST_PROJECT_ADMIN,
        `adminB refused with ${LAST_PROJECT_ADMIN}, got: ${String(reason)}`,
      )
      assert.equal(await roleOf(projectId, adminA.id), 'user')
      assert.equal(await roleOf(projectId, adminB.id), 'admin')
      assert.deepEqual(await adminUserIdsOf(projectId), [adminB.id], 'exactly one admin remains')
    } finally {
      releaseA()
      setLastAdminDecisionHookForTests(null)
    }
  })

  it('post-lock role re-read: a committed change while waiting on the lock is never a stale refusal', async () => {
    // Connection Y holds the project's advisory xact lock, and while X (a
    // guarded demote of adminA that already passed its pre-lock role read)
    // waits on that lock, Y demotes BOTH admins and commits. When X gets the
    // lock it must re-read its own target row: adminA is no longer an admin,
    // so the demote is a no-op and must NOT raise a stale last_project_admin.
    // Without the post-lock re-read X would count admins after the lock,
    // see zero, and throw - this test goes RED on that mutant.
    const projectId = await makeProject('Reread demote', [adminA.id, adminB.id])
    const mA = await membershipIdOf(projectId, adminA.id)
    const mB = await membershipIdOf(projectId, adminB.id)

    const y = await pool!.connect()
    let demoteA: Promise<void> | undefined
    try {
      await y.query('begin')
      await y.query(
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`hitly:project-admin:${projectId}`],
      )

      demoteA = guardMembershipChange(projectId, mA, 'user')
      const waiting = await advisoryLockWaited(projectId)
      assert.ok(waiting, 'X contends the held advisory lock (guard is not serialising)')

      // Y demotes both admins behind X and commits, releasing the lock.
      await y.query('update project_memberships set role = $1 where id = any($2)', ['user', [mA, mB]])
      await y.query('commit')
    } finally {
      await y.query('rollback').catch(() => undefined)
      y.release()
    }

    const rA = await demoteA
    assert.equal(rA, undefined, 'the stale demote resolves as a no-op, not a refusal')
    assert.equal(await roleOf(projectId, adminA.id), 'user')
    assert.equal(await roleOf(projectId, adminB.id), 'user')
  })

  it('the decision seam is inert outside NODE_ENV=test', async () => {
    // setLastAdminDecisionHookForTests is a no-op for non-null hooks unless
    // NODE_ENV === 'test', so no production import can arm it by mistake.
    const projectId = await makeProject('Seam gate', [adminA.id, adminB.id])
    const mA = await membershipIdOf(projectId, adminA.id)
    let hookCalls = 0
    const env = process.env as Record<string, string | undefined>
    const savedEnv = env.NODE_ENV
    env.NODE_ENV = 'production'
    try {
      setLastAdminDecisionHookForTests(async () => {
        hookCalls += 1
      })
      await guardMembershipChange(projectId, mA, 'user')
      assert.equal(hookCalls, 0, 'no hook runs when NODE_ENV is not test')
      assert.equal(await roleOf(projectId, adminA.id), 'user', 'the guarded write still commits')
    } finally {
      setLastAdminDecisionHookForTests(null)
      env.NODE_ENV = savedEnv
    }
  })
})

describe('workspace removal cascade', () => {
  it('refuses removing a workspace member who is the only admin of a project, then allows it after a second admin', async () => {
    const projectId = await makeProject('Cascade', [soloAdmin.id])
    await assert.rejects(
      () =>
        withTenant(workspaceId, () =>
          assertWorkspaceMemberRemovalKeepsProjectAdmins({ userId: soloAdmin.id }),
        ),
      (error: unknown) => error instanceof MembershipGuardError && error.code === LAST_PROJECT_ADMIN,
    )
    await addProjectMemberRow(projectId, adminB.id, 'admin')
    await withTenant(workspaceId, () =>
      assertWorkspaceMemberRemovalKeepsProjectAdmins({ userId: soloAdmin.id }),
    )
  })

  it('passes trivially for a person with no project admin seats', async () => {
    await withTenant(workspaceId, () =>
      assertWorkspaceMemberRemovalKeepsProjectAdmins({ userId: owner.id }),
    )
  })
})

describe('workspace last-owner guard', () => {
  async function ownerMembershipId() {
    const rows = await database
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, owner.id)))
      .limit(1)
    return rows[0]!.id
  }

  it('refuses removing the last owner', async () => {
    const membershipId = await ownerMembershipId()
    await assert.rejects(
      () => withTenant(workspaceId, () => assertWorkspaceKeepsOwner({ membershipId })),
      (error: unknown) =>
        error instanceof MembershipGuardError &&
        error.code === LAST_WORKSPACE_OWNER &&
        error.status === 409,
    )
  })

  it('allows removing a non-owner admin', async () => {
    const rows = await database
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, adminB.id)))
      .limit(1)
    await withTenant(workspaceId, () => assertWorkspaceKeepsOwner({ membershipId: rows[0]!.id }))
  })
})

describe('people tab disabled state', () => {
  it('flags exactly the last admin row', () => {
    assert.equal(isLastAdminRow('admin', 1), true)
    assert.equal(isLastAdminRow('admin', 0), true)
    assert.equal(isLastAdminRow('admin', 2), false)
    assert.equal(isLastAdminRow('user', 1), false)
    assert.equal(isLastAdminRow('reader', 1), false)
  })
})

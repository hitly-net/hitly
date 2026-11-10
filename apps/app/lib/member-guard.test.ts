/**
 * Last-admin / last-owner guard (lib/member-guard.ts), run against real
 * Postgres: the product rule is that a project always keeps at least one
 * admin and a workspace always keeps at least one owner, checked race-safe
 * inside the transaction (advisory xact lock per project).
 *
 * Run with: yarn db:up && yarn test
 */

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

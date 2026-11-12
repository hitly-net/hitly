/**
 * TEST-ONLY harness for action-path tests of the unverified-email gate (M2).
 *
 * It simulates lib/tenant.ts withTenant semantics faithfully:
 *   - the callback RETURNING normally COMMITs the pending writes,
 *   - a THROWN error ROLLS them back,
 *   - Next's redirect control-flow throw commits, then rethrows.
 *
 * The lib fakes below deliberately record their write BEFORE the gate check
 * (the mutant ordering Test used). So an action that catches the gate error
 * INSIDE the transaction and returns normally will COMMIT the write and the
 * action-path tests fail; only an action that lets the gate error throw out
 * of the transaction (so it rolls back) and converts it outside passes.
 *
 * Not a .test file: imported by actions/projects-gate.test.ts and
 * actions/team-gate.test.ts.
 */

import { VerifiedEmailRequiredError } from './verified-gate'

export type SimKey = { id: string; projectId: string; hashed: string; prefix: string }
export type SimInvite = { id: string; email: string; tokenHash: string; actorUserId: string }

type PendingWrite = { op: string; apply: () => void }

export const sim = {
  ctx: {
    user: { id: 'usr_actor_sim', email: 'actor-sim@example.com', name: 'Sim Actor' },
    workspace: { id: 'ws_sim', name: 'Sim Co' },
    role: 'admin' as const,
    workspaces: [] as unknown[],
  },
  /** Stored emailVerified per user id (live read semantics). */
  verified: new Map<string, boolean>(),
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  writeJournal: [] as PendingWrite[],
  committed: [] as string[],
  projects: [] as Array<{ id: string; name: string; by: string }>,
  keys: new Map<string, SimKey>(),
  invites: [] as SimInvite[],
  /** Counts invite emails "sent" — only as a committed side effect. */
  inviteSendCount: 0,
  /** When set, lib fakes throw a PLAIN Error carrying the gate text (S11 soft mutant). */
  plainTextThrow: false,
  seq: 0,

  reset() {
    sim.verified.clear()
    sim.calls = []
    sim.writeJournal = []
    sim.committed = []
    sim.projects = []
    sim.keys = new Map()
    sim.invites = []
    sim.inviteSendCount = 0
    sim.plainTextThrow = false
    sim.seq = 0
    delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  },

  /** Same parsing rules as requireVerifiedEmailGateEnabled (trim + lowercase). */
  flagOn(): boolean {
    return ['1', 'true', 'yes', 'on'].includes((process.env.HITLY_REQUIRE_VERIFIED_EMAIL ?? '').trim().toLowerCase())
  },
  gateBlocks(userId: string): boolean {
    return sim.flagOn() && sim.verified.get(userId) === false
  },
  gateError(): Error {
    return sim.plainTextThrow
      ? new Error('email_not_verified')
      : new VerifiedEmailRequiredError()
  },
  record(op: string, apply: () => void) {
    sim.writeJournal.push({ op, apply })
  },

  /** Simulated tenant transaction (see file header). */
  async runTx<T>(fn: () => Promise<T>): Promise<T> {
    sim.writeJournal = []
    let out: unknown
    try {
      out = await fn()
    } catch (error) {
      if (isNextRedirect(error)) {
        sim.committed.push(...sim.writeJournal.map((w) => w.op))
        for (const w of sim.writeJournal) w.apply()
        sim.writeJournal = []
        throw error
      }
      // ROLLBACK: pending writes are discarded, never applied.
      sim.writeJournal = []
      throw error
    }
    // COMMIT: normal return.
    sim.committed.push(...sim.writeJournal.map((w) => w.op))
    for (const w of sim.writeJournal) w.apply()
    sim.writeJournal = []
    return out as T
  },

  seedKey(key: SimKey) {
    sim.keys.set(key.id, key)
  },
  seedInvite(invite: SimInvite) {
    sim.invites.push(invite)
  },
}

function isNextRedirect(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'digest' in error &&
      typeof (error as { digest?: unknown }).digest === 'string' &&
      (error as { digest: string }).digest.startsWith('NEXT_REDIRECT'),
  )
}

/**
 * Fakes for lib/project-create.ts chokepoints. MUTANT ORDERING is modeled:
 * record the write FIRST, check the gate SECOND. The real lib gates before
 * the write; modeling the mutant ordering here means a swallowed gate error
 * surfaces as a committed row, which is exactly what the tests forbid.
 */
export const projectCreateFakes = {
  async insertNewProject(args: { userId: string; name: unknown; description: unknown; plugin: unknown }): Promise<string> {
    sim.calls.push({ fn: 'insertNewProject', args: { ...args } })
    const id = `prj_sim_${++sim.seq}`
    const name = String(args.name)
    sim.record(`project:${id}`, () => sim.projects.push({ id, name, by: args.userId }))
    if (sim.gateBlocks(args.userId)) throw sim.gateError()
    return id
  },
  async insertNewProjectApiKey(args: { projectId: string; userId: string; name: string }): Promise<string> {
    sim.calls.push({ fn: 'insertNewProjectApiKey', args: { ...args } })
    const id = `key_sim_${++sim.seq}`
    const raw = `hitly_sim_${sim.seq}`
    sim.record(`key:${id}`, () => sim.keys.set(id, { id, projectId: args.projectId, hashed: `stored_${raw}`, prefix: raw.slice(0, 12) }))
    if (sim.gateBlocks(args.userId)) throw sim.gateError()
    return raw
  },
  async rotateProjectApiKeyRecord(args: { projectId: string; keyId: string; userId: string }): Promise<string> {
    sim.calls.push({ fn: 'rotateProjectApiKeyRecord', args: { ...args } })
    const key = sim.keys.get(args.keyId)
    if (!key || key.projectId !== args.projectId) throw new Error('Key not found')
    const raw = `hitly_rotated_${++sim.seq}`
    sim.record(`rotate:${args.keyId}`, () => {
      key.hashed = `stored_${raw}`
      key.prefix = raw.slice(0, 12)
    })
    if (sim.gateBlocks(args.userId)) throw sim.gateError()
    return raw
  },
}

/** Fakes for lib/invites.ts chokepoints, same mutant ordering. */
export const inviteFakes = {
  async createAndSendWorkspaceInvite(args: {
    workspaceId: string
    workspaceName: string
    email: string
    role: 'admin' | 'member'
    invitedByUserId: string | null
    actorUserId: string
    appUrl: string
    database?: unknown
    send?: unknown
  }): Promise<{ id: string; expiresAt: Date }> {
    sim.calls.push({ fn: 'createAndSendWorkspaceInvite', args: { ...args } })
    const id = `inv_sim_${++sim.seq}`
    const tokenHash = `tok_${sim.seq}`
    const expiresAt = new Date()
    sim.record(`invite:${id}`, () => {
      sim.invites.push({ id, email: args.email, tokenHash, actorUserId: args.actorUserId })
      sim.inviteSendCount += 1
    })
    if (sim.gateBlocks(args.actorUserId)) throw sim.gateError()
    return { id, expiresAt }
  },
  async resendWorkspaceInvite(args: {
    workspaceId: string
    workspaceName: string
    inviteId: string
    actorUserId: string
    appUrl: string
    database?: unknown
    send?: unknown
  }): Promise<{ ok: true; expiresAt: Date } | { ok: false }> {
    sim.calls.push({ fn: 'resendWorkspaceInvite', args: { ...args } })
    const invite = sim.invites.find((row) => row.id === args.inviteId)
    if (!invite) return { ok: false }
    sim.record(`rotate-invite:${args.inviteId}`, () => {
      invite.tokenHash = `tok_${++sim.seq}`
    })
    if (sim.gateBlocks(args.actorUserId)) throw sim.gateError()
    return { ok: true, expiresAt: new Date() }
  },
}

/** Chainable no-op drizzle surface so action-internal requireProjectAdmin passes. */
export const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ id: 'row_sim' }],
      }),
    }),
  }),
  insert: () => ({ values: async () => undefined }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
  delete: () => ({ where: async () => undefined }),
}

export function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  if (value === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
  else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = value
  return fn().finally(() => {
    if (saved === undefined) delete process.env.HITLY_REQUIRE_VERIFIED_EMAIL
    else process.env.HITLY_REQUIRE_VERIFIED_EMAIL = saved
  })
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { edition } from '@hitly/cloud'
import { db } from './db'

type AppDb = NonNullable<typeof db>
type TenantTx = Parameters<Parameters<AppDb['transaction']>[0]>[0]
export type TenantDatabase = AppDb | TenantTx

type TenantStore = {
  workspaceId: string
  tx: TenantTx
  /** Detached work. Flushed only after the outer transaction commits. */
  afterCommit: Array<() => Promise<void>>
}

const tenantAls = new AsyncLocalStorage<TenantStore>()

export function tenantWorkspaceId() {
  return tenantAls.getStore()?.workspaceId
}

export function requireTenantWorkspaceId() {
  const workspaceId = tenantWorkspaceId()
  if (!workspaceId) {
    throw new Error('Tenant workspace context is not set')
  }
  return workspaceId
}

export function requireDb(): TenantDatabase {
  const store = tenantAls.getStore()
  if (store) return store.tx
  if (!db) {
    throw new Error('DATABASE_URL is not set')
  }
  return db
}

const nextRedirect: unique symbol = Symbol('next-redirect')

function isNextRedirectError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'digest' in error &&
      typeof error.digest === 'string' &&
      error.digest.startsWith('NEXT_REDIRECT'),
  )
}

export async function withTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const current = tenantAls.getStore()
  if (current) {
    if (current.workspaceId !== workspaceId) {
      throw new Error('Nested tenant context does not match the active workspace')
    }
    return fn()
  }
  if (!db) {
    throw new Error('DATABASE_URL is not set')
  }
  const afterCommit: Array<() => Promise<void>> = []
  const result = await db.transaction(async (tx): Promise<T | { [nextRedirect]: unknown }> => {
    if (edition.id === 'cloud' && !edition.applyTenantContext) {
      throw new Error('Cloud edition must set tenant RLS context')
    }
    if (edition.applyTenantContext) {
      await edition.applyTenantContext(tx, workspaceId)
    }
    try {
      return await tenantAls.run({ workspaceId, tx, afterCommit }, fn)
    } catch (error) {
      // redirect() throws; drizzle would ROLLBACK unless we swallow until COMMIT.
      if (isNextRedirectError(error)) {
        return { [nextRedirect]: error }
      }
      throw error
    }
  })
  // The transaction promise resolves only after COMMIT. Queue detached work
  // here so a later read (the push badge count) cannot miss the new row.
  // A thrown transaction discards the queue: the insert was rolled back.
  for (const work of afterCommit) enqueueAfterCommit(work)
  if (result && typeof result === 'object' && nextRedirect in result) {
    throw result[nextRedirect]
  }
  return result as T
}

const pendingAfterTenantCommit: Promise<void>[] = []

/**
 * Schedule work that must see the committed tenant transaction and must not
 * hold it. Inside `withTenant`, the callback is queued and started only after
 * COMMIT. Outside a tenant, it runs on the next event-loop turn.
 * Used for fire-and-forget push.
 */
export function afterTenantCommit(work: () => Promise<void>): void {
  const store = tenantAls.getStore()
  if (store) {
    store.afterCommit.push(work)
    return
  }
  enqueueAfterCommit(work)
}

function enqueueAfterCommit(work: () => Promise<void>) {
  const task = new Promise<void>((resolve) => {
    setImmediate(() => {
      void Promise.resolve()
        .then(work)
        .catch((error) => {
          console.error('[hitly push]', error instanceof Error ? error.message : error)
        })
        .finally(resolve)
    })
  })
  pendingAfterTenantCommit.push(task)
}

export async function flushAfterTenantCommitForTests() {
  for (let i = 0; i < 10 && pendingAfterTenantCommit.length > 0; i++) {
    const batch = pendingAfterTenantCommit.splice(0)
    await Promise.all(batch)
  }
}

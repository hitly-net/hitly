import { AsyncLocalStorage } from 'node:async_hooks'
import { edition } from '@hitly/cloud'
import { db } from './db'

type AppDb = NonNullable<typeof db>
type TenantTx = Parameters<Parameters<AppDb['transaction']>[0]>[0]
export type TenantDatabase = AppDb | TenantTx

type TenantStore = {
  workspaceId: string
  tx: TenantTx
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
  const result = await db.transaction(async (tx): Promise<T | { [nextRedirect]: unknown }> => {
    if (edition.id === 'cloud' && !edition.applyTenantContext) {
      throw new Error('Cloud edition must set tenant RLS context')
    }
    if (edition.applyTenantContext) {
      await edition.applyTenantContext(tx, workspaceId)
    }
    try {
      return await tenantAls.run({ workspaceId, tx }, fn)
    } catch (error) {
      // redirect() throws; drizzle would ROLLBACK unless we swallow until COMMIT.
      if (isNextRedirectError(error)) {
        return { [nextRedirect]: error }
      }
      throw error
    }
  })
  if (result && typeof result === 'object' && nextRedirect in result) {
    throw result[nextRedirect]
  }
  return result as T
}

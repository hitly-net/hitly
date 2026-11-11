import type { InboxPage } from './inbox-pages'

export type InboxRefreshApply = {
  setRefreshing: (value: boolean) => void
  applyPage: (page: InboxPage) => void
}

/**
 * Single-flight gate for inbox page-1 refreshes (pull-to-refresh and the
 * header button). A second refresh while one is running joins the in-flight
 * promise and does not start another fetch.
 */
export function createInboxRefreshGate() {
  let inFlight: Promise<void> | null = null

  return {
    get busy() {
      return inFlight !== null
    },
    refresh(fetchPage1: () => Promise<InboxPage>, apply: InboxRefreshApply): Promise<void> {
      if (inFlight) return inFlight
      apply.setRefreshing(true)
      inFlight = (async () => {
        try {
          apply.applyPage(await fetchPage1())
        } finally {
          inFlight = null
          apply.setRefreshing(false)
        }
      })()
      return inFlight
    },
  }
}

export type InboxRefreshGate = ReturnType<typeof createInboxRefreshGate>

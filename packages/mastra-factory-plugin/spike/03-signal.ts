/**
 * Phase 1 spike — session-signal proof.
 *
 * Exercises `deliverFactorySessionNotification` and `resolveSessionThread`
 * (the seam `factory_signal_session` itself uses) with fake controller and
 * session rows, proving the fallback used for:
 *   - ask_user typed answers (no typed-answer seam exists in answerParkedCall)
 *   - review verdicts (accept → merge-ready note, reject → findings)
 *   - expiry notices
 *
 * Run: cd packages/mastra-factory-plugin && npx tsx spike/03-signal.ts
 */
import assert from 'node:assert/strict';
import {
  deliverFactorySessionNotification,
  resolveSessionThread,
  FACTORY_SESSION_NOTIFICATION_SOURCE,
} from '@mastra/factory/tools/deliver';

const sessionId = 'sess-1';
const threadId = 'thread-1';
const row = {
  sessionId,
  userId: 'user-1',
  orgId: 'org-1',
  factoryProjectId: 'proj-1',
  projectRepositoryId: 'repo-1',
};

interface Sent {
  notification: unknown;
  address: unknown;
}

function fakeController(options: { live?: { activeStream: boolean; threadId: string }; sent: Sent[] }) {
  const session = options.live
    ? {
        stream: { isActive: () => options.live!.activeStream },
        thread: { getId: () => options.live!.threadId },
      }
    : null;
  return {
    queryThreadById: async ({ threadId: id }: { threadId: string }) =>
      id === threadId
        ? { id, resourceId: sessionId, metadata: { factorySessionId: sessionId }, updatedAt: new Date() }
        : null,
    getSession: async (id: string) => (id === sessionId ? session : null),
    createSession: async () =>
      options.live
        ? {
            stream: { isActive: () => options.live!.activeStream },
            thread: { getId: () => options.live!.threadId },
          }
        : {
            stream: { isActive: () => false },
            thread: { getId: () => threadId },
          },
    getCurrentAgent: (_session: unknown) => ({
      sendNotificationSignal: async (notification: unknown, address: unknown) => {
        options.sent.push({ notification, address });
        return {
          persisted: Promise.resolve(),
          accepted: Promise.resolve(),
          record: { id: 'notif-1' },
          decision: { action: 'deliver' },
        };
      },
    }),
  };
}

const sessions = { getBySessionId: async (id: string) => (id === sessionId ? row : null) };
const workItemsWithRun = {
  findActiveRunBindingForSession: async () => ({ threadId }),
};

async function main(): Promise<void> {
  // 1. resolveSessionThread prefers the active run binding (work-item run).
  const resolved = await resolveSessionThread({
    controller: fakeController({ sent: [] }) as never,
    sessions: sessions as never,
    workItems: workItemsWithRun as never,
    sessionId,
  });
  assert.equal(resolved, threadId);
  console.log('[spike] resolveSessionThread    → active run binding thread OK');

  // 2. Cold session (no live session): notification is persisted for wake-up.
  const sent: Sent[] = [];
  const result = await deliverFactorySessionNotification({
    controller: fakeController({ sent }) as never,
    sessions: sessions as never,
    target: { sessionId, threadId },
    notification: { kind: 'message', priority: 'medium', summary: 'Plan approved', payload: { message: 'accept' } },
    runs: {} as never,
  });
  assert.equal(result.delivered, 'woken');
  assert.equal(result.notificationId, 'notif-1');
  assert.equal(sent.length, 1);
  const n = sent[0]!.notification as { source: string; payload: { message: string } };
  assert.equal(n.source, FACTORY_SESSION_NOTIFICATION_SOURCE);
  assert.equal(n.payload.message, 'accept');
  assert.deepEqual(sent[0]!.address, { resourceId: sessionId, threadId });
  console.log('[spike] cold delivery           → woken, source tagged, addressed to thread OK');

  // 3. Busy session on the same thread → mid-run.
  const sentBusy: Sent[] = [];
  const busy = await deliverFactorySessionNotification({
    controller: fakeController({ live: { activeStream: true, threadId }, sent: sentBusy }) as never,
    sessions: sessions as never,
    target: { sessionId, threadId },
    notification: { kind: 'message', priority: 'medium', summary: 'Review: request changes', payload: { message: 'findings' } },
    runs: {} as never,
  });
  assert.equal(busy.delivered, 'mid-run');
  console.log('[spike] busy delivery           → mid-run OK');

  // 4. Unknown thread → skipped, never throws at the caller.
  const gone = await deliverFactorySessionNotification({
    controller: fakeController({ sent: [] }) as never,
    sessions: sessions as never,
    target: { sessionId, threadId: 'thread-missing' },
    notification: { kind: 'message', priority: 'medium', summary: 'x', payload: { message: 'y' } },
    runs: {} as never,
  });
  assert.deepEqual(gone, { delivered: 'skipped', reason: 'thread-not-found' });
  console.log('[spike] unknown thread          → skipped/thread-not-found OK');

  console.log('[spike] 03-signal: PASS — signal fallback proven for ask_user/review/expiry');
}

main().catch((error) => {
  console.error('[spike] 03-signal: FAIL', error);
  process.exit(1);
});

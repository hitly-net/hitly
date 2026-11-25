/**
 * Phase 1 spike — answerParkedCall proof.
 *
 * Exercises the deep-imported `answerParkedCall` (the only mechanism to
 * release a parked tool call) against fake live sessions for BOTH channels
 * the function understands:
 *   - gate   (approval.list)            → respondToToolApproval
 *   - resume (pendingSuspensions)       → claim → respondToToolSuspension → release
 *
 * Also proves the failure paths the plugin must distinguish:
 *   - nothing waiting (already answered / run ended)
 *   - a non-bare resumeSchema is NOT on the approval channel — this is why
 *     ask_user (free-text) cannot be answered via answerParkedCall and must
 *     go through the session-signal path (see 03-signal.ts).
 *
 * Run: cd packages/mastra-factory-plugin && npx tsx spike/02-answer-parked.ts
 */
import assert from 'node:assert/strict';
import { answerParkedCall } from '@mastra/factory/tools/approval-tools';

interface CallLog {
  gate: unknown[];
  claimed: string[];
  suspended: unknown[];
  released: string[];
}

const DECISION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { action: { enum: ['approved', 'rejected'] } },
  required: ['action'],
});

const FREE_TEXT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { response: { type: 'string' } },
  required: ['response'],
});

function fakeLive(options: {
  gate?: Array<{ toolCallId: string; toolName: string }>;
  suspensions?: Array<{ toolCallId: string; toolName: string; resumeSchema: string }>;
  claimAccepted?: boolean;
  gateAccepted?: boolean;
  log: CallLog;
}) {
  const suspensionAddresses = new Map<string, string>();
  if (options.claimAccepted !== false) {
    for (const s of options.suspensions ?? []) suspensionAddresses.set(s.toolCallId, `addr:${s.toolCallId}`);
  }
  return {
    approval: { list: () => options.gate ?? [] },
    displayState: {
      get: () => ({
        pendingSuspensions: new Map(
          (options.suspensions ?? []).map((s) => [s.toolCallId, s]),
        ),
      }),
    },
    suspensions: new Set<string>(),
    claimToolSuspension(toolCallId: string) {
      options.log.claimed.push(toolCallId);
      const address = suspensionAddresses.get(toolCallId);
      if (!address) return { accepted: false as const };
      return { accepted: true as const, address, claimKey: `claim:${toolCallId}` };
    },
    async respondToToolSuspension(args: { resumeData: unknown; address: string }) {
      options.log.suspended.push(args);
      // Simulate the session carrying on: the address is no longer waiting.
      for (const [k, v] of suspensionAddresses) if (v === args.address) suspensionAddresses.delete(k);
    },
    releaseToolResponse(claimKey: string) {
      options.log.released.push(claimKey);
    },
    respondToToolApproval(args: unknown) {
      options.log.gate.push(args);
      return { accepted: options.gateAccepted !== false };
    },
  };
}

function depsFor(live: unknown) {
  return {
    messaging: async () => ({
      controller: { getSession: async () => live },
    }),
  };
}

const session = { sessionId: 'sess-1', userId: 'user-1', orgId: 'org-1' };

async function main(): Promise<void> {
  // 1. Gate channel approve (plan accept path).
  const log1: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live1 = fakeLive({
    gate: [{ toolCallId: 'tc-plan', toolName: 'submit_plan' }],
    log: log1,
  });
  const r1 = await answerParkedCall(depsFor(live1), { session, toolCallId: 'tc-plan', decision: 'approve', declineReason: '' });
  assert.deepEqual(r1, { toolCallId: 'tc-plan', toolName: 'submit_plan' });
  assert.equal(log1.gate.length, 1);
  assert.deepEqual((log1.gate[0] as { decision: string }).decision, 'approve');
  console.log('[spike] gate approve            → respondToToolApproval(decision=approve) OK');

  // 2. Gate channel decline with reason (plan reject path).
  const log2: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live2 = fakeLive({
    gate: [{ toolCallId: 'tc-plan', toolName: 'submit_plan' }],
    log: log2,
  });
  await answerParkedCall(depsFor(live2), { session, toolCallId: 'tc-plan', decision: 'decline', declineReason: 'nope' });
  const gateCall = log2.gate[0] as { decision: string; declineContext?: { reason: string } };
  assert.equal(gateCall.decision, 'decline');
  assert.equal(gateCall.declineContext?.reason, 'nope');
  console.log('[spike] gate decline            → declineContext.reason carried OK');

  // 3. Resume channel approve (bare decision schema).
  const log3: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live3 = fakeLive({
    suspensions: [{ toolCallId: 'tc-susp', toolName: 'some_tool', resumeSchema: DECISION_SCHEMA }],
    log: log3,
  });
  const r3 = await answerParkedCall(depsFor(live3), { session, toolCallId: 'tc-susp', decision: 'approve', declineReason: '' });
  assert.deepEqual(r3, { toolCallId: 'tc-susp', toolName: 'some_tool' });
  assert.deepEqual(log3.claimed, ['tc-susp']);
  assert.deepEqual((log3.suspended[0] as { resumeData: unknown }).resumeData, { action: 'approved' });
  assert.deepEqual(log3.released, ['claim:tc-susp']);
  console.log('[spike] resume approve          → claim → respondToToolSuspension({action:approved}) → release OK');

  // 4. Resume channel decline carries feedback.
  const log4: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live4 = fakeLive({
    suspensions: [{ toolCallId: 'tc-susp', toolName: 'some_tool', resumeSchema: DECISION_SCHEMA }],
    log: log4,
  });
  await answerParkedCall(depsFor(live4), { session, toolCallId: 'tc-susp', decision: 'decline', declineReason: 'because' });
  assert.deepEqual((log4.suspended[0] as { resumeData: unknown }).resumeData, {
    action: 'rejected',
    feedback: 'because',
  });
  console.log('[spike] resume decline          → resumeData {action:rejected, feedback} OK');

  // 5. Free-text resumeSchema (ask_user shape) is NOT answerable via this seam.
  const log5: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live5 = fakeLive({
    suspensions: [{ toolCallId: 'tc-ask', toolName: 'ask_user', resumeSchema: FREE_TEXT_SCHEMA }],
    log: log5,
  });
  await assert.rejects(
    () => answerParkedCall(depsFor(live5), { session, toolCallId: 'tc-ask', decision: 'approve', declineReason: '' }),
    /Nothing is waiting on that tool call/,
  );
  console.log('[spike] free-text suspension    → rejected by seam (ask_user MUST use session signal) OK');

  // 6. Nothing waiting → clear error the poller treats as already-answered.
  const log6: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live6 = fakeLive({ log: log6 });
  await assert.rejects(
    () => answerParkedCall(depsFor(live6), { session, toolCallId: 'tc-gone', decision: 'approve', declineReason: '' }),
    /Nothing is waiting on that tool call/,
  );
  console.log('[spike] nothing waiting         → explicit error OK');

  // 7. Lost claim race → ALREADY_ANSWERED style error.
  const log7: CallLog = { gate: [], claimed: [], suspended: [], released: [] };
  const live7 = fakeLive({
    suspensions: [{ toolCallId: 'tc-susp', toolName: 'some_tool', resumeSchema: DECISION_SCHEMA }],
    claimAccepted: false,
    log: log7,
  });
  await assert.rejects(
    () => answerParkedCall(depsFor(live7), { session, toolCallId: 'tc-susp', decision: 'approve', declineReason: '' }),
    /already/i,
  );
  console.log('[spike] lost claim race         → already-answered error OK');

  console.log('[spike] 02-answer-parked: PASS — both channels + failure modes proven');
}

main().catch((error) => {
  console.error('[spike] 02-answer-parked: FAIL', error);
  process.exit(1);
});

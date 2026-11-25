/**
 * Phase 1 spike — mount proof.
 *
 * Mounts a minimal FactoryIntegration inside a real MastraFactory host
 * (LibSQL in-memory storage, auth disabled) and proves:
 *   1. The integration is accepted by the constructor and survives prepare().
 *   2. initialize() receives the scoped integration storage handle.
 *   3. workers(ctx) is collected into MastraArgs.workers.
 *   4. routes(ctx) is invoked with an IntegrationContext carrying the fields
 *      the plugin needs (auth, storage.generic, controller, baseUrl).
 *
 * Run: cd packages/mastra-factory-plugin && npx tsx spike/01-mount.ts
 */
import assert from 'node:assert/strict';
import { MastraFactory } from '@mastra/factory';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { MastraWorker } from '@mastra/core/worker';
import type {
  FactoryIntegration,
  IntegrationContext,
} from '@mastra/factory/integrations/base';

class SpikeWorker extends MastraWorker {
  readonly name = 'hitly-spike-worker';
  #running = false;
  async start(): Promise<void> {
    this.#running = true;
  }
  async stop(): Promise<void> {
    this.#running = false;
  }
  get isRunning(): boolean {
    return this.#running;
  }
}

interface Observed {
  initializeStorage: boolean;
  workerContext: IntegrationContext | undefined;
  routeContext: IntegrationContext | undefined;
}

class SpikeIntegration implements FactoryIntegration {
  readonly id = 'hitly-spike';
  readonly observed: Observed = {
    initializeStorage: false,
    workerContext: undefined,
    routeContext: undefined,
  };

  async initialize(args: { storage: { integrationId?: string; connections?: unknown; settings?: unknown } }): Promise<void> {
    this.observed.initializeStorage =
      args.storage?.integrationId === 'hitly-spike' &&
      Boolean(args.storage.connections) &&
      Boolean(args.storage.settings);
  }

  routes(ctx: IntegrationContext) {
    this.observed.routeContext = ctx;
    return [
      {
        path: '/hitly-spike/ping',
        method: 'GET' as const,
        requiresAuth: false,
        handler: (c: { text: (t: string) => unknown }) => c.text('pong'),
      },
    ];
  }

  workers(ctx: IntegrationContext) {
    this.observed.workerContext = ctx;
    return [new SpikeWorker()];
  }

  postToolObserver(args: unknown): void {
    // Presence proof only in the spike; the real observer lands in Phase 3.
    void args;
  }

  diagnostics(): Record<string, unknown> {
    return { hitlySpike: { mounted: true } };
  }
}

async function main(): Promise<void> {
  const integration = new SpikeIntegration();
  const storage = new LibSQLFactoryStorage({ url: ':memory:' });
  const factory = new MastraFactory({ storage, auth: null, integrations: [integration] });

  const args = await factory.prepare();

  const workers = (args as { workers?: Array<{ name?: string }> }).workers ?? [];
  assert.ok(
    workers.some((w) => w?.name === 'hitly-spike-worker'),
    'spike worker was not collected into MastraArgs.workers',
  );
  assert.equal(integration.observed.initializeStorage, true, 'initialize() did not receive storage.generic');
  assert.ok(integration.observed.routeContext, 'routes(ctx) never called');
  assert.ok(integration.observed.workerContext, 'workers(ctx) never called');

  const ctx = integration.observed.routeContext!;
  console.log('[spike] IntegrationContext keys:', Object.keys(ctx).sort().join(', '));
  assert.ok(ctx.auth, 'ctx.auth missing');
  assert.ok(ctx.storage?.generic, 'ctx.storage.generic missing');

  await factory.shutdown?.();
  console.log('[spike] 01-mount: PASS — integration mounted, prepare() resolved, worker + routes wired');
}

main().catch((error) => {
  console.error('[spike] 01-mount: FAIL', error);
  process.exit(1);
});

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { FastifyAdapter as BullBoardFastifyAdapter } from '@bull-board/fastify';
import { Queue } from 'bullmq';
import { FastifyInstance } from 'fastify';

// Mounted only on the worker container so the dashboard's polling never
// competes with the API instances that are being load-tested.
export async function mountBullBoard(app: FastifyInstance, queue: Queue): Promise<void> {
  const serverAdapter = new BullBoardFastifyAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    // @bull-board/api's bundled bullmq types lag the bullmq version we run —
    // this is a type-only mismatch (Job.progress), not a runtime issue.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queues: [new BullMQAdapter(queue as never) as any],
    serverAdapter,
  });
  // Fastify's `prefix` option is what actually mounts the routes here — it's
  // applied by Fastify's own plugin encapsulation, not read by the plugin
  // itself, so it's absent from registerPlugin()'s declared options type.
  await app.register(
    serverAdapter.registerPlugin(),
    { prefix: '/admin/queues' } as Parameters<typeof app.register>[1],
  );
}

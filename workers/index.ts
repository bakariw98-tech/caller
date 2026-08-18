import { buildApp } from './app.js';
import type { Env } from './env.js';
import { pollAllConnections } from './email/poll.js';
import { processIngestBatch } from './youtube/ingest.js';
import { wrapD1 } from './db/d1-adapter.js';

export { CallSessionDO } from './durable-objects/call-session.js';

const app = buildApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Polls every connected creator's Gmail inbox — see workers/email/poll.ts
  // for why this is a cursor-based poll rather than Pub/Sub push. Also
  // drains a small batch of queued YouTube videos — see
  // workers/youtube/ingest.ts for why that has to be background work at
  // all (a 500-video channel cannot process in one request) rather than
  // running inline when a creator connects their channel.
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      pollAllConnections(env).then((summary) => {
        if (summary.errors.length) console.error('gmail poll completed with errors', summary);
      }),
    );
    ctx.waitUntil(
      processIngestBatch(env, wrapD1(env.DB)).catch((err) => {
        console.error('youtube ingest tick failed', err);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

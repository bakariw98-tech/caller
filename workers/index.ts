import { buildApp } from './app.js';
import type { Env } from './env.js';
import { pollAllConnections } from './email/poll.js';

export { CallSessionDO } from './durable-objects/call-session.js';

const app = buildApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  // Polls every connected creator's Gmail inbox — see workers/email/poll.ts
  // for why this is a cursor-based poll rather than Pub/Sub push.
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      pollAllConnections(env).then((summary) => {
        if (summary.errors.length) console.error('gmail poll completed with errors', summary);
      }),
    );
  },
} satisfies ExportedHandler<Env>;

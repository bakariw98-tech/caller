import { buildApp } from './app.js';
import type { Env } from './env.js';

export { CallSessionDO } from './durable-objects/call-session.js';

const app = buildApp();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;

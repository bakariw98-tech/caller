import { Hono } from 'hono';
import type { Env } from './env.js';
import { webhookRoute } from './routes/webhook.js';
import { mcpRoute } from './routes/mcp.js';
import { adminRoute } from './routes/admin.js';
import { phoneNumberRoute } from './routes/phone-numbers.js';
import { customerRoute } from './routes/customer.js';
import { onboardingRoute } from './routes/onboarding.js';
import { leadgenRoute } from './routes/leadgen.js';
import { clickRoute } from './routes/click.js';

export function buildApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.route('/', webhookRoute);
  app.route('/', mcpRoute);
  app.route('/', adminRoute);
  app.route('/', phoneNumberRoute);
  app.route('/', customerRoute);
  app.route('/', onboardingRoute);
  app.route('/', leadgenRoute);
  app.route('/', clickRoute);

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  return app;
}

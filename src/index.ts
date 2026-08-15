import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { config } from './config.js';
import { applySchema, getDb } from './db/index.js';
import { registerWebhookRoutes } from './http/webhook-route.js';
import { registerMcpServer } from './mcp/server.js';
import { registerCustomerRoutes } from './web/customer-routes.js';
import { registerCreatorRoutes } from './web/creator-routes.js';
import { activeCallCount } from './telephony/registry.js';

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Bearer tokens for MCP sessions ride in this header on every tool call.
      redact: ['req.headers.authorization'],
    },
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(formbody);

  /**
   * Webhook signatures cover the exact bytes received, so the raw string has to
   * survive JSON parsing. Re-serialising the parsed object changes whitespace
   * and key order and fails verification every time.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = raw;
    try {
      done(null, raw.length ? JSON.parse(raw) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    activeCalls: activeCallCount(),
    uptimeSeconds: Math.round(process.uptime()),
  }));

  registerWebhookRoutes(app);
  registerMcpServer(app);
  registerCustomerRoutes(app);
  registerCreatorRoutes(app);

  return app;
}

async function main(): Promise<void> {
  applySchema(getDb());

  const app = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });

  app.log.info(
    {
      publicBaseUrl: config.publicBaseUrl,
      webhook: `${config.publicBaseUrl}/webhooks/xai`,
      mcp: `${config.publicBaseUrl}/mcp`,
    },
    'coach platform listening',
  );

  if (!config.xai.apiKey) {
    app.log.warn('XAI_API_KEY is not set — calls cannot be answered');
  }
  if (!config.publicBaseUrl.startsWith('https://')) {
    app.log.warn(
      'PUBLIC_BASE_URL is not https — xAI must be able to reach both the webhook and the MCP endpoint',
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

// Only run when executed directly, so tests can import buildServer().
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

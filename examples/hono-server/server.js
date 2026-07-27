import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/health', (context) => context.json({ status: 'ok' }));

app.post('/logs', async (context) => {
  let batch;

  try {
    batch = await context.req.json();
  } catch {
    return context.json({ error: 'Request body must be valid JSON' }, 400);
  }

  if (!Array.isArray(batch) || batch.some((record) => !isRecord(record))) {
    return context.json({ error: 'Request body must be an array of log objects' }, 400);
  }

  for (const record of batch) {
    console.log(JSON.stringify(record));
  }

  return context.body(null, 204);
});

const port = parsePort(process.env.PORT);

serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`Receiving Pino batches at http://localhost:${listeningPort}/logs`);
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePort(value) {
  if (value === undefined) {
    return 3000;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return parsed;
}

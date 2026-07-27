# Hono receiver example

This example runs a small Hono server that receives the JSON arrays posted by
`pino-http-transport`.

The server listens on port `3000` by default. Set `PORT` to use another port.

Configure Pino to send logs to it:

```js
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-http-transport',
    options: {
      url: 'http://localhost:3000/logs',
      batchSize: 10,
      batchInterval: 1000,
    },
  },
});

logger.info({ requestId: 'req_123' }, 'Received request');
```

You can also send a sample batch directly:

```bash
curl --request POST http://localhost:3000/logs \
  --header 'content-type: application/json' \
  --data '[{"level":30,"time":1785182400000,"msg":"Hello from curl"}]'
```

The endpoint returns `204 No Content` for a valid array of objects and `400` for
invalid JSON or payloads with the wrong shape. A health check is available at
`GET /health`.

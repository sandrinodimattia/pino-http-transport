# pino-http-transport

[![npm version](https://badge.fury.io/js/pino-http-transport.svg)](https://www.npmjs.com/package/pino-http-transport)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Pino](https://github.com/pinojs/pino) transport that sends JSON log batches to an HTTP or HTTPS endpoint. It preserves batch order, retries transient delivery failures, bounds memory use, and drains queued records during shutdown.

Requires Node.js 24 or later.

## Install

```bash
pnpm add pino-http-transport
```

## Usage

Use it through Pino's worker transport in production:

```js
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-http-transport',
    options: {
      url: 'https://logs.example.com/ingest',
      headers: { authorization: `Bearer ${process.env.LOG_API_TOKEN}` },
    },
  },
});
```

The endpoint receives an HTTP `POST` with a JSON array of Pino log objects. A response is successful only when it has a 2xx status.

### Received JSON

Each request body is an array containing up to `batchSize` records. Standard Pino fields and any structured fields supplied to the logger are preserved:

```json
[
  {
    "level": 30,
    "time": 1785182400000,
    "pid": 4127,
    "hostname": "api-01",
    "requestId": "req_01K1ABCDEF",
    "userId": "user_123",
    "msg": "Checkout completed"
  },
  {
    "level": 40,
    "time": 1785182400125,
    "pid": 4127,
    "hostname": "api-01",
    "requestId": "req_01K1ABCDEG",
    "durationMs": 842,
    "msg": "Slow request"
  }
]
```

Errors logged with `logger.error({ err }, message)` include Pino's serialized error object:

```json
[
  {
    "level": 50,
    "time": 1785182400250,
    "pid": 4127,
    "hostname": "api-01",
    "err": {
      "type": "Error",
      "message": "Database unavailable",
      "stack": "Error: Database unavailable\n    at updateOrder (file:///app/orders.js:42:11)"
    },
    "orderId": "order_456",
    "msg": "Could not update order"
  }
]
```

The exact fields depend on your Pino configuration and the structured values passed to each log call.

For direct embedding, import the ESM entry point:

```js
import pino from 'pino';
import httpTransport from 'pino-http-transport';

const logger = pino(
  httpTransport({
    url: 'https://logs.example.com/ingest',
  })
);
```

## Options

```ts
interface HttpTransportOptions {
  url: string; // Required HTTP(S) endpoint
  headers?: Record<string, string>; // Content-Type defaults to application/json
  timeout?: number; // Per request, ms; default 2500
  batchSize?: number; // Records per request; default 100
  batchInterval?: number; // Partial-batch delay, ms; default 5000
  maxRetries?: number; // Retries after the initial request; default 2
  retryDelay?: number; // Initial exponential-backoff delay, ms; default 1000
  maxBufferSize?: number; // Waiting records; default 100000
  silent?: boolean; // Suppress diagnostics only; default false
}
```

`url` must use `http:` or `https:`. Numeric options are validated when the transport is created.

## Receiver example

[`examples/hono-server`](./examples/hono-server) contains a runnable [Hono](https://hono.dev/) server that validates incoming batches and prints each record.

Point the transport at `http://localhost:3000/logs`. See the example's README for configuration and a sample request.

## Delivery and shutdown behavior

- Only one batch is delivered at a time, preserving record order.
- A full batch sends immediately; a partial batch sends after `batchInterval`.
- Network errors, timeouts, and non-2xx responses retry with exponential backoff. The delay is capped at `timeout`.
- When retries are exhausted, the failed batch is reported and subsequent queued batches continue. The transport then fails close so Pino can surface the delivery failure.
- If the waiting queue exceeds `maxBufferSize`, the oldest waiting records are discarded. The active request is never discarded.
- Closing Pino's transport drains the active request and every queued partial batch before completion. Do not call `process.exit()` directly after logging; allow Pino's transport to finish.

For typical service shutdown, stop accepting work, then end the Pino transport through your application's normal logging lifecycle. Pino's worker transport handles the drain on `transport.end()`.

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` validates formatting, linting, JSDoc, and types. CI additionally runs coverage, the production build, and a package dry run.

## License

MIT

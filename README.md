# pino-http-transport

[![npm version](https://badge.fury.io/js/pino-http-transport.svg)](https://www.npmjs.com/package/pino-http-transport)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Pino](https://github.com/pinojs/pino) transport that sends logs to an HTTP endpoint. Supports batching, retries with exponential backoff, and buffer management.

## Install

```bash
npm install pino-http-transport
```

## Usage

### Worker Thread Mode (Recommended)

```javascript
import pino from 'pino';

const logger = pino({
  transport: {
    target: 'pino-http-transport',
    options: {
      url: 'https://logs.example.com/ingest',
      headers: {
        'Authorization': 'Bearer <token>'
      }
    }
  }
});
```

### Direct Usage

```javascript
import pino from 'pino';
import httpTransport from 'pino-http-transport';

const logger = pino(httpTransport({
  url: 'https://logs.example.com/ingest'
}));
```

## Configuration

```typescript
interface HttpTransportOptions {
  url: string;                  // HTTP endpoint to POST logs to
  headers?: Record<string, string>;
  timeout?: number;             // Request timeout (default: 2500ms)
  batchSize?: number;           // Logs per batch (default: 100)
  batchInterval?: number;       // Max ms between flushes (default: 5000ms)
  maxRetries?: number;          // Retry attempts (default: 2)
  retryDelay?: number;          // Initial retry delay (default: 1000ms)
  maxBufferSize?: number;       // Max buffered logs (default: 100000)
  silent?: boolean;             // Suppress error logging (default: false)
}
```

## How it Works

Logs are buffered in memory and sent in batches via HTTP POST. The request body is a JSON array of log objects:

```bash
POST /ingest
Content-Type: application/json

[
  {"level":30,"time":1234567890,"msg":"hello world","pid":123,"hostname":"server"},
  {"level":40,"time":1234567891,"msg":"warning","pid":123,"hostname":"server"}
]
```

### Batching

Logs flush when either:
- Buffer reaches `batchSize` logs
- `batchInterval` milliseconds have elapsed since last flush

Only one batch sends at a time to prevent concurrent requests.

### Retries

Failed requests retry with exponential backoff:
- Attempts: 1 initial + `maxRetries`
- Delay: `retryDelay` × 2^attempt (capped at `timeout`)
- Triggers: Network errors, timeouts, non-2xx responses

### Buffer Management

When buffer exceeds `maxBufferSize`, the oldest logs are dropped (FIFO) to prevent out-of-memory errors. A warning is logged on first drop and every 1000 drops thereafter (unless `silent: true`).

## Examples

### With Authentication

```javascript
const logger = pino({
  transport: {
    target: 'pino-http-transport',
    options: {
      url: 'https://logs.example.com/ingest',
      headers: {
        'X-API-Key': process.env.LOG_API_KEY
      },
      batchSize: 50,
      batchInterval: 2000
    }
  }
});
```

### Multiple Transports

```javascript
const logger = pino({
  transports: [
    { target: 'pino-pretty' },
    {
      target: 'pino-http-transport',
      options: { url: 'https://logs.example.com/ingest' }
    }
  ]
});
```

### Graceful Shutdown

```javascript
process.on('SIGTERM', async () => {
  await logger.flush();
  process.exit(0);
});
```

## Development

```bash
pnpm install
pnpm test           # Run tests
pnpm test:coverage  # Run with coverage
pnpm build          # Build for distribution
pnpm lint           # Lint code
```

## License

MIT

import build from 'pino-abstract-transport';
import { backOff } from 'exponential-backoff';
import { isMainThread } from 'node:worker_threads';

import type { PinoLogObject } from './types/log';

export interface HttpTransportOptions {
  /**
   * The HTTP endpoint URL to send logs to.
   */
  url: string;

  /**
   * Additional HTTP headers to include in requests.
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds.
   * @default 2500
   */
  timeout?: number;

  /**
   * Number of logs to batch before sending.
   * @default 100
   */
  batchSize?: number;

  /**
   * Maximum interval in milliseconds between batch sends.
   * @default 5000
   */
  batchInterval?: number;

  /**
   * Maximum number of retry attempts for failed requests.
   * @default 2
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds for exponential backoff retries.
   * @default 1000
   */
  retryDelay?: number;

  /**
   * Whether to suppress error logging to console.
   * When false, errors are logged to stderr (visible in worker threads).
   * When true, errors are silently ignored.
   * @default false (errors are logged)
   */
  silent?: boolean;

  /**
   * Maximum number of logs to buffer before dropping old logs.
   * When the buffer exceeds this count, the oldest logs are dropped to prevent OOM errors.
   * Estimated at ~1KB per log, so 100000 logs ≈ 100MB.
   * @default 100000
   */
  maxBufferSize?: number;
}

/**
 * Handle uncaught exceptions (only in worker mode).
 */
if (!isMainThread) {
  process.on('uncaughtException', (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[pino-http-transport] Uncaught exception:`, err.message);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[pino-http-transport] Unhandled rejection:`, err.message);
    process.exit(1);
  });
}

/**
 * Create a new HTTP transport for Pino which sends logs to an HTTP endpoint.
 * @param opts - The transport options.
 * @returns The transport function.
 */
export default function httpTransport(opts: HttpTransportOptions): ReturnType<typeof build> {
  const {
    url,
    headers = {},
    timeout = 2500,
    batchSize = 100,
    batchInterval = 5000,
    maxRetries = 2,
    retryDelay = 1000,
    silent = false,
    maxBufferSize = 100000, // ~100MB assuming ~1KB per log
  } = opts;

  const logger = {
    warn: (message: string) => {
      if (!silent) {
        console.warn(`[pino-http-transport] ${message}`);
      }
    },
    error: (message: string, error: Error) => {
      if (!silent) {
        console.error(`[pino-http-transport] ${message}:`, error.message);
      }
    },
  };

  // Validate required options
  if (!url || typeof url !== 'string') {
    throw new Error('HTTP transport requires a valid URL');
  }

  let flushing = false;
  let flushTimer: NodeJS.Timeout | null = null;
  let droppedLogsCount = 0;

  // In-memory buffer for logs awaiting transmission
  const buffer: PinoLogObject[] = [];

  /**
   * Send a batch of logs to the HTTP endpoint with retry logic using exponential backoff.
   * @param logs - Array of log objects to send.
   */
  async function sendBatch(logs: PinoLogObject[]): Promise<void> {
    if (logs.length === 0) {
      return;
    }

    // Pre-serialize to avoid holding log objects in memory during retries
    const payload = JSON.stringify(logs);

    // Clear the logs array immediately to allow GC of log objects
    logs.length = 0;

    try {
      await backOff(
        async () => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), timeout);

          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...headers,
              },
              body: payload,
              signal: controller.signal,
            });

            clearTimeout(timeoutId);

            // If the response is not ok, log an error and throw an error
            if (!response.ok) {
              const err = new Error(`HTTP Status Code: ${response.status}, Status Text: ${response.statusText}`);
              logger.error(`Log delivery failed`, err);
              throw err;
            }
          } catch (error) {
            clearTimeout(timeoutId);
            throw error;
          }
        },
        {
          delayFirstAttempt: false,
          numOfAttempts: maxRetries + 1,
          startingDelay: retryDelay,
          timeMultiple: 2,
          maxDelay: timeout,
        }
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error(`Failed to send batch after ${maxRetries} retries`, err);
    }
  }

  /**
   * Flush function to send buffered logs to HTTP endpoint.
   */
  async function flushBuffer(): Promise<void> {
    // Skip if a flush is already in progress
    if (flushing) {
      return;
    }

    // Skip if there are no logs to flush
    if (buffer.length === 0) {
      return;
    }

    // Set the flushing flag to avoid concurrent flushes
    flushing = true;

    try {
      // Limit batch size to prevent huge JSON payloads that cause memory spikes
      // Under heavy load, buffer can grow large; send in chunks to limit memory usage
      // Enforce a max batchSize per flush to prevent multi-MB JSON.stringify operations
      const maxLogsPerFlush = Math.min(buffer.length, batchSize);

      // Use splice to remove items from buffer and get them in one operation
      // This is more memory-efficient than spreading [...buffer] then clearing
      const logsToSend = buffer.splice(0, maxLogsPerFlush);

      // Send logs asynchronously
      await sendBatch(logsToSend);

      // If there are still logs in buffer after this flush, schedule another flush
      // This prevents buffer from staying full when under sustained high load
      if (buffer.length > 0) {
        // Use setImmediate to allow event loop to process other events
        setImmediate(() => {
          flushBuffer().catch((e) => {
            logger.error('Continuation flush failed', e as Error);
          });
        });
      }
    } catch (e) {
      logger.error('Flushing logs failed', e as Error);
    } finally {
      flushing = false;
    }
  }

  /**
   * Schedule a batch flush if not already scheduled.
   */
  function scheduleBatchFlush(): void {
    if (flushTimer) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;

      // Fire and forget - don't await to avoid blocking
      flushBuffer().catch((e) => {
        logger.error('Scheduled flush failed', e as Error);
      });
    }, batchInterval);
  }

  // Return the transport function
  return build(
    async (source) => {
      for await (const obj of source) {
        const log = obj as PinoLogObject;

        // FIFO: Drop oldest logs if buffer is at capacity BEFORE adding new log
        // This ensures new logs are always accepted and old logs are dropped
        if (buffer.length >= maxBufferSize) {
          // Drop the oldest log to make room for the new one
          buffer.shift();
          droppedLogsCount++;

          // Warn on first drop and then periodically to avoid log spam
          if (droppedLogsCount === 1 || droppedLogsCount % 1000 === 0) {
            logger.warn(
              `Buffer size limit exceeded (${maxBufferSize}). Dropped ${droppedLogsCount} oldest log(s) to prevent OOM.`
            );
          }
        }

        // Add the new log to the buffer
        buffer.push(log);

        // If buffer exceeds the threshold, flush immediately
        if (buffer.length >= batchSize) {
          // Cancel any scheduled flush since we're flushing immediately
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }

          // Fire and forget - don't await to avoid blocking the log stream
          flushBuffer().catch((e) => {
            logger.error('Immediate flush failed', e as Error);
          });
        } else {
          // Schedule a flush if not already scheduled
          scheduleBatchFlush();
        }
      }
    },
    {
      close: async (err?: Error) => {
        try {
          // If there was an error, reject the promise
          if (err) {
            throw err;
          }

          // Clear the flush timer
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }

          // Flush any remaining logs and wait for completion
          await flushBuffer();
        } catch (e) {
          logger.error('Transport close failed', e as Error);
          throw e;
        }
      },
    }
  );
}

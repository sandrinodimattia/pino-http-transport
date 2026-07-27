import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import build from 'pino-abstract-transport';

/**
 * A parsed JSON object emitted by Pino's transport stream.
 */
type PinoRecord = Record<string, unknown>;

/**
 * Largest delay accepted by Node's timer implementation.
 */
const MAX_TIMER_DELAY = 2_147_483_647;

/**
 * Configuration for delivering Pino records as JSON batches.
 */
export interface HttpTransportOptions {
  /**
   * HTTP or HTTPS endpoint that receives JSON batches.
   */
  url: string;

  /**
   * Additional request headers. Content-Type defaults to application/json.
   */
  headers?: Record<string, string>;

  /**
   * Per-request timeout in milliseconds. @default 2500
   */
  timeout?: number;

  /**
   * Records per request. @default 100
   */
  batchSize?: number;

  /**
   * Maximum age of a partial batch in milliseconds. @default 5000
   */
  batchInterval?: number;

  /**
   * Retries after the first failed request. @default 2
   */
  maxRetries?: number;

  /**
   * Initial retry delay in milliseconds. @default 1000
   */
  retryDelay?: number;

  /**
   * Suppress transport diagnostics without changing failure semantics. @default false
   */
  silent?: boolean;

  /**
   * Maximum queued records waiting behind the active request. @default 100000
   */
  maxBufferSize?: number;
}

/**
 * Fully validated options used by the delivery state machine.
 */
interface ValidatedOptions {
  /**
   * Parsed endpoint used by Node's HTTP client.
   */
  endpoint: URL;

  /**
   * Normalized request headers.
   */
  headers: Record<string, string>;

  /**
   * Timeout applied to every HTTP request.
   */
  timeout: number;

  /**
   * Maximum records in a request batch.
   */
  batchSize: number;

  /**
   * Maximum partial-batch wait time.
   */
  batchInterval: number;

  /**
   * Number of retries after the initial request.
   */
  maxRetries: number;

  /**
   * Initial retry backoff delay.
   */
  retryDelay: number;

  /**
   * Whether diagnostics are suppressed.
   */
  silent: boolean;

  /**
   * Maximum records waiting behind the active request.
   */
  maxBufferSize: number;
}

/**
 * Sends Pino records to an HTTP endpoint while preserving record order and
 * making shutdown observable to Pino's worker transport.
 */
export default function httpTransport(options: HttpTransportOptions): ReturnType<typeof build> {
  const config = validateOptions(options);
  const buffer = new RecordQueue();
  let activeDelivery: Promise<void> | undefined;
  let deliveryError: Error | undefined;
  let droppedRecords = 0;
  let flushDue = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;

  /**
   * Reports buffer-pressure diagnostics unless explicitly silenced.
   */
  function warn(message: string): void {
    if (!config.silent) {
      console.warn(`[pino-http-transport] ${message}`);
    }
  }

  /**
   * Reports terminal delivery failures without altering their propagation.
   */
  function reportError(error: Error): void {
    if (!config.silent) {
      console.error('[pino-http-transport] Log delivery failed:', error);
    }
  }

  /**
   * Cancels the pending partial-batch timer when immediate work supersedes it.
   */
  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  /**
   * Schedules delivery of a partial batch while the transport remains open.
   */
  function scheduleFlush(): void {
    if (flushTimer || buffer.length === 0 || closing) {
      return;
    }

    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushDue = true;
      maybeStartDelivery();
    }, config.batchInterval);
  }

  /**
   * Starts the next batch only when ordering and batching constraints allow it.
   */
  function maybeStartDelivery(): void {
    if (activeDelivery || buffer.length === 0) {
      return;
    }

    if (!closing && !flushDue && buffer.length < config.batchSize) {
      scheduleFlush();
      return;
    }

    const records = buffer.take(config.batchSize);
    if (buffer.length === 0) {
      clearFlushTimer();
      flushDue = false;
    }

    activeDelivery = sendBatch(records)
      .catch((error: unknown) => {
        const failure = toError(error);
        deliveryError ??= failure;
        reportError(failure);
      })
      .finally(() => {
        activeDelivery = undefined;
        maybeStartDelivery();
      });
  }

  /**
   * Delivers one batch and retries retryable failures with bounded backoff.
   */
  async function sendBatch(records: PinoRecord[]): Promise<void> {
    const body = JSON.stringify(records);

    for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
      try {
        await postJson(config.endpoint, config.headers, body, config.timeout);

        return;
      } catch (error) {
        if (attempt === config.maxRetries) {
          throw toError(error);
        }

        const delay = Math.min(config.retryDelay * 2 ** attempt, config.timeout);
        await wait(delay);
      }
    }
  }

  /**
   * Prevents new timer scheduling and waits for all buffered delivery work.
   */
  async function drain(): Promise<void> {
    closing = true;
    clearFlushTimer();
    flushDue = true;

    while (activeDelivery || buffer.length > 0) {
      maybeStartDelivery();
      if (activeDelivery) {
        await activeDelivery;
      }
    }

    clearFlushTimer();
    flushDue = false;

    if (deliveryError) {
      throw deliveryError;
    }
  }

  /**
   * Adds a record while retaining a bounded queue of waiting records.
   */
  function enqueueRecord(record: PinoRecord): void {
    if (buffer.length >= config.maxBufferSize) {
      buffer.dropOldest();
      droppedRecords += 1;

      if (droppedRecords === 1 || droppedRecords % 1000 === 0) {
        warn(`Buffer limit ${config.maxBufferSize} exceeded; dropped ${droppedRecords} oldest record(s).`);
      }
    }

    buffer.enqueue(record);

    if (buffer.length >= config.batchSize) {
      clearFlushTimer();
      maybeStartDelivery();
    } else {
      scheduleFlush();
    }
  }

  return build(
    (source) => {
      // A data listener receives every parsed line before stream shutdown starts.
      // An async iterator can otherwise be cut short by an immediate worker end.
      source.on('data', (record) => enqueueRecord(record as PinoRecord));
    },
    {
      /**
       * Drains delivery work and combines source and delivery failures when both occur.
       */
      close: async (sourceError?: Error) => {
        let deliveryFailure: Error | undefined;

        try {
          await drain();
        } catch (error) {
          deliveryFailure = toError(error);
        }

        if (sourceError && deliveryFailure) {
          throw new AggregateError(
            [sourceError, deliveryFailure],
            'Transport source and HTTP delivery failed during close'
          );
        }

        if (sourceError) {
          throw sourceError;
        }

        if (deliveryFailure) {
          throw deliveryFailure;
        }
      },
    }
  );
}

/**
 * FIFO record storage that avoids repeated array-front shifts under load.
 */
class RecordQueue {
  /**
   * Backing storage; consumed entries are cleared until compaction.
   */
  private records: Array<PinoRecord | undefined> = [];

  /**
   * Index of the next record available to consume.
   */
  private head = 0;

  /**
   * Number of records that have not yet been consumed.
   */
  get length(): number {
    return this.records.length - this.head;
  }

  /**
   * Appends a record to the tail of the queue.
   */
  enqueue(record: PinoRecord): void {
    this.records.push(record);
  }

  /**
   * Discards the oldest waiting record when the configured buffer is full.
   */
  dropOldest(): void {
    if (this.length === 0) {
      return;
    }

    this.records[this.head] = undefined;
    this.head += 1;
    this.compact();
  }

  /**
   * Removes and returns up to the requested number of records in FIFO order.
   */
  take(limit: number): PinoRecord[] {
    const end = Math.min(this.records.length, this.head + limit);
    const batch: PinoRecord[] = [];

    while (this.head < end) {
      const record = this.records[this.head];
      this.records[this.head] = undefined;
      this.head += 1;

      if (record) {
        batch.push(record);
      }
    }

    this.compact();
    return batch;
  }

  /**
   * Reclaims consumed storage after full depletion or substantial head growth.
   */
  private compact(): void {
    if (this.head === this.records.length) {
      this.records = [];
      this.head = 0;
      return;
    }

    if (this.head >= 4096 && this.head * 2 >= this.records.length) {
      this.records = this.records.slice(this.head);
      this.head = 0;
    }
  }
}

/**
 * Validates public options and applies the transport's delivery defaults.
 */
function validateOptions(input: unknown): ValidatedOptions {
  if (!isPlainRecord(input)) {
    throw new Error('HTTP transport options must be a plain object');
  }

  const url = input.url;
  if (typeof url !== 'string') {
    throw new Error('url must be a valid HTTP or HTTPS URL');
  }

  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    throw new Error('url must be a valid HTTP or HTTPS URL');
  }

  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('url must be a valid HTTP or HTTPS URL');
  }

  const rawHeaders = input.headers === undefined ? {} : input.headers;
  if (!isPlainRecord(rawHeaders)) {
    throw new Error('headers must be a plain record');
  }

  for (const [name, value] of Object.entries(rawHeaders)) {
    if (name.trim().length === 0 || typeof value !== 'string') {
      throw new Error('headers must contain non-empty names and string values');
    }
  }

  const normalizedHeaders = new Headers(rawHeaders as Record<string, string>);
  if (!normalizedHeaders.has('content-type')) {
    normalizedHeaders.set('content-type', 'application/json');
  }

  const timeout = input.timeout === undefined ? 2500 : input.timeout;
  const batchSize = input.batchSize === undefined ? 100 : input.batchSize;
  const batchInterval = input.batchInterval === undefined ? 5000 : input.batchInterval;
  const maxRetries = input.maxRetries === undefined ? 2 : input.maxRetries;
  const retryDelay = input.retryDelay === undefined ? 1000 : input.retryDelay;
  const silent = input.silent === undefined ? false : input.silent;
  const maxBufferSize = input.maxBufferSize === undefined ? 100_000 : input.maxBufferSize;

  requireTimer(timeout, 'timeout', 1);
  requireSafeInteger(batchSize, 'batchSize', 1);
  requireTimer(batchInterval, 'batchInterval', 1);
  requireSafeInteger(maxRetries, 'maxRetries', 0);
  requireTimer(retryDelay, 'retryDelay', 0);
  requireSafeInteger(maxBufferSize, 'maxBufferSize', 1);

  if (typeof silent !== 'boolean') {
    throw new Error('silent must be a boolean');
  }

  return {
    endpoint,
    headers: Object.fromEntries(normalizedHeaders.entries()),
    timeout,
    batchSize,
    batchInterval,
    maxRetries,
    retryDelay,
    silent,
    maxBufferSize,
  };
}

/**
 * Ensures a number can be used safely as a Node timer delay.
 */
function requireTimer(value: unknown, name: string, minimum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > MAX_TIMER_DELAY) {
    throw new Error(`${name} must be a safe integer between ${minimum} and ${MAX_TIMER_DELAY}`);
  }
}

/**
 * Ensures an option is a safe integer at or above its allowed minimum.
 */
function requireSafeInteger(value: unknown, name: string, minimum: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer of at least ${minimum}`);
  }
}

/**
 * Narrows unknown values to ordinary object records used for runtime options.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Normalizes thrown non-Error values for consistent reporting and propagation.
 */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Sends a JSON body through Node's HTTP client and resolves only for 2xx responses.
 */
function postJson(endpoint: URL, headers: Record<string, string>, body: string, timeout: number): Promise<void> {
  const request = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const contentLength = Buffer.byteLength(body);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    /**
     * Settles the request promise at most once and clears its timeout.
     */
    function settle(callback: () => void): void {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      callback();
    }

    const outgoing = request(
      endpoint,
      {
        method: 'POST',
        headers: {
          ...headers,
          'content-length': String(contentLength),
        },
      },
      (response) => {
        response.resume();
        response.once('error', (error) => settle(() => reject(error)));
        response.once('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            settle(resolve);
            return;
          }

          const description = response.statusMessage ? ` ${response.statusMessage}` : '';
          settle(() => reject(new Error(`HTTP ${status}${description}`)));
        });
      }
    );

    outgoing.once('error', (error) => settle(() => reject(error)));
    timeoutId = setTimeout(() => {
      outgoing.destroy(new Error(`HTTP request timed out after ${timeout}ms`));
    }, timeout);
    outgoing.end(body);
  });
}

/**
 * Waits for retry backoff without blocking the worker event loop.
 */
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

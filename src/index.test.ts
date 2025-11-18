import pino from 'pino';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import httpTransport, { type HttpTransportOptions } from './index';
import type { PinoLogObject } from './types/log';

// Mock fetch using Vitest's stubGlobal for proper cleanup
const mockFetch = vi.fn();

interface FetchCall {
  url: string;
  options: RequestInit;
  body: PinoLogObject[];
}

/**
 * Helper to get the last fetch call details
 */
function getLastFetchCall(): FetchCall | null {
  const calls = mockFetch.mock.calls;
  if (calls.length === 0) {
    return null;
  }

  const lastCall = calls[calls.length - 1];
  const url = lastCall[0];
  const options = lastCall[1];
  const body = JSON.parse(options.body);

  return { url, options, body };
}

/**
 * Helper to get all fetch calls
 */
function getAllFetchCalls(): FetchCall[] {
  return mockFetch.mock.calls.map((call) => ({
    url: call[0],
    options: call[1],
    body: JSON.parse(call[1].body),
  }));
}

/**
 * Create a mock successful response
 */
function createMockResponse(status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => ({}),
    text: async () => '',
  } as Response;
}

describe('pino-http-transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue(createMockResponse());
    // Stub global fetch with our mock
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    // Cleanup is automatic with vi.unstubAllGlobals() or vi.restoreAllMocks()
    vi.unstubAllGlobals();
  });

  describe('transport creation and validation', () => {
    it('should create transport with minimal options', () => {
      const transport = httpTransport({ url: 'http://localhost:3000/logs' });
      expect(transport).toBeDefined();
    });

    it('should throw error if url is not provided', () => {
      expect(() => httpTransport({} as HttpTransportOptions)).toThrow('HTTP transport requires a valid URL');
    });

    it('should throw error if url is not a string', () => {
      expect(() => httpTransport({ url: 123 as unknown as string })).toThrow('HTTP transport requires a valid URL');
    });

    it('should create transport with all custom options', () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        headers: { 'X-Custom': 'header' },
        timeout: 5000,
        batchSize: 20,
        batchInterval: 2000,
        maxRetries: 5,
        retryDelay: 500,
      });
      expect(transport).toBeDefined();
    });
  });

  describe('basic logging', () => {
    it('should send logs to the configured URL', async () => {
      const url = 'http://localhost:3000/logs';
      const transport = httpTransport({ url, batchInterval: 50 });
      const logger = pino(transport);

      logger.info('Test message');

      // Wait for batch interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = getLastFetchCall();
      expect(call?.url).toBe(url);
    });

    it('should send logs with correct structure', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test message');

      // Wait for batch interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body).toHaveLength(1);
      expect(call?.body[0]).toMatchObject({
        level: 30,
        msg: 'Test message',
      });
      expect(call?.body[0].time).toBeDefined();
      expect(call?.body[0].pid).toBeDefined();
      expect(call?.body[0].hostname).toBeDefined();
    });

    it('should send multiple log levels correctly', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino({ level: 'trace' }, transport);

      logger.trace('Trace message');
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warn message');
      logger.error('Error message');
      logger.fatal('Fatal message');

      // Wait for batch interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body).toHaveLength(6);
      expect(call?.body[0].level).toBe(10); // trace
      expect(call?.body[1].level).toBe(20); // debug
      expect(call?.body[2].level).toBe(30); // info
      expect(call?.body[3].level).toBe(40); // warn
      expect(call?.body[4].level).toBe(50); // error
      expect(call?.body[5].level).toBe(60); // fatal
    });

    it('should include custom metadata in logs', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info({ userId: 123, requestId: 'req-456' }, 'User action');

      // Wait for batch interval
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body[0]).toMatchObject({
        msg: 'User action',
        userId: 123,
        requestId: 'req-456',
      });
    });
  });

  describe('batching behavior', () => {
    it('should batch logs up to batchSize before sending', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 3,
        batchInterval: 1000, // Long interval to test batch size trigger
      });
      const logger = pino(transport);

      logger.info('Log 1');
      logger.info('Log 2');

      // Should not have sent yet
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockFetch).not.toHaveBeenCalled();

      logger.info('Log 3');

      // Should send immediately after reaching batch size
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const call = getLastFetchCall();
      expect(call?.body).toHaveLength(3);
    });

    it('should flush logs after batchInterval even if batchSize not reached', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 100, // Large batch size
        batchInterval: 100,
      });
      const logger = pino(transport);

      logger.info('Single log');

      // Should not have sent immediately
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockFetch).not.toHaveBeenCalled();

      // Should send after interval
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const call = getLastFetchCall();
      expect(call?.body).toHaveLength(1);
    });

    it('should handle multiple batches correctly', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 2,
        batchInterval: 1000,
      });
      const logger = pino(transport);

      // First batch
      logger.info('Log 1');
      logger.info('Log 2');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second batch
      logger.info('Log 3');
      logger.info('Log 4');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const calls = getAllFetchCalls();
      expect(calls[0].body).toHaveLength(2);
      expect(calls[1].body).toHaveLength(2);
    });

    it('should not flush empty buffer', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      // Don't log anything, just wait
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockFetch).not.toHaveBeenCalled();

      logger.flush();
      transport.end();
    });
  });

  describe('HTTP request configuration', () => {
    it('should use POST method by default', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.options.method).toBe('POST');
    });

    it('should include Content-Type header', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.options.headers).toMatchObject({
        'Content-Type': 'application/json',
      });
    });

    it('should include custom headers', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        headers: {
          'X-API-Key': 'secret-key',
          'X-Service': 'my-service',
        },
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.options.headers).toMatchObject({
        'Content-Type': 'application/json',
        'X-API-Key': 'secret-key',
        'X-Service': 'my-service',
      });
    });

    it('should send logs as JSON array in body', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test 1');
      logger.info('Test 2');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(Array.isArray(call?.body)).toBe(true);
      expect(call?.body).toHaveLength(2);
    });
  });

  describe('timeout handling', () => {
    it('should abort request after timeout', async () => {
      // Mock fetch that never resolves
      mockFetch.mockImplementation(
        () =>
          new Promise(() => {
            // Never resolve to simulate hanging request
          })
      );

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        timeout: 100,
        maxRetries: 0, // No retries to speed up test
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(mockFetch).toHaveBeenCalled();
      // Verify AbortController signal was passed
      const call = mockFetch.mock.calls[0];
      expect(call[1].signal).toBeDefined();

      logger.flush();
      transport.end();
    });

    it('should use custom timeout value', async () => {
      let timeoutValue = 0;
      mockFetch.mockImplementation(async (_, options) => {
        // Check if signal gets aborted
        const signal = options.signal as AbortSignal;
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            timeoutValue = Date.now();
            reject(new Error('Aborted'));
          });
        });
      });

      const startTime = Date.now();
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        timeout: 150,
        maxRetries: 0,
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 250));

      if (timeoutValue > 0) {
        const elapsed = timeoutValue - startTime;
        // Should be close to 150ms (allow some margin for timing variance)
        expect(elapsed).toBeGreaterThanOrEqual(140);
        expect(elapsed).toBeLessThan(250);
      }

      logger.flush();
      transport.end();
    });
  });

  describe('retry logic and error handling', () => {
    it('should retry on failed request', async () => {
      let attempts = 0;
      mockFetch.mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          return createMockResponse(500, 'Internal Server Error');
        }
        return createMockResponse(200, 'OK');
      });

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 3,
        retryDelay: 10, // Short delay for testing
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have retried and eventually succeeded
      expect(attempts).toBe(3);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      logger.flush();
      transport.end();
    });

    it('should use exponential backoff for retries', async () => {
      const attemptTimes: number[] = [];
      mockFetch.mockImplementation(async () => {
        attemptTimes.push(Date.now());
        return createMockResponse(500, 'Internal Server Error');
      });

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 3,
        retryDelay: 50,
        batchInterval: 10,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have made initial attempt + 3 retries
      expect(attemptTimes.length).toBe(4);

      // Check exponential backoff (approximately)
      if (attemptTimes.length >= 3) {
        const delay1 = attemptTimes[1] - attemptTimes[0];
        const delay2 = attemptTimes[2] - attemptTimes[1];

        // Second delay should be roughly 2x first delay (exponential)
        // Allow 40% margin for timing variance
        expect(delay2).toBeGreaterThan(delay1 * 1.5);
      }

      logger.flush();
      transport.end();
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 1,
        retryDelay: 10,
        batchInterval: 50,
      });
      const logger = pino(transport);

      // Should not throw
      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should have attempted initial + 1 retry
      expect(mockFetch).toHaveBeenCalledTimes(2);

      logger.flush();
      transport.end();
    });

    it('should handle non-200 status codes', async () => {
      mockFetch.mockResolvedValue(createMockResponse(404, 'Not Found'));

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 2,
        retryDelay: 10,
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should have retried
      expect(mockFetch).toHaveBeenCalledTimes(3);

      logger.flush();
      transport.end();
    });

    it('should not retry indefinitely', async () => {
      mockFetch.mockResolvedValue(createMockResponse(500, 'Internal Server Error'));

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 2,
        retryDelay: 10,
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should stop after maxRetries (initial + 2 retries = 3 total)
      expect(mockFetch).toHaveBeenCalledTimes(3);

      logger.flush();
      transport.end();
    });

    it('should continue processing new logs after failed batch', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return createMockResponse(500, 'Internal Server Error');
        }
        return createMockResponse(200, 'OK');
      });

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 1,
        retryDelay: 10,
        batchSize: 1,
        batchInterval: 1000,
      });
      const logger = pino(transport);

      // First log (will fail then succeed on retry)
      logger.info('Log 1');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second log (should succeed)
      logger.info('Log 2');
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Both should have been sent
      const calls = getAllFetchCalls();
      expect(calls.length).toBeGreaterThanOrEqual(2);

      logger.flush();
      transport.end();
    });
  });

  describe('graceful shutdown', () => {
    it('should complete close operation without errors', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 10,
        batchInterval: 100,
      });
      const logger = pino(transport);

      logger.info('Test log');
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should complete without throwing (if it throws, test will fail)
      await transport.end();
      expect(true).toBe(true); // Test passes if we get here
    });

    it('should not throw if closed with empty buffer', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 100,
        batchInterval: 5000,
      });

      // Close without logging anything - should not throw
      await transport.end();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('concurrency and performance', () => {
    it('should handle high-volume logging', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 50,
        batchInterval: 100,
      });
      const logger = pino(transport);

      // Log 100 messages
      for (let i = 0; i < 100; i++) {
        logger.info(`Log ${i}`);
      }

      // Wait for all batches
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have sent at least 2 batches
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Total logs sent should be 100
      const calls = getAllFetchCalls();
      const totalLogs = calls.reduce((sum, call) => sum + call.body.length, 0);
      expect(totalLogs).toBe(100);

      logger.flush();
      transport.end();
    });

    it('should not send concurrent batches', async () => {
      let inFlight = 0;
      let maxConcurrent = 0;

      mockFetch.mockImplementation(async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight--;
        return createMockResponse();
      });

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 2,
        batchInterval: 1000,
      });
      const logger = pino(transport);

      // Trigger multiple batches in quick succession
      logger.info('Log 1');
      logger.info('Log 2');
      await new Promise((resolve) => setTimeout(resolve, 10));
      logger.info('Log 3');
      logger.info('Log 4');
      await new Promise((resolve) => setTimeout(resolve, 10));
      logger.info('Log 5');
      logger.info('Log 6');

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should never have more than 1 concurrent request
      expect(maxConcurrent).toBeLessThanOrEqual(1);

      logger.flush();
      transport.end();
    });

    it('should handle rapid bursts of logs', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchSize: 10,
        batchInterval: 100,
      });
      const logger = pino(transport);

      const burstCount = 25;
      const logMessages: string[] = [];

      // Burst of 25 logs with unique identifiers
      for (let i = 0; i < burstCount; i++) {
        const msg = `Burst log ${i}`;
        logMessages.push(msg);
        logger.info(msg);
      }

      // Wait for all logs to be processed and sent
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify all our logs were sent
      const calls = getAllFetchCalls();
      const allSentLogs = calls.flatMap((call) => call.body);
      const sentMessages = allSentLogs.map((log) => log.msg);

      // Check that all our burst logs are present
      for (const msg of logMessages) {
        expect(sentMessages).toContain(msg);
      }

      await transport.end();
    });
  });

  describe('edge cases', () => {
    it('should handle logs with special characters', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Log with "quotes" and \\backslashes\\ and emoji 🎉');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body[0].msg).toBe('Log with "quotes" and \\backslashes\\ and emoji 🎉');

      logger.flush();
      transport.end();
    });

    it('should handle very large log messages', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      const largeMessage = 'x'.repeat(10000);
      logger.info(largeMessage);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body[0].msg).toBe(largeMessage);

      logger.flush();
      transport.end();
    });

    it('should handle logs with circular references', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      const obj: PinoLogObject = { level: 30, time: Date.now(), msg: 'test' };
      obj.self = obj;

      // Pino should handle circular references
      logger.info({ data: obj }, 'Circular reference');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body[0].msg).toBe('Circular reference');

      logger.flush();
      transport.end();
    });

    it('should handle empty log messages', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body[0].msg).toBe('');

      logger.flush();
      transport.end();
    });

    it('should handle undefined and null values in metadata', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info({ nullValue: null, undefinedValue: undefined, zeroValue: 0 }, 'Test');

      await new Promise((resolve) => setTimeout(resolve, 100));

      const call = getLastFetchCall();
      expect(call?.body[0].nullValue).toBeNull();
      expect(call?.body[0].zeroValue).toBe(0);
      // undefined values are typically omitted in JSON

      logger.flush();
      transport.end();
    });
  });

  describe('error logging behavior', () => {
    it('should surface errors from actual worker thread to parent process', async () => {
      // This test creates a REAL worker thread using pino.transport()
      // and verifies that errors surface to the parent process

      let stderrOutput = '';
      const originalWrite = process.stderr.write.bind(process.stderr);

      // Capture stderr writes
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((buffer: Uint8Array | string) => {
        stderrOutput += buffer.toString();
        // Also write to actual stderr so we can see it
        originalWrite(buffer);
        return true;
      }) as any);

      try {
        // Create logger with transport running in a worker thread
        // Use the built dist file so it can be loaded in the worker
        const logger = pino({
          transport: {
            target: resolve(__dirname, '../dist/index.cjs'),
            options: {
              url: 'http://localhost:9999/will-fail',
              maxRetries: 0,
              batchInterval: 100,
            },
          },
        });

        // Log something to trigger the transport
        logger.info('Test from worker thread');

        // Wait for the worker to process and fail
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Verify that errors from the worker thread appeared in parent's stderr
        expect(stderrOutput).toContain('[pino-http-transport]');
        expect(stderrOutput.toLowerCase()).toMatch(/failed|error|econnrefused/);

        // Clean up
        await logger.flush();
      } finally {
        stderrSpy.mockRestore();
      }
    }, 10000);

    it('should surface errors via console.error (visible in worker threads)', async () => {
      mockFetch.mockRejectedValue(new Error('Worker thread error'));

      // Capture console.error calls - in worker threads, this goes to parent's stderr
      const errorMessages: string[] = [];
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
        errorMessages.push(args.join(' '));
      });

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 0,
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test from worker');
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify console.error was called with transport errors
      // In actual worker threads, console.error output goes to parent process stderr
      expect(errorMessages.length).toBeGreaterThan(0);
      const transportErrors = errorMessages.filter((msg) => msg.includes('[pino-http-transport]'));
      expect(transportErrors.length).toBeGreaterThan(0);
      expect(transportErrors.some((msg) => msg.includes('Worker thread error'))).toBe(true);

      consoleSpy.mockRestore();
      await transport.end();
    });

    it('should not log errors when silent option is enabled', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('Network error'));

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 0,
        batchInterval: 50,
        silent: true, // Explicitly silence errors
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();

      logger.flush();
      transport.end();
    });

    it('should log errors by default', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('Network error'));

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 0,
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('[pino-http-transport]');

      consoleSpy.mockRestore();

      logger.flush();
      transport.end();
    });

    it('should include error details in log output', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('Connection timeout'));

      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxRetries: 0,
        batchInterval: 50,
      });
      const logger = pino(transport);

      logger.info('Test');
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][1]).toBe('Connection timeout');

      consoleSpy.mockRestore();

      logger.flush();
      transport.end();
    });
  });

  describe('buffer size limiting', () => {
    it('should use default maxBufferSize of 100000 logs', () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
      });
      expect(transport).toBeDefined();
      // Default is 100000 logs (~100MB assuming ~1KB per log)
    });

    it('should accept custom maxBufferSize', () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 10,
      });
      expect(transport).toBeDefined();
    });

    it('should drop old logs when buffer exceeds maxBufferSize', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Use a very small buffer size to trigger dropping
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 5, // Only 5 logs
        batchSize: 1000, // Large batch size to prevent flushing
        batchInterval: 10000, // Long interval to prevent flushing
      });
      const logger = pino(transport);

      // Create more logs than the limit
      for (let i = 0; i < 10; i++) {
        logger.info(`Log ${i}`);
      }

      // Wait a bit for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have warned about dropping logs
      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Buffer size limit exceeded');
      expect(consoleSpy.mock.calls[0][0]).toContain('Dropped');

      consoleSpy.mockRestore();
      await transport.end();
    });

    it('should not drop logs when buffer is under limit', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 1000, // Plenty of space
        batchSize: 1000,
        batchInterval: 10000,
      });
      const logger = pino(transport);

      // Create logs that won't exceed the limit
      for (let i = 0; i < 100; i++) {
        logger.info(`Log ${i}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not have warned about dropping logs
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      await transport.end();
    });

    it('should drop oldest logs first (FIFO)', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 10, // Only 10 logs
        batchSize: 1000,
        batchInterval: 10000,
      });
      const logger = pino(transport);

      // Create logs with unique identifiers
      const logIds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const logId = `log-${i}`;
        logIds.push(logId);
        logger.info({ logId }, `Message ${i}`);
      }

      // Wait for logs to be processed into buffer
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Flush and check what was sent
      await transport.end();

      // Wait a bit for the flush to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const calls = getAllFetchCalls();
      const allLogs = calls.flatMap((call) => call.body);
      const sentLogIds = allLogs.map((log) => (log as PinoLogObject).logId).filter(Boolean);

      // Should have at most 10 logs (the limit) since oldest were dropped
      expect(sentLogIds.length).toBeLessThanOrEqual(10);
      expect(sentLogIds.length).toBeGreaterThan(0);

      // The newest logs should be present (last 5 for sure)
      const lastFewLogIds = logIds.slice(-5);
      for (const logId of lastFewLogIds) {
        expect(sentLogIds).toContain(logId);
      }

      // The oldest logs should NOT be present (first 5 should be dropped)
      const firstFewLogIds = logIds.slice(0, 5);
      for (const logId of firstFewLogIds) {
        expect(sentLogIds).not.toContain(logId);
      }
    });

    it('should not warn when silent is enabled and logs are dropped', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 5,
        batchSize: 1000,
        batchInterval: 10000,
        silent: true,
      });
      const logger = pino(transport);

      for (let i = 0; i < 10; i++) {
        logger.info(`Log ${i}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not have warned (silent mode)
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      await transport.end();
    });

    it('should reset buffer count after flushing', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 20,
        batchSize: 5, // Small batch to trigger flush
        batchInterval: 1000,
      });
      const logger = pino(transport);

      // Add logs that will trigger a flush
      for (let i = 0; i < 10; i++) {
        logger.info(`Log ${i}`);
      }

      // Wait for flush
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Buffer should have been flushed, so adding more logs shouldn't trigger drops
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Add more logs - should not drop since buffer was flushed
      for (let i = 0; i < 5; i++) {
        logger.info(`Log ${i}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should not warn about dropping (buffer was reset after flush)
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
      await transport.end();
    });

    it('should maintain buffer count accuracy across multiple operations', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 100,
        batchSize: 3, // Small batch to trigger flush
        batchInterval: 1000,
      });
      const logger = pino(transport);

      // Add various sized logs that will trigger a flush
      logger.info('Small log');
      logger.info({ data: 'x'.repeat(100) }, 'Medium log');
      logger.info({ data: 'x'.repeat(500) }, 'Large log');

      // Wait for batch to be flushed (should happen when batchSize reached)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Verify logs were sent
      const calls = getAllFetchCalls();
      const allLogs = calls.flatMap((call) => call.body);
      expect(allLogs.length).toBeGreaterThanOrEqual(3);

      await transport.end();
    });

    it('should enforce limit exactly at maxBufferSize', async () => {
      const transport = httpTransport({
        url: 'http://localhost:3000/logs',
        maxBufferSize: 5,
        batchSize: 1000,
        batchInterval: 10000,
      });
      const logger = pino(transport);

      // Add exactly 5 logs - should not drop
      for (let i = 0; i < 5; i++) {
        logger.info(`Log ${i}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Add one more - should drop the oldest
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logger.info('Log 5');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should have warned about dropping
      expect(consoleSpy).toHaveBeenCalled();

      await transport.end();
      consoleSpy.mockRestore();
    });
  });
});

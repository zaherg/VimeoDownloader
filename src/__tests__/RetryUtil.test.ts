import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryUtil, NetworkError, RetryOptions } from '../RetryUtil';

describe('RetryUtil', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createNetworkError', () => {
    it('should create a network error with basic properties', () => {
      const error = RetryUtil.createNetworkError('Test error', 500);
      
      expect(error.message).toBe('Test error');
      expect(error.status).toBe(500);
      expect(error.retryable).toBe(true);
    });

    it('should create error with all properties', () => {
      const error = RetryUtil.createNetworkError(
        'Rate limited',
        429,
        60,
        'RATE_LIMIT'
      );
      
      expect(error.message).toBe('Rate limited');
      expect(error.status).toBe(429);
      expect(error.retryAfter).toBe(60);
      expect(error.errorType).toBe('RATE_LIMIT');
      expect(error.retryable).toBe(true);
    });

    it('should mark auth errors as non-retryable', () => {
      const error = RetryUtil.createNetworkError(
        'Unauthorized',
        401,
        undefined,
        'AUTH_ERROR'
      );
      
      expect(error.retryable).toBe(false);
    });

    it('should mark permission errors as non-retryable', () => {
      const error = RetryUtil.createNetworkError(
        'Forbidden',
        403,
        undefined,
        'PERMISSION_ERROR'
      );
      
      expect(error.retryable).toBe(false);
    });

    it('should mark client errors as non-retryable by default', () => {
      const error = RetryUtil.createNetworkError('Bad Request', 400);
      
      expect(error.retryable).toBe(false);
    });

    it('should mark server errors as retryable', () => {
      const error = RetryUtil.createNetworkError('Internal Server Error', 500);
      
      expect(error.retryable).toBe(true);
    });
  });

  describe('withRetry - success scenarios', () => {
    it('should return result immediately on first success', async () => {
      const operation = vi.fn().mockResolvedValue('success');
      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 100,
        maxDelay: 1000
      };

      const result = await RetryUtil.withRetry(operation, options);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should succeed after retries', async () => {
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockRejectedValueOnce(new Error('Another failure'))
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100
      };

      const result = await RetryUtil.withRetry(operation, options);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });
  });

  describe('withRetry - failure scenarios', () => {
    it('should throw last error after max retries exceeded', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Persistent failure'));
      const options: RetryOptions = {
        maxRetries: 2,
        baseDelay: 10,
        maxDelay: 100
      };

      await expect(RetryUtil.withRetry(operation, options)).rejects.toThrow('Persistent failure');
      expect(operation).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should not retry non-retryable errors', async () => {
      const authError = RetryUtil.createNetworkError('Unauthorized', 401, undefined, 'AUTH_ERROR');
      const operation = vi.fn().mockRejectedValue(authError);
      
      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100
      };

      await expect(RetryUtil.withRetry(operation, options)).rejects.toThrow('Unauthorized');
      expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    it('should not retry 404 errors', async () => {
      const notFoundError = new Error('404');
      const operation = vi.fn().mockRejectedValue(notFoundError);
      
      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100
      };

      await expect(RetryUtil.withRetry(operation, options)).rejects.toThrow('404');
      expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    it('should not retry forbidden errors unless explicitly allowed', async () => {
      const forbiddenError = new Error('forbidden');
      const operation = vi.fn().mockRejectedValue(forbiddenError);
      
      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100
      };

      await expect(RetryUtil.withRetry(operation, options)).rejects.toThrow('forbidden');
      expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    it('should retry forbidden errors if explicitly allowed', async () => {
      const forbiddenError = new Error('forbidden');
      const operation = vi.fn()
        .mockRejectedValueOnce(forbiddenError)
        .mockResolvedValue('success');
      
      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100,
        retryOnStatus: [403]
      };

      const result = await RetryUtil.withRetry(operation, options);
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('withRetry - exponential backoff and jitter', () => {
    it('should use exponential backoff with default multiplier', async () => {
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Failure 1'))
        .mockRejectedValueOnce(new Error('Failure 2'))
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 2,
        baseDelay: 100,
        maxDelay: 10000,
        enableJitter: false // Disable jitter for predictable testing
      };

      await RetryUtil.withRetry(operation, options);

      // Should call sleep twice (after each failure)
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(sleepSpy).toHaveBeenNthCalledWith(1, 100); // baseDelay * 2^0
      expect(sleepSpy).toHaveBeenNthCalledWith(2, 200); // baseDelay * 2^1

      sleepSpy.mockRestore();
    });

    it('should respect max delay limit', async () => {
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Failure'))
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 1,
        baseDelay: 1000,
        maxDelay: 500, // Lower than baseDelay * 2^attempt
        enableJitter: false
      };

      await RetryUtil.withRetry(operation, options);

      expect(sleepSpy).toHaveBeenCalledWith(500); // Capped at maxDelay

      sleepSpy.mockRestore();
    });

    it('should use custom backoff multiplier', async () => {
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Failure'))
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 10000,
        backoffMultiplier: 3,
        enableJitter: false
      };

      await RetryUtil.withRetry(operation, options);

      expect(sleepSpy).toHaveBeenCalledWith(300); // baseDelay * 3^1

      sleepSpy.mockRestore();
    });

    it('should add jitter when enabled', async () => {
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      const mathSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      
      const operation = vi.fn()
        .mockRejectedValueOnce(new Error('Failure'))
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 10000,
        enableJitter: true
      };

      await RetryUtil.withRetry(operation, options);

      // With 50% jitter and 0.5 random: delay = 100 + (100 * 0.1 * 0.5) = 105
      expect(sleepSpy).toHaveBeenCalledWith(105);

      mathSpy.mockRestore();
      sleepSpy.mockRestore();
    });
  });

  describe('withRetry - rate limiting', () => {
    it('should respect Retry-After header from rate limit errors', async () => {
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      const rateLimitError = RetryUtil.createNetworkError(
        'Rate limited',
        429,
        30, // 30 second retry-after
        'RATE_LIMIT'
      );
      
      const operation = vi.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 1000
      };

      await RetryUtil.withRetry(operation, options);

      // Should use retry-after instead of exponential backoff
      expect(sleepSpy).toHaveBeenCalledWith(30000); // 30 seconds in ms

      sleepSpy.mockRestore();
    });

    it('should log rate limit wait message', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      
      const rateLimitError = RetryUtil.createNetworkError(
        'Rate limited',
        429,
        60,
        'RATE_LIMIT'
      );
      
      const operation = vi.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 1000
      };

      await RetryUtil.withRetry(operation, options);

      expect(consoleSpy).toHaveBeenCalledWith('⏳ Rate limited. Waiting 60s before retry...');

      consoleSpy.mockRestore();
      sleepSpy.mockRestore();
    });
  });

  describe('withRetry - retry callbacks', () => {
    it('should call onRetry callback with attempt number and error', async () => {
      const onRetry = vi.fn();
      const error1 = new Error('First failure');
      const error2 = new Error('Second failure');
      
      const operation = vi.fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 2,
        baseDelay: 10,
        maxDelay: 100,
        onRetry
      };

      await RetryUtil.withRetry(operation, options);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, error1);
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, error2);
    });

    it('should not call onRetry for non-retryable errors', async () => {
      const onRetry = vi.fn();
      const authError = RetryUtil.createNetworkError('Unauthorized', 401, undefined, 'AUTH_ERROR');
      
      const operation = vi.fn().mockRejectedValue(authError);

      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100,
        onRetry
      };

      await expect(RetryUtil.withRetry(operation, options)).rejects.toThrow('Unauthorized');
      expect(onRetry).not.toHaveBeenCalled();
    });
  });

  describe('withRetry - error type handling', () => {
    it('should handle NetworkError with retryable flag', async () => {
      const retryableError = RetryUtil.createNetworkError(
        'Temporary error',
        500,
        undefined,
        'SERVER_ERROR'
      );
      retryableError.retryable = true;
      
      const operation = vi.fn()
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValue('success');

      const options: RetryOptions = {
        maxRetries: 1,
        baseDelay: 10,
        maxDelay: 100
      };

      const result = await RetryUtil.withRetry(operation, options);
      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should respect retryable=false flag', async () => {
      const nonRetryableError = RetryUtil.createNetworkError(
        'Client error',
        400,
        undefined,
        'API_ERROR'
      );
      nonRetryableError.retryable = false;
      
      const operation = vi.fn().mockRejectedValue(nonRetryableError);

      const options: RetryOptions = {
        maxRetries: 3,
        baseDelay: 10,
        maxDelay: 100
      };

      await expect(RetryUtil.withRetry(operation, options)).rejects.toThrow('Client error');
      expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    it('should handle different error types correctly', async () => {
      const testCases = [
        { errorType: 'AUTH_ERROR' as const, shouldRetry: false },
        { errorType: 'PERMISSION_ERROR' as const, shouldRetry: false },
        { errorType: 'RATE_LIMIT' as const, shouldRetry: true },
        { errorType: 'SERVER_ERROR' as const, shouldRetry: true },
        { errorType: 'TIMEOUT' as const, shouldRetry: true },
        { errorType: 'CONNECTION_FAILED' as const, shouldRetry: true },
        { errorType: 'PARSE_ERROR' as const, shouldRetry: false },
        { errorType: 'INVALID_RESPONSE' as const, shouldRetry: false },
      ];

      for (const testCase of testCases) {
        const error = RetryUtil.createNetworkError(
          `${testCase.errorType} error`,
          500,
          undefined,
          testCase.errorType
        );
        
        const operation = vi.fn().mockRejectedValue(error);
        const options: RetryOptions = {
          maxRetries: 1,
          baseDelay: 10,
          maxDelay: 100
        };

        try {
          await RetryUtil.withRetry(operation, options);
        } catch {
          // Expected for non-retryable errors
        }

        const expectedCalls = testCase.shouldRetry ? 2 : 1;
        expect(operation).toHaveBeenCalledTimes(expectedCalls);
        
        // Reset for next iteration
        operation.mockClear();
      }
    });
  });

  describe('sleep utility', () => {
    it('should resolve after specified time', async () => {
      const start = Date.now();
      await (RetryUtil as any).sleep(10);
      const elapsed = Date.now() - start;
      
      // Allow some tolerance for timing
      expect(elapsed).toBeGreaterThanOrEqual(8);
      expect(elapsed).toBeLessThan(50);
    });
  });
});
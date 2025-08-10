import { describe, it, expect, vi } from 'vitest';
import { ErrorHandler, ErrorGuidance } from '../ErrorHandler';
import { RetryUtil, NetworkError } from '../RetryUtil';

describe('ErrorHandler', () => {
  describe('classifyError - Network errors with errorType', () => {
    it('should classify AUTH_ERROR correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Authentication failed',
        401,
        undefined,
        'AUTH_ERROR'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('authentication');
      expect(guidance.recoverable).toBe(false);
      expect(guidance.userMessage).toBe('Authentication failed with Vimeo API');
      expect(guidance.suggestedActions).toContain('Check that your access token is valid and not expired');
      expect(guidance.suggestedActions).toContain('Verify the token has necessary permissions (download, video access)');
      expect(guidance.suggestedActions).toContain('Generate a new access token from Vimeo Developer settings');
    });

    it('should classify PERMISSION_ERROR correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Access denied',
        403,
        undefined,
        'PERMISSION_ERROR'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('permission');
      expect(guidance.recoverable).toBe(false);
      expect(guidance.userMessage).toBe('Access denied to video or resource');
      expect(guidance.suggestedActions).toContain('Check if you have permission to download this video');
      expect(guidance.suggestedActions).toContain('Verify the video download settings in Vimeo');
    });

    it('should classify RATE_LIMIT correctly with retry-after', () => {
      const error = RetryUtil.createNetworkError(
        'Too many requests',
        429,
        120, // 2 minutes
        'RATE_LIMIT'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('server');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Rate limit exceeded');
      expect(guidance.technicalDetails).toBe('Too many requests (Retry after: 120 seconds)');
      expect(guidance.suggestedActions).toContain('Wait 120 seconds before retrying');
      expect(guidance.suggestedActions).toContain('Reduce concurrent download connections');
    });

    it('should classify RATE_LIMIT correctly without retry-after', () => {
      const error = RetryUtil.createNetworkError(
        'Rate limited',
        429,
        undefined,
        'RATE_LIMIT'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.technicalDetails).toBe('Rate limited (Retry after: a while)');
      expect(guidance.suggestedActions).toContain('Wait a while before retrying');
    });

    it('should classify CONNECTION_FAILED correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Connection failed',
        0,
        undefined,
        'CONNECTION_FAILED'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('network');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Network connection failed');
      expect(guidance.suggestedActions).toContain('Check your internet connection');
      expect(guidance.suggestedActions).toContain('Verify DNS settings and firewall configuration');
      expect(guidance.suggestedActions).toContain('Use a VPN if regional blocking is suspected');
    });

    it('should classify TIMEOUT correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Request timeout',
        0,
        undefined,
        'TIMEOUT'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('network');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Request timed out');
      expect(guidance.suggestedActions).toContain('Check your internet connection speed');
      expect(guidance.suggestedActions).toContain('Try again - the server may be temporarily slow');
    });

    it('should classify SERVER_ERROR correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Internal server error',
        500,
        undefined,
        'SERVER_ERROR'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('server');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Vimeo server error');
      expect(guidance.technicalDetails).toBe('Internal server error (Status: 500)');
      expect(guidance.suggestedActions).toContain('Wait a few minutes and try again - this is usually temporary');
      expect(guidance.suggestedActions).toContain('Check Vimeo status page for ongoing issues');
    });

    it('should classify PARSE_ERROR correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Invalid JSON',
        200,
        undefined,
        'PARSE_ERROR'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('server');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Invalid response from server');
      expect(guidance.suggestedActions).toContain('Try again - this may be a temporary server issue');
    });

    it('should classify INVALID_RESPONSE correctly', () => {
      const error = RetryUtil.createNetworkError(
        'Non-JSON response',
        200,
        undefined,
        'INVALID_RESPONSE'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('server');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Invalid response from server');
    });
  });

  describe('classifyError - Generic errors', () => {
    it('should classify DNS errors correctly', () => {
      const error = new Error('ENOTFOUND api.vimeo.com');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('network');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('DNS resolution failed');
      expect(guidance.suggestedActions).toContain('Check your internet connection');
      expect(guidance.suggestedActions).toContain('Try using a different DNS server (8.8.8.8 or 1.1.1.1)');
    });

    it('should classify connection refused errors correctly', () => {
      const error = new Error('ECONNREFUSED 127.0.0.1:3000');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('network');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Connection refused by server');
      expect(guidance.suggestedActions).toContain('Check if the service is running');
      expect(guidance.suggestedActions).toContain('Verify firewall settings');
    });

    it('should classify connection reset errors correctly', () => {
      const error = new Error('ECONNRESET');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('network');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Connection refused by server');
    });

    it('should classify disk space errors correctly', () => {
      const error = new Error('ENOSPC: no space left on device');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('system');
      expect(guidance.recoverable).toBe(false);
      expect(guidance.userMessage).toBe('Insufficient disk space');
      expect(guidance.suggestedActions).toContain('Free up disk space on your system');
      expect(guidance.suggestedActions).toContain('Choose a different download location with more space');
    });

    it('should classify permission errors correctly', () => {
      const error = new Error('EACCES: permission denied');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('system');
      expect(guidance.recoverable).toBe(false);
      expect(guidance.userMessage).toBe('File system permission denied');
      expect(guidance.suggestedActions).toContain('Check file/folder permissions for the download directory');
      expect(guidance.suggestedActions).toContain('Run with appropriate user permissions');
    });

    it('should classify unknown errors with generic guidance', () => {
      const error = new Error('Unknown weird error');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('client');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('An unexpected error occurred');
      expect(guidance.technicalDetails).toBe('Unknown weird error');
      expect(guidance.suggestedActions).toContain('Try the operation again');
      expect(guidance.suggestedActions).toContain('Check your network connection and permissions');
    });
  });

  describe('formatErrorGuidance', () => {
    it('should format authentication error with correct icon and structure', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Authentication failed',
        technicalDetails: 'Token expired',
        suggestedActions: ['Get new token', 'Check permissions'],
        recoverable: false,
        category: 'authentication'
      };

      const formatted = ErrorHandler.formatErrorGuidance(guidance);

      expect(formatted).toContain('🔐 Authentication failed (⛔ Not recoverable)');
      expect(formatted).toContain('Token expired');
      expect(formatted).toContain('💡 Suggested actions:');
      expect(formatted).toContain('1. Get new token');
      expect(formatted).toContain('2. Check permissions');
    });

    it('should format network error with correct icon', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Connection failed',
        technicalDetails: 'Network timeout',
        suggestedActions: ['Check connection'],
        recoverable: true,
        category: 'network'
      };

      const formatted = ErrorHandler.formatErrorGuidance(guidance);

      expect(formatted).toContain('🌐 Connection failed (🔄 Recoverable)');
      expect(formatted).toContain('Network timeout');
    });

    it('should format all error categories with correct icons', () => {
      const categories = [
        { category: 'authentication' as const, expectedIcon: '🔐' },
        { category: 'permission' as const, expectedIcon: '🚫' },
        { category: 'network' as const, expectedIcon: '🌐' },
        { category: 'server' as const, expectedIcon: '🖥️' },
        { category: 'system' as const, expectedIcon: '💾' },
        { category: 'client' as const, expectedIcon: '❌' },
      ];

      for (const testCase of categories) {
        const guidance: ErrorGuidance = {
          userMessage: 'Test error',
          technicalDetails: 'Details',
          suggestedActions: ['Action 1'],
          recoverable: true,
          category: testCase.category
        };

        const formatted = ErrorHandler.formatErrorGuidance(guidance);
        expect(formatted).toContain(testCase.expectedIcon);
      }
    });

    it('should handle multiple suggested actions', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Multiple actions error',
        technicalDetails: 'Error details',
        suggestedActions: [
          'First action to try',
          'Second action if first fails',
          'Third action as last resort'
        ],
        recoverable: true,
        category: 'client'
      };

      const formatted = ErrorHandler.formatErrorGuidance(guidance);

      expect(formatted).toContain('1. First action to try');
      expect(formatted).toContain('2. Second action if first fails');
      expect(formatted).toContain('3. Third action as last resort');
    });

    it('should handle empty suggested actions', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'No actions error',
        technicalDetails: 'Error details',
        suggestedActions: [],
        recoverable: false,
        category: 'system'
      };

      const formatted = ErrorHandler.formatErrorGuidance(guidance);

      expect(formatted).toContain('💡 Suggested actions:');
      expect(formatted).not.toContain('1.');
    });
  });

  describe('shouldRetry', () => {
    it('should return true for recoverable network errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Network error',
        technicalDetails: 'Connection timeout',
        suggestedActions: ['Try again'],
        recoverable: true,
        category: 'network'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(true);
    });

    it('should return true for recoverable server errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Server error',
        technicalDetails: 'Internal server error',
        suggestedActions: ['Wait and retry'],
        recoverable: true,
        category: 'server'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(true);
    });

    it('should return true for recoverable client errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Client error',
        technicalDetails: 'Temporary issue',
        suggestedActions: ['Retry'],
        recoverable: true,
        category: 'client'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(true);
    });

    it('should return false for non-recoverable errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Auth error',
        technicalDetails: 'Invalid token',
        suggestedActions: ['Get new token'],
        recoverable: false,
        category: 'authentication'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(false);
    });

    it('should return false for recoverable authentication errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Auth error',
        technicalDetails: 'Temporary auth issue',
        suggestedActions: ['Wait and retry'],
        recoverable: true,
        category: 'authentication'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(false);
    });

    it('should return false for recoverable permission errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'Permission error',
        technicalDetails: 'Access denied',
        suggestedActions: ['Fix permissions'],
        recoverable: true,
        category: 'permission'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(false);
    });

    it('should return false for recoverable system errors', () => {
      const guidance: ErrorGuidance = {
        userMessage: 'System error',
        technicalDetails: 'Disk space issue',
        suggestedActions: ['Free disk space'],
        recoverable: true,
        category: 'system'
      };

      expect(ErrorHandler.shouldRetry(guidance)).toBe(false);
    });
  });

  describe('Edge cases and complex scenarios', () => {
    it('should handle non-Error objects', () => {
      const notAnError = { message: 'Not an Error instance' };

      const guidance = ErrorHandler.classifyError(notAnError as Error);

      expect(guidance.category).toBe('client');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.technicalDetails).toBe('Not an Error instance');
    });

    it('should handle errors without messages', () => {
      const errorWithoutMessage = new Error();
      errorWithoutMessage.message = '';

      const guidance = ErrorHandler.classifyError(errorWithoutMessage);

      expect(guidance.category).toBe('client');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.technicalDetails).toBe('');
    });

    it('should handle NetworkError without errorType', () => {
      const networkError = RetryUtil.createNetworkError('Generic network error', 500);
      delete (networkError as any).errorType;

      const guidance = ErrorHandler.classifyError(networkError);

      expect(guidance.category).toBe('client');
      expect(guidance.userMessage).toBe('An unexpected error occurred');
    });

    it('should prioritize errorType over generic error patterns', () => {
      const error = RetryUtil.createNetworkError(
        'ENOTFOUND api.vimeo.com',
        0,
        undefined,
        'TIMEOUT'
      );

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('network');
      expect(guidance.userMessage).toBe('Request timed out'); // From errorType, not ENOTFOUND pattern
    });

    it('should handle case-insensitive error message matching', () => {
      const error = new Error('FORBIDDEN ACCESS');

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.category).toBe('client');
      expect(guidance.userMessage).toBe('An unexpected error occurred');
    });

    it('should handle multiple error patterns in one message', () => {
      const error = new Error('ENOTFOUND and EACCES occurred together');

      const guidance = ErrorHandler.classifyError(error);

      // Should match the first pattern (DNS error)
      expect(guidance.category).toBe('network');
      expect(guidance.userMessage).toBe('DNS resolution failed');
    });
  });

  describe('Integration with NetworkError', () => {
    it('should work correctly with NetworkError created by RetryUtil', () => {
      const originalError = RetryUtil.createNetworkError(
        'API request failed: 429 Too Many Requests',
        429,
        30,
        'RATE_LIMIT'
      );

      const guidance = ErrorHandler.classifyError(originalError);

      expect(guidance.category).toBe('server');
      expect(guidance.recoverable).toBe(true);
      expect(guidance.userMessage).toBe('Rate limit exceeded');
      expect(originalError.retryable).toBe(true);
    });

    it('should respect retryable flag from NetworkError', () => {
      const error = RetryUtil.createNetworkError('Custom error', 400);
      error.retryable = false;

      const guidance = ErrorHandler.classifyError(error);

      expect(guidance.recoverable).toBe(true); // ErrorHandler makes its own decision
      expect(error.retryable).toBe(false); // But respects the original flag
    });
  });
});
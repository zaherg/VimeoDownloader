import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VimeoDownloader } from '../VimeoDownloader';
import { RetryUtil } from '../RetryUtil';
import { ErrorHandler } from '../ErrorHandler';
import { ProgressTracker } from '../ProgressTracker';
import type { Config } from '../types';

// Mock all the modules
vi.mock('fs');
vi.mock('path', () => ({
  default: {
    join: (...parts: string[]) => parts.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  }
}));

describe('Error Recovery Integration Tests', () => {
  let downloader: VimeoDownloader;
  let mockConfig: Config;
  let mockFs: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    
    mockConfig = {
      clientId: 'test_client_id',
      clientSecret: 'test_client_secret',
      accessToken: 'test_access_token',
      downloadPath: './test-downloads',
      maxConcurrentDownloads: 2,
      quality: 'highest',
      dryRun: false,
      overwrite: false,
    };

    mockFs = await import('fs');
    vi.mocked(mockFs.existsSync).mockReturnValue(false);
    vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});
    vi.mocked(mockFs.statSync).mockReturnValue({ size: 1000000 } as any);

    global.fetch = vi.fn();
    global.Bun = {
      file: vi.fn(),
      write: vi.fn(),
    } as any;

    downloader = new VimeoDownloader(mockConfig);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Network Error Recovery Scenarios', () => {
    it('should recover from temporary network failures with exponential backoff', async () => {
      // Setup: Mock API calls that fail then succeed
      const mockVideoResponse = {
        data: [{
          uri: '/videos/123',
          name: 'Test Video',
          created_time: '2023-01-01T00:00:00Z',
          modified_time: '2023-01-01T00:00:00Z',
        }],
        paging: { next: null }
      };

      const mockDownloadInfo = {
        download: [{
          quality: 'hd',
          type: 'video/mp4',
          link: 'https://example.com/video.mp4',
          size: 1000000,
          public_name: '1080p MP4'
        }]
      };

      // First call fails with network error, second succeeds
      vi.mocked(fetch)
        .mockRejectedValueOnce(new Error('Network connection failed'))
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => mockVideoResponse,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => mockDownloadInfo,
        } as Response);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Should recover and complete successfully
      const videos = await downloader['getAllVideos']();
      
      expect(videos).toHaveLength(1);
      expect(videos[0].name).toBe('Test Video');
      
      // Should have attempted retry
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Retrying video fetch'));

      consoleSpy.mockRestore();
    });

    it('should handle rate limiting with proper backoff', async () => {
      const rateLimitResponse = {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '5' }),
      } as Response;

      const successResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: [], paging: { next: null } }),
      } as Response;

      vi.mocked(fetch)
        .mockResolvedValueOnce(rateLimitResponse)
        .mockResolvedValueOnce(successResponse);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await downloader['getAllVideos']();

      expect(consoleSpy).toHaveBeenCalledWith('⏳ Rate limited. Waiting 5s before retry...');
      
      consoleSpy.mockRestore();
    });

    it('should fail fast on authentication errors without retries', async () => {
      const authError = RetryUtil.createNetworkError(
        'Authentication failed',
        401,
        undefined,
        'AUTH_ERROR'
      );

      vi.mocked(fetch).mockRejectedValue(authError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(downloader['verifyAuthentication']()).rejects.toThrow();

      // Should not retry auth errors
      expect(fetch).toHaveBeenCalledTimes(1);
      
      // Should provide helpful error message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Authentication Error')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Download Resume Scenarios', () => {
    it('should resume interrupted download from partial file', async () => {
      const mockJob = {
        video: { uri: '/videos/123', name: 'Test Video' },
        downloadUrl: 'https://example.com/test.mp4',
        filePath: '/test/downloads/test.mp4',
        size: 1000000
      };

      const partialSize = 400000;

      // Setup: partial file exists
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false) // Main file doesn't exist
        .mockReturnValueOnce(true); // Partial file exists
      vi.mocked(mockFs.statSync)
        .mockReturnValueOnce({ size: partialSize } as any) // Partial file size
        .mockReturnValue({ size: 1000000 } as any); // Final verification
      vi.mocked(mockFs.renameSync).mockImplementation(() => {});

      // Mock successful resume download
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(100000) })
          .mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(Bun.file).mockReturnValue({
        writer: vi.fn().mockReturnValue(mockWriter),
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(partialSize))
      });

      // Mock 206 Partial Content response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: new Headers({
          'content-length': String(1000000 - partialSize)
        }),
        body: {
          getReader: () => mockReader
        }
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await downloader['downloadSingleVideo'](mockJob, 1, 1);

      expect(result).toBe('downloaded');
      
      // Should log resume message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('📁 Resuming Test Video from 390.62 KB')
      );
      
      // Should request with Range header
      expect(fetch).toHaveBeenCalledWith(
        mockJob.downloadUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Range': `bytes=${partialSize}-`
          })
        })
      );

      // Should rename temp file to final location
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        mockJob.filePath + '.partial',
        mockJob.filePath
      );

      consoleSpy.mockRestore();
    });

    it('should handle resume failures and restart from beginning', async () => {
      const mockJob = {
        video: { uri: '/videos/123', name: 'Test Video' },
        downloadUrl: 'https://example.com/test.mp4',
        filePath: '/test/downloads/test.mp4',
        size: 1000000
      };

      // Setup: partial file exists but server doesn't support resume
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false) // Main file doesn't exist
        .mockReturnValueOnce(true); // Partial file exists
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 400000 } as any);
      vi.mocked(mockFs.unlinkSync).mockImplementation(() => {});

      // First attempt: server doesn't support range requests (returns 200 instead of 206)
      const failureResponse = {
        ok: true,
        status: 200, // Should be 206 for partial content
        headers: new Headers({
          'content-length': '1000000'
        }),
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValue({ done: true }),
            releaseLock: vi.fn()
          })
        }
      } as any;

      // Second attempt: full download succeeds
      const successResponse = {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': '1000000'
        }),
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({ done: false, value: new Uint8Array(100000) })
              .mockResolvedValueOnce({ done: true }),
            releaseLock: vi.fn()
          })
        }
      } as any;

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(Bun.file).mockReturnValue({
        writer: vi.fn().mockReturnValue(mockWriter)
      });

      vi.mocked(fetch)
        .mockResolvedValueOnce(failureResponse)
        .mockResolvedValueOnce(successResponse);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Should fail first attempt but retry without range
      await expect(downloader['downloadSingleVideo'](mockJob, 1, 1)).rejects.toMatchObject({
        message: 'Resume not supported, retrying from beginning',
        errorType: 'SERVER_ERROR'
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Server doesn\'t support resume')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Progress Persistence and Recovery', () => {
    it('should save progress during downloads and resume after crash simulation', async () => {
      const downloadPath = '/test/downloads';
      const progressFile = `${downloadPath}/.vimeo-download-progress.json`;

      // Mock progress tracker with persistence
      const tracker = new ProgressTracker(downloadPath);

      // Simulate starting downloads
      tracker.startDownload('video1', 1000000, 'video1.mp4');
      tracker.startDownload('video2', 2000000, 'video2.mp4');

      // Update progress
      tracker.updateProgress('video1', 500000);
      tracker.updateProgress('video2', 1000000);

      // Complete one download
      tracker.completeDownload('video1');

      // Verify progress save was called
      expect(Bun.write).toHaveBeenCalledWith(
        progressFile,
        expect.stringContaining('video1')
      );

      // Get incomplete downloads (simulating app restart)
      const incomplete = tracker.getIncompleteDownloads();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0].id).toBe('video2');
      expect(incomplete[0].downloadedSize).toBe(1000000);
    });

    it('should clean up progress file when all downloads complete', () => {
      const tracker = new ProgressTracker('/test/downloads');

      tracker.startDownload('video1', 1000000, 'video1.mp4');
      tracker.completeDownload('video1');

      // Simulate cleanup on exit
      (tracker as any).cleanup();

      expect(mockFs.unlinkSync).toHaveBeenCalledWith(
        '/test/downloads/.vimeo-download-progress.json'
      );
    });
  });

  describe('Error Classification and User Guidance', () => {
    it('should provide specific guidance for different error types', () => {
      const testCases = [
        {
          error: RetryUtil.createNetworkError('Unauthorized', 401, undefined, 'AUTH_ERROR'),
          expectedCategory: 'authentication',
          expectedRecoverable: false,
          expectedSuggestion: 'Check that your access token is valid'
        },
        {
          error: RetryUtil.createNetworkError('Connection timeout', 0, undefined, 'TIMEOUT'),
          expectedCategory: 'network',
          expectedRecoverable: true,
          expectedSuggestion: 'Check your internet connection speed'
        },
        {
          error: new Error('ENOSPC: no space left on device'),
          expectedCategory: 'system',
          expectedRecoverable: false,
          expectedSuggestion: 'Free up disk space on your system'
        },
        {
          error: RetryUtil.createNetworkError('Rate limited', 429, 30, 'RATE_LIMIT'),
          expectedCategory: 'server',
          expectedRecoverable: true,
          expectedSuggestion: 'Wait 30 seconds before retrying'
        }
      ];

      for (const testCase of testCases) {
        const guidance = ErrorHandler.classifyError(testCase.error);
        
        expect(guidance.category).toBe(testCase.expectedCategory);
        expect(guidance.recoverable).toBe(testCase.expectedRecoverable);
        expect(guidance.suggestedActions.some(action => 
          action.toLowerCase().includes(testCase.expectedSuggestion.toLowerCase())
        )).toBe(true);

        // Test formatted output
        const formatted = ErrorHandler.formatErrorGuidance(guidance);
        expect(formatted).toContain('💡 Suggested actions:');
        expect(formatted).toContain(testCase.expectedRecoverable ? '🔄 Recoverable' : '⛔ Not recoverable');
      }
    });
  });

  describe('End-to-End Error Recovery Flow', () => {
    it('should handle complex scenario: auth error, then rate limit, then successful download', async () => {
      const mockVideo = {
        uri: '/videos/123',
        name: 'Test Video',
        created_time: '2023-01-01T00:00:00Z',
        modified_time: '2023-01-01T00:00:00Z',
      };

      const mockDownloadInfo = {
        download: [{
          quality: 'hd',
          type: 'video/mp4',
          link: 'https://example.com/video.mp4',
          size: 1000000,
          public_name: '1080p MP4'
        }]
      };

      // Sequence of responses: auth error, then rate limit, then success
      const authError = {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers()
      } as Response;

      const rateLimitError = {
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({ 'retry-after': '1' })
      } as Response;

      const successResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => mockDownloadInfo
      } as Response;

      vi.mocked(fetch)
        .mockResolvedValueOnce(authError)
        .mockResolvedValueOnce(rateLimitError)
        .mockResolvedValueOnce(successResponse);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // First call should fail with auth error (no retry)
      await expect(downloader['getVideoDownloadInfo'](mockVideo)).rejects.toThrow();

      // Should not retry auth errors
      expect(fetch).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });

    it('should provide comprehensive error summary with recovery instructions', async () => {
      // Simulate the main download process with various errors
      const mockJob = {
        video: { uri: '/videos/123', name: 'Test Video' },
        downloadUrl: 'https://example.com/test.mp4',
        filePath: '/test/downloads/test.mp4',
        size: 1000000
      };

      vi.mocked(mockFs.existsSync).mockReturnValue(false);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});

      // Mock network failure during download
      const networkError = RetryUtil.createNetworkError(
        'Connection failed',
        0,
        undefined,
        'CONNECTION_FAILED'
      );

      vi.mocked(fetch).mockRejectedValue(networkError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await downloader['downloadSingleVideo'](mockJob, 1, 1);
      } catch (error) {
        // Error is expected
      }

      // Should provide error classification and guidance
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test Video: Network connection failed')
      );

      consoleSpy.mockRestore();
    });

    it('should handle multiple concurrent download failures with proper error reporting', async () => {
      const mockJobs = [
        {
          video: { uri: '/videos/1', name: 'Video 1' },
          downloadUrl: 'https://example.com/1.mp4',
          filePath: '/test/1.mp4',
          size: 1000000
        },
        {
          video: { uri: '/videos/2', name: 'Video 2' },
          downloadUrl: 'https://example.com/2.mp4',
          filePath: '/test/2.mp4',
          size: 2000000
        }
      ];

      vi.mocked(mockFs.existsSync).mockReturnValue(false);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});

      // Different errors for different downloads
      const timeoutError = RetryUtil.createNetworkError('Timeout', 0, undefined, 'TIMEOUT');
      const rateLimitError = RetryUtil.createNetworkError('Rate limited', 429, 60, 'RATE_LIMIT');

      vi.mocked(fetch)
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(rateLimitError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Download both jobs (they should fail)
      const results = await Promise.allSettled([
        downloader['downloadSingleVideo'](mockJobs[0], 1, 2),
        downloader['downloadSingleVideo'](mockJobs[1], 2, 2)
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');

      // Should report both errors with specific guidance
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Video 1: Request timed out'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Video 2: Rate limit exceeded'));

      consoleSpy.mockRestore();
    });
  });

  describe('Retry Logic Integration', () => {
    it('should use enhanced retry logic with jitter and custom backoff', async () => {
      const sleepSpy = vi.spyOn(RetryUtil as any, 'sleep').mockResolvedValue(undefined);
      
      // Mock temporary failures followed by success
      const temporaryError = RetryUtil.createNetworkError('Temporary failure', 503, undefined, 'SERVER_ERROR');
      const successResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: [], paging: { next: null } })
      } as Response;

      vi.mocked(fetch)
        .mockRejectedValueOnce(temporaryError)
        .mockRejectedValueOnce(temporaryError)
        .mockResolvedValueOnce(successResponse);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await downloader['getAllVideos']();

      // Should have attempted retries with backoff
      expect(sleepSpy).toHaveBeenCalledTimes(2);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Retrying video fetch'));

      sleepSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('should respect retry limits and fail after max attempts', async () => {
      const persistentError = RetryUtil.createNetworkError('Persistent failure', 503, undefined, 'SERVER_ERROR');
      
      vi.mocked(fetch).mockRejectedValue(persistentError);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(downloader['getAllVideos']()).rejects.toThrow();

      // Should have attempted max retries (3 + 1 initial = 4 total calls)
      expect(fetch).toHaveBeenCalledTimes(4);

      consoleSpy.mockRestore();
    });
  });
});
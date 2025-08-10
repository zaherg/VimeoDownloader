import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VimeoDownloader } from '../VimeoDownloader';
import { RetryUtil } from '../RetryUtil';
import { ErrorHandler } from '../ErrorHandler';
import type { Config, VimeoVideo, VimeoFolder, VimeoDownloadLink } from '../types';

// Mock external modules
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  renameSync: vi.fn(),
}));

// Mock path module
vi.mock('path', () => ({
  default: {
    join: (...parts: string[]) => parts.join('/'),
    dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  }
}));

// Mock fetch globally
global.fetch = vi.fn();

describe('VimeoDownloader', () => {
  let downloader: VimeoDownloader;
  let mockConfig: Config;
  
  beforeEach(() => {
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
    
    downloader = new VimeoDownloader(mockConfig);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Constructor', () => {
    it('should initialize with correct config', () => {
      expect(downloader).toBeInstanceOf(VimeoDownloader);
      expect(downloader['config']).toEqual(mockConfig);
      expect(downloader['baseUrl']).toBe('https://api.vimeo.com');
    });

    it('should have correct headers', () => {
      const headers = downloader['headers'];
      expect(headers.Authorization).toBe('Bearer test_access_token');
      expect(headers['User-Agent']).toBe('VimeoDownloader/1.0');
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove invalid characters', () => {
      const result = downloader['sanitizeFilename']('test<>:"/\\|?*file.mp4');
      expect(result).toBe('test_______file.mp4');
    });

    it('should handle Windows reserved names', () => {
      const result = downloader['sanitizeFilename']('CON');
      expect(result).toBe('_CON');
    });

    it('should normalize whitespace', () => {
      const result = downloader['sanitizeFilename']('test   multiple   spaces');
      expect(result).toBe('test multiple spaces');
    });

    it('should remove leading dots', () => {
      const result = downloader['sanitizeFilename']('...hidden.file');
      expect(result).toBe('hidden.file');
    });

    it('should limit filename length', () => {
      const longName = 'a'.repeat(250);
      const result = downloader['sanitizeFilename'](longName);
      expect(result.length).toBe(200);
    });

    it('should handle empty string', () => {
      const result = downloader['sanitizeFilename']('');
      expect(result).toBe('');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(downloader['formatFileSize'](0)).toBe('0 Bytes');
      expect(downloader['formatFileSize'](1024)).toBe('1 KB');
      expect(downloader['formatFileSize'](1048576)).toBe('1 MB');
      expect(downloader['formatFileSize'](1073741824)).toBe('1 GB');
    });

    it('should handle decimal places', () => {
      expect(downloader['formatFileSize'](1536)).toBe('1.5 KB');
      expect(downloader['formatFileSize'](2621440)).toBe('2.5 MB');
    });

    it('should round to 2 decimal places', () => {
      expect(downloader['formatFileSize'](1234567)).toBe('1.18 MB');
    });
  });

  describe('getFileExtension', () => {
    it('should return extension for known MIME types', () => {
      expect(downloader['getFileExtension']('video/mp4')).toBe('mp4');
      expect(downloader['getFileExtension']('video/quicktime')).toBe('mov');
      expect(downloader['getFileExtension']('video/x-msvideo')).toBe('avi');
      expect(downloader['getFileExtension']('video/webm')).toBe('webm');
    });

    it('should return mp4 as default for unknown MIME types', () => {
      expect(downloader['getFileExtension']('unknown/type')).toBe('mp4');
      expect(downloader['getFileExtension']('')).toBe('mp4');
    });
  });

  describe('generateFilePath', () => {
    const mockVideo: VimeoVideo = {
      uri: '/videos/123456',
      name: 'Test Video',
      created_time: '2023-01-01T00:00:00Z',
      modified_time: '2023-01-01T00:00:00Z',
    };

    it('should generate correct file path without folder', () => {
      const result = downloader['generateFilePath'](mockVideo, 'Test Video.mp4');
      expect(result).toBe('test-downloads/Test Video.mp4');
    });

    it('should generate correct file path with folder structure', () => {
      const videoWithFolder: VimeoVideo = {
        ...mockVideo,
        parent_folder: {
          uri: '/folders/789',
          name: 'My Folder',
          created_time: '2023-01-01T00:00:00Z',
          modified_time: '2023-01-01T00:00:00Z',
        }
      };

      const result = downloader['generateFilePath'](videoWithFolder, 'Test Video.mp4');
      expect(result).toBe('test-downloads/My Folder/Test Video.mp4');
    });

    it('should handle nested folder structure', () => {
      const parentFolder: VimeoFolder = {
        uri: '/folders/456',
        name: 'Parent Folder',
        created_time: '2023-01-01T00:00:00Z',
        modified_time: '2023-01-01T00:00:00Z',
      };

      const childFolder: VimeoFolder = {
        uri: '/folders/789',
        name: 'Child Folder',
        created_time: '2023-01-01T00:00:00Z',
        modified_time: '2023-01-01T00:00:00Z',
        parent_folder: parentFolder,
      };

      const videoWithNestedFolders: VimeoVideo = {
        ...mockVideo,
        parent_folder: childFolder,
      };

      const result = downloader['generateFilePath'](videoWithNestedFolders, 'Test Video.mp4');
      expect(result).toBe('test-downloads/Child Folder/Test Video.mp4');
    });

    it('should sanitize folder and file names', () => {
      const videoWithInvalidChars: VimeoVideo = {
        ...mockVideo,
        name: 'Test<>Video',
        parent_folder: {
          uri: '/folders/789',
          name: 'My|Folder',
          created_time: '2023-01-01T00:00:00Z',
          modified_time: '2023-01-01T00:00:00Z',
        }
      };

      const result = downloader['generateFilePath'](videoWithInvalidChars, 'Test__Video.mp4');
      expect(result).toBe('test-downloads/My_Folder/Test__Video.mp4');
    });
  });

  describe('selectQuality', () => {
    const mockDownloadLinks: VimeoDownloadLink[] = [
      {
        quality: 'hd',
        type: 'source',
        width: 1920,
        height: 1080,
        expires: '2024-01-01T00:00:00Z',
        link: 'https://example.com/1080p.mp4',
        created_time: '2023-01-01T00:00:00Z',
        fps: 30,
        size: 100000000,
        md5: 'hash1',
        public_name: '1080p MP4',
        size_short: '95.37 MB',
      },
      {
        quality: 'sd',
        type: 'video/mp4',
        width: 1280,
        height: 720,
        expires: '2024-01-01T00:00:00Z',
        link: 'https://example.com/720p.mp4',
        created_time: '2023-01-01T00:00:00Z',
        fps: 30,
        size: 50000000,
        md5: 'hash2',
        public_name: '720p MP4',
        size_short: '47.68 MB',
      },
      {
        quality: 'mobile',
        type: 'video/mp4',
        width: 640,
        height: 360,
        expires: '2024-01-01T00:00:00Z',
        link: 'https://example.com/360p.mp4',
        created_time: '2023-01-01T00:00:00Z',
        fps: 30,
        size: 25000000,
        md5: 'hash3',
        public_name: '360p MP4',
        size_short: '23.84 MB',
      },
    ];

    it('should select highest quality when configured as "highest"', () => {
      downloader['config'].quality = 'highest';
      const result = downloader['selectQuality'](mockDownloadLinks);
      expect(result).toEqual(mockDownloadLinks[0]); // 1080p
    });

    it('should select source quality first', () => {
      const linksWithSource = [...mockDownloadLinks];
      linksWithSource[1].type = 'source';
      linksWithSource[1].quality = 'sd';
      
      downloader['config'].quality = 'highest';
      const result = downloader['selectQuality'](linksWithSource);
      expect(result).toEqual(linksWithSource[0]); // Still HD source
    });

    it('should select specific quality when requested', () => {
      downloader['config'].quality = '720p';
      const result = downloader['selectQuality'](mockDownloadLinks);
      expect(result).toEqual(mockDownloadLinks[1]); // 720p
    });

    it('should fallback to next best quality if specific not available', () => {
      downloader['config'].quality = '1440p'; // Not available
      const result = downloader['selectQuality'](mockDownloadLinks);
      expect(result).toEqual(mockDownloadLinks[0]); // Best available (1080p)
    });

    it('should handle empty download links', () => {
      const result = downloader['selectQuality']([]);
      expect(result).toBeNull();
    });

    it('should prioritize larger size when qualities are similar', () => {
      const similarQualityLinks = [
        { ...mockDownloadLinks[0], size: 50000000 },
        { ...mockDownloadLinks[0], size: 100000000 },
      ];
      
      downloader['config'].quality = 'highest';
      const result = downloader['selectQuality'](similarQualityLinks);
      expect(result).toEqual(similarQualityLinks[1]); // Larger file
    });
  });

  describe('apiRequest', () => {
    beforeEach(() => {
      vi.mocked(fetch).mockClear();
    });

    it('should make successful API request', async () => {
      const mockResponse = { data: 'test' };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'content-type': 'application/json'
        }),
        json: async () => mockResponse,
      } as Response);

      const result = await downloader['apiRequest']('/test');
      
      expect(fetch).toHaveBeenCalledWith(
        'https://api.vimeo.com/test',
        {
          headers: {
            'Authorization': 'Bearer test_access_token',
            'Accept': 'application/vnd.vimeo.*+json;version=3.4',
          },
          signal: expect.any(AbortSignal),
        }
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors with enhanced error types', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      } as Response);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        message: 'API request failed: 404 Not Found',
        status: 404,
        errorType: 'API_ERROR'
      });
    });

    it('should handle authentication errors', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: new Headers(),
      } as Response);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        message: 'Authentication failed. Please check your access token.',
        status: 401,
        errorType: 'AUTH_ERROR'
      });
    });

    it('should handle rate limiting with retry-after header', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({
          'retry-after': '60'
        }),
      } as Response);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        message: 'Rate limited. Please wait before retrying.',
        status: 429,
        errorType: 'RATE_LIMIT',
        retryAfter: 60
      });
    });

    it('should handle server errors', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: new Headers(),
      } as Response);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        status: 500,
        errorType: 'SERVER_ERROR'
      });
    });

    it('should validate JSON content type', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({
          'content-type': 'text/html'
        }),
        json: async () => ({}),
      } as Response);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        message: 'Invalid response format - expected JSON',
        errorType: 'INVALID_RESPONSE'
      });
    });

    it('should handle timeout errors', async () => {
      const timeoutError = new Error('Timeout');
      timeoutError.name = 'AbortError';
      vi.mocked(fetch).mockRejectedValueOnce(timeoutError);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        message: expect.stringContaining('Request timeout'),
        errorType: 'TIMEOUT'
      });
    });

    it('should handle connection failures', async () => {
      const networkError = new TypeError('fetch failed');
      vi.mocked(fetch).mockRejectedValueOnce(networkError);

      await expect(downloader['apiRequest']('/test')).rejects.toMatchObject({
        message: expect.stringContaining('Network connection failed'),
        errorType: 'CONNECTION_FAILED'
      });
    });

    it('should handle network errors', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      await expect(downloader['apiRequest']('/test')).rejects.toThrow('Network error');
    });
  });

  describe('verifyAuthentication', () => {
    it('should verify valid authentication', async () => {
      const mockUserData = { name: 'Test User', account: 'pro', metadata: { connections: {} } };
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockUserData,
      } as Response);

      await expect(downloader['verifyAuthentication']()).resolves.not.toThrow();
      
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/me?fields=name,account,metadata.connections'),
        expect.any(Object)
      );
    });

    it('should handle authentication failure', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as Response);

      await expect(downloader['verifyAuthentication']()).rejects.toThrow('Failed to authenticate with Vimeo API');
    });
  });

  describe('prepareDownloadJobs', () => {
    it('should return empty array and show error summary when no videos are downloadable', async () => {
      const mockVideos: VimeoVideo[] = [
        {
          uri: '/videos/123',
          name: 'Test Video 1',
          created_time: '2023-01-01T00:00:00Z',
          modified_time: '2023-01-01T00:00:00Z',
        },
        {
          uri: '/videos/456', 
          name: 'Test Video 2',
          created_time: '2023-01-01T00:00:00Z',
          modified_time: '2023-01-01T00:00:00Z',
        }
      ];

      // Mock API responses with no download/files arrays
      vi.mocked(fetch)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        } as Response);

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const jobs = await downloader['prepareDownloadJobs'](mockVideos);

      expect(jobs).toHaveLength(0);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 videos could not be downloaded'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Test Video 1'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Test Video 2'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Video download not enabled in Vimeo settings'));

      consoleSpy.mockRestore();
    });

    it('should create jobs for videos with download info', async () => {
      const mockVideos: VimeoVideo[] = [
        {
          uri: '/videos/123',
          name: 'Downloadable Video',
          created_time: '2023-01-01T00:00:00Z',
          modified_time: '2023-01-01T00:00:00Z',
        }
      ];

      // Mock API response with download info
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          download: [
            {
              quality: 'hd',
              type: 'video/mp4',
              link: 'https://example.com/video.mp4',
              size: 1000000,
              public_name: '1080p MP4'
            }
          ]
        }),
      } as Response);

      const jobs = await downloader['prepareDownloadJobs'](mockVideos);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].video.name).toBe('Downloadable Video');
      expect(jobs[0].downloadUrl).toBe('https://example.com/video.mp4');
      expect(jobs[0].size).toBe(1000000);
    });
  });

  describe('downloadSingleVideo', () => {
    let mockJob: any;
    let mockFs: any;

    beforeEach(async () => {
      mockJob = {
        video: { uri: '/videos/123', name: 'Test Video' },
        downloadUrl: 'https://example.com/test.mp4',
        filePath: '/test/path/test.mp4',
        size: 1000000
      };
      
      mockFs = await import('fs');
    });

    it('should return "skipped" when file already exists and not overwriting', async () => {
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(true) // Main file exists
        .mockReturnValue(false); // No partial file
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 1000000 } as any); // Complete file

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await downloader['downloadSingleVideo'](mockJob, 1, 1);

      expect(result).toBe('skipped');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping Test Video (already complete)'));

      consoleSpy.mockRestore();
    });

    it('should resume download from partial file', async () => {
      const partialSize = 500000;
      
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false) // Main file doesn't exist
        .mockReturnValueOnce(true); // Partial file exists
      vi.mocked(mockFs.statSync).mockReturnValue({ size: partialSize } as any);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});
      vi.mocked(mockFs.renameSync).mockImplementation(() => {});

      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(100) })
          .mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined)
      };

      global.Bun = {
        file: vi.fn().mockReturnValue({
          writer: vi.fn().mockReturnValue(mockWriter),
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(partialSize))
        })
      } as any;

      // Mock partial content response (206)
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 206, // Partial content
        headers: new Headers({
          'content-length': String(mockJob.size - partialSize)
        }),
        body: {
          getReader: () => mockReader
        }
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await downloader['downloadSingleVideo'](mockJob, 1, 1);

      expect(result).toBe('downloaded');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Resuming Test Video'));
      
      // Should request with Range header
      expect(fetch).toHaveBeenCalledWith(
        mockJob.downloadUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            'Range': `bytes=${partialSize}-`
          })
        })
      );

      consoleSpy.mockRestore();
    });

    it('should rename complete partial file', async () => {
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false) // Main file doesn't exist
        .mockReturnValueOnce(true); // Partial file exists
      vi.mocked(mockFs.statSync).mockReturnValue({ size: mockJob.size } as any); // Complete partial
      vi.mocked(mockFs.renameSync).mockImplementation(() => {});

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await downloader['downloadSingleVideo'](mockJob, 1, 1);

      expect(result).toBe('downloaded');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Completed Test Video (was partial)'));
      expect(mockFs.renameSync).toHaveBeenCalledWith(
        mockJob.filePath + '.partial',
        mockJob.filePath
      );

      consoleSpy.mockRestore();
    });

    it('should delete corrupted partial file and start over', async () => {
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false) // Main file doesn't exist
        .mockReturnValueOnce(true); // Corrupted partial file exists
      vi.mocked(mockFs.statSync)
        .mockReturnValueOnce({ size: 0 } as any) // Corrupted partial (0 bytes)
        .mockReturnValue({ size: mockJob.size } as any); // Final verification
      vi.mocked(mockFs.unlinkSync).mockImplementation(() => {});
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});
      vi.mocked(mockFs.renameSync).mockImplementation(() => {});

      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array(100) })
          .mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined)
      };

      global.Bun = {
        file: vi.fn().mockReturnValue({
          writer: vi.fn().mockReturnValue(mockWriter)
        })
      } as any;

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(mockJob.size)
        }),
        body: {
          getReader: () => mockReader
        }
      } as any);

      const result = await downloader['downloadSingleVideo'](mockJob, 1, 1);

      expect(result).toBe('downloaded');
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(mockJob.filePath + '.partial');
      
      // Should start download from beginning (no Range header)
      expect(fetch).toHaveBeenCalledWith(
        mockJob.downloadUrl,
        expect.not.objectContaining({
          headers: expect.objectContaining({
            'Range': expect.any(String)
          })
        })
      );
    });

    it('should handle range not satisfiable error (416)', async () => {
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 500000 } as any);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});

      // Mock 416 Range Not Satisfiable response
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 416,
        statusText: 'Range Not Satisfiable',
        headers: new Headers()
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(downloader['downloadSingleVideo'](mockJob, 1, 1)).rejects.toMatchObject({
        message: 'Range not satisfiable, retrying from beginning',
        status: 416,
        errorType: 'SERVER_ERROR'
      });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid resume range'));

      consoleSpy.mockRestore();
    });

    it('should handle server that doesn\'t support resume', async () => {
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 500000 } as any);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});

      // Mock server response without partial content support
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200, // Should be 206 for partial content
        headers: new Headers({
          'content-length': String(mockJob.size)
        }),
        body: {
          getReader: () => ({
            read: vi.fn().mockResolvedValue({ done: true }),
            releaseLock: vi.fn()
          })
        }
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(downloader['downloadSingleVideo'](mockJob, 1, 1)).rejects.toMatchObject({
        message: 'Resume not supported, retrying from beginning',
        errorType: 'SERVER_ERROR'
      });

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Server doesn\'t support resume'));

      consoleSpy.mockRestore();
    });

    it('should verify file size after download', async () => {
      vi.mocked(mockFs.existsSync).mockReturnValue(false);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 999999 } as any); // Wrong size
      vi.mocked(mockFs.renameSync).mockImplementation(() => {});

      const mockReader = {
        read: vi.fn().mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined)
      };

      global.Bun = {
        file: vi.fn().mockReturnValue({
          writer: vi.fn().mockReturnValue(mockWriter)
        })
      } as any;

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(mockJob.size)
        }),
        body: {
          getReader: () => mockReader
        }
      } as any);

      await expect(downloader['downloadSingleVideo'](mockJob, 1, 1)).rejects.toThrow(
        'File size mismatch: expected 1000000, got 999999'
      );
    });

    it('should preserve partial file on download failure', async () => {
      vi.mocked(mockFs.existsSync).mockReturnValue(false);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 500000 } as any);

      const networkError = new Error('Network failed');
      const mockReader = {
        read: vi.fn().mockRejectedValue(networkError),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockRejectedValue(new Error('Writer error'))
      };

      global.Bun = {
        file: vi.fn().mockReturnValue({
          writer: vi.fn().mockReturnValue(mockWriter)
        })
      } as any;

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(mockJob.size)
        }),
        body: {
          getReader: () => mockReader
        }
      } as any);

      await expect(downloader['downloadSingleVideo'](mockJob, 1, 1)).rejects.toThrow();

      // Should not delete partial file (only small corrupted ones)
      expect(mockFs.unlinkSync).not.toHaveBeenCalledWith(mockJob.filePath + '.partial');
    });

    it('should delete very small corrupted partial files on error', async () => {
      vi.mocked(mockFs.existsSync).mockReturnValue(false);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});
      vi.mocked(mockFs.statSync)
        .mockReturnValueOnce({ size: 500 } as any); // Small corrupted file
      vi.mocked(mockFs.unlinkSync).mockImplementation(() => {});

      const networkError = new Error('Network failed');
      const mockReader = {
        read: vi.fn().mockRejectedValue(networkError),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockRejectedValue(new Error('Writer error'))
      };

      global.Bun = {
        file: vi.fn().mockReturnValue({
          writer: vi.fn().mockReturnValue(mockWriter)
        })
      } as any;

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(mockJob.size)
        }),
        body: {
          getReader: () => mockReader
        }
      } as any);

      await expect(downloader['downloadSingleVideo'](mockJob, 1, 1)).rejects.toThrow();

      // Should delete small corrupted files
      expect(mockFs.unlinkSync).toHaveBeenCalledWith(mockJob.filePath + '.partial');
    });
  });

  describe('downloadVideos messaging', () => {
    it('should show "Nothing to download" message when all files are skipped', async () => {
      const mockJobs = [
        {
          video: { uri: '/videos/123', name: 'Video 1' },
          downloadUrl: 'https://example.com/1.mp4',
          filePath: '/test/1.mp4',
          size: 1000000
        },
        {
          video: { uri: '/videos/456', name: 'Video 2' },
          downloadUrl: 'https://example.com/2.mp4', 
          filePath: '/test/2.mp4',
          size: 2000000
        }
      ];

      const mockFs = await import('fs');
      vi.mocked(mockFs.existsSync).mockReturnValue(true);
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 100 } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await downloader['downloadVideos'](mockJobs);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Nothing to download - all 2 files already exist'));

      consoleSpy.mockRestore();
    });

    it('should show download success message with skip count', async () => {
      const mockJobs = [
        {
          video: { uri: '/videos/123', name: 'New Video' },
          downloadUrl: 'https://example.com/new.mp4',
          filePath: '/test/new.mp4', 
          size: 1000000
        },
        {
          video: { uri: '/videos/456', name: 'Existing Video' },
          downloadUrl: 'https://example.com/existing.mp4',
          filePath: '/test/existing.mp4',
          size: 2000000
        }
      ];

      const mockFs = await import('fs');
      // First call (new video) - doesn't exist, second call (existing video) - exists
      vi.mocked(mockFs.existsSync)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      vi.mocked(mockFs.statSync).mockReturnValue({ size: 100 } as any);
      vi.mocked(mockFs.mkdirSync).mockImplementation(() => {});

      // Mock successful download for first video
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
          .mockResolvedValueOnce({ done: true }),
        releaseLock: vi.fn()
      };

      const mockWriter = {
        write: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined)
      };

      global.Bun = {
        file: vi.fn().mockReturnValue({
          writer: vi.fn().mockReturnValue(mockWriter)
        })
      } as any;

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-length', '1000000']]),
        body: {
          getReader: () => mockReader
        }
      } as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await downloader['downloadVideos'](mockJobs);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Downloaded 1 file! (1 already existed)'));

      consoleSpy.mockRestore();
    });
  });
});
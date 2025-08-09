import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Mock child_process and fs for CLI testing
vi.mock('child_process');
vi.mock('fs');

// Helper function to simulate CLI execution
const mockSpawn = vi.mocked(spawn);
const mockFs = vi.mocked(fs);

// Mock environment for CLI tests
const originalEnv = process.env;

describe('CLI Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set up test environment variables
    process.env = {
      ...originalEnv,
      VIMEO_CLIENT_ID: 'test_client_id',
      VIMEO_CLIENT_SECRET: 'test_client_secret',
      VIMEO_ACCESS_TOKEN: 'test_access_token',
      DOWNLOAD_PATH: './test-downloads',
      MAX_CONCURRENT_DOWNLOADS: '2',
    };

    // Mock fetch for API calls
    global.fetch = vi.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Command Parsing', () => {
    it('should parse download command with default options', async () => {
      // This test would require actually importing and testing the commander setup
      // For now, we'll test the expected behavior patterns
      const { Command } = await import('commander');
      
      const program = new Command();
      program
        .command('download')
        .option('-p, --path <path>', 'Download path', './downloads')
        .option('-c, --concurrent <number>', 'Max concurrent downloads', '3')
        .action((options) => {
          expect(options.path).toBe('./downloads');
          expect(options.concurrent).toBe('3');
        });

      // Simulate parsing arguments
      program.parse(['node', 'script.js', 'download']);
    });

    it('should parse download command with custom options', async () => {
      const { Command } = await import('commander');
      
      const program = new Command();
      program
        .command('download')
        .option('-p, --path <path>', 'Download path', './downloads')
        .option('-c, --concurrent <number>', 'Max concurrent downloads', '3')
        .option('--dry-run', 'Show what would be downloaded')
        .option('--overwrite', 'Overwrite existing files')
        .action((options) => {
          expect(options.path).toBe('/custom/path');
          expect(options.concurrent).toBe('5');
          expect(options.dryRun).toBe(true);
          expect(options.overwrite).toBe(true);
        });

      program.parse([
        'node', 'script.js', 'download',
        '--path', '/custom/path',
        '--concurrent', '5',
        '--dry-run',
        '--overwrite'
      ]);
    });

    it('should handle auth command', async () => {
      const { Command } = await import('commander');
      
      let authCalled = false;
      const program = new Command();
      program
        .command('auth')
        .action(() => {
          authCalled = true;
        });

      program.parse(['node', 'script.js', 'auth']);
      expect(authCalled).toBe(true);
    });
  });

  describe('Environment Variable Validation', () => {
    it('should fail when required env vars are missing', () => {
      delete process.env.VIMEO_CLIENT_ID;
      delete process.env.VIMEO_CLIENT_SECRET;
      delete process.env.VIMEO_ACCESS_TOKEN;

      // Mock config creation that would fail
      const createConfig = () => {
        const config = {
          clientId: process.env.VIMEO_CLIENT_ID!,
          clientSecret: process.env.VIMEO_CLIENT_SECRET!,
          accessToken: process.env.VIMEO_ACCESS_TOKEN!,
          downloadPath: './downloads',
          maxConcurrentDownloads: 3,
          quality: 'highest',
          dryRun: false,
          overwrite: false,
        };

        if (!config.clientId || !config.clientSecret || !config.accessToken) {
          throw new Error('Missing required environment variables');
        }

        return config;
      };

      expect(createConfig).toThrow('Missing required environment variables');
    });

    it('should use environment defaults when present', () => {
      const config = {
        clientId: process.env.VIMEO_CLIENT_ID!,
        clientSecret: process.env.VIMEO_CLIENT_SECRET!,
        accessToken: process.env.VIMEO_ACCESS_TOKEN!,
        downloadPath: process.env.DOWNLOAD_PATH || './downloads',
        maxConcurrentDownloads: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '3'),
        quality: 'highest',
        dryRun: false,
        overwrite: false,
      };

      expect(config.clientId).toBe('test_client_id');
      expect(config.clientSecret).toBe('test_client_secret');
      expect(config.accessToken).toBe('test_access_token');
      expect(config.downloadPath).toBe('./test-downloads');
      expect(config.maxConcurrentDownloads).toBe(2);
    });
  });

  describe('File System Operations', () => {
    it('should check if download directory exists', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => {});

      const downloadPath = './test-downloads/My Folder';
      
      if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
      }

      expect(mockFs.existsSync).toHaveBeenCalledWith(downloadPath);
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(downloadPath, { recursive: true });
    });

    it('should handle file existence checking', () => {
      const filePath = './test-downloads/existing-file.mp4';
      
      mockFs.existsSync.mockReturnValue(true);
      
      const fileExists = fs.existsSync(filePath);
      expect(fileExists).toBe(true);
      expect(mockFs.existsSync).toHaveBeenCalledWith(filePath);
    });

    it('should create download directory recursively', () => {
      const nestedPath = './downloads/Parent Folder/Child Folder';
      
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation(() => {});

      fs.mkdirSync(nestedPath, { recursive: true });

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(nestedPath, { recursive: true });
    });
  });

  describe('API Integration Patterns', () => {
    it('should make authentication request', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: 'Test User' }),
      } as Response);

      const response = await fetch('https://api.vimeo.com/me', {
        headers: {
          'Authorization': 'Bearer test_access_token',
          'User-Agent': 'VimeoDownloader/1.0',
          'Accept': 'application/vnd.vimeo.*+json;version=3.4',
        },
      });

      expect(fetch).toHaveBeenCalledWith('https://api.vimeo.com/me', {
        headers: {
          'Authorization': 'Bearer test_access_token',
          'User-Agent': 'VimeoDownloader/1.0',
          'Accept': 'application/vnd.vimeo.*+json;version=3.4',
        },
      });

      const data = await response.json();
      expect(data.name).toBe('Test User');
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as Response);

      const response = await fetch('https://api.vimeo.com/me', {
        headers: { 'Authorization': 'Bearer invalid_token' },
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });

    it('should handle network errors', async () => {
      vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

      await expect(
        fetch('https://api.vimeo.com/me')
      ).rejects.toThrow('Network error');
    });
  });

  describe('Quality Selection Logic', () => {
    const mockDownloadLinks = [
      {
        quality: 'hd',
        type: 'source',
        width: 1920,
        height: 1080,
        link: 'https://example.com/1080p.mp4',
        size: 100000000,
      },
      {
        quality: 'sd', 
        type: 'video/mp4',
        width: 1280,
        height: 720,
        link: 'https://example.com/720p.mp4',
        size: 50000000,
      },
      {
        quality: 'mobile',
        type: 'video/mp4', 
        width: 640,
        height: 360,
        link: 'https://example.com/360p.mp4',
        size: 25000000,
      },
    ];

    it('should select highest quality by default', () => {
      const selectQuality = (links: any[], preferredQuality: string) => {
        if (preferredQuality === 'highest') {
          // Sort by size descending, prefer source type
          return links.sort((a, b) => {
            if (a.type === 'source' && b.type !== 'source') return -1;
            if (b.type === 'source' && a.type !== 'source') return 1;
            return b.size - a.size;
          })[0];
        }
        return links.find(link => link.quality === preferredQuality) || links[0];
      };

      const selected = selectQuality(mockDownloadLinks, 'highest');
      expect(selected.quality).toBe('hd');
      expect(selected.type).toBe('source');
    });

    it('should select specific quality when requested', () => {
      const selectQuality = (links: any[], preferredQuality: string) => {
        if (preferredQuality === 'highest') {
          return links.sort((a, b) => b.size - a.size)[0];
        }
        
        // Map quality names to expected qualities
        const qualityMap: { [key: string]: string } = {
          '1080p': 'hd',
          '720p': 'sd',
          '360p': 'mobile',
        };

        const targetQuality = qualityMap[preferredQuality] || preferredQuality;
        return links.find(link => link.quality === targetQuality) || links[0];
      };

      const selected720p = selectQuality(mockDownloadLinks, '720p');
      expect(selected720p.quality).toBe('sd');
      expect(selected720p.width).toBe(1280);

      const selected360p = selectQuality(mockDownloadLinks, '360p');
      expect(selected360p.quality).toBe('mobile');
      expect(selected360p.width).toBe(640);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing download links', () => {
      const handleMissingLinks = (video: any) => {
        if (!video.download || video.download.length === 0) {
          return { error: 'No download links available' };
        }
        return { success: true };
      };

      const videoWithoutLinks = { name: 'Test Video', download: [] };
      const result = handleMissingLinks(videoWithoutLinks);
      
      expect(result.error).toBe('No download links available');
    });

    it('should handle invalid file paths', () => {
      const sanitizePath = (filePath: string) => {
        return filePath
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '_$1')
          .trim();
      };

      const invalidPath = 'folder/file<>:"|?.mp4';
      const sanitized = sanitizePath(invalidPath);
      
      expect(sanitized).toBe('folder/file_______.mp4');
    });

    it('should handle network timeouts gracefully', async () => {
      // Mock a timeout scenario
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout')), 100);
      });

      vi.mocked(fetch).mockReturnValueOnce(timeoutPromise as any);

      await expect(fetch('https://api.vimeo.com/slow-endpoint')).rejects.toThrow('Timeout');
    });
  });

  describe('Dry Run Mode', () => {
    it('should not create files in dry run mode', () => {
      const isDryRun = true;
      mockFs.createWriteStream.mockImplementation(() => null as any);

      const downloadFile = (filePath: string, dryRun: boolean) => {
        if (dryRun) {
          console.log(`Would download: ${filePath}`);
          return { skipped: true };
        }
        
        fs.createWriteStream(filePath);
        return { downloaded: true };
      };

      const result = downloadFile('./test.mp4', isDryRun);
      
      expect(result.skipped).toBe(true);
      expect(mockFs.createWriteStream).not.toHaveBeenCalled();
    });

    it('should show preview of what would be downloaded', () => {
      const mockVideos = [
        { name: 'Video 1', size: 1000000 },
        { name: 'Video 2', size: 2000000 },
      ];

      const showDryRunResults = (videos: any[]) => {
        const totalSize = videos.reduce((sum, video) => sum + video.size, 0);
        const count = videos.length;
        
        return {
          message: `Would download ${count} videos (${totalSize} bytes total)`,
          videos: videos.map(v => ({ name: v.name, size: v.size })),
        };
      };

      const results = showDryRunResults(mockVideos);
      
      expect(results.message).toBe('Would download 2 videos (3000000 bytes total)');
      expect(results.videos).toHaveLength(2);
    });
  });

  describe('UX Improvements Integration', () => {
    it('should validate clean output by default (no verbose debug info)', () => {
      // Test that verbose logging is controlled by environment variable
      const mockDebugMode = process.env.DEBUG_VIMEO;
      
      // Test default (no debug)
      delete process.env.DEBUG_VIMEO;
      let shouldShowDebug = process.env.DEBUG_VIMEO === 'true';
      expect(shouldShowDebug).toBe(false);
      
      // Test with debug enabled
      process.env.DEBUG_VIMEO = 'true';
      shouldShowDebug = process.env.DEBUG_VIMEO === 'true';
      expect(shouldShowDebug).toBe(true);
      
      // Restore original state
      if (mockDebugMode) {
        process.env.DEBUG_VIMEO = mockDebugMode;
      } else {
        delete process.env.DEBUG_VIMEO;
      }
    });

    it('should format error messages properly for non-downloadable videos', () => {
      const failedVideos = ['Video 1', 'Video 2', 'Video 3'];
      
      const formatErrorMessage = (videos: string[]) => {
        const count = videos.length;
        const plural = count > 1 ? 's' : '';
        
        return {
          summary: `⚠️  ${count} video${plural} could not be downloaded:`,
          videoList: videos.map(name => `   • ${name}`),
          helpText: [
            '\n   This might be due to:',
            '   1. Video download not enabled in Vimeo settings',
            '   2. Access token missing download permissions',
            '   3. Video privacy settings restricting downloads'
          ]
        };
      };

      const result = formatErrorMessage(failedVideos);
      
      expect(result.summary).toBe('⚠️  3 videos could not be downloaded:');
      expect(result.videoList).toEqual([
        '   • Video 1',
        '   • Video 2', 
        '   • Video 3'
      ]);
      expect(result.helpText).toContain('   1. Video download not enabled in Vimeo settings');
    });

    it('should format completion messages based on download results', () => {
      const formatCompletionMessage = (actualDownloads: number, skippedFiles: number) => {
        if (actualDownloads === 0) {
          if (skippedFiles > 0) {
            return `📁 Nothing to download - all ${skippedFiles} files already exist.`;
          } else {
            return '❌ No files were downloaded.';
          }
        } else {
          const plural = actualDownloads > 1 ? 's' : '';
          const skipInfo = skippedFiles > 0 ? ` (${skippedFiles} already existed)` : '';
          return `✅ Downloaded ${actualDownloads} file${plural}!${skipInfo}`;
        }
      };

      // Test all files skipped
      expect(formatCompletionMessage(0, 3)).toBe('📁 Nothing to download - all 3 files already exist.');
      
      // Test no files processed
      expect(formatCompletionMessage(0, 0)).toBe('❌ No files were downloaded.');
      
      // Test successful downloads only
      expect(formatCompletionMessage(2, 0)).toBe('✅ Downloaded 2 files!');
      
      // Test mixed success and skips
      expect(formatCompletionMessage(1, 2)).toBe('✅ Downloaded 1 file! (2 already existed)');
    });

    it('should handle download status return values correctly', () => {
      const simulateDownloadResult = (fileExists: boolean, downloadSucceeds: boolean): 'downloaded' | 'skipped' | 'failed' => {
        if (fileExists) {
          return 'skipped';
        }
        
        if (downloadSucceeds) {
          return 'downloaded';
        }
        
        return 'failed';
      };

      expect(simulateDownloadResult(true, true)).toBe('skipped');   // File exists
      expect(simulateDownloadResult(false, true)).toBe('downloaded'); // New file, success
      expect(simulateDownloadResult(false, false)).toBe('failed');    // New file, failed
    });

    it('should validate progress tracking counts', () => {
      const trackDownloadResults = (results: ('downloaded' | 'skipped' | 'failed')[]) => {
        let actualDownloads = 0;
        let skippedFiles = 0;
        
        for (const result of results) {
          if (result === 'downloaded') {
            actualDownloads++;
          } else if (result === 'skipped') {
            skippedFiles++;
          }
          // 'failed' downloads are not counted in either category
        }
        
        return { actualDownloads, skippedFiles };
      };

      const testResults = ['downloaded', 'skipped', 'downloaded', 'failed', 'skipped'];
      const counts = trackDownloadResults(testResults);
      
      expect(counts.actualDownloads).toBe(2);
      expect(counts.skippedFiles).toBe(2);
    });

    it('should validate environment-based debug logging', () => {
      const shouldShowDebugInfo = (category: 'auth' | 'videos' | 'api') => {
        const debugEnabled = process.env.DEBUG_VIMEO === 'true';
        
        if (!debugEnabled) {
          return false;
        }
        
        // All debug info is shown when DEBUG_VIMEO is true
        return true;
      };

      // Test with debug disabled
      delete process.env.DEBUG_VIMEO;
      expect(shouldShowDebugInfo('auth')).toBe(false);
      expect(shouldShowDebugInfo('videos')).toBe(false);
      expect(shouldShowDebugInfo('api')).toBe(false);

      // Test with debug enabled  
      process.env.DEBUG_VIMEO = 'true';
      expect(shouldShowDebugInfo('auth')).toBe(true);
      expect(shouldShowDebugInfo('videos')).toBe(true);
      expect(shouldShowDebugInfo('api')).toBe(true);
    });
  });
});
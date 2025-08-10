import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProgressTracker } from '../ProgressTracker';
import type { DownloadProgress } from '../ProgressTracker';
import { existsSync, unlinkSync } from 'fs';
import path from 'path';

// Mock Date for consistent testing
const mockNow = new Date('2023-01-01T12:00:00Z').getTime();
vi.setSystemTime(mockNow);

// Mock file system operations
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock Bun.file and Bun.write
global.Bun = {
  file: vi.fn(),
  write: vi.fn(),
} as any;

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;
  const testDownloadPath = '/test/downloads';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(Bun.file).mockReturnValue({
      text: vi.fn().mockResolvedValue('{}'),
    });
    vi.mocked(Bun.write).mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up any timers
    if (tracker && (tracker as any).saveInterval) {
      clearInterval((tracker as any).saveInterval);
    }
    vi.useRealTimers();
  });

  describe('startDownload', () => {
    it('should start a new download with correct initial state', () => {
      tracker.startDownload('test-id', 1000000, 'test-file.mp4');

      const progress = tracker.getProgress('test-id');
      
      expect(progress).toEqual({
        id: 'test-id',
        filename: 'test-file.mp4',
        totalSize: 1000000,
        downloadedSize: 0,
        completed: false,
        startTime: mockNow,
      });
    });

    it('should handle multiple downloads', () => {
      tracker.startDownload('id1', 1000000, 'file1.mp4');
      tracker.startDownload('id2', 2000000, 'file2.mp4');

      expect(tracker.getProgress('id1')?.filename).toBe('file1.mp4');
      expect(tracker.getProgress('id2')?.filename).toBe('file2.mp4');
      expect(tracker.getAllProgress()).toHaveLength(2);
    });

    it('should overwrite existing download with same id', () => {
      tracker.startDownload('test-id', 1000000, 'file1.mp4');
      tracker.updateProgress('test-id', 500000);
      tracker.startDownload('test-id', 2000000, 'file2.mp4');

      const progress = tracker.getProgress('test-id');
      expect(progress?.filename).toBe('file2.mp4');
      expect(progress?.downloadedSize).toBe(0); // Reset
      expect(progress?.totalSize).toBe(2000000);
    });
  });

  describe('updateProgress', () => {
    beforeEach(() => {
      tracker.startDownload('test-id', 1000000, 'test-file.mp4');
    });

    it('should update download progress correctly', () => {
      const newTime = mockNow + 5000;
      vi.setSystemTime(newTime);

      tracker.updateProgress('test-id', 250000);

      const progress = tracker.getProgress('test-id');
      expect(progress?.downloadedSize).toBe(250000);
      expect(progress?.completed).toBe(false);
    });

    it('should handle progress updates for non-existent download', () => {
      expect(() => {
        tracker.updateProgress('non-existent', 1000);
      }).not.toThrow();
      
      expect(tracker.getProgress('non-existent')).toBeUndefined();
    });

    it('should handle progress exceeding total size', () => {
      tracker.updateProgress('test-id', 1500000); // More than total

      const progress = tracker.getProgress('test-id');
      expect(progress?.downloadedSize).toBe(1500000);
    });

    it('should handle negative progress', () => {
      tracker.updateProgress('test-id', -100);

      const progress = tracker.getProgress('test-id');
      expect(progress?.downloadedSize).toBe(-100);
    });
  });

  describe('completeDownload', () => {
    beforeEach(() => {
      tracker.startDownload('test-id', 1000000, 'test-file.mp4');
      tracker.updateProgress('test-id', 750000);
    });

    it('should mark download as completed', () => {
      const newTime = mockNow + 10000;
      vi.setSystemTime(newTime);

      tracker.completeDownload('test-id');

      const progress = tracker.getProgress('test-id');
      expect(progress?.completed).toBe(true);
      expect(progress?.downloadedSize).toBe(750000); // Preserve progress
    });

    it('should handle completing non-existent download', () => {
      expect(() => {
        tracker.completeDownload('non-existent');
      }).not.toThrow();
    });

    it('should complete download even with zero progress', () => {
      tracker.startDownload('zero-id', 1000, 'zero.mp4');
      tracker.completeDownload('zero-id');

      const progress = tracker.getProgress('zero-id');
      expect(progress?.completed).toBe(true);
      expect(progress?.downloadedSize).toBe(0);
    });
  });

  describe('getProgress', () => {
    it('should return undefined for non-existent download', () => {
      expect(tracker.getProgress('non-existent')).toBeUndefined();
    });

    it('should return correct progress for existing download', () => {
      tracker.startDownload('test-id', 1000, 'test.mp4');
      
      const progress = tracker.getProgress('test-id');
      expect(progress?.id).toBe('test-id');
      expect(progress?.filename).toBe('test.mp4');
    });
  });

  describe('getAllProgress', () => {
    it('should return empty array when no downloads', () => {
      expect(tracker.getAllProgress()).toEqual([]);
    });

    it('should return all downloads in correct order', () => {
      tracker.startDownload('id1', 1000, 'file1.mp4');
      tracker.startDownload('id2', 2000, 'file2.mp4');
      tracker.startDownload('id3', 3000, 'file3.mp4');

      const allProgress = tracker.getAllProgress();
      expect(allProgress).toHaveLength(3);
      expect(allProgress.map(p => p.id)).toEqual(['id1', 'id2', 'id3']);
    });

    it('should include both completed and active downloads', () => {
      tracker.startDownload('active', 1000, 'active.mp4');
      tracker.startDownload('completed', 2000, 'completed.mp4');
      tracker.completeDownload('completed');

      const allProgress = tracker.getAllProgress();
      expect(allProgress).toHaveLength(2);
      expect(allProgress.find(p => p.id === 'active')?.completed).toBe(false);
      expect(allProgress.find(p => p.id === 'completed')?.completed).toBe(true);
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(tracker.formatFileSize(0)).toBe('0 B');
      expect(tracker.formatFileSize(1024)).toBe('1 KB');
      expect(tracker.formatFileSize(1048576)).toBe('1 MB');
      expect(tracker.formatFileSize(1073741824)).toBe('1 GB');
    });

    it('should handle decimal places', () => {
      expect(tracker.formatFileSize(1536)).toBe('1.5 KB');
      expect(tracker.formatFileSize(2621440)).toBe('2.5 MB');
    });

    it('should round appropriately', () => {
      expect(tracker.formatFileSize(1234567)).toBe('1.18 MB');
      expect(tracker.formatFileSize(999)).toBe('999 B');
    });
  });

  describe('formatProgress', () => {
    beforeEach(() => {
      tracker.startDownload('test-id', 1000000, 'test-file.mp4');
    });

    it('should format progress with percentage and sizes', () => {
      tracker.updateProgress('test-id', 250000);
      
      const formatted = tracker.formatProgress('test-id');
      expect(formatted).toContain('25%');
      expect(formatted).toContain('244.14 KB');
      expect(formatted).toContain('976.56 KB');
    });

    it('should handle zero total size', () => {
      tracker.startDownload('zero-size', 0, 'zero.mp4');
      
      const formatted = tracker.formatProgress('zero-size');
      expect(formatted).toContain('0%');
      expect(formatted).toContain('0 B');
    });

    it('should handle completed download', () => {
      tracker.updateProgress('test-id', 1000000);
      tracker.completeDownload('test-id');
      
      const formatted = tracker.formatProgress('test-id');
      expect(formatted).toContain('100%');
      expect(formatted).toContain('✓');
    });

    it('should return empty string for non-existent download', () => {
      const formatted = tracker.formatProgress('non-existent');
      expect(formatted).toBe('');
    });

    it('should handle progress exceeding total', () => {
      tracker.updateProgress('test-id', 1500000);
      
      const formatted = tracker.formatProgress('test-id');
      expect(formatted).toContain('150%');
    });
  });

  describe('Persistence Features', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(testDownloadPath);
    });

    it('should create progress file in correct location', () => {
      const expectedPath = path.join(testDownloadPath, '.vimeo-download-progress.json');
      expect((tracker as any).persistenceFile).toBe(expectedPath);
    });

    it('should use current working directory when no path provided', () => {
      const tracker2 = new ProgressTracker();
      const expectedPath = path.join(process.cwd(), '.vimeo-download-progress.json');
      expect((tracker2 as any).persistenceFile).toBe(expectedPath);
    });

    it('should save progress automatically every 5 seconds', async () => {
      vi.useFakeTimers();
      
      tracker.startDownload('test-id', 1000000, 'test.mp4');
      tracker.updateProgress('test-id', 500000);
      
      // Fast-forward 5 seconds
      vi.advanceTimersByTime(5000);
      
      expect(Bun.write).toHaveBeenCalledWith(
        expect.stringContaining('.vimeo-download-progress.json'),
        expect.stringContaining('test-id')
      );
    });

    it('should save progress immediately on completion', () => {
      tracker.startDownload('test-id', 1000000, 'test.mp4');
      tracker.completeDownload('test-id');
      
      expect(Bun.write).toHaveBeenCalledWith(
        expect.stringContaining('.vimeo-download-progress.json'),
        expect.any(String)
      );
    });

    it('should save progress immediately on failure', () => {
      tracker.startDownload('test-id', 1000000, 'test.mp4');
      tracker.failDownload('test-id', 'Network error');
      
      expect(Bun.write).toHaveBeenCalledWith(
        expect.stringContaining('.vimeo-download-progress.json'),
        expect.any(String)
      );
    });

    it('should load existing progress on startup', async () => {
      const existingProgress = {
        timestamp: Date.now(),
        downloads: [
          {
            id: 'existing-id',
            filename: 'existing.mp4',
            totalSize: 2000000,
            downloadedSize: 1000000,
            startTime: mockNow - 10000,
            completed: false,
            failed: false
          }
        ]
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(Bun.file).mockReturnValue({
        text: vi.fn().mockResolvedValue(JSON.stringify(existingProgress)),
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Create new tracker that should load existing progress
      const newTracker = new ProgressTracker(testDownloadPath);
      
      // Wait for async loading to complete
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleSpy).toHaveBeenCalledWith('📄 Restored 1 incomplete download(s) from previous session');
      
      // Should not load completed or failed downloads
      expect(newTracker.getAllProgress()).toHaveLength(0); // Initially empty until loaded
      
      consoleSpy.mockRestore();
    });

    it('should only load incomplete downloads', async () => {
      const existingProgress = {
        downloads: [
          {
            id: 'incomplete-id',
            filename: 'incomplete.mp4',
            totalSize: 1000000,
            downloadedSize: 500000,
            startTime: mockNow,
            completed: false,
            failed: false
          },
          {
            id: 'completed-id',
            filename: 'completed.mp4',
            totalSize: 1000000,
            downloadedSize: 1000000,
            startTime: mockNow,
            completed: true,
            failed: false
          },
          {
            id: 'failed-id',
            filename: 'failed.mp4',
            totalSize: 1000000,
            downloadedSize: 100000,
            startTime: mockNow,
            completed: false,
            failed: true
          }
        ]
      };

      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(Bun.file).mockReturnValue({
        text: vi.fn().mockResolvedValue(JSON.stringify(existingProgress)),
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      new ProgressTracker(testDownloadPath);
      await new Promise(resolve => setTimeout(resolve, 0));

      // Should only mention 1 incomplete download
      expect(consoleSpy).toHaveBeenCalledWith('📄 Restored 1 incomplete download(s) from previous session');
      
      consoleSpy.mockRestore();
    });

    it('should handle corrupted progress file gracefully', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(Bun.file).mockReturnValue({
        text: vi.fn().mockResolvedValue('invalid json'),
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      new ProgressTracker(testDownloadPath);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not load previous download progress'),
        expect.any(String)
      );
      
      consoleSpy.mockRestore();
    });

    it('should clean up progress file when all downloads complete', async () => {
      tracker.startDownload('test-id', 1000000, 'test.mp4');
      tracker.completeDownload('test-id');
      
      // Simulate cleanup on exit
      (tracker as any).cleanup();
      
      expect(unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('.vimeo-download-progress.json')
      );
    });

    it('should not clean up progress file when incomplete downloads exist', () => {
      tracker.startDownload('incomplete-id', 1000000, 'incomplete.mp4');
      tracker.updateProgress('incomplete-id', 500000);
      
      // Simulate cleanup on exit
      (tracker as any).cleanup();
      
      expect(unlinkSync).not.toHaveBeenCalled();
    });

    it('should update existing download from previous session', () => {
      // Simulate existing download
      const existingDownload: DownloadProgress = {
        id: 'existing-id',
        filename: 'old-name.mp4',
        totalSize: 1000000,
        downloadedSize: 500000,
        startTime: mockNow - 10000,
        completed: false,
        failed: false
      };
      
      (tracker as any).downloads.set('existing-id', existingDownload);
      
      // Start "new" download with same ID
      tracker.startDownload('existing-id', 2000000, 'new-name.mp4');
      
      const progress = tracker.getProgress('existing-id');
      expect(progress?.filename).toBe('new-name.mp4');
      expect(progress?.totalSize).toBe(2000000);
      expect(progress?.downloadedSize).toBe(500000); // Preserved
    });
  });

  describe('New utility methods', () => {
    beforeEach(() => {
      tracker = new ProgressTracker();
    });

    it('should return incomplete downloads', () => {
      tracker.startDownload('incomplete1', 1000000, 'incomplete1.mp4');
      tracker.startDownload('incomplete2', 2000000, 'incomplete2.mp4');
      tracker.startDownload('completed', 1000000, 'completed.mp4');
      tracker.startDownload('failed', 1000000, 'failed.mp4');
      
      tracker.updateProgress('incomplete1', 500000);
      tracker.updateProgress('incomplete2', 750000);
      tracker.completeDownload('completed');
      tracker.failDownload('failed', 'Error');
      
      const incompleteDownloads = tracker.getIncompleteDownloads();
      
      expect(incompleteDownloads).toHaveLength(2);
      expect(incompleteDownloads.map(d => d.id)).toEqual(['incomplete1', 'incomplete2']);
    });

    it('should check if there are incomplete downloads', () => {
      expect(tracker.hasIncompleteDownloads()).toBe(false);
      
      tracker.startDownload('test-id', 1000000, 'test.mp4');
      expect(tracker.hasIncompleteDownloads()).toBe(true);
      
      tracker.completeDownload('test-id');
      expect(tracker.hasIncompleteDownloads()).toBe(false);
    });
  });

  describe('failDownload functionality', () => {
    beforeEach(() => {
      tracker = new ProgressTracker();
      tracker.startDownload('test-id', 1000000, 'test.mp4');
    });

    it('should mark download as failed with error message', () => {
      const errorMessage = 'Network connection failed';
      
      tracker.failDownload('test-id', errorMessage);
      
      const progress = tracker.getProgress('test-id');
      expect(progress?.failed).toBe(true);
      expect(progress?.errorMessage).toBe(errorMessage);
      expect(progress?.endTime).toBeDefined();
    });

    it('should check if download is failed', () => {
      expect(tracker.isDownloadFailed('test-id')).toBe(false);
      
      tracker.failDownload('test-id', 'Error occurred');
      
      expect(tracker.isDownloadFailed('test-id')).toBe(true);
    });

    it('should return failed downloads', () => {
      tracker.startDownload('failed1', 1000000, 'failed1.mp4');
      tracker.startDownload('failed2', 2000000, 'failed2.mp4');
      tracker.startDownload('success', 1000000, 'success.mp4');
      
      tracker.failDownload('failed1', 'Error 1');
      tracker.failDownload('failed2', 'Error 2');
      tracker.completeDownload('success');
      
      const failedDownloads = tracker.getFailedDownloads();
      
      expect(failedDownloads).toHaveLength(2);
      expect(failedDownloads.map(d => d.id)).toEqual(['failed1', 'failed2']);
      expect(failedDownloads[0].errorMessage).toBe('Error 1');
      expect(failedDownloads[1].errorMessage).toBe('Error 2');
    });

    it('should handle failing non-existent download', () => {
      expect(() => {
        tracker.failDownload('non-existent', 'Some error');
      }).not.toThrow();
      
      expect(tracker.isDownloadFailed('non-existent')).toBe(false);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    beforeEach(() => {
      tracker = new ProgressTracker();
    });
    it('should handle concurrent updates to same download', () => {
      tracker.startDownload('concurrent-id', 1000000, 'test.mp4');
      
      // Simulate rapid updates
      tracker.updateProgress('concurrent-id', 100000);
      tracker.updateProgress('concurrent-id', 200000);
      tracker.updateProgress('concurrent-id', 300000);
      
      const progress = tracker.getProgress('concurrent-id');
      expect(progress?.downloadedSize).toBe(300000);
    });

    it('should handle extremely large file sizes', () => {
      const largeSize = Number.MAX_SAFE_INTEGER;
      tracker.startDownload('large-id', largeSize, 'large.mp4');
      tracker.updateProgress('large-id', largeSize / 2);
      
      const progress = tracker.getProgress('large-id');
      expect(progress?.totalSize).toBe(largeSize);
      expect(progress?.downloadedSize).toBe(largeSize / 2);
    });

    it('should handle special characters in filename', () => {
      const specialFilename = 'tëst fîlé wîth émöjîs 🎥.mp4';
      tracker.startDownload('special-id', 1000, specialFilename);
      
      const progress = tracker.getProgress('special-id');
      expect(progress?.filename).toBe(specialFilename);
    });

    it('should maintain separate state for different instances', () => {
      const tracker2 = new ProgressTracker();
      
      tracker.startDownload('test-id', 1000000, 'test-file.mp4');
      tracker2.startDownload('id2', 2000, 'file2.mp4');
      
      expect(tracker.getAllProgress()).toHaveLength(1);
      expect(tracker2.getAllProgress()).toHaveLength(1);
      expect(tracker.getProgress('id2')).toBeUndefined();
      expect(tracker2.getProgress('id1')).toBeUndefined();
    });
  });
});
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProgressTracker } from '../ProgressTracker';
import type { DownloadProgress } from '../ProgressTracker';

// Mock Date for consistent testing
const mockNow = new Date('2023-01-01T12:00:00Z').getTime();
vi.setSystemTime(mockNow);

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;

  beforeEach(() => {
    tracker = new ProgressTracker();
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

  describe('Edge Cases and Error Handling', () => {
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
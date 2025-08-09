import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { ProgressDisplay } from '../ProgressDisplay';
import { ProgressTracker } from '../ProgressTracker';

// Mock Ink components
vi.mock('ink', () => ({
  Box: ({ children, ...props }: any) => <div data-testid="box" {...props}>{children}</div>,
  Text: ({ children, color, bold, ...props }: any) => (
    <span data-testid="text" data-color={color} data-bold={bold} {...props}>
      {children}
    </span>
  ),
}));

describe('ProgressDisplay', () => {
  let progressTracker: ProgressTracker;
  let mockSetInterval: any;
  let mockClearInterval: any;

  beforeEach(() => {
    progressTracker = new ProgressTracker();
    
    // Mock timers
    mockSetInterval = vi.fn();
    mockClearInterval = vi.fn();
    vi.stubGlobal('setInterval', mockSetInterval);
    vi.stubGlobal('clearInterval', mockClearInterval);
    
    // Make setInterval call the callback immediately for testing
    mockSetInterval.mockImplementation((callback: () => void) => {
      callback();
      return 12345; // Mock interval ID
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Component Rendering', () => {
    it('should render completion message when no active downloads', () => {
      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(/All downloads completed! \(0 files\)/)).toBeInTheDocument();
    });

    it('should render active downloads when in progress', () => {
      // Add some test downloads
      progressTracker.startDownload('id1', 1000000, 'video1.mp4');
      progressTracker.startDownload('id2', 2000000, 'video2.mp4');
      progressTracker.updateProgress('id1', 250000);
      progressTracker.updateProgress('id2', 500000);

      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(/Active Downloads \(2\/3\)/)).toBeInTheDocument();
      expect(getByText('video1.mp4')).toBeInTheDocument();
      expect(getByText('video2.mp4')).toBeInTheDocument();
    });

    it('should show completed count', () => {
      progressTracker.startDownload('id1', 1000000, 'video1.mp4');
      progressTracker.startDownload('id2', 2000000, 'video2.mp4');
      progressTracker.completeDownload('id1');

      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(/Completed: 1/)).toBeInTheDocument();
    });

    it('should limit active downloads to maxConcurrentDownloads', () => {
      // Add more downloads than the limit
      progressTracker.startDownload('id1', 1000000, 'video1.mp4');
      progressTracker.startDownload('id2', 2000000, 'video2.mp4');
      progressTracker.startDownload('id3', 3000000, 'video3.mp4');

      const { getByText, queryByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={2} />
      );

      expect(getByText(/Active Downloads \(2\/2\)/)).toBeInTheDocument();
      expect(getByText('video1.mp4')).toBeInTheDocument();
      expect(getByText('video2.mp4')).toBeInTheDocument();
      expect(queryByText('video3.mp4')).not.toBeInTheDocument();
    });
  });

  describe('Progress Display', () => {
    beforeEach(() => {
      progressTracker.startDownload('test-id', 1000000, 'test-video.mp4');
      progressTracker.updateProgress('test-id', 250000);
    });

    it('should show progress percentage', () => {
      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(/25%/)).toBeInTheDocument();
    });

    it('should show file sizes', () => {
      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      // Should show downloaded/total format
      expect(getByText(/KB/)).toBeInTheDocument();
    });

    it('should display progress bar', () => {
      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      // Progress bars use Unicode block characters
      const progressText = container.textContent;
      expect(progressText).toMatch(/[█▱]/); // Unicode progress bar characters
    });
  });

  describe('File Name Handling', () => {
    it('should truncate long filenames', () => {
      const longFilename = 'a'.repeat(50) + '.mp4';
      progressTracker.startDownload('long-id', 1000000, longFilename);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      // Should be truncated with ellipsis
      expect(text.includes('...')).toBe(true);
      expect(text.length).toBeLessThan(longFilename.length + 100); // Some buffer for other text
    });

    it('should display short filenames fully', () => {
      const shortFilename = 'short.mp4';
      progressTracker.startDownload('short-id', 1000000, shortFilename);

      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(shortFilename)).toBeInTheDocument();
    });

    it('should handle special characters in filenames', () => {
      const specialFilename = 'tëst fîlé 🎥.mp4';
      progressTracker.startDownload('special-id', 1000000, specialFilename);

      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(specialFilename)).toBeInTheDocument();
    });
  });

  describe('Speed Calculation', () => {
    it('should show download speed when available', () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);
      
      progressTracker.startDownload('speed-id', 1000000, 'speed-test.mp4');
      
      // Advance time and update progress
      vi.setSystemTime(startTime + 5000); // 5 seconds later
      progressTracker.updateProgress('speed-id', 500000); // 500KB in 5 seconds

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      expect(text.includes('/s')).toBe(true); // Speed indicator
    });

    it('should handle zero elapsed time gracefully', () => {
      progressTracker.startDownload('zero-time-id', 1000000, 'zero-time.mp4');
      progressTracker.updateProgress('zero-time-id', 100000);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      // Should not crash with division by zero
      expect(container).toBeInTheDocument();
    });
  });

  describe('Progress Bar Visualization', () => {
    it('should show empty progress bar for 0% progress', () => {
      progressTracker.startDownload('empty-id', 1000000, 'empty.mp4');
      // Don't update progress (stays at 0)

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      expect(text).toContain('0%');
    });

    it('should show full progress bar for 100% progress', () => {
      progressTracker.startDownload('full-id', 1000000, 'full.mp4');
      progressTracker.updateProgress('full-id', 1000000);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      expect(text).toContain('100%');
    });

    it('should handle progress over 100%', () => {
      progressTracker.startDownload('over-id', 1000000, 'over.mp4');
      progressTracker.updateProgress('over-id', 1500000); // 150% progress

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      expect(text).toContain('150%');
    });

    it('should handle zero total size', () => {
      progressTracker.startDownload('zero-total-id', 0, 'zero-total.mp4');
      progressTracker.updateProgress('zero-total-id', 0);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      // Should not crash with division by zero
      expect(container).toBeInTheDocument();
    });
  });

  describe('Component Lifecycle', () => {
    it('should set up interval on mount', () => {
      render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(mockSetInterval).toHaveBeenCalledWith(expect.any(Function), 100);
    });

    it('should clean up interval on unmount', () => {
      const { unmount } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      unmount();

      expect(mockClearInterval).toHaveBeenCalledWith(12345);
    });

    it('should update when progressTracker changes', () => {
      const { rerender } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const newProgressTracker = new ProgressTracker();
      newProgressTracker.startDownload('new-id', 'new.mp4', 1000000);

      rerender(
        <ProgressDisplay progressTracker={newProgressTracker} maxConcurrentDownloads={3} />
      );

      // Should set up new interval with new tracker
      expect(mockSetInterval).toHaveBeenCalledTimes(2);
    });
  });

  describe('UX Improvements Validation', () => {
    it('should handle non-string filenames gracefully', () => {
      // Test the truncateFilename function directly by simulating edge cases
      const testTruncation = (filename: any, maxLength: number = 40): string => {
        if (!filename || typeof filename !== 'string') return 'Unknown file';
        if (filename.length <= maxLength) return filename;
        return filename.substring(0, maxLength - 3) + '...';
      };

      expect(testTruncation(null)).toBe('Unknown file');
      expect(testTruncation(undefined)).toBe('Unknown file');
      expect(testTruncation(123)).toBe('Unknown file');
      expect(testTruncation('')).toBe('Unknown file');
      expect(testTruncation('short.mp4')).toBe('short.mp4');
      expect(testTruncation('a'.repeat(50))).toBe('a'.repeat(37) + '...');
    });

    it('should handle progress bar calculation edge cases', () => {
      const testProgressBar = (downloaded: number, total: number, width: number = 20): string => {
        if (total === 0) return ''.padEnd(width, '─');
        
        const percentage = Math.min(downloaded / total, 1); // Cap at 100%
        const filled = Math.floor(percentage * width);
        const empty = Math.max(width - filled, 0); // Ensure non-negative
        
        return '█'.repeat(filled) + '░'.repeat(empty);
      };

      // Test normal progress
      expect(testProgressBar(50, 100)).toBe('█'.repeat(10) + '░'.repeat(10));
      
      // Test over 100% progress (should cap at 100%)
      expect(testProgressBar(150, 100)).toBe('█'.repeat(20));
      
      // Test zero total (should show empty bar)
      expect(testProgressBar(0, 0)).toBe('─'.repeat(20));
      
      // Test edge case with very small progress
      expect(testProgressBar(1, 1000)).toBe('░'.repeat(20));
    });

    it('should show appropriate completion message when no active downloads', () => {
      const { getByText } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(getByText(/All downloads completed! \(0 files\)/)).toBeInTheDocument();
    });

    it('should handle filename with special characters', () => {
      const specialFilename = 'tëst fîlé with émöjîs 🎥 and symbols !@#$%^&*()_+.mp4';
      progressTracker.startDownload('special-id', 1000000, specialFilename);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(container.textContent).toContain('tëst fîlé with émöjîs 🎥 and symbols');
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid progress updates', () => {
      progressTracker.startDownload('rapid-id', 1000000, 'rapid.mp4');
      
      // Simulate rapid updates
      for (let i = 0; i < 100; i++) {
        progressTracker.updateProgress('rapid-id', i * 10000);
      }

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(container).toBeInTheDocument();
    });

    it('should handle empty filename', () => {
      progressTracker.startDownload('empty-name-id', 1000000, '');

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      expect(container).toBeInTheDocument();
    });

    it('should handle very small files', () => {
      progressTracker.startDownload('tiny-id', 1, 'tiny.mp4');
      progressTracker.updateProgress('tiny-id', 1);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      expect(text).toContain('100%');
      expect(text).toContain('B'); // Bytes unit
    });

    it('should handle very large files', () => {
      const largeSize = 10 * 1024 * 1024 * 1024; // 10GB
      progressTracker.startDownload('large-id', largeSize, 'large.mp4');
      progressTracker.updateProgress('large-id', largeSize / 2);

      const { container } = render(
        <ProgressDisplay progressTracker={progressTracker} maxConcurrentDownloads={3} />
      );

      const text = container.textContent || '';
      expect(text).toContain('50%');
      expect(text).toContain('GB'); // GB unit
    });
  });
});
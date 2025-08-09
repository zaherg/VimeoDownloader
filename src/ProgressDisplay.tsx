import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ProgressTracker, DownloadProgress } from './ProgressTracker';

interface ProgressDisplayProps {
  progressTracker: ProgressTracker;
  maxConcurrentDownloads: number;
}

export function ProgressDisplay({ progressTracker, maxConcurrentDownloads }: ProgressDisplayProps) {
  const [activeDownloads, setActiveDownloads] = useState<DownloadProgress[]>([]);
  const [completedCount, setCompletedCount] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      const allProgress = progressTracker.getAllProgress();
      const completed = allProgress.filter(p => p.completed);
      const active = allProgress
        .filter(p => !p.completed)
        .slice(0, maxConcurrentDownloads);
      
      setActiveDownloads(active);
      setCompletedCount(completed.length);
    }, 100); // Update every 100ms for smooth progress

    return () => clearInterval(interval);
  }, [progressTracker, maxConcurrentDownloads]);

  const formatFileSize = (bytes: number): string => {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  };

  const formatSpeed = (progress: DownloadProgress): string => {
    if (!progress.lastUpdate || !progress.startTime || progress.downloadedSize === 0) {
      return '';
    }
    
    const elapsed = (progress.lastUpdate - progress.startTime) / 1000;
    if (elapsed === 0) return '';
    
    const bytesPerSecond = progress.downloadedSize / elapsed;
    return ` (${formatFileSize(bytesPerSecond)}/s)`;
  };

  const getProgressBar = (downloaded: number, total: number, width: number = 20): string => {
    if (total === 0) return ''.padEnd(width, '─');
    
    const percentage = Math.min(downloaded / total, 1); // Cap at 100%
    const filled = Math.floor(percentage * width);
    const empty = Math.max(width - filled, 0); // Ensure non-negative
    
    return '█'.repeat(filled) + '░'.repeat(empty);
  };

  const truncateFilename = (filename: string, maxLength: number = 40): string => {
    if (!filename || typeof filename !== 'string') return 'Unknown file';
    if (filename.length <= maxLength) return filename;
    return filename.substring(0, maxLength - 3) + '...';
  };

  if (activeDownloads.length === 0) {
    if (completedCount > 0) {
      return (
        <Box flexDirection="column">
          <Text color="green">✅ All downloads completed! ({completedCount} files)</Text>
        </Box>
      );
    }
    // If no active downloads and no completed downloads, don't show anything
    // Let the main process handle the messaging
    return null;
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan" bold>📥 Active Downloads ({activeDownloads.length}/{maxConcurrentDownloads}) | Completed: {completedCount}</Text>
      </Box>
      
      {activeDownloads.map((progress) => {
        const percentage = Math.round((progress.downloadedSize / progress.totalSize) * 100);
        const progressBar = getProgressBar(progress.downloadedSize, progress.totalSize);
        const downloaded = formatFileSize(progress.downloadedSize);
        const total = formatFileSize(progress.totalSize);
        const speed = formatSpeed(progress);
        const truncatedName = truncateFilename(progress.filename);
        
        return (
          <Box key={progress.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color="white">{truncatedName}</Text>
            </Box>
            <Box>
              <Text color="blue">[{progressBar}]</Text>
              <Text color="yellow"> {percentage}% </Text>
              <Text color="gray">{downloaded}/{total}{speed}</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
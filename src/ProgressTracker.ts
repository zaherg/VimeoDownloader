export class ProgressTracker {
  private downloads: Map<string, DownloadProgress> = new Map();

  startDownload(id: string, totalSize: number, filename: string): void {
    this.downloads.set(id, {
      id,
      filename,
      totalSize,
      downloadedSize: 0,
      startTime: Date.now(),
      completed: false,
    });
  }

  updateProgress(id: string, downloadedSize: number): void {
    const download = this.downloads.get(id);
    if (download) {
      download.downloadedSize = downloadedSize;
      download.lastUpdate = Date.now();
    }
  }

  completeDownload(id: string): void {
    const download = this.downloads.get(id);
    if (download) {
      download.completed = true;
      download.endTime = Date.now();
    }
  }

  getProgress(id: string): DownloadProgress | undefined {
    return this.downloads.get(id);
  }

  getAllProgress(): DownloadProgress[] {
    return Array.from(this.downloads.values());
  }

  formatProgress(id: string): string {
    const progress = this.downloads.get(id);
    if (!progress) return '';

    const percentage = Math.round((progress.downloadedSize / progress.totalSize) * 100);
    const downloaded = this.formatFileSize(progress.downloadedSize);
    const total = this.formatFileSize(progress.totalSize);
    
    let speed = '';
    if (progress.lastUpdate && progress.startTime) {
      const elapsed = (progress.lastUpdate - progress.startTime) / 1000;
      const bytesPerSecond = progress.downloadedSize / elapsed;
      speed = ` (${this.formatFileSize(bytesPerSecond)}/s)`;
    }

    return `${percentage}% - ${downloaded}/${total}${speed}`;
  }

  private formatFileSize(bytes: number): string {
    const sizes = ['B', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }
}

export interface DownloadProgress {
  id: string;
  filename: string;
  totalSize: number;
  downloadedSize: number;
  startTime: number;
  lastUpdate?: number;
  endTime?: number;
  completed: boolean;
}
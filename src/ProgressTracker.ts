import { existsSync, unlinkSync } from 'fs';
import path from 'path';

export class ProgressTracker {
  private downloads: Map<string, DownloadProgress> = new Map();
  private persistenceFile: string;
  private saveInterval: NodeJS.Timeout | null = null;
  
  constructor(downloadPath?: string) {
    // Store progress file next to downloads
    const baseDir = downloadPath || process.cwd();
    this.persistenceFile = path.join(baseDir, '.vimeo-download-progress.json');
    
    // Load existing progress on startup
    this.loadProgress().catch(error => {
      console.warn('⚠️  Could not load previous download progress:', error instanceof Error ? error.message : error);
    });
    
    // Auto-save progress every 5 seconds
    this.saveInterval = setInterval(() => {
      this.saveProgress();
    }, 5000);
    
    // Save progress on exit
    process.on('exit', () => this.cleanup());
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }
  
  private async loadProgress(): Promise<void> {
    try {
      if (existsSync(this.persistenceFile)) {
        const data = await Bun.file(this.persistenceFile).text();
        const parsed = JSON.parse(data) as { downloads: DownloadProgress[] };
        
        // Only load incomplete downloads
        parsed.downloads
          .filter(d => !d.completed && !d.failed)
          .forEach(download => {
            this.downloads.set(download.id, download);
          });
        
        if (this.downloads.size > 0) {
          console.log(`📄 Restored ${this.downloads.size} incomplete download(s) from previous session`);
        }
      }
    } catch (error) {
      console.warn('⚠️  Could not load previous download progress:', error instanceof Error ? error.message : error);
    }
  }
  
  private saveProgress(): void {
    try {
      const data = {
        timestamp: Date.now(),
        downloads: Array.from(this.downloads.values())
      };
      
      Bun.write(this.persistenceFile, JSON.stringify(data, null, 2));
    } catch (error) {
      // Silently fail to avoid interrupting downloads
      if (process.env.DEBUG_VIMEO === 'true') {
        console.warn('⚠️  Could not save download progress:', error instanceof Error ? error.message : error);
      }
    }
  }
  
  private cleanup(): void {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    
    // Save final progress
    this.saveProgress();
    
    // Clean up progress file if all downloads are complete
    const incompleteDownloads = Array.from(this.downloads.values())
      .filter(d => !d.completed && !d.failed);
    
    if (incompleteDownloads.length === 0) {
      try {
        unlinkSync(this.persistenceFile);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  startDownload(id: string, totalSize: number, filename: string): void {
    // Check if we already have this download from a previous session
    const existing = this.downloads.get(id);
    if (existing && !existing.completed && !existing.failed) {
      // Update the existing download record
      existing.filename = filename;
      existing.totalSize = totalSize;
      existing.lastUpdate = Date.now();
      return;
    }
    
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
      download.failed = false;
      download.endTime = Date.now();
      
      // Immediately save on completion
      this.saveProgress();
    }
  }

  failDownload(id: string, errorMessage: string): void {
    const download = this.downloads.get(id);
    if (download) {
      download.failed = true;
      download.errorMessage = errorMessage;
      download.endTime = Date.now();
      
      // Immediately save on failure
      this.saveProgress();
    }
  }

  isDownloadFailed(id: string): boolean {
    const download = this.downloads.get(id);
    return download?.failed === true;
  }

  getFailedDownloads(): DownloadProgress[] {
    return Array.from(this.downloads.values()).filter(d => d.failed);
  }
  
  getIncompleteDownloads(): DownloadProgress[] {
    return Array.from(this.downloads.values()).filter(d => !d.completed && !d.failed);
  }
  
  hasIncompleteDownloads(): boolean {
    return this.getIncompleteDownloads().length > 0;
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
  failed?: boolean;
  errorMessage?: string;
  resumable?: boolean;
  partialFilePath?: string;
}
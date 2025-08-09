import { existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import React from 'react';
import { render } from 'ink';
import { Config, VimeoVideo, VimeoFolder, VimeoResponse, DownloadJob } from './types';
import { ProgressTracker } from './ProgressTracker';
import { ProgressDisplay } from './ProgressDisplay';
import { Semaphore } from './Semaphore';
import { RetryUtil } from './RetryUtil';

export class VimeoDownloader {
  private baseUrl = 'https://api.vimeo.com';
  private headers: Record<string, string>;
  private config: Config;
  private progressTracker: ProgressTracker;
  private progressDisplay: any = null;

  constructor(config: Config) {
    this.config = config;
    this.headers = {
      'Authorization': `Bearer ${config.accessToken}`,
      'Accept': 'application/vnd.vimeo.*+json;version=3.4',
    };
    this.progressTracker = new ProgressTracker();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Vimeo download process...');
    
    try {
      await this.verifyAuthentication();
      
      const folders = await this.getAllFolders();
      const videos = await this.getAllVideos();
      
      if (process.env.DEBUG_VIMEO === 'true') {
        console.log(`📁 Found ${folders.length} folders`);
        console.log(`🎥 Found ${videos.length} videos`);
      }
      
      mkdirSync(this.config.downloadPath, { recursive: true });
      
      const downloadJobs = await this.prepareDownloadJobs(videos);
      
      if (downloadJobs.length === 0) {
        console.log('\n❌ No videos available for download.');
        return;
      }
      
      if (this.config.dryRun) {
        console.log('\n🔍 Dry run mode - showing what would be downloaded:');
        this.showDryRunResults(downloadJobs);
        return;
      }
      
      const { actualDownloads } = await this.downloadVideos(downloadJobs);
      
      // Only show download summary if files were actually downloaded
      if (actualDownloads > 0) {
        this.printDownloadSummary(actualDownloads);
      }
    } catch (error) {
      console.error('❌ Error during download process:', error);
      throw error;
    }
  }

  private async apiRequest<T>(endpoint: string): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        headers: this.headers,
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Authentication failed. Please check your access token.');
        }
        if (response.status === 403) {
          throw new Error('Access forbidden. Please check your permissions.');
        }
        if (response.status === 429) {
          throw new Error('Rate limited. Please wait before retrying.');
        }
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
          throw new Error(`Request timeout for ${url}`);
        }
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
          throw new Error(`Network error: Unable to reach ${url}`);
        }
      }
      throw error;
    }
  }

  private async verifyAuthentication(): Promise<void> {
    try {
      const response = await RetryUtil.withRetry(
        () => this.apiRequest<{ name: string; account: string; metadata?: { connections?: any } }>('/me?fields=name,account,metadata.connections'),
        { maxRetries: 2, baseDelay: 1000, maxDelay: 5000 }
      );
      if (process.env.DEBUG_VIMEO === 'true') {
        console.log(`✅ Authenticated as: ${response.name}`);
        console.log('Account type:', response.account);
        console.log('Available connections:', Object.keys(response.metadata?.connections || {}));
      }
    } catch (error) {
      throw new Error('Failed to authenticate with Vimeo API. Check your access token.');
    }
  }

  private async getAllFolders(): Promise<VimeoFolder[]> {
    const folders: VimeoFolder[] = [];
    let nextUrl: string | null = '/me/projects';
    
    while (nextUrl) {
      try {
        const response = await this.apiRequest<VimeoResponse<VimeoFolder>>(nextUrl);
        folders.push(...response.data);
        nextUrl = response.paging.next;
      } catch (error) {
        console.warn('Warning: Could not fetch folders. Continuing without folder structure.');
        break;
      }
    }
    
    return folders;
  }

  private async getAllVideos(): Promise<VimeoVideo[]> {
    const videos: VimeoVideo[] = [];
    let nextUrl: string | null = '/me/videos?fields=uri,name,description,created_time,modified_time,download,files,parent_folder';
    
    while (nextUrl) {
      try {
        const response = await RetryUtil.withRetry(
          () => this.apiRequest<VimeoResponse<VimeoVideo>>(nextUrl!),
          { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 }
        );
        videos.push(...response.data);
        nextUrl = response.paging.next;
        
        if (process.env.DEBUG_VIMEO === 'true') {
          console.log(`📥 Fetched ${videos.length} videos so far...`);
        }
      } catch (error) {
        console.error('Error fetching videos:', error instanceof Error ? error.message : error);
        break;
      }
    }
    
    return videos;
  }

  private async prepareDownloadJobs(videos: VimeoVideo[]): Promise<DownloadJob[]> {
    const jobs: DownloadJob[] = [];
    const failedVideos: string[] = [];
    
    for (const video of videos) {
      try {
        const downloadInfo = await this.getVideoDownloadInfo(video);
        if (downloadInfo) {
          const filePath = this.generateFilePath(video, downloadInfo.filename);
          jobs.push({
            video,
            downloadUrl: downloadInfo.url,
            filePath,
            size: downloadInfo.size,
          });
        } else {
          failedVideos.push(video.name);
        }
      } catch (error) {
        failedVideos.push(video.name);
      }
    }
    
    // Show failed videos summary if any
    if (failedVideos.length > 0) {
      console.warn(`\n⚠️  ${failedVideos.length} video${failedVideos.length > 1 ? 's' : ''} could not be downloaded:`);
      failedVideos.forEach(name => console.warn(`   • ${name}`));
      console.warn(`\n   This might be due to:`);
      console.warn(`   1. Video download not enabled in Vimeo settings`);
      console.warn(`   2. Access token missing download permissions`);
      console.warn(`   3. Video privacy settings restricting downloads`);
    }
    
    return jobs;
  }

  private async getVideoDownloadInfo(video: VimeoVideo): Promise<{ url: string; filename: string; size: number } | null> {
    try {
      const videoId = video.uri.split('/').pop();
      
      if (process.env.DEBUG_VIMEO === 'true') {
        console.log(`\n🔍 Requesting download info for video ID: ${videoId}`);
        console.log(`Full video URI: ${video.uri}`);
      }
      
      const response = await this.apiRequest<{ download?: any[]; files?: any[] }>(`/videos/${videoId}?fields=download,files`);
      
      // Optional debug logging (can be enabled for troubleshooting)
      if (process.env.DEBUG_VIMEO === 'true') {
        console.log(`\n🔍 Debug info for video: ${video.name}`);
        console.log('Download array:', response.download ? response.download.length : 'null/undefined');
        console.log('Files array:', response.files ? response.files.length : 'null/undefined');
        
        if (response.download) {
          console.log('Download options:', response.download.map((d: any) => `${d.public_name || d.quality} - ${d.type}`));
        }
        
        if (response.files) {
          console.log('File options:', response.files.map((f: any) => `${f.quality} - ${f.type} - ${f.link?.includes('.m3u8') ? 'HLS' : 'Direct'}`));
        }
      }
      
      // Check if this is a permission issue
      if (!response.download && !response.files) {
        return null;
      }
      
      // Prefer any direct download over streaming files
      if (response.download && response.download.length > 0) {
        const selectedDownload = this.selectQuality(response.download);
        
        if (selectedDownload) {
          if (process.env.DEBUG_VIMEO === 'true') {
            console.log(`✅ Using direct download URL: ${selectedDownload.public_name}`);
          }
          return {
            url: selectedDownload.link,
            filename: this.sanitizeFilename(`${video.name}.${this.getFileExtension(selectedDownload.type)}`),
            size: selectedDownload.size,
          };
        }
      }
      
      // Fallback to highest quality direct file (avoid HLS)
      if (response.files && response.files.length > 0) {
        // Filter out HLS files and prefer direct downloads
        const directFiles = response.files.filter((f: any) => 
          f.quality !== 'hls' && !f.link?.includes('.m3u8')
        );
        
        if (directFiles.length > 0) {
          const highestQuality = directFiles.reduce((prev: any, current: any) => 
            (prev.width * prev.height) > (current.width * current.height) ? prev : current
          );
          
          if (process.env.DEBUG_VIMEO === 'true') {
            console.log(`✅ Using direct file URL: ${highestQuality.quality}`);
          }
          return {
            url: highestQuality.link,
            filename: this.sanitizeFilename(`${video.name}.${this.getFileExtension(highestQuality.type)}`),
            size: highestQuality.size,
          };
        }
        
        // Last resort: use HLS (this should rarely happen now)
        const hlsFile = response.files.find((f: any) => f.quality === 'hls');
        if (hlsFile) {
          console.log('⚠️  Only HLS available for', video.name, '- will download M3U8 playlist');
          return {
            url: hlsFile.link,
            filename: this.sanitizeFilename(`${video.name}.${this.getFileExtension(hlsFile.type)}`),
            size: hlsFile.size,
          };
        }
      }
      
      return null;
    } catch (error) {
      console.warn(`Could not get download info for ${video.name}:`, error);
      return null;
    }
  }

  private generateFilePath(video: VimeoVideo, filename: string): string {
    let folderPath = this.config.downloadPath;
    
    // Create folder structure if video is in a folder
    if (video.parent_folder) {
      const folderName = this.sanitizeFilename(video.parent_folder.name);
      folderPath = path.join(folderPath, folderName);
    }
    
    return path.join(folderPath, filename);
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // Invalid chars and control chars
      .replace(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i, '_$1') // Windows reserved names
      .replace(/\s+/g, ' ') // Multiple spaces to single space
      .replace(/^\.+/, '') // Leading dots
      .trim()
      .slice(0, 200); // Limit filename length
  }

  private getFileExtension(mimeType: string): string {
    const extensions: { [key: string]: string } = {
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/x-msvideo': 'avi',
      'video/webm': 'webm',
    };
    return extensions[mimeType] || 'mp4';
  }

  private showDryRunResults(jobs: DownloadJob[]): void {
    const totalSize = jobs.reduce((sum, job) => sum + job.size, 0);
    const totalSizeGB = (totalSize / (1024 * 1024 * 1024)).toFixed(2);
    
    console.log(`\nTotal videos to download: ${jobs.length}`);
    console.log(`Total size: ${totalSizeGB} GB\n`);
    
    jobs.forEach((job, index) => {
      const sizeHuman = this.formatFileSize(job.size);
      console.log(`${index + 1}. ${job.video.name} (${sizeHuman})`);
      console.log(`   → ${job.filePath}`);
    });
  }

  private async downloadVideos(jobs: DownloadJob[]): Promise<{ actualDownloads: number; skippedFiles: number }> {
    console.log(`\n📥 Starting download of ${jobs.length} videos...`);
    
    // Start the progress display
    this.progressDisplay = render(
      React.createElement(ProgressDisplay, {
        progressTracker: this.progressTracker,
        maxConcurrentDownloads: this.config.maxConcurrentDownloads
      })
    );
    
    const semaphore = new Semaphore(this.config.maxConcurrentDownloads);
    let actualDownloads = 0;
    let skippedFiles = 0;
    
    const downloadPromises = jobs.map(async (job, index) => {
      await semaphore.acquire();
      
      try {
        const result = await this.downloadSingleVideo(job, index + 1, jobs.length);
        if (result === 'downloaded') {
          actualDownloads++;
        } else if (result === 'skipped') {
          skippedFiles++;
        }
        // 'failed' downloads are not counted in either category
      } catch (error) {
        // Progress display will show the error, but still log it for debugging
        if (process.env.DEBUG_VIMEO === 'true') {
          console.error(`❌ Failed to download ${job.video.name}:`, error instanceof Error ? error.message : error);
        }
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(downloadPromises);
    
    // Stop the progress display
    if (this.progressDisplay) {
      this.progressDisplay.unmount();
      this.progressDisplay = null;
    }
    
    // Show appropriate completion message
    if (actualDownloads === 0) {
      if (skippedFiles > 0) {
        console.log(`\n📁 Nothing to download - all ${skippedFiles} files already exist.`);
      } else {
        console.log(`\n❌ No files were downloaded.`);
      }
    } else {
      console.log(`\n✅ Downloaded ${actualDownloads} file${actualDownloads > 1 ? 's' : ''}!${skippedFiles > 0 ? ` (${skippedFiles} already existed)` : ''}`);
    }
    
    return { actualDownloads, skippedFiles };
  }

  private async downloadSingleVideo(job: DownloadJob, current: number, total: number): Promise<'downloaded' | 'skipped' | 'failed'> {
    const { downloadUrl, filePath, video } = job;
    
    // Start progress tracking for all files (including skipped ones)
    const trackingId = video.uri;
    this.progressTracker.startDownload(trackingId, job.size, video.name);
    
    // Check if file already exists
    if (existsSync(filePath)) {
      if (!this.config.overwrite) {
        const stats = statSync(filePath);
        if (stats.size > 0) {
          console.log(`⏭️  Skipping ${video.name} (already exists)`);
          // Mark as completed immediately for skipped files
          this.progressTracker.updateProgress(trackingId, job.size);
          this.progressTracker.completeDownload(trackingId);
          return 'skipped';
        }
      } else {
        console.log(`🔄 Overwriting ${video.name}`);
      }
    }
    
    // Ensure directory exists
    mkdirSync(path.dirname(filePath), { recursive: true });
    
    await RetryUtil.withRetry(
      async () => {
        const response = await fetch(downloadUrl, {
          signal: AbortSignal.timeout(300000), // 5 minute timeout for downloads
        });
        
        if (!response.ok) {
          if (response.status === 403) {
            throw new Error(`Download link expired or access denied for ${video.name}`);
          }
          if (response.status === 404) {
            throw new Error(`Video file not found for ${video.name}`);
          }
          throw new Error(`Download failed: ${response.status} ${response.statusText}`);
        }
        
        if (!response.body) {
          throw new Error('No response body available for download');
        }
        
        const totalSize = parseInt(response.headers.get('content-length') || '0');
        let downloadedSize = 0;
        let lastProgress = -1;
        
        // Use Bun's file writer for better performance
        const file = Bun.file(filePath);
        const writer = file.writer();
        
        const reader = response.body.getReader();
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;
            
            downloadedSize += value.length;
            
            // Update progress tracker (the UI will automatically update)
            this.progressTracker.updateProgress(trackingId, downloadedSize);
            
            writer.write(value);
          }
          
          await writer.end();
          
          // Verify file was written correctly
          if (totalSize > 0) {
            const actualSize = statSync(filePath).size;
            if (actualSize !== totalSize) {
              throw new Error(`File size mismatch: expected ${totalSize}, got ${actualSize}`);
            }
          }
          
          this.progressTracker.completeDownload(trackingId);
        } catch (error) {
          try {
            await writer.end();
          } catch {
            // Ignore writer end errors
          }
          try { 
            unlinkSync(filePath); 
          } catch {
            // Ignore cleanup errors
          }
          
          if (error instanceof Error) {
            if (error.name === 'TimeoutError') {
              throw new Error(`Download timeout for ${video.name}`);
            }
            if (error.name === 'AbortError') {
              throw new Error(`Download aborted for ${video.name}`);
            }
          }
          throw error;
        } finally {
          reader.releaseLock();
        }
      },
      { maxRetries: 2, baseDelay: 5000, maxDelay: 15000 }
    );
    
    return 'downloaded';
  }

  private selectQuality(downloads: any[]): any | null {
    // If user wants highest quality, return the highest resolution
    if (this.config.quality === 'highest') {
      return downloads.reduce((prev: any, current: any) => {
        const prevRes = parseInt(prev.public_name) || 0;
        const currentRes = parseInt(current.public_name) || 0;
        return currentRes > prevRes ? current : prev;
      });
    }
    
    // Look for exact quality match first
    const exactMatch = downloads.find((d: any) => d.public_name === this.config.quality);
    if (exactMatch) {
      return exactMatch;
    }
    
    // If no exact match, find the closest quality (prefer higher)
    const targetRes = parseInt(this.config.quality) || 0;
    if (targetRes > 0) {
      // Sort by resolution and find closest match
      const sorted = downloads
        .map((d: any) => ({
          ...d,
          resolution: parseInt(d.public_name) || 0
        }))
        .filter((d: any) => d.resolution > 0)
        .sort((a: any, b: any) => Math.abs(a.resolution - targetRes) - Math.abs(b.resolution - targetRes));
      
      if (sorted.length > 0) {
        return sorted[0];
      }
    }
    
    // Fallback to highest quality
    return downloads.reduce((prev: any, current: any) => {
      const prevRes = parseInt(prev.public_name) || 0;
      const currentRes = parseInt(current.public_name) || 0;
      return currentRes > prevRes ? current : prev;
    });
  }

  private formatFileSize(bytes: number): string {
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    if (bytes === 0) return '0 Bytes';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
  }

  private printDownloadSummary(actualDownloadCount: number): void {
    if (actualDownloadCount === 0) return;
    
    const allProgress = this.progressTracker.getAllProgress();
    // Filter to only files that were actually downloaded (not skipped)
    // We can identify these as files that have meaningful download duration
    const actualDownloads = allProgress.filter(p => {
      if (!p.completed) return false;
      
      const duration = p.endTime ? p.endTime - p.startTime : 0;
      // If download took more than 100ms, it was actually downloaded (not skipped)
      return duration > 100;
    });
    
    if (actualDownloads.length === 0) return;
    
    const totalSize = actualDownloads.reduce((sum, p) => sum + p.totalSize, 0);
    const totalDuration = actualDownloads.reduce((max, p) => {
      const duration = p.endTime ? p.endTime - p.startTime : 0;
      return Math.max(max, duration);
    }, 0);
    
    console.log('\n📊 Download Summary:');
    console.log(`   Total files: ${actualDownloads.length}`);
    console.log(`   Total size: ${this.formatFileSize(totalSize)}`);
    console.log(`   Total time: ${Math.round(totalDuration / 1000)}s`);
    
    if (totalDuration > 0) {
      const avgSpeed = totalSize / (totalDuration / 1000);
      console.log(`   Average speed: ${this.formatFileSize(avgSpeed)}/s`);
    }
  }
}
import { existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import React from 'react';
import { render } from 'ink';
import { Config, VimeoVideo, VimeoFolder, VimeoResponse, DownloadJob } from './types';
import { ProgressTracker } from './ProgressTracker';
import { ProgressDisplay } from './ProgressDisplay';
import { Semaphore } from './Semaphore';
import { RetryUtil, NetworkError } from './RetryUtil';
import { ErrorHandler } from './ErrorHandler';

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
    this.progressTracker = new ProgressTracker(config.downloadPath);
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
      const guidance = ErrorHandler.classifyError(error instanceof Error ? error : new Error(String(error)));
      console.error('❌ Critical error during download process:');
      console.error(ErrorHandler.formatErrorGuidance(guidance));
      
      // Show summary of incomplete downloads for user recovery
      const incompleteDownloads = this.progressTracker.getIncompleteDownloads();
      if (incompleteDownloads.length > 0) {
        console.log(`\n📋 ${incompleteDownloads.length} download(s) were interrupted and can be resumed:`);
        incompleteDownloads.forEach((download, index) => {
          const progress = Math.round((download.downloadedSize / download.totalSize) * 100);
          console.log(`   ${index + 1}. ${download.filename} (${progress}% complete)`);
        });
        console.log('\n💡 Run the command again to resume interrupted downloads.\n');
      }
      
      throw error;
    }
  }

  private async apiRequest<T>(endpoint: string): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      
      const response = await fetch(url, {
        headers: this.headers,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // Extract retry-after header for rate limiting
        const retryAfter = response.headers.get('retry-after');
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter) : undefined;
        
        if (response.status === 401) {
          throw RetryUtil.createNetworkError('Authentication failed. Please check your access token.', 401, undefined, 'AUTH_ERROR');
        }
        if (response.status === 403) {
          throw RetryUtil.createNetworkError('Access forbidden. Please check your permissions.', 403, undefined, 'PERMISSION_ERROR');
        }
        if (response.status === 429) {
          throw RetryUtil.createNetworkError('Rate limited. Please wait before retrying.', 429, retryAfterSeconds, 'RATE_LIMIT');
        }
        if (response.status >= 500) {
          throw RetryUtil.createNetworkError(`Server error: ${response.status} ${response.statusText}`, response.status, undefined, 'SERVER_ERROR');
        }
        throw RetryUtil.createNetworkError(`API request failed: ${response.status} ${response.statusText}`, response.status, undefined, 'API_ERROR');
      }
      
      // Validate response content type
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw RetryUtil.createNetworkError('Invalid response format - expected JSON', response.status, undefined, 'INVALID_RESPONSE');
      }
      
      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw RetryUtil.createNetworkError(`Request timeout for ${url} (30s)`, 0, undefined, 'TIMEOUT');
        }
        if (error.name === 'TypeError') {
          if (error.message.includes('fetch') || error.message.includes('network')) {
            throw RetryUtil.createNetworkError(`Network connection failed: Unable to reach ${url}`, 0, undefined, 'CONNECTION_FAILED');
          }
          if (error.message.includes('Failed to parse')) {
            throw RetryUtil.createNetworkError('Invalid JSON response from server', 0, undefined, 'PARSE_ERROR');
          }
        }
        if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
          throw RetryUtil.createNetworkError(`DNS or connection error: ${error.message}`, 0, undefined, 'CONNECTION_FAILED');
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
      const guidance = ErrorHandler.classifyError(error instanceof Error ? error : new Error('Authentication failed'));
      console.error('Authentication Error:');
      console.error(ErrorHandler.formatErrorGuidance(guidance));
      throw error;
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
          { 
            maxRetries: 3, 
            baseDelay: 2000, 
            maxDelay: 10000,
            onRetry: (attempt, error) => {
              console.log(`⚠️  Retrying video fetch (${attempt}/3): ${error.message}`);
            }
          }
        );
        videos.push(...response.data);
        nextUrl = response.paging.next;
        
        if (process.env.DEBUG_VIMEO === 'true') {
          console.log(`📥 Fetched ${videos.length} videos so far...`);
        }
      } catch (error) {
        const guidance = ErrorHandler.classifyError(error instanceof Error ? error : new Error(String(error)));
        console.error('❌ Error fetching videos:');
        console.error(ErrorHandler.formatErrorGuidance(guidance));
        
        if (!guidance.recoverable) {
          throw error;
        }
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
        if (process.env.DEBUG_VIMEO === 'true') {
          const guidance = ErrorHandler.classifyError(error instanceof Error ? error : new Error(String(error)));
          console.debug(`Failed to get download info for ${video.name}:`);
          console.debug(ErrorHandler.formatErrorGuidance(guidance));
        }
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
      
      const response = await RetryUtil.withRetry(
        () => this.apiRequest<{ download?: any[]; files?: any[] }>(`/videos/${videoId}?fields=download,files`),
        {
          maxRetries: 2,
          baseDelay: 1000,
          maxDelay: 5000,
          onRetry: (attempt, error) => {
            if (process.env.DEBUG_VIMEO === 'true') {
              console.log(`⚠️  Retrying download info for ${video.name} (${attempt}/2): ${error.message}`);
            }
          }
        }
      );
      
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
        const guidance = ErrorHandler.classifyError(error instanceof Error ? error : new Error(String(error)));
        this.progressTracker.failDownload(trackingId, guidance.userMessage);
        
        if (process.env.DEBUG_VIMEO === 'true') {
          console.error(`❌ Failed to download ${job.video.name}:`);
          console.error(ErrorHandler.formatErrorGuidance(guidance));
        } else {
          console.error(`❌ ${job.video.name}: ${guidance.userMessage}`);
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
    
    // Show recovery guidance for any failed or incomplete downloads
    this.showRecoveryGuidance();
    
    return { actualDownloads, skippedFiles };
  }

  private async downloadSingleVideo(job: DownloadJob, current: number, total: number): Promise<'downloaded' | 'skipped' | 'failed'> {
    const { downloadUrl, filePath, video } = job;
    
    // Start progress tracking for all files (including skipped ones)
    const trackingId = video.uri;
    this.progressTracker.startDownload(trackingId, job.size, video.name);
    
    let resumeFrom = 0;
    let tempFilePath = filePath + '.partial';
    
    // Check if file already exists and is complete
    if (existsSync(filePath)) {
      if (!this.config.overwrite) {
        const stats = statSync(filePath);
        if (stats.size === job.size || (job.size === 0 && stats.size > 0)) {
          console.log(`⏭️  Skipping ${video.name} (already complete)`);
          this.progressTracker.updateProgress(trackingId, job.size || stats.size);
          this.progressTracker.completeDownload(trackingId);
          return 'skipped';
        }
      } else {
        console.log(`🔄 Overwriting ${video.name}`);
        // Remove existing file to start fresh
        try {
          unlinkSync(filePath);
        } catch {}
      }
    }
    
    // Check for partial download that can be resumed
    if (existsSync(tempFilePath)) {
      const stats = statSync(tempFilePath);
      if (stats.size > 0 && stats.size < job.size) {
        resumeFrom = stats.size;
        console.log(`📁 Resuming ${video.name} from ${this.formatFileSize(resumeFrom)}`);
        this.progressTracker.updateProgress(trackingId, resumeFrom);
      } else if (stats.size >= job.size) {
        // Partial file is complete, just rename it
        try {
          const fs = require('fs');
          fs.renameSync(tempFilePath, filePath);
          console.log(`✅ Completed ${video.name} (was partial)`);
          this.progressTracker.updateProgress(trackingId, job.size);
          this.progressTracker.completeDownload(trackingId);
          return 'downloaded';
        } catch (error) {
          // If rename fails, delete and start over
          try { unlinkSync(tempFilePath); } catch {}
          resumeFrom = 0;
        }
      } else {
        // Invalid partial file, delete and start over
        try { unlinkSync(tempFilePath); } catch {}
        resumeFrom = 0;
      }
    }
    
    // Ensure directory exists
    mkdirSync(path.dirname(filePath), { recursive: true });
    
    await RetryUtil.withRetry(
      async () => {
        const headers: Record<string, string> = {};
        if (resumeFrom > 0) {
          headers['Range'] = `bytes=${resumeFrom}-`;
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout
        
        const response = await fetch(downloadUrl, {
          headers,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          if (response.status === 403) {
            throw RetryUtil.createNetworkError(`Download link expired or access denied for ${video.name}`, 403, undefined, 'PERMISSION_ERROR');
          }
          if (response.status === 404) {
            throw RetryUtil.createNetworkError(`Video file not found for ${video.name}`, 404, undefined, 'API_ERROR');
          }
          if (response.status === 416) {
            // Range not satisfiable - file might be corrupted, start over
            console.log(`⚠️  Invalid resume range for ${video.name}, starting over`);
            try { unlinkSync(tempFilePath); } catch {}
            resumeFrom = 0;
            throw RetryUtil.createNetworkError('Range not satisfiable, retrying from beginning', 416, undefined, 'SERVER_ERROR');
          }
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            throw RetryUtil.createNetworkError('Rate limited during download', 429, retryAfter ? parseInt(retryAfter) : undefined, 'RATE_LIMIT');
          }
          throw RetryUtil.createNetworkError(`Download failed: ${response.status} ${response.statusText}`, response.status, undefined, 'API_ERROR');
        }
        
        if (!response.body) {
          throw new Error('No response body available for download');
        }
        
        // Handle partial content responses
        const isPartialContent = response.status === 206;
        const contentLength = parseInt(response.headers.get('content-length') || '0');
        const totalSize = isPartialContent ? resumeFrom + contentLength : contentLength;
        let downloadedSize = resumeFrom;
        
        // Validate that we can resume properly
        if (resumeFrom > 0 && !isPartialContent) {
          console.log(`⚠️  Server doesn't support resume for ${video.name}, starting over`);
          try { unlinkSync(tempFilePath); } catch {}
          resumeFrom = 0;
          downloadedSize = 0;
          // Re-throw to retry without range header
          throw RetryUtil.createNetworkError('Resume not supported, retrying from beginning', 200, undefined, 'SERVER_ERROR');
        }
        
        // Use Bun's file writer for better performance
        const file = Bun.file(tempFilePath);
        const writer = resumeFrom > 0 ? file.writer({ highWaterMark: 64 * 1024 }) : file.writer();
        
        // If resuming, seek to the end of existing content
        if (resumeFrom > 0) {
          // For Bun, we need to append to existing file
          const existingData = await Bun.file(tempFilePath).arrayBuffer();
          writer.write(new Uint8Array(existingData));
        }
        
        const reader = response.body!.getReader();
        
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
          const actualSize = statSync(tempFilePath).size;
          const expectedSize = job.size || totalSize;
          
          if (expectedSize > 0 && actualSize !== expectedSize) {
            throw new Error(`File size mismatch: expected ${expectedSize}, got ${actualSize}`);
          }
          
          // Move completed file from temp to final location
          const fs = require('fs');
          fs.renameSync(tempFilePath, filePath);
          
          this.progressTracker.completeDownload(trackingId);
        } catch (error) {
          try {
            await writer.end();
          } catch {
            // Ignore writer end errors
          }
          // Don't delete partial file - keep it for resume
          // Only delete if the file is corrupted (very small)
          try {
            const stats = statSync(tempFilePath);
            if (stats.size < 1024) { // Less than 1KB, probably corrupted
              unlinkSync(tempFilePath);
            }
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
      { 
        maxRetries: 3, 
        baseDelay: 2000, 
        maxDelay: 30000,
        enableJitter: true,
        backoffMultiplier: 2,
        retryOnStatus: [429, 500, 502, 503, 504, 416], // Include 416 for range errors
        onRetry: (attempt, error) => {
          console.log(`⚠️  Retrying download for ${video.name} (${attempt}/3): ${error.message}`);
          // Reset resume position on certain errors
          const networkError = error as any;
          if (networkError.status === 416) {
            resumeFrom = 0;
          }
        }
      }
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

  private showRecoveryGuidance(): void {
    const failedDownloads = this.progressTracker.getFailedDownloads();
    const incompleteDownloads = this.progressTracker.getIncompleteDownloads();
    
    if (failedDownloads.length > 0) {
      console.log(`\n⚠️  ${failedDownloads.length} download(s) failed:`);
      failedDownloads.forEach((download, index) => {
        console.log(`   ${index + 1}. ${download.filename} - ${download.errorMessage}`);
      });
      console.log('\n   Check error details above for specific resolution steps.');
    }
    
    if (incompleteDownloads.length > 0) {
      console.log(`\n📋 ${incompleteDownloads.length} download(s) were interrupted:`);
      incompleteDownloads.forEach((download, index) => {
        const progress = download.totalSize > 0 ? Math.round((download.downloadedSize / download.totalSize) * 100) : 0;
        console.log(`   ${index + 1}. ${download.filename} (${progress}% complete)`);
      });
      console.log('\n💡 Run the command again to resume these downloads.');
    }
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
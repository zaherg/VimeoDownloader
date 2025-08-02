import axios, { AxiosInstance } from 'axios';
import fs from 'fs-extra';
import path from 'path';
import { Config, VimeoVideo, VimeoFolder, VimeoResponse, DownloadJob } from './types';
import { ProgressTracker } from './ProgressTracker';
import { Semaphore } from './Semaphore';
import { RetryUtil } from './RetryUtil';

export class VimeoDownloader {
  private api: AxiosInstance;
  private config: Config;
  private progressTracker: ProgressTracker;

  constructor(config: Config) {
    this.config = config;
    this.api = axios.create({
      baseURL: 'https://api.vimeo.com',
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Accept': 'application/vnd.vimeo.*+json;version=3.4',
      },
    });
    this.progressTracker = new ProgressTracker();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting Vimeo download process...');
    
    try {
      await this.verifyAuthentication();
      
      const folders = await this.getAllFolders();
      const videos = await this.getAllVideos();
      
      console.log(`📁 Found ${folders.length} folders`);
      console.log(`🎥 Found ${videos.length} videos`);
      
      await fs.ensureDir(this.config.downloadPath);
      
      const downloadJobs = await this.prepareDownloadJobs(videos);
      
      if (this.config.dryRun) {
        console.log('\n🔍 Dry run mode - showing what would be downloaded:');
        this.showDryRunResults(downloadJobs);
        return;
      }
      
      await this.downloadVideos(downloadJobs);
      
      console.log('\n✅ Download process completed!');
    } catch (error) {
      console.error('❌ Error during download process:', error);
      throw error;
    }
  }

  private async verifyAuthentication(): Promise<void> {
    try {
      const response = await RetryUtil.withRetry(
        () => this.api.get('/me'),
        { maxRetries: 2, baseDelay: 1000, maxDelay: 5000 }
      );
      console.log(`✅ Authenticated as: ${response.data.name}`);
    } catch (error) {
      throw new Error('Failed to authenticate with Vimeo API. Check your access token.');
    }
  }

  private async getAllFolders(): Promise<VimeoFolder[]> {
    const folders: VimeoFolder[] = [];
    let nextUrl: string | null = '/me/projects';
    
    while (nextUrl) {
      try {
        const response = nextUrl.startsWith('http') 
          ? await axios.get<VimeoResponse<VimeoFolder>>(nextUrl, { headers: this.api.defaults.headers })
          : await this.api.get<VimeoResponse<VimeoFolder>>(nextUrl);
        folders.push(...response.data.data);
        nextUrl = response.data.paging.next;
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
          () => nextUrl!.startsWith('http')
            ? axios.get<VimeoResponse<VimeoVideo>>(nextUrl!, { headers: this.api.defaults.headers })
            : this.api.get<VimeoResponse<VimeoVideo>>(nextUrl!),
          { maxRetries: 3, baseDelay: 2000, maxDelay: 10000 }
        );
        videos.push(...response.data.data);
        nextUrl = response.data.paging.next;
        
        console.log(`📥 Fetched ${videos.length} videos so far...`);
      } catch (error) {
        console.error('Error fetching videos:', error instanceof Error ? error.message : error);
        break;
      }
    }
    
    return videos;
  }

  private async prepareDownloadJobs(videos: VimeoVideo[]): Promise<DownloadJob[]> {
    const jobs: DownloadJob[] = [];
    
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
        }
      } catch (error) {
        console.warn(`⚠️  Could not get download info for video: ${video.name}`);
      }
    }
    
    return jobs;
  }

  private async getVideoDownloadInfo(video: VimeoVideo): Promise<{ url: string; filename: string; size: number } | null> {
    try {
      const videoId = video.uri.split('/').pop();
      const response = await this.api.get(`/videos/${videoId}?fields=download,files`);
      
      // Optional debug logging (can be enabled for troubleshooting)
      if (process.env.DEBUG_VIMEO === 'true') {
        console.log(`\n🔍 Debug info for video: ${video.name}`);
        console.log('Download array:', response.data.download ? response.data.download.length : 'null/undefined');
        console.log('Files array:', response.data.files ? response.data.files.length : 'null/undefined');
        
        if (response.data.download) {
          console.log('Download options:', response.data.download.map((d: any) => `${d.public_name || d.quality} - ${d.type}`));
        }
        
        if (response.data.files) {
          console.log('File options:', response.data.files.map((f: any) => `${f.quality} - ${f.type} - ${f.link?.includes('.m3u8') ? 'HLS' : 'Direct'}`));
        }
      }
      
      // Prefer any direct download over streaming files
      if (response.data.download && response.data.download.length > 0) {
        const selectedDownload = this.selectQuality(response.data.download);
        
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
      if (response.data.files && response.data.files.length > 0) {
        // Filter out HLS files and prefer direct downloads
        const directFiles = response.data.files.filter((f: any) => 
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
        const hlsFile = response.data.files.find((f: any) => f.quality === 'hls');
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

  private async downloadVideos(jobs: DownloadJob[]): Promise<void> {
    console.log(`\n📥 Starting download of ${jobs.length} videos...`);
    
    const semaphore = new Semaphore(this.config.maxConcurrentDownloads);
    let completedJobs = 0;
    
    const downloadPromises = jobs.map(async (job, index) => {
      await semaphore.acquire();
      
      try {
        await this.downloadSingleVideo(job, index + 1, jobs.length);
        completedJobs++;
      } catch (error) {
        console.error(`❌ Failed to download ${job.video.name}:`, error instanceof Error ? error.message : error);
      } finally {
        semaphore.release();
      }
    });
    
    await Promise.all(downloadPromises);
  }

  private async downloadSingleVideo(job: DownloadJob, current: number, total: number): Promise<void> {
    const { downloadUrl, filePath, video } = job;
    
    // Check if file already exists
    if (await fs.pathExists(filePath)) {
      if (!this.config.overwrite) {
        const stats = await fs.stat(filePath);
        if (stats.size > 0) {
          console.log(`⏭️  Skipping ${video.name} (already exists)`);
          return;
        }
      } else {
        console.log(`🔄 Overwriting ${video.name}`);
      }
    }
    
    // Ensure directory exists
    await fs.ensureDir(path.dirname(filePath));
    
    console.log(`📥 (${current}/${total}) Downloading: ${video.name}`);
    
    await RetryUtil.withRetry(
      async () => {
        const response = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          timeout: 60000, // 60 second timeout
        });
        
        const totalSize = parseInt(response.headers['content-length'] || '0');
        let downloadedSize = 0;
        let lastProgress = -1;
        
        const writer = fs.createWriteStream(filePath);
        
        // Track download progress
        response.data.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length;
          const progress = Math.round((downloadedSize / totalSize) * 100);
          
          // Only log progress every 10% to avoid spam
          if (progress !== lastProgress && progress % 10 === 0) {
            const downloadedMB = (downloadedSize / (1024 * 1024)).toFixed(1);
            const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
            console.log(`📥 (${current}/${total}) ${video.name} - ${progress}% (${downloadedMB}/${totalMB} MB)`);
            lastProgress = progress;
          }
        });
        
        response.data.pipe(writer);
        
        return new Promise<void>((resolve, reject) => {
          writer.on('finish', () => {
            console.log(`✅ (${current}/${total}) ${video.name} - Complete`);
            resolve();
          });
          writer.on('error', (error) => {
            // Clean up partial file on error
            fs.unlink(filePath).catch(() => {});
            reject(error);
          });
          response.data.on('error', (error) => {
            writer.destroy();
            fs.unlink(filePath).catch(() => {});
            reject(error);
          });
        });
      },
      { maxRetries: 2, baseDelay: 5000, maxDelay: 15000 }
    );
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
}
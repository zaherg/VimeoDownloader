#!/usr/bin/env node

import { Command } from 'commander';
import dotenv from 'dotenv';
import { VimeoDownloader } from './src/VimeoDownloader';
import { Config } from './src/types';

dotenv.config();

const program = new Command();

program
  .name('vimeo-downloader')
  .description('CLI tool to download Vimeo videos with directory structure preservation')
  .version('1.0.0');

program
  .command('download')
  .description('Download all videos from your Vimeo account')
  .option('-p, --path <path>', 'Download path', process.env.DOWNLOAD_PATH || './downloads')
  .option('-c, --concurrent <number>', 'Max concurrent downloads', process.env.MAX_CONCURRENT_DOWNLOADS || '3')
  .option('-q, --quality <quality>', 'Video quality preference (highest, 2160p, 1440p, 1080p, 720p, 540p, 360p, 240p)', 'highest')
  .option('--dry-run', 'Show what would be downloaded without actually downloading')
  .option('--overwrite', 'Overwrite existing files instead of skipping them')
  .action(async (options) => {
    try {
      const config: Config = {
        clientId: process.env.VIMEO_CLIENT_ID!,
        clientSecret: process.env.VIMEO_CLIENT_SECRET!,
        accessToken: process.env.VIMEO_ACCESS_TOKEN!,
        downloadPath: options.path,
        maxConcurrentDownloads: parseInt(options.concurrent),
        quality: options.quality,
        dryRun: options.dryRun || false,
        overwrite: options.overwrite || false,
      };

      if (!config.clientId || !config.clientSecret || !config.accessToken) {
        console.error('❌ Missing required environment variables. Please check your .env file.');
        console.log('Required variables: VIMEO_CLIENT_ID, VIMEO_CLIENT_SECRET, VIMEO_ACCESS_TOKEN');
        process.exit(1);
      }

      const downloader = new VimeoDownloader(config);
      await downloader.start();
    } catch (error) {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('auth')
  .description('Authenticate with Vimeo and get access token')
  .action(async () => {
    console.log('🔑 Vimeo Authentication Setup');
    console.log('1. Go to https://developer.vimeo.com/apps');
    console.log('2. Create a new app or use an existing one');
    console.log('3. Generate a personal access token with "private" and "download" scopes');
    console.log('4. Add the credentials to your .env file');
  });

program.parse();
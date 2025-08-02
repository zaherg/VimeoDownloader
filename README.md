# Vimeo Downloader CLI

A TypeScript CLI tool built with Bun to download all your Vimeo videos while preserving the original directory structure.

## Features

- 🔐 Secure authentication with Vimeo API
- 📁 Preserves folder structure from your Vimeo account
- 🎥 Downloads original quality videos when available
- ⚡ Concurrent downloads for faster processing
- 🔍 Dry run mode to preview downloads
- ✅ Skip already downloaded files
- 📊 Progress tracking with file size information

## Prerequisites

- [Bun](https://bun.sh) installed on your system
- A Vimeo account with videos to download
- Vimeo API credentials (see setup below)

## Installation Options

### Option 1: Standalone Executable (Recommended)

**Download pre-built executable:** *(coming soon - see releases)*

**Or build from source:**
```bash
git clone <repository-url>
cd VimeoDownloader
bun install
bun run build:exe        # For your current platform
bun run build:all        # For all platforms
```

### Option 2: From Source

```bash
git clone <repository-url>
cd VimeoDownloader
bun install
```

## Setup

1. **Get Vimeo API credentials:**
   ```bash
   # Using executable
   ./vimeo-downloader auth
   
   # Or from source
   bun run index.ts auth
   ```
   This will show you instructions to:
   - Go to https://developer.vimeo.com/apps
   - Create a new app or use an existing one
   - Generate a personal access token with "private" and "download" scopes

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and add your credentials:
   ```env
   VIMEO_CLIENT_ID=your_client_id_here
   VIMEO_CLIENT_SECRET=your_client_secret_here
   VIMEO_ACCESS_TOKEN=your_access_token_here
   DOWNLOAD_PATH=./downloads
   MAX_CONCURRENT_DOWNLOADS=3
   ```

## Usage

### Using Standalone Executable

#### Download all videos
```bash
./vimeo-downloader download
```

#### Download with custom path
```bash
./vimeo-downloader download --path /path/to/downloads
```

#### Dry run (preview what will be downloaded)
```bash
./vimeo-downloader download --dry-run
```

#### Set concurrent downloads
```bash
./vimeo-downloader download --concurrent 5
```

### Using From Source

#### Download all videos
```bash
bun run index.ts download
```

#### Download with custom path
```bash
bun run index.ts download --path /path/to/downloads
```

#### Dry run (preview what will be downloaded)
```bash
bun run index.ts download --dry-run
```

#### Set concurrent downloads
```bash
bun run index.ts download --concurrent 5
```

### Build Commands

```bash
# Build regular JavaScript bundle
bun run build

# Build standalone executable for current platform
bun run build:exe

# Build for specific platforms
bun run build:exe-win      # Windows
bun run build:exe-linux    # Linux
bun run build:exe-mac      # macOS

# Build for all platforms
bun run build:all
```

## Command Options

### `download`
Downloads all videos from your Vimeo account.

**Options:**
- `-p, --path <path>` - Download directory (default: ./downloads)
- `-c, --concurrent <number>` - Max concurrent downloads (default: 3)
- `--dry-run` - Show what would be downloaded without downloading

### `auth`
Shows instructions for setting up Vimeo API authentication.

## File Structure

Downloaded videos will maintain your Vimeo folder structure:

```
downloads/
├── My Project Folder/
│   ├── video1.mp4
│   └── video2.mp4
├── Another Folder/
│   └── video3.mov
└── standalone-video.mp4
```

## Features in Detail

### Original Quality Downloads
The tool prioritizes downloading original source files when available, falling back to the highest quality version if originals aren't accessible.

### Folder Structure Preservation
Your Vimeo folders are recreated locally, maintaining the same organization structure.

### Smart Skipping
Already downloaded files are automatically skipped to avoid re-downloading.

### Concurrent Downloads
Configure multiple simultaneous downloads to speed up the process while respecting Vimeo's rate limits.

## Troubleshooting

### Authentication Issues
- Ensure your access token has "private" and "download" scopes
- Check that your credentials in `.env` are correct
- Verify your Vimeo app is properly configured

### Download Failures
- Check your internet connection
- Verify you have sufficient disk space
- Some videos might not have download permissions enabled

### Rate Limiting
- Reduce concurrent downloads with `--concurrent 1`
- The tool automatically handles most Vimeo API rate limits

## Executable Information

### File Sizes
- **macOS**: ~57 MB (includes Bun runtime)
- **Linux**: ~98 MB (includes Bun runtime)  
- **Windows**: ~TBD MB (includes Bun runtime)

### Benefits of Standalone Executable
- ✅ **No dependencies** - Users don't need Node.js, Bun, or any runtime installed
- ✅ **Single file** - Easy to distribute and deploy
- ✅ **Fast startup** - No module resolution or compilation needed
- ✅ **Cross-platform** - Build once for each target platform

### Distribution
The standalone executables can be distributed directly to users without requiring them to install any development tools. Just provide the appropriate executable for their operating system.

## Development

```bash
# Run in development mode
bun run dev

# Build regular JavaScript bundle
bun run build

# Build standalone executable
bun run build:exe

# Type checking (requires TypeScript)
bunx tsc --noEmit
```

## License

MIT License - see LICENSE file for details.

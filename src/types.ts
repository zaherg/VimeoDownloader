export interface Config {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  downloadPath: string;
  maxConcurrentDownloads: number;
  quality: string;
  dryRun: boolean;
  overwrite: boolean;
}

export interface VimeoVideo {
  uri: string;
  name: string;
  description?: string;
  created_time: string;
  modified_time: string;
  download?: VimeoDownloadLink[];
  files?: VimeoFile[];
  parent_folder?: VimeoFolder;
}

export interface VimeoDownloadLink {
  quality: string;
  type: string;
  width: number;
  height: number;
  expires: string;
  link: string;
  created_time: string;
  fps: number;
  size: number;
  md5: string;
  public_name: string;
  size_short: string;
}

export interface VimeoFile {
  quality: string;
  type: string;
  width: number;
  height: number;
  link: string;
  created_time: string;
  fps: number;
  size: number;
  md5: string;
  public_name: string;
  size_short: string;
}

export interface VimeoFolder {
  uri: string;
  name: string;
  created_time: string;
  modified_time: string;
  parent_folder?: VimeoFolder;
}

export interface VimeoResponse<T> {
  total: number;
  page: number;
  per_page: number;
  paging: {
    next: string | null;
    previous: string | null;
    first: string;
    last: string;
  };
  data: T[];
}

export interface DownloadJob {
  video: VimeoVideo;
  downloadUrl: string;
  filePath: string;
  size: number;
}
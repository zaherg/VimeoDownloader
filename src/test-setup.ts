import '@testing-library/jest-dom';

// Mock environment variables for tests
process.env.VIMEO_CLIENT_ID = 'test_client_id';
process.env.VIMEO_CLIENT_SECRET = 'test_client_secret';
process.env.VIMEO_ACCESS_TOKEN = 'test_access_token';
process.env.DOWNLOAD_PATH = './test-downloads';
process.env.MAX_CONCURRENT_DOWNLOADS = '2';
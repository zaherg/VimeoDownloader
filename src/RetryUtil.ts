export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  retryOnStatus?: number[];
  onRetry?: (attempt: number, error: Error) => void;
  enableJitter?: boolean;
  backoffMultiplier?: number;
}

export interface NetworkError extends Error {
  code?: string;
  status?: number;
  retryAfter?: number;
  errorType?: 'AUTH_ERROR' | 'PERMISSION_ERROR' | 'RATE_LIMIT' | 'SERVER_ERROR' | 'API_ERROR' | 'TIMEOUT' | 'CONNECTION_FAILED' | 'PARSE_ERROR' | 'INVALID_RESPONSE';
  retryable?: boolean;
}

export class RetryUtil {
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = { maxRetries: 3, baseDelay: 1000, maxDelay: 10000 }
  ): Promise<T> {
    const retryOnStatus = options.retryOnStatus || [429, 500, 502, 503, 504];
    let lastError: Error;
    
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on certain error types
        if (this.isNonRetryableError(lastError, retryOnStatus)) {
          throw lastError;
        }
        
        // Call retry callback if provided
        if (options.onRetry) {
          options.onRetry(attempt + 1, lastError);
        }
        
        if (attempt === options.maxRetries) {
          throw lastError;
        }
        
        // Calculate delay with exponential backoff and jitter
        const multiplier = options.backoffMultiplier || 2;
        let delay = options.baseDelay * Math.pow(multiplier, attempt);
        
        // Add jitter to prevent thundering herd
        if (options.enableJitter !== false) {
          const jitter = delay * 0.1 * Math.random(); // 10% jitter
          delay = delay + jitter;
        }
        
        delay = Math.min(delay, options.maxDelay);
        
        // Check if this is a rate limit error with retry-after
        const networkError = lastError as NetworkError;
        if (networkError.status === 429 && networkError.retryAfter) {
          delay = networkError.retryAfter * 1000; // Convert to milliseconds
          console.log(`⏳ Rate limited. Waiting ${networkError.retryAfter}s before retry...`);
        } else {
          console.log(`⏳ Retry attempt ${attempt + 1}/${options.maxRetries} in ${Math.round(delay)}ms...`);
        }
        
        await this.sleep(delay);
      }
    }
    
    throw lastError!;
  }
  
  private static isNonRetryableError(error: Error, retryOnStatus: number[]): boolean {
    const message = error.message.toLowerCase();
    const networkError = error as NetworkError;
    
    // Use the retryable flag if available
    if (networkError.retryable !== undefined) {
      return !networkError.retryable;
    }
    
    // Check error type first
    if (networkError.errorType) {
      switch (networkError.errorType) {
        case 'AUTH_ERROR':
        case 'PERMISSION_ERROR':
          return true;
        case 'RATE_LIMIT':
        case 'SERVER_ERROR':
        case 'TIMEOUT':
        case 'CONNECTION_FAILED':
          return false;
        case 'PARSE_ERROR':
        case 'INVALID_RESPONSE':
          return true; // Usually indicates a permanent issue
        default:
          break;
      }
    }
    
    // Fallback to original logic
    if (message.includes('unauthorized') || message.includes('authentication failed')) {
      return true;
    }
    
    if (message.includes('forbidden') && !retryOnStatus.includes(403)) {
      return true;
    }
    
    if (networkError.status) {
      const status = networkError.status;
      if (status >= 400 && status < 500 && !retryOnStatus.includes(status)) {
        return true;
      }
    }
    
    if (message.includes('400') || message.includes('404')) {
      return true;
    }
    
    return false;
  }
  
  static createNetworkError(
    message: string, 
    status?: number, 
    retryAfter?: number, 
    errorType?: 'AUTH_ERROR' | 'PERMISSION_ERROR' | 'RATE_LIMIT' | 'SERVER_ERROR' | 'API_ERROR' | 'TIMEOUT' | 'CONNECTION_FAILED' | 'PARSE_ERROR' | 'INVALID_RESPONSE'
  ): NetworkError {
    const error = new Error(message) as NetworkError;
    error.status = status;
    error.retryAfter = retryAfter;
    error.errorType = errorType;
    error.retryable = this.isErrorRetryable(errorType, status);
    return error;
  }
  
  private static isErrorRetryable(errorType?: string, status?: number): boolean {
    // Non-retryable error types
    if (errorType === 'AUTH_ERROR' || errorType === 'PERMISSION_ERROR') {
      return false;
    }
    
    // Client errors are generally not retryable (except rate limits)
    if (status && status >= 400 && status < 500 && status !== 429) {
      return false;
    }
    
    // Server errors, timeouts, and connection issues are retryable
    return true;
  }
  
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
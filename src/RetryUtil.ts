export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

export class RetryUtil {
  static async withRetry<T>(
    operation: () => Promise<T>,
    options: RetryOptions = { maxRetries: 3, baseDelay: 1000, maxDelay: 10000 }
  ): Promise<T> {
    let lastError: Error;
    
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Don't retry on certain error types
        if (this.isNonRetryableError(lastError)) {
          throw lastError;
        }
        
        if (attempt === options.maxRetries) {
          throw lastError;
        }
        
        // Calculate delay with exponential backoff and jitter
        const delay = Math.min(
          options.baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
          options.maxDelay
        );
        
        console.log(`⏳ Retry attempt ${attempt + 1}/${options.maxRetries} in ${Math.round(delay)}ms...`);
        await this.sleep(delay);
      }
    }
    
    throw lastError!;
  }
  
  private static isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    
    // Don't retry on authentication errors
    if (message.includes('unauthorized') || message.includes('forbidden')) {
      return true;
    }
    
    // Don't retry on client errors (4xx except 429)
    if (message.includes('400') || message.includes('404')) {
      return true;
    }
    
    return false;
  }
  
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
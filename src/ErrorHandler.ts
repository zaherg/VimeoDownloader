import { NetworkError } from './RetryUtil';

export interface ErrorGuidance {
  userMessage: string;
  technicalDetails: string;
  suggestedActions: string[];
  recoverable: boolean;
  category: 'authentication' | 'network' | 'permission' | 'server' | 'client' | 'system';
}

export class ErrorHandler {
  static classifyError(error: Error): ErrorGuidance {
    const networkError = error as NetworkError;
    
    // Handle different error types with specific guidance
    if (networkError.errorType) {
      switch (networkError.errorType) {
        case 'AUTH_ERROR':
          return {
            userMessage: 'Authentication failed with Vimeo API',
            technicalDetails: error.message,
            suggestedActions: [
              'Check that your access token is valid and not expired',
              'Verify the token has necessary permissions (download, video access)',
              'Generate a new access token from Vimeo Developer settings'
            ],
            recoverable: false,
            category: 'authentication'
          };
          
        case 'PERMISSION_ERROR':
          return {
            userMessage: 'Access denied to video or resource',
            technicalDetails: error.message,
            suggestedActions: [
              'Check if you have permission to download this video',
              'Verify the video download settings in Vimeo',
              'Ensure your access token has download permissions'
            ],
            recoverable: false,
            category: 'permission'
          };
          
        case 'RATE_LIMIT':
          const retryAfter = networkError.retryAfter ? `${networkError.retryAfter} seconds` : 'a while';
          return {
            userMessage: 'Rate limit exceeded',
            technicalDetails: `${error.message} (Retry after: ${retryAfter})`,
            suggestedActions: [
              `Wait ${retryAfter} before retrying`,
              'Reduce concurrent download connections',
              'Consider upgrading your Vimeo plan for higher limits'
            ],
            recoverable: true,
            category: 'server'
          };
          
        case 'CONNECTION_FAILED':
          return {
            userMessage: 'Network connection failed',
            technicalDetails: error.message,
            suggestedActions: [
              'Check your internet connection',
              'Verify DNS settings and firewall configuration',
              'Try again in a few minutes - the issue may be temporary',
              'Use a VPN if regional blocking is suspected'
            ],
            recoverable: true,
            category: 'network'
          };
          
        case 'TIMEOUT':
          return {
            userMessage: 'Request timed out',
            technicalDetails: error.message,
            suggestedActions: [
              'Check your internet connection speed',
              'Try again - the server may be temporarily slow',
              'Reduce concurrent downloads to avoid timeout issues'
            ],
            recoverable: true,
            category: 'network'
          };
          
        case 'SERVER_ERROR':
          return {
            userMessage: 'Vimeo server error',
            technicalDetails: `${error.message} (Status: ${networkError.status})`,
            suggestedActions: [
              'Wait a few minutes and try again - this is usually temporary',
              'Check Vimeo status page for ongoing issues',
              'Reduce request frequency if the problem persists'
            ],
            recoverable: true,
            category: 'server'
          };
          
        case 'PARSE_ERROR':
        case 'INVALID_RESPONSE':
          return {
            userMessage: 'Invalid response from server',
            technicalDetails: error.message,
            suggestedActions: [
              'Try again - this may be a temporary server issue',
              'Check if there are any Vimeo service disruptions',
              'Verify your access token is still valid'
            ],
            recoverable: true,
            category: 'server'
          };
      }
    }
    
    // Fallback for unknown errors
    return this.classifyGenericError(error);
  }
  
  private static classifyGenericError(error: Error): ErrorGuidance {
    const message = error.message.toLowerCase();
    
    if (message.includes('enotfound') || message.includes('dns')) {
      return {
        userMessage: 'DNS resolution failed',
        technicalDetails: error.message,
        suggestedActions: [
          'Check your internet connection',
          'Try using a different DNS server (8.8.8.8 or 1.1.1.1)',
          'Verify the hostname is correct'
        ],
        recoverable: true,
        category: 'network'
      };
    }
    
    if (message.includes('econnrefused') || message.includes('econnreset')) {
      return {
        userMessage: 'Connection refused by server',
        technicalDetails: error.message,
        suggestedActions: [
          'Check if the service is running',
          'Verify firewall settings',
          'Try again later - the server may be temporarily unavailable'
        ],
        recoverable: true,
        category: 'network'
      };
    }
    
    if (message.includes('enospc') || message.includes('no space')) {
      return {
        userMessage: 'Insufficient disk space',
        technicalDetails: error.message,
        suggestedActions: [
          'Free up disk space on your system',
          'Choose a different download location with more space',
          'Clean up temporary files and downloads'
        ],
        recoverable: false,
        category: 'system'
      };
    }
    
    if (message.includes('eacces') || message.includes('permission denied')) {
      return {
        userMessage: 'File system permission denied',
        technicalDetails: error.message,
        suggestedActions: [
          'Check file/folder permissions for the download directory',
          'Run with appropriate user permissions',
          'Choose a different download location'
        ],
        recoverable: false,
        category: 'system'
      };
    }
    
    // Generic fallback
    return {
      userMessage: 'An unexpected error occurred',
      technicalDetails: error.message,
      suggestedActions: [
        'Try the operation again',
        'Check your network connection and permissions',
        'Contact support if the issue persists'
      ],
      recoverable: true,
      category: 'client'
    };
  }
  
  static formatErrorGuidance(guidance: ErrorGuidance): string {
    const icon = this.getErrorIcon(guidance.category);
    const recoverable = guidance.recoverable ? '🔄 Recoverable' : '⛔ Not recoverable';
    
    let message = `\n${icon} ${guidance.userMessage} (${recoverable})\n`;
    message += `   ${guidance.technicalDetails}\n\n`;
    message += `   💡 Suggested actions:\n`;
    
    guidance.suggestedActions.forEach((action, index) => {
      message += `      ${index + 1}. ${action}\n`;
    });
    
    return message;
  }
  
  private static getErrorIcon(category: string): string {
    switch (category) {
      case 'authentication': return '🔐';
      case 'permission': return '🚫';
      case 'network': return '🌐';
      case 'server': return '🖥️';
      case 'system': return '💾';
      default: return '❌';
    }
  }
  
  static shouldRetry(guidance: ErrorGuidance): boolean {
    return guidance.recoverable && 
           (guidance.category === 'network' || 
            guidance.category === 'server' ||
            guidance.category === 'client');
  }
}
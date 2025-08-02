export class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve();
      } else {
        this.waiting.push(() => {
          this.permits--;
          resolve();
        });
      }
    });
  }

  release(): void {
    this.permits++;
    if (this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      next();
    }
  }
}
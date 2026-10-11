export class BoundedTurnGate {
  private active = 0;
  private peakActive = 0;
  private readonly waiters: Array<{
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: unknown) => void;
    readonly signal?: AbortSignal;
    abortListener?: () => void;
  }> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4) {
      throw new RangeError("turn concurrency limit must be an integer from 1 to 4");
    }
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.waiters.length; }
  get peakActiveCount(): number { return this.peakActive; }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return Promise.resolve(this.makeRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        waiter.abortListener = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abortListener!);
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.abortListener?.();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (!next) {
        this.active -= 1;
        return;
      }
      if (next.signal && next.abortListener) next.signal.removeEventListener("abort", next.abortListener);
      next.resolve(this.makeRelease());
    };
  }
}

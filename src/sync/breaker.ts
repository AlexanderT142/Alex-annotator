/** Circuit breaker: a failing PDF stops syncing; repeated failures stop the add-on. */
export class SyncBreaker {
  private failedDocs = new Set<string>();
  private failures = 0;
  private tripped = false;

  constructor(private limit = 3) {}

  fail(docHash: string): "doc" | "all" {
    this.failedDocs.add(docHash);
    this.failures++;
    if (this.failures >= this.limit) this.tripped = true;
    return this.tripped ? "all" : "doc";
  }

  isBlocked(docHash: string): boolean {
    return this.tripped || this.failedDocs.has(docHash);
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  /** The user asked to resume this PDF: forgive its failure and reset the counter. */
  clear(docHash: string): void {
    this.failedDocs.delete(docHash);
    this.failures = 0;
    this.tripped = false;
  }
}

export interface GovernorOptions {
  /** Cycles slower than this (main-thread ms) back off. */
  slowMs: number;
  /** First extra delay after a slow cycle; doubles each time. */
  firstBackoffMs: number;
  maxBackoffMs: number;
  /** More sync-originated shard writes than this within the window means a loop. */
  loopLimit: number;
  loopWindowMs: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = {
  slowMs: 300,
  firstBackoffMs: 2000,
  maxBackoffMs: 60000,
  loopLimit: 10,
  loopWindowMs: 10 * 60 * 1000,
};

/**
 * Stops sync from hurting the app without throwing: slow cycles back off
 * and eventually pause; shard writes with no user or AI change behind them
 * (a write loop) pause after a limit. Only sync-originated writes count, so
 * normal editing and AI batches never trip it.
 */
export class SyncGovernor {
  extraDelayMs = 0;
  private loopWrites: number[] = [];

  constructor(private o: GovernorOptions = DEFAULT_GOVERNOR) {}

  record(cycle: { workMs: number; wroteShard: boolean; externalChange: boolean; now: number }): "ok" | "pause-slow" | "pause-loop" {
    if (cycle.wroteShard && !cycle.externalChange) {
      this.loopWrites = this.loopWrites.filter((t) => cycle.now - t < this.o.loopWindowMs);
      this.loopWrites.push(cycle.now);
      if (this.loopWrites.length > this.o.loopLimit) return "pause-loop";
    }
    if (cycle.workMs > this.o.slowMs) {
      if (this.extraDelayMs >= this.o.maxBackoffMs) return "pause-slow";
      this.extraDelayMs = this.extraDelayMs ? Math.min(this.extraDelayMs * 2, this.o.maxBackoffMs) : this.o.firstBackoffMs;
    } else if (this.extraDelayMs) {
      this.extraDelayMs = this.extraDelayMs / 2 < this.o.firstBackoffMs ? 0 : this.extraDelayMs / 2;
    }
    return "ok";
  }

  reset(): void {
    this.extraDelayMs = 0;
    this.loopWrites = [];
  }
}

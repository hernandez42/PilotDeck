/**
 * MemoryCircuitBreaker — circuit breaker for APEX-MEM / memory heartbeat services.
 *
 * After `failureThreshold` failures within `windowMs`, the breaker opens.
 * In "open" state, memory operations degrade gracefully instead of hammering a dead service.
 *
 * Health check performs read-only verification:
 *   - SQLite integrity_check
 *   - memories count vs FTS count alignment
 *   - BM25 max_doc vs actual doc count
 */

export type MemoryHealthStatus = 'ok' | 'degraded' | 'down';

export interface MemoryHealthCheckOptions {
  /** Number of consecutive failures before the breaker opens. Default: 3. */
  failureThreshold?: number;
  /** Time window in ms to count failures. Default: 30_000 (30 seconds). */
  windowMs?: number;
  /** Cooldown period after breaker opens. Default: 300_000 (5 minutes). */
  cooldownMs?: number;
}

interface CircuitState {
  failures: number[];
  firstFailureAt: number | null;
  lastFailureAt: number | null;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_WINDOW_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 300_000;

export class MemoryCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private openedAt: number | null = null;
  private failures: number[] = []; // timestamps of failures within window
  private lastCheckAt: number | null = null;
  private lastHealthStatus: MemoryHealthStatus = 'ok';

  constructor(options: MemoryHealthCheckOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** Current circuit state. */
  get circuitState(): 'closed' | 'open' | 'half-open' {
    if (this.state === 'open') {
      const elapsed = Date.now() - (this.openedAt ?? 0);
      if (elapsed >= this.cooldownMs) {
        this.state = 'half-open';
      }
    }
    return this.state;
  }

  /** Last recorded health status. */
  get healthStatus(): MemoryHealthStatus {
    return this.lastHealthStatus;
  }

  /** Record a failed memory operation (network error, 503, etc.). */
  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    // Prune failures outside the window
    const cutoff = now - this.windowMs;
    this.failures = this.failures.filter((ts) => ts > cutoff);

    if (this.failures.length >= this.failureThreshold && this.state === 'closed') {
      this.state = 'open';
      this.openedAt = now;
      console.warn(
        `[memory-circuit-breaker] Circuit OPEN. Failures=${this.failures.length} within ${this.windowMs}ms. ` +
          `Will retry after ${this.cooldownMs / 1000}s.`,
      );
    }
  }

  /** Record a successful memory operation — resets the breaker to closed. */
  recordSuccess(): void {
    if (this.state !== 'half-open') return;
    this.state = 'closed';
    this.failures = [];
    this.openedAt = null;
    console.info('[memory-circuit-breaker] Circuit CLOSED (half-open probe succeeded)');
  }

  /**
   * Returns true if memory operations should be rejected/degraded.
   * When open, callers should return cached/degraded results instead of hitting the service.
   */
  isOpen(): boolean {
    return this.circuitState === 'open';
  }

  /**
   * Returns true if the next probe should be allowed through (half-open state).
   * Callers use this to decide whether to attempt a health check ping.
   */
  isHalfOpen(): boolean {
    return this.circuitState === 'half-open';
  }

  /** Last health check timestamp. */
  get lastCheckAt(): number | null {
    return this.lastCheckAt;
  }

  /**
   * Perform a read-only health check.
   * Implementors can call this from their health-check endpoint.
   *
   * Returns 'ok' if all checks pass, 'degraded' if only some pass, 'down' if all fail.
   */
  async runHealthCheck(ctx: {
    sqliteIntegrity?: () => Promise<boolean>;
    memoriesCount?: () => Promise<number>;
    ftsCount?: () => Promise<number>;
    bm25MaxDoc?: () => Promise<number>;
  }): Promise<MemoryHealthStatus> {
    this.lastCheckAt = Date.now();
    const results: boolean[] = [];

    try {
      if (ctx.sqliteIntegrity) results.push(await ctx.sqliteIntegrity());
    } catch { results.push(false); }

    try {
      if (ctx.memoriesCount && ctx.ftsCount) {
        const [mc, fc] = await Promise.all([ctx.memoriesCount(), ctx.ftsCount()]);
        results.push(mc === fc); // counts must align
      }
    } catch { results.push(false); }

    try {
      if (ctx.bm25MaxDoc && ctx.memoriesCount) {
        const [bm, mc] = await Promise.all([ctx.bm25MaxDoc(), ctx.memoriesCount()]);
        results.push(bm === mc); // BM25 index must match memories count
      }
    } catch { results.push(false); }

    const passCount = results.filter(Boolean).length;
    const totalCount = results.length;

    if (passCount === totalCount) {
      this.lastHealthStatus = 'ok';
      this.recordSuccess();
    } else if (passCount > 0) {
      this.lastHealthStatus = 'degraded';
      // Don't record as success in degraded state
    } else {
      this.lastHealthStatus = 'down';
      this.recordFailure();
    }

    console.debug(
      `[memory-circuit-breaker] Health check: ${passCount}/${totalCount} checks passed, status=${this.lastHealthStatus}`,
    );
    return this.lastHealthStatus;
  }
}
/**
 * ToolLoopCircuitBreaker — prevents the tool loop from spinning on consecutively
 * broken (toolName + validationError) pairs.
 *
 * After `threshold` consecutive failures of the same (toolName + validationError)
 * pattern, the breaker opens and the call is rejected with CircuitOpenError
 * until the backoff window expires.
 *
 * Backoff: 60s → 120s → 240s → 480s (capped), resets on successful call.
 */

export interface ToolCallCircuitBreakerOptions {
  threshold?: number;
  initialBackoffMs?: number;
  maxBackoffMultiplier?: number;
}

interface CircuitState {
  consecutiveFailures: number;
  firstFailureAt: number | null;
  currentBackoffMs: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_INITIAL_BACKOFF_MS = 60_000;
const DEFAULT_MAX_BACKOFF_MULTIPLIER = 8;

export class ToolCallCircuitBreaker {
  private readonly threshold: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMultiplier: number;
  private readonly circuits = new Map<string, CircuitState>();

  constructor(options: ToolCallCircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMultiplier = options.maxBackoffMultiplier ?? DEFAULT_MAX_BACKOFF_MULTIPLIER;
  }

  private key(toolName: string, validationError: string): string {
    return `${toolName}\x00${validationError}`;
  }

  private getOrCreate(key: string): CircuitState {
    if (!this.circuits.has(key)) {
      this.circuits.set(key, {
        consecutiveFailures: 0,
        firstFailureAt: null,
        currentBackoffMs: this.initialBackoffMs,
      });
    }
    return this.circuits.get(key)!;
  }

  private isOpen(state: CircuitState): boolean {
    if (state.consecutiveFailures < this.threshold) return false;
    if (state.firstFailureAt === null) return false;
    return Date.now() - state.firstFailureAt < state.currentBackoffMs;
  }

  recordFailure(toolName: string, validationError: string): void {
    const state = this.getOrCreate(this.key(toolName, validationError));
    state.consecutiveFailures++;
    if (state.firstFailureAt === null) state.firstFailureAt = Date.now();
    if (state.consecutiveFailures === this.threshold) {
      state.currentBackoffMs = Math.min(
        state.currentBackoffMs * 2,
        this.initialBackoffMs * this.maxBackoffMultiplier,
      );
      console.warn(
        `[circuit-breaker] Tool circuit OPEN for "${toolName}" (error=${JSON.stringify(validationError)}). ` +
          `Backoff=${state.currentBackoffMs / 1000}s.`,
      );
    }
  }

  isOpen(toolName: string, validationError: string): boolean {
    return this.isOpen(this.getOrCreate(this.key(toolName, validationError)));
  }

  reset(toolName: string, validationError: string): void {
    const state = this.circuits.get(this.key(toolName, validationError));
    if (state) {
      state.consecutiveFailures = 0;
      state.firstFailureAt = null;
      state.currentBackoffMs = this.initialBackoffMs;
    }
  }

  resetAll(): void {
    this.circuits.clear();
  }

  get openCircuits(): number {
    let count = 0;
    for (const s of this.circuits.values()) {
      if (this.isOpen(s)) count++;
    }
    return count;
  }
}

export class CircuitOpenError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly validationError: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Tool circuit breaker is open for "${toolName}" (validationError=${JSON.stringify(validationError)}). ` +
        `Retry allowed after ${retryAfterMs / 1000}s.`,
    );
    this.name = 'CircuitOpenError';
  }
}
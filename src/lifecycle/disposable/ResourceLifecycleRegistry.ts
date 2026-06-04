import { AsyncSeriesWaterfallHook } from 'tapable';

export interface Disposable {
  dispose(): Promise<void>;
  disposed: boolean;
}

export interface RegisteredResource {
  id: string;
  /** Higher priority = disposed first (browser contexts before browsers, etc.) */
  priority: number;
  resource: Disposable;
  registeredAt: number;
}

export class ResourceLifecycleRegistry {
  private readonly resources = new Map<string, RegisteredResource>();
  private disposing = false;
  private disposedAt?: number;

  /** True once disposeAll() has been called (even if some resources failed to dispose) */
  get disposed(): boolean {
    return this.disposing || this.disposedAt !== undefined;
  }

  /**
   * Register a resource for lifecycle-managed disposal.
   * If a resource with the same id is already registered, the old one is disposed
   * (fire-and-forget) and replaced.
   */
  register(id: string, resource: Disposable, priority = 0): void {
    if (this.disposed) {
      throw new Error(`[lifecycle] Cannot register ${id}: registry is already disposed`);
    }
    const existing = this.resources.get(id);
    if (existing) {
      console.warn(`[lifecycle] Duplicate registration of "${id}", disposing old resource first`);
      existing.resource.dispose().catch(() => {});
    }
    this.resources.set(id, { id, priority, resource, registeredAt: Date.now() });
    console.debug(`[lifecycle] Registered "${id}" (priority=${priority}, total=${this.resources.size})`);
  }

  /** Unregister a resource without disposing it (e.g. ownership transferred elsewhere). */
  unregister(id: string): void {
    this.resources.delete(id);
    console.debug(`[lifecycle] Unregistered "${id}" (remaining=${this.resources.size})`);
  }

  get(id: string): Disposable | undefined {
    return this.resources.get(id)?.resource;
  }

  /** IDs of resources that are registered but not yet disposed — for smoke tests. */
  getOpenHandles(): string[] {
    return [...this.resources.values()]
      .filter((r) => !r.resource.disposed)
      .map((r) => r.id);
  }

  /**
   * Dispose all registered resources in priority order.
   * Each individual dispose() has a 3-second timeout.
   */
  async disposeAll(timeoutMs = 10_000): Promise<'ok' | 'timeout'> {
    if (this.disposed) return 'ok';
    this.disposing = true;

    const sorted = [...this.resources.values()].sort((a, b) => b.priority - a.priority);
    const start = Date.now();

    await Promise.allSettled(
      sorted.map(async (r) => {
        if (r.resource.disposed) return;
        try {
          console.debug(`[lifecycle] Disposing "${r.id}" …`);
          await Promise.race([
            r.resource.dispose(),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000)),
          ]);
        } catch (err) {
          console.error(`[lifecycle] Error disposing "${r.id}":`, err);
        }
      }),
    );

    this.disposedAt = Date.now();
    const elapsed = Date.now() - start;
    console.info(`[lifecycle] disposeAll completed in ${elapsed}ms (handles=${sorted.length})`);
    return elapsed > timeoutMs ? 'timeout' : 'ok';
  }

  /**
   * Dispose all resources and wait up to `timeoutMs` for completion.
   * Logs a warning with the remaining open handles if the timeout is hit.
   */
  async disposeAllAndWait(timeoutMs = 30_000): Promise<'ok' | 'timeout'> {
    const result = await this.disposeAll(timeoutMs);
    if (result === 'timeout') {
      const handles = this.getOpenHandles();
      console.error(`[lifecycle] disposeAllAndWait TIMEOUT — open handles: ${handles.join(', ')}`);
    }
    return result;
  }

  /** Number of currently registered resources. */
  get size(): number {
    return this.resources.size;
  }
}

/** Singleton registry for agent-scoped resources. */
export const agentRegistry = new ResourceLifecycleRegistry();
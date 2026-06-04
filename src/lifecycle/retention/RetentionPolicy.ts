/**
 * RetentionPolicy — cleanup policy for runtime-generated directories.
 *
 * Applies TTL and count-based retention to:
 *   - .pilotdeck-always-on/    (TTL: 7 days, max 50 dirs per project)
 *   - .agi-output/             (TTL: 30 days)
 *   - .cci-output/            (TTL: 30 days)
 *   - TaskOutputStore entries  (TTL: 30 days)
 */

export interface RetentionPolicyOptions {
  /** Max age in ms before a directory is considered for deletion. Default: 7 days. */
  alwaysOnTtlMs?: number;
  /** Max age in ms before output dirs are cleaned. Default: 30 days. */
  outputTtlMs?: number;
  /** Max directories per project for always-on. Default: 50. */
  alwaysOnMaxCount?: number;
}

interface RetentionEntry {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

const DEFAULT_ALWAYS_ON_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_OUTPUT_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const DEFAULT_ALWAYS_ON_MAX_COUNT = 50;

export class RetentionPolicy {
  private readonly alwaysOnTtlMs: number;
  private readonly outputTtlMs: number;
  private readonly alwaysOnMaxCount: number;

  constructor(options: RetentionPolicyOptions = {}) {
    this.alwaysOnTtlMs = options.alwaysOnTtlMs ?? DEFAULT_ALWAYS_ON_TTL_MS;
    this.outputTtlMs = options.outputTtlMs ?? DEFAULT_OUTPUT_TTL_MS;
    this.alwaysOnMaxCount = options.alwaysOnMaxCount ?? DEFAULT_ALWAYS_ON_MAX_COUNT;
  }

  /**
   * Scan `rootDir` for retention-target directories and return those that are candidates
   * for cleanup (expired TTL or over count limit).
   */
  async scanRetentionCandidates(rootDir: string): Promise<RetentionEntry[]> {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');
    const now = Date.now();

    const candidates: RetentionEntry[] = [];

    // .pilotdeck-always-on/
    try {
      const alwaysOnDir = join(rootDir, '.pilotdeck-always-on');
      const stat = await fs.stat(alwaysOnDir);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(alwaysOnDir);
        for (const entry of entries) {
          const entryPath = join(alwaysOnDir, entry);
          try {
            const st = await fs.stat(entryPath);
            candidates.push({
              path: entryPath,
              mtimeMs: st.mtimeMs,
              sizeBytes: 0, // skip size for dirs
            });
          } catch { /* skip */ }
        }
      }
    } catch { /* dir doesn't exist */ }

    // .agi-output/, .cci-output/
    for (const subdir of ['.agi-output', '.cci-output']) {
      try {
        const dir = join(rootDir, subdir);
        const stat = await fs.stat(dir);
        if (stat.isDirectory()) {
          const entries = await fs.readdir(dir);
          for (const entry of entries) {
            const entryPath = join(dir, entry);
            try {
              const st = await fs.stat(entryPath);
              candidates.push({
                path: entryPath,
                mtimeMs: st.mtimeMs,
                sizeBytes: 0,
              });
            } catch { /* skip */ }
          }
        }
      } catch { /* dir doesn't exist */ }
    }

    return candidates;
  }

  /**
   * Given candidates from scanRetentionCandidates(), return the subset that should
   * actually be deleted (TTL expired OR always-on over count limit).
   */
  computeDeletionSet(
    candidates: RetentionEntry[],
    options: { alwaysOnCount?: number } = {},
  ): RetentionEntry[] {
    const now = Date.now();
    const toDelete: RetentionEntry[] = [];

    for (const c of candidates) {
      const isAlwaysOn = c.path.includes('.pilotdeck-always-on');
      const isOutput = c.path.includes('.agi-output') || c.path.includes('.cci-output');
      const age = now - c.mtimeMs;

      if (isAlwaysOn) {
        const overCount = (options.alwaysOnCount ?? this.alwaysOnMaxCount) < candidates.filter(
          (x) => x.path.includes('.pilotdeck-always-on'),
        ).length;
        const expired = age > this.alwaysOnTtlMs;
        if (expired || overCount) toDelete.push(c);
      } else if (isOutput) {
        if (age > this.outputTtlMs) toDelete.push(c);
      }
    }

    return toDelete;
  }

  /**
   * Delete a set of entries returned by computeDeletionSet().
   * Removes directories recursively.
   */
  async applyDeletions(entries: RetentionEntry[]): Promise<{ deleted: number; freedBytes: number }> {
    const { promises: fs } = await import('fs');
    const { join } = await import('path');

    let deleted = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      try {
        // Estimate freed bytes by reading dir size
        let size = 0;
        try {
          const { stdout } = await import('child_process').exec(
            `du -sb "${entry.path}" 2>/dev/null | cut -f1`,
            { timeout: 5000 },
          );
          size = parseInt(stdout.trim(), 10) || 0;
        } catch { /* ignore */ }

        await fs.rm(entry.path, { recursive: true, force: true });
        deleted++;
        freedBytes += size;
        console.debug(`[retention] Deleted: ${entry.path} (~${size} bytes)`);
      } catch (err) {
        console.warn(`[retention] Failed to delete ${entry.path}:`, err);
      }
    }

    return { deleted, freedBytes };
  }

  /** Convenience: run full scan → compute → delete cycle on `rootDir`. */
  async runRetentionCleanup(rootDir: string): Promise<{ deleted: number; freedBytes: number }> {
    const candidates = await this.scanRetentionCandidates(rootDir);
    const toDelete = this.computeDeletionSet(candidates);
    const result = await this.applyDeletions(toDelete);
    console.info(
      `[retention] Cleanup complete on ${rootDir}: deleted=${result.deleted}, freed_bytes=${result.freedBytes}`,
    );
    return result;
  }
}
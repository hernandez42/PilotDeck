import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface AlwaysOnRetentionPolicy {
  retentionDays: number;
  maxRetainedWorkspaces: number;
}

export interface AlwaysOnRetentionOptions {
  /** Root directory containing workspace subdirectories (worktrees/snapshots). */
  workspaceRoot: string;
  policy: AlwaysOnRetentionPolicy;
  /** Active work cycle working directories that should never be deleted. */
  protectedCwds?: Set<string>;
  /** Workspace IDs currently in active/applying/applied cycle. */
  protectedWorkspaceIds?: Set<string>;
  now?: () => Date;
}

interface WorkspaceInfo {
  path: string;
  id: string;
  mtime: Date;
}

/**
 * Best-effort retention cleanup for Always-On isolated workspaces.
 * Does NOT touch `.apex-mem` (database/index — persistent memory data).
 * Protects workspaces that are:
 *   - Currently referenced by an active work cycle (active/applying/applied)
 *   - Among the N most-recent by mtime, up to maxRetainedWorkspaces
 */
export class AlwaysOnRetention {
  private readonly workspaceRoot: string;
  private readonly policy: AlwaysOnRetentionPolicy;
  private readonly protectedCwds: Set<string>;
  private readonly protectedWorkspaceIds: Set<string>;
  private readonly now: () => Date;

  constructor(options: AlwaysOnRetentionOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.policy = options.policy;
    this.protectedCwds = options.protectedCwds ?? new Set();
    this.protectedWorkspaceIds = options.protectedWorkspaceIds ?? new Set();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Run retention cleanup. Best-effort — errors are collected and returned
   * but do not throw. Cleanup failures do NOT block Always-On startup.
   */
  run(): { deleted: string[]; errors: Array<{ path: string; error: string }> } {
    const deleted: string[] = [];
    const errors: Array<{ path: string; error: string }> = [];

    if (!existsSync(this.workspaceRoot)) {
      return { deleted, errors };
    }

    let entries: WorkspaceInfo[];
    try {
      entries = this.listWorkspaceInfos();
    } catch (err) {
      errors.push({ path: this.workspaceRoot, error: String(err) });
      return { deleted, errors };
    }

    // Filter to workspaces eligible for deletion
    const deletable = entries.filter((w) => this.isDeletable(w));
    const toDelete = this.pickWorkspacesToDelete(deletable, entries);

    for (const workspace of toDelete) {
      try {
        rmSync(workspace.path, { recursive: true, force: true });
        deleted.push(workspace.path);
      } catch (err) {
        errors.push({ path: workspace.path, error: String(err) });
      }
    }

    return { deleted, errors };
  }

  private listWorkspaceInfos(): WorkspaceInfo[] {
    const subdirs = ["worktrees", "snapshots"];
    const infos: WorkspaceInfo[] = [];

    for (const subdir of subdirs) {
      const subdirPath = join(this.workspaceRoot, subdir);
      if (!existsSync(subdirPath)) continue;

      let entries: string[];
      try {
        entries = readdirSync(subdirPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        // Skip dotfiles and non-directories
        if (entry.startsWith(".")) continue;
        const fullPath = join(subdirPath, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;

        infos.push({
          path: fullPath,
          id: entry,
          mtime: stat.mtime,
        });
      }
    }

    return infos;
  }

  private isDeletable(workspace: WorkspaceInfo): boolean {
    // Never delete if cwd is protected
    if (this.protectedCwds.has(workspace.path)) return false;
    // Never delete if workspace ID is in active cycle
    if (this.protectedWorkspaceIds.has(workspace.id)) return false;
    return true;
  }

  private pickWorkspacesToDelete(
    deletable: WorkspaceInfo[],
    all: WorkspaceInfo[],
  ): WorkspaceInfo[] {
    const now = this.now();
    const cutoffMs = this.policy.retentionDays * 86_400_000;
    const ageThreshold = new Date(now.getTime() - cutoffMs);

    const old = deletable.filter((w) => w.mtime < ageThreshold);
    if (old.length > 0) return old;

    // No old workspaces — keep the newest up to maxRetainedWorkspaces
    const sorted = [...all].sort(
      (a, b) => b.mtime.getTime() - a.mtime.getTime(),
    );
    const keep = new Set(sorted.slice(0, this.policy.maxRetainedWorkspaces).map((w) => w.id));

    return deletable.filter((w) => !keep.has(w.id));
  }
}
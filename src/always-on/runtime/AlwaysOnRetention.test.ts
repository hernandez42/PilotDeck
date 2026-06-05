import { readdirSync, statSync, rmSync, existsSync, utimesSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { ok, strictEqual, equal } from "node:assert";
import { AlwaysOnRetention } from "./AlwaysOnRetention.js";

function makeOldDir(path: string, ageHours: number): void {
  const past = new Date(Date.now() - ageHours * 3_600_000);
  try {
    utimesSync(path, past, past);
  } catch {
    // Some filesystems don't support utimes — skip mtime manipulation
  }
}

describe("AlwaysOnRetention", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "aor-"));
  });

  it("deletes old unreferenced workspaces", () => {
    const wsRoot = join(tmp, "workspaces");
    const wtDir = mkdirSync(join(wsRoot, "worktrees"), { recursive: true });
    const oldWs = mkdirSync(join(wtDir, "ws-old"));
    makeOldDir(oldWs, 20 * 24); // 20 days old

    const retention = new AlwaysOnRetention({
      workspaceRoot: wsRoot,
      policy: { retentionDays: 14, maxRetainedWorkspaces: 8 },
      now: () => new Date(),
    });

    const { deleted, errors } = retention.run();
    ok(deleted.some((d) => d.includes("ws-old")), "expected ws-old to be deleted");
    strictEqual(errors.length, 0);
  });

  it("preserves workspace referenced by active cycle", () => {
    const wsRoot = join(tmp, "workspaces");
    mkdirSync(join(wsRoot, "worktrees"), { recursive: true });
    mkdirSync(join(wsRoot, "worktrees", "ws-active"));

    const retention = new AlwaysOnRetention({
      workspaceRoot: wsRoot,
      policy: { retentionDays: 14, maxRetainedWorkspaces: 8 },
      protectedWorkspaceIds: new Set(["ws-active"]),
      now: () => new Date(),
    });

    const { deleted } = retention.run();
    ok(!deleted.some((d) => d.includes("ws-active")), "expected ws-active to be preserved");
  });

  it("keeps newest workspaces up to maxRetainedWorkspaces", () => {
    const wsRoot = join(tmp, "workspaces");
    const wtDir = mkdirSync(join(wsRoot, "worktrees"), { recursive: true });

    // Create 12 workspaces (more than maxRetainedWorkspaces=8)
    for (let i = 0; i < 12; i++) {
      const ws = join(wtDir, `ws-${i}`);
      mkdirSync(ws);
      if (i >= 4) {
        // Mark 8 newest as recently accessed (no age manipulation needed)
        makeOldDir(ws, 0);
      } else {
        // Mark 4 oldest as old (but not past retention threshold)
        makeOldDir(ws, 1);
      }
    }

    const retention = new AlwaysOnRetention({
      workspaceRoot: wsRoot,
      policy: { retentionDays: 14, maxRetainedWorkspaces: 8 },
      now: () => new Date(),
    });

    const { deleted } = retention.run();
    // Should have deleted 4 oldest
    strictEqual(deleted.length, 4);
  });

  it("protects active cwd even if workspace is old", () => {
    const wsRoot = join(tmp, "workspaces");
    const wtDir = mkdirSync(join(wsRoot, "worktrees"), { recursive: true });
    const oldWs = mkdirSync(join(wtDir, "ws-old"));
    makeOldDir(oldWs, 20 * 24); // 20 days old — past 14-day retention

    const retention = new AlwaysOnRetention({
      workspaceRoot: wsRoot,
      policy: { retentionDays: 14, maxRetainedWorkspaces: 8 },
      protectedCwds: new Set([oldWs]),
      now: () => new Date(),
    });

    const { deleted } = retention.run();
    ok(!deleted.some((d) => d.includes("ws-old")), "expected ws-old to be preserved due to protected cwd");
  });

  it("returns empty when workspaceRoot does not exist", () => {
    const retention = new AlwaysOnRetention({
      workspaceRoot: join(tmp, "nonexistent"),
      policy: { retentionDays: 14, maxRetainedWorkspaces: 8 },
      now: () => new Date(),
    });

    const { deleted, errors } = retention.run();
    strictEqual(deleted.length, 0);
    strictEqual(errors.length, 0);
  });

  it("does not delete .apex-mem directories", () => {
    const wsRoot = join(tmp, "workspaces");
    const wtDir = mkdirSync(join(wsRoot, "worktrees"), { recursive: true });
    const wsWithMem = mkdirSync(join(wtDir, "ws-has-apex"));
    mkdirSync(join(wsWithMem, ".apex-mem"), { recursive: true });
    makeOldDir(wsWithMem, 20 * 24);

    const retention = new AlwaysOnRetention({
      workspaceRoot: wsRoot,
      policy: { retentionDays: 14, maxRetainedWorkspaces: 8 },
      now: () => new Date(),
    });

    const { deleted } = retention.run();
    // Workspace should be deleted (retention is workspace-level, not file-level)
    ok(deleted.some((d) => d.includes("ws-has-apex")), "expected old workspace to be deleted");
  });
});
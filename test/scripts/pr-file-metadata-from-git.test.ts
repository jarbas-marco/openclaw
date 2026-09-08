import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const helper = resolve("scripts/lib/pr-file-metadata-from-git.mjs");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createDiffFixture(): { base: string; head: string; repo: string } {
  const repo = mkdtempSync(join(tmpdir(), "openclaw-pr-file-metadata-"));
  tempDirs.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "OpenClaw Test");
  git(repo, "config", "user.email", "openclaw-test@example.invalid");
  writeFileSync(join(repo, "delete.txt"), "delete me\n");
  writeFileSync(join(repo, "modify.txt"), "before\n");
  writeFileSync(join(repo, "rename-source.txt"), "renamed without content changes\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 2]));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");

  rmSync(join(repo, "delete.txt"));
  writeFileSync(join(repo, "modify.txt"), "after\n");
  renameSync(join(repo, "rename-source.txt"), join(repo, "rename-target.txt"));
  writeFileSync(join(repo, "added.txt"), "added\n");
  writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 3]));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "head");
  return { base, head: git(repo, "rev-parse", "HEAD"), repo };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PR file metadata from Git", () => {
  it("preserves statuses and stats while matching the expected rename count", () => {
    const fixture = createDiffFixture();
    const result = spawnSync("node", [helper, fixture.base, fixture.head, "5"], {
      cwd: fixture.repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const files = JSON.parse(result.stdout) as Array<{
      path: string;
      additions: number;
      deletions: number;
      changeType: string;
    }>;
    expect(files).toEqual(
      expect.arrayContaining([
        { path: "added.txt", additions: 1, deletions: 0, changeType: "ADDED" },
        { path: "delete.txt", additions: 0, deletions: 1, changeType: "DELETED" },
        { path: "modify.txt", additions: 1, deletions: 1, changeType: "MODIFIED" },
        { path: "rename-target.txt", additions: 0, deletions: 0, changeType: "RENAMED" },
        { path: "binary.bin", additions: 0, deletions: 0, changeType: "MODIFIED" },
      ]),
    );
  });

  it("fails closed when no rename threshold matches the expected file count", () => {
    const fixture = createDiffFixture();
    const result = spawnSync("node", [helper, fixture.base, fixture.head, "4"], {
      cwd: fixture.repo,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected 4");
    expect(result.stdout).toBe("");
  });

  it("uses a fractional rename threshold when whole percentages miss the expected count", () => {
    const binDir = mkdtempSync(join(tmpdir(), "openclaw-pr-file-metadata-fake-git-"));
    tempDirs.push(binDir);
    const fakeGit = join(binDir, "git");
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const renameArg = args.find((arg) => arg.startsWith("--find-renames="));
const threshold = renameArg ? Number(renameArg.slice("--find-renames=".length, -1)) : 100;
const count = threshold < 87.4 ? 18359 : threshold === 87.4 ? 18360 : 18362;
const nameStatus = args.includes("--name-status");
const chunks = [];
for (let index = 0; index < count; index += 1) {
  const path = \`file-\${String(index).padStart(5, "0")}\`;
  chunks.push(nameStatus ? \`M\\0\${path}\\0\` : \`0\\t0\\t\${path}\\0\`);
}
process.stdout.write(chunks.join(""));
`,
    );
    chmodSync(fakeGit, 0o755);

    const result = spawnSync("node", [helper, "base", "head", "18360"], {
      cwd: binDir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toHaveLength(18360);
  });

  it("overrides a restrictive rename limit for modified rename candidates", () => {
    const repo = mkdtempSync(join(tmpdir(), "openclaw-pr-file-metadata-renames-"));
    tempDirs.push(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "OpenClaw Test");
    git(repo, "config", "user.email", "openclaw-test@example.invalid");
    git(repo, "config", "diff.renameLimit", "1");
    for (const name of ["alpha", "beta"]) {
      writeFileSync(join(repo, `${name}-source.txt`), `${name}\n`.repeat(200));
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");

    for (const name of ["alpha", "beta"]) {
      renameSync(join(repo, `${name}-source.txt`), join(repo, `${name}-target.txt`));
      writeFileSync(join(repo, `${name}-target.txt`), `${name}\n`.repeat(200) + "changed\n");
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "head");
    const head = git(repo, "rev-parse", "HEAD");

    const result = spawnSync("node", [helper, base, head, "2"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const files = JSON.parse(result.stdout) as Array<{ path: string; changeType: string }>;
    expect(files).toEqual(
      expect.arrayContaining([
        { path: "alpha-target.txt", additions: 1, deletions: 0, changeType: "RENAMED" },
        { path: "beta-target.txt", additions: 1, deletions: 0, changeType: "RENAMED" },
      ]),
    );
  });
});

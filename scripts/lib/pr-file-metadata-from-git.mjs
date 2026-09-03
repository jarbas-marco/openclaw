#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const [base, head, expectedCountText] = process.argv.slice(2);
const expectedCount =
  expectedCountText === undefined || !/^\d+$/u.test(expectedCountText)
    ? undefined
    : Number(expectedCountText);
const GIT_DIFF_TIMEOUT_MS = 60_000;
const GIT_DIFF_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const GIT_RENAME_CANDIDATE_LIMIT = 5_000;
const deadline = Date.now() + GIT_DIFF_TIMEOUT_MS;

if (
  !base ||
  !head ||
  base.startsWith("-") ||
  head.startsWith("-") ||
  (expectedCountText !== undefined && expectedCount === undefined)
) {
  console.error("usage: pr-file-metadata-from-git.mjs <base> <head> [expected-file-count]");
  process.exit(2);
}

function runGit(args) {
  const timeout = deadline - Date.now();
  if (timeout <= 0) {
    throw new Error(`git diff metadata exceeded its ${String(GIT_DIFF_TIMEOUT_MS)}ms budget`);
  }
  const result = spawnSync("git", args, {
    encoding: "buffer",
    maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
    timeout,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(stderr || `git ${args.join(" ")} exited with status ${String(result.status)}`);
  }
  return result.stdout;
}

function splitNul(buffer) {
  if (buffer.length === 0) {
    return [];
  }
  const parts = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) {
      continue;
    }
    parts.push(buffer.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start !== buffer.length) {
    throw new Error("git diff emitted an unterminated path record");
  }
  return parts;
}

function changeType(status) {
  switch (status[0]) {
    case "A":
      return "ADDED";
    case "D":
      return "DELETED";
    case "M":
      return "MODIFIED";
    case "R":
      return "RENAMED";
    case "C":
      return "COPIED";
    case "T":
    case "U":
    case "B":
      return "CHANGED";
    default:
      throw new Error(`unsupported git diff status: ${status}`);
  }
}

function parseNameStatus(buffer) {
  const parts = splitNul(buffer);
  const files = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) {
      throw new Error("git diff emitted an empty status");
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const originalPath = parts[index++];
      const path = parts[index++];
      if (originalPath === undefined || path === undefined) {
        throw new Error(`git diff emitted an incomplete ${status} record`);
      }
      files.push({ path, changeType: changeType(status) });
      continue;
    }
    const path = parts[index++];
    if (path === undefined) {
      throw new Error(`git diff emitted an incomplete ${status} record`);
    }
    files.push({ path, changeType: changeType(status) });
  }
  return files;
}

function parseCount(value, path) {
  if (value === "-") {
    return 0;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`invalid numstat value for ${JSON.stringify(path)}: ${value}`);
  }
  return Number(value);
}

function parseNumstat(buffer) {
  const parts = splitNul(buffer);
  const stats = new Map();
  for (let index = 0; index < parts.length;) {
    const record = parts[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      throw new Error(`git diff emitted an invalid numstat record: ${JSON.stringify(record)}`);
    }
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      const originalPath = parts[index++];
      path = parts[index++];
      if (originalPath === undefined || path === undefined) {
        throw new Error("git diff emitted an incomplete renamed numstat record");
      }
    }
    if (stats.has(path)) {
      throw new Error(`git diff emitted duplicate numstat metadata for ${JSON.stringify(path)}`);
    }
    stats.set(path, {
      additions: parseCount(additionsText, path),
      deletions: parseCount(deletionsText, path),
    });
  }
  return stats;
}

try {
  const renameLimitArg = `-l${String(GIT_RENAME_CANDIDATE_LIMIT)}`;
  let renameArg = "--find-renames";
  let statuses;
  if (expectedCount === undefined) {
    statuses = parseNameStatus(
      runGit(["diff", renameLimitArg, renameArg, "-z", "--name-status", base, head, "--"]),
    );
  } else {
    renameArg = "--no-renames";
    statuses = parseNameStatus(
      runGit(["diff", renameLimitArg, renameArg, "-z", "--name-status", base, head, "--"]),
    );
    let minimumThreshold = 1;
    let maximumThreshold = 100;
    while (statuses.length !== expectedCount && minimumThreshold <= maximumThreshold) {
      const threshold = Math.floor((minimumThreshold + maximumThreshold) / 2);
      renameArg = `--find-renames=${String(threshold)}%`;
      statuses = parseNameStatus(
        runGit(["diff", renameLimitArg, renameArg, "-z", "--name-status", base, head, "--"]),
      );
      if (statuses.length < expectedCount) {
        minimumThreshold = threshold + 1;
      } else {
        maximumThreshold = threshold - 1;
      }
    }
    if (statuses.length !== expectedCount) {
      throw new Error(
        `pinned Git diff produced ${String(statuses.length)} files; expected ${String(expectedCount)}`,
      );
    }
  }
  const diffArgs = ["diff", renameLimitArg, renameArg, "-z"];
  const stats = parseNumstat(runGit([...diffArgs, "--numstat", base, head, "--"]));
  const files = statuses.map((file) => {
    const fileStats = stats.get(file.path);
    if (!fileStats) {
      throw new Error(`missing numstat metadata for ${JSON.stringify(file.path)}`);
    }
    stats.delete(file.path);
    return {
      path: file.path,
      changeType: file.changeType,
      additions: fileStats.additions,
      deletions: fileStats.deletions,
    };
  });
  if (stats.size > 0) {
    throw new Error("numstat metadata included paths absent from name-status output");
  }
  process.stdout.write(`${JSON.stringify(files)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const owner = join(process.cwd(), ".github/actions/git-owner/owner.py");
const policy = join(process.cwd(), ".github/actions/git-owner/protocol-release-base.py");
const roots: string[] = [];
const fixtureEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "0",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: fixtureEnv });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function fixture(
  options: {
    tag?: "missing" | "lightweight" | "mismatch" | "unrelated";
    version?: string;
    shallow?: boolean;
    syntheticMerge?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "protocol-release-base-"));
  roots.push(root);
  const source = join(root, "source");
  const target = join(root, "target");
  git(root, "init", "--initial-branch=main", source);
  const commit = (version: string, label: string) => {
    writeFileSync(join(source, "package.json"), JSON.stringify({ version }));
    git(source, "add", "package.json");
    git(source, "commit", "--allow-empty", "-m", label);
    return git(source, "rev-parse", "HEAD");
  };
  const base = commit("2026.8.2", "fork base");
  if (options.tag === "unrelated") {
    git(source, "checkout", "--orphan", "upstream");
  }
  const release = commit(options.tag === "mismatch" ? "2026.9.2" : "2026.9.3", "official release");
  if (options.tag !== "missing") {
    git(
      source,
      "tag",
      ...(options.tag === "lightweight" ? [] : ["-a", "-m", "release"]),
      "v2026.9.3",
    );
  }
  if (options.tag === "unrelated") {
    git(source, "checkout", "main");
  }
  const head = commit(options.version ?? "2026.9.3", "fork integration");
  const selected = options.syntheticMerge
    ? git(source, "commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "PR merge")
    : head;
  git(source, "checkout", "--detach", selected);
  git(root, "clone", ...(options.shallow ? ["--depth=1"] : []), pathToFileURL(source).href, target);
  // Match CI's separately fetched, immutable ratchet base in its shallow checkout.
  git(target, "fetch", "--no-tags", "origin", `${base}:refs/remotes/origin/ci-ratchet-base`);
  // Exact rewrites keep the production URLs fixed and all proof offline.
  for (const repository of ["openclaw/openclaw", "fixture/openclaw"]) {
    git(
      target,
      "config",
      "--add",
      `url.${pathToFileURL(source).href}.insteadOf`,
      `https://github.com/${repository}.git`,
    );
  }
  const event = {
    repository: { full_name: "fixture/openclaw" },
    pull_request: {
      head: { repo: { full_name: "fixture/openclaw" }, ref: "release/2026.9.3", sha: head },
      base: { repo: { full_name: "fixture/openclaw" } },
    },
  };
  const run = (env: Record<string, string> = {}) => {
    const outputPath = join(root, "output");
    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const result = spawnSync("python3", ["-I", "-S", owner, "--policy", policy], {
      cwd: target,
      encoding: "utf8",
      env: {
        ...fixtureEnv,
        GITHUB_REPOSITORY: "fixture/openclaw",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_SHA: head,
        GITHUB_REF: "refs/heads/release/2026.9.3",
        PROTOCOL_TARGET_SHA: selected,
        PROTOCOL_SINCE_BASE_SHA: base,
        ...env,
      },
    });
    return { ...result, output: existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "" };
  };
  return { base, release, head, target, source, event, run };
}

it.each([false, true])(
  "selects the official annotated release ancestor (shallow=%s)",
  (shallow) => {
    const f = fixture({ shallow });
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(`sha=${f.release}\n`);
    expect(git(f.target, "rev-parse", "refs/remotes/origin/ci-ratchet-base")).toBe(f.base);
  },
);

it("proves the PR head and official release in a depth-one synthetic merge checkout", () => {
  const f = fixture({ shallow: true, syntheticMerge: true });
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toBe(`sha=${f.release}\n`);
});

it("retains the original baseline when the official release tag is absent", () => {
  const f = fixture({ tag: "missing" });
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toBe(`sha=${f.base}\n`);
});

it.each([
  ["lightweight", "annotated tag"],
  ["mismatch", "package version"],
  ["unrelated", "ancestors"],
] as const)("rejects invalid release provenance: %s", (tag, message) => {
  const result = fixture({ tag }).run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.output).toBe("");
});

it.each([
  ["version", "invalid stable release version"],
  ["target", "full commit SHA"],
  ["base", "selected diff base"],
  ["branch", "release branch"],
] as const)("fails closed for malformed or mismatched %s", (kind, message) => {
  const f = fixture(kind === "version" ? { version: "2026.9.3\n--bad" } : {});
  if (kind === "branch") {
    f.event.pull_request.head.ref = "release/2026.9.4";
  }
  const result = f.run(
    kind === "target"
      ? { PROTOCOL_TARGET_SHA: "abc" }
      : kind === "base"
        ? { PROTOCOL_SINCE_BASE_SHA: f.head }
        : {},
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
  expect(result.output).toBe("");
});

it.each(["ordinary", "external", "upstream", "dispatch-input"])(
  "does not exempt %s context",
  (context) => {
    const f = fixture({ tag: "mismatch" });
    if (context === "ordinary") {
      f.event.pull_request.head.ref = "feature/example";
    }
    if (context === "external") {
      f.event.pull_request.head.repo.full_name = "contributor/openclaw";
    }
    const result = f.run(
      context === "upstream"
        ? { GITHUB_REPOSITORY: "openclaw/openclaw" }
        : context === "dispatch-input"
          ? {
              GITHUB_EVENT_NAME: "workflow_dispatch",
              GITHUB_REF: "refs/heads/main",
              INPUT_TARGET_CONTEXT_REF: "release/2026.9.3",
            }
          : {},
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe(`sha=${f.base}\n`);
  },
);

it.each(["push", "workflow_dispatch"])("accepts a pinned actual release branch for %s", (event) => {
  const f = fixture();
  const result = f.run({ GITHUB_EVENT_NAME: event });
  expect(result.status, result.stderr).toBe(0);
  expect(result.output).toBe(`sha=${f.release}\n`);
});

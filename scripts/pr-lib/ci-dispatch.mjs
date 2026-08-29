#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execGhJson, execGhRead, execPlainGh, workflowRunsApiArgs } from "../lib/plain-gh.mjs";

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;

function isRepositoryNameWithOwner(value) {
  if (typeof value !== "string") {
    return false;
  }
  const components = value.split("/");
  return (
    components.length === 2 &&
    components.every((component) => {
      return (
        REPOSITORY_COMPONENT_PATTERN.test(component) &&
        component !== "." &&
        component !== ".." &&
        !component.startsWith("-")
      );
    })
  );
}

function requirePrRecord({ pr, headRefName, headRefOid, isCrossRepository, repo }) {
  if (!Number.isSafeInteger(pr) || pr <= 0) {
    throw new Error("Expected a positive PR number.");
  }
  if (typeof headRefName !== "string" || headRefName.length === 0 || headRefName.startsWith("-")) {
    throw new Error("Expected a non-empty PR headRefName.");
  }
  if (!SHA_PATTERN.test(headRefOid)) {
    throw new Error("Expected a full PR headRefOid.");
  }
  if (!isRepositoryNameWithOwner(repo)) {
    throw new Error("Expected repo to be an owner/repository slug.");
  }
  if (isCrossRepository === true) {
    throw new Error(
      `PR #${pr} comes from a fork; release-gate workflow dispatch requires a branch in the base repository at ${headRefOid}.`,
    );
  }
}

function buildCiDispatchArgs(record) {
  requirePrRecord(record);
  return [
    "workflow",
    "run",
    "ci.yml",
    "--repo",
    record.repo,
    "--ref",
    record.headRefName,
    "-f",
    `target_ref=${record.headRefOid}`,
    "-f",
    "release_gate=true",
    "-f",
    `pull_request_number=${record.pr}`,
  ];
}

function listCiRuns(repo, headRefOid) {
  return execGhJson(workflowRunsApiArgs(repo, headRefOid, "workflow_dispatch", 20), {
    stdio: ["ignore", "pipe", "pipe"],
  }).workflow_runs;
}

function readCurrentPrHeadOid(repo, pr) {
  return execGhRead(
    ["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function dispatchCiForPr(
  record,
  {
    pollAttempts = 10,
    pollIntervalMs = 1500,
    listRuns = listCiRuns,
    runDispatch = (args) =>
      execPlainGh(args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    readHeadOid = readCurrentPrHeadOid,
    wait = delay,
  } = {},
) {
  requirePrRecord(record);
  const priorRunIds = new Set(listRuns(record.repo, record.headRefOid).map((run) => run.id));
  const headBeforeDispatch = readHeadOid(record.repo, record.pr);
  if (headBeforeDispatch !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed before CI dispatch (expected ${record.headRefOid}, got ${headBeforeDispatch}).`,
    );
  }
  runDispatch(buildCiDispatchArgs(record));

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const run = listRuns(record.repo, record.headRefOid).find(
      (candidate) =>
        candidate.head_sha === record.headRefOid &&
        !priorRunIds.has(candidate.id) &&
        typeof candidate.html_url === "string" &&
        candidate.html_url.length > 0,
    );
    if (run) {
      const headAtObservation = readHeadOid(record.repo, record.pr);
      if (headAtObservation !== record.headRefOid) {
        throw new Error(
          `PR #${record.pr} head changed before an exact-SHA CI run became visible (expected ${record.headRefOid}, got ${headAtObservation}); verify the run before retrying.`,
        );
      }
      return run;
    }
    if (attempt < pollAttempts) {
      await wait(pollIntervalMs);
    }
  }
  const headAfterDispatch = readHeadOid(record.repo, record.pr);
  if (headAfterDispatch !== record.headRefOid) {
    throw new Error(
      `PR #${record.pr} head changed while CI dispatch was being indexed (expected ${record.headRefOid}, got ${headAfterDispatch}); verify the run before retrying.`,
    );
  }
  return undefined;
}

// Dispatch always targets the REMOTE head; unpushed local work silently gets
// no CI. Warn (never block) when a same-named local branch points elsewhere,
// so an operator who meant to test local changes pushes first. Best-effort:
// any git failure (no repo, no branch) skips the check.
function warnOnLocalHeadDrift(record) {
  const probe = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${record.headRefName}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (probe.status !== 0) {
    return;
  }
  const localOid = probe.stdout.trim();
  if (SHA_PATTERN.test(localOid) && localOid !== record.headRefOid) {
    console.error(
      `warning: local branch ${record.headRefName} is at ${localOid}, but CI is being dispatched for the remote head ${record.headRefOid}; push first if you meant to test local changes.`,
    );
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 5 || !["true", "false"].includes(argv[3])) {
    console.error(
      "Usage: ci-dispatch.mjs <PR> <headRefName> <headRefOid> <isCrossRepository> <owner/repository>",
    );
    process.exitCode = 2;
    return;
  }
  const record = {
    pr: Number(argv[0]),
    headRefName: argv[1],
    headRefOid: argv[2],
    isCrossRepository: argv[3] === "true",
    repo: argv[4],
  };
  requirePrRecord(record);
  warnOnLocalHeadDrift(record);
  const run = await dispatchCiForPr(record);
  if (run) {
    console.log(
      `GitHub accepted CI dispatch for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      "Observed a new exact-SHA manual run after dispatch; GitHub does not expose a dispatch correlation ID, so concurrent requests cannot be distinguished.",
    );
    console.log(`observed_run_url=${run.html_url}`);
  } else {
    console.log(
      `Requested CI for PR #${record.pr} at unchanged remote head ${record.headRefOid} (${record.headRefName}).`,
    );
    console.log(
      "run_url=pending (GitHub accepted the dispatch, but Actions has not indexed it yet)",
    );
    console.log(
      `inspect_with=gh api --method GET repos/${record.repo}/actions/workflows/ci.yml/runs -f event=workflow_dispatch -f head_sha=${record.headRefOid} -f per_page=20`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}

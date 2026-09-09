#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { downloadPreparedNpmBundle } from "../npm-prepared-bundle.mjs";

// Full Release deliberately produces npm bytes in a different run from its image candidate.
// Authorize those bytes through the actual producer and complete archive, not a caller's tuple.
export async function verifyCandidateNpmBundle({
  descriptor,
  repository,
  candidateSha,
  workflowSha,
  workflowRef,
  defaultBranch,
  callerWorkflowSha,
  outputDir,
  token,
  runGh,
  fetchImpl,
}) {
  if (
    !/^[0-9a-f]{40}$/u.test(workflowSha ?? "") ||
    candidateSha !== workflowSha ||
    callerWorkflowSha !== workflowSha ||
    workflowRef !== `refs/heads/${defaultBranch}` ||
    typeof descriptor?.producer?.workflowRef !== "string" ||
    !descriptor.producer.workflowRef.endsWith(`@${workflowRef}`)
  ) {
    throw new Error(
      "Privileged npm bundles require the exact trusted source and default-scope producer.",
    );
  }
  // Existing authority checks cover repository, allowed producer workflow, immutable run/attempt,
  // unique successful job, archive metadata/digest, source manifest and every core package sibling.
  return downloadPreparedNpmBundle({
    descriptor,
    repository,
    sourceSha: candidateSha,
    toolingSha: workflowSha,
    outputDir,
    token,
    runGh,
    fetchImpl,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDir = mkdtempSync(join(tmpdir(), "candidate-npm-authority-"));
  try {
    await verifyCandidateNpmBundle({
      descriptor: JSON.parse(process.env.PREPARED_NPM_BUNDLE_JSON ?? "null"),
      repository: process.env.GITHUB_REPOSITORY,
      candidateSha: process.env.CANDIDATE_SHA,
      workflowSha: process.env.WORKFLOW_SHA,
      workflowRef: process.env.WORKFLOW_REF,
      defaultBranch: process.env.DEFAULT_BRANCH,
      callerWorkflowSha: process.env.CALLER_WORKFLOW_SHA,
      outputDir,
      token: process.env.GH_TOKEN,
    });
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

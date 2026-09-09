import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Classify authority from the called workflow identity and the execution cache scope. */
export function classifyCandidateExecution({
  candidateSha,
  workflowSha,
  workflowRef,
  defaultBranch,
  workflowInDefaultHistory,
}) {
  for (const [name, value] of Object.entries({ candidateSha, workflowSha })) {
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
      throw new Error(`${name} must be a full lowercase commit SHA`);
    }
  }
  if (workflowInDefaultHistory !== true) {
    throw new Error("The called workflow commit must belong to the default branch history");
  }
  if (typeof defaultBranch !== "string" || !defaultBranch || /[\s\p{Cc}]/u.test(defaultBranch)) {
    throw new Error("The repository default branch is required");
  }
  if (workflowRef === `refs/heads/${defaultBranch}`) {
    if (candidateSha !== workflowSha) {
      throw new Error(
        "A different candidate cannot execute in the default branch cache scope. " +
          "Run the unchanged trusted workflow commit from a nondefault branch context to validate historical or arbitrary candidates.",
      );
    }
    return { mode: "trusted-candidate", privileged: true, cacheMode: "restore" };
  }
  if (typeof workflowRef !== "string" || !/^refs\/(heads|tags)\/.+/u.test(workflowRef)) {
    throw new Error("Candidate execution requires a branch or tag context");
  }
  // Even an equal SHA cannot promote a branch-scoped cache to privileged use later.
  return { mode: "isolated-candidate", privileged: false, cacheMode: "off" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = classifyCandidateExecution({
    candidateSha: process.env.CANDIDATE_SHA,
    workflowSha: process.env.WORKFLOW_SHA,
    workflowRef: process.env.WORKFLOW_REF,
    defaultBranch: process.env.DEFAULT_BRANCH,
    workflowInDefaultHistory: process.env.WORKFLOW_IN_DEFAULT_HISTORY === "true",
  });
  if (!process.env.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT is required");
  }
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `mode=${result.mode}\nprivileged=${result.privileged}\ncache_mode=${result.cacheMode}\n`,
  );
}

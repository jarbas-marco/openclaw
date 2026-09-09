#!/usr/bin/env bash
set -euo pipefail
artifact_kind="${ARTIFACT_KIND:-package}"

# This is authority for a narrowly identified producer, not trust in a supplied tuple.
[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ && "$ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ &&
  "$ARTIFACT_RUN_ID" == "$GITHUB_RUN_ID" && "$ARTIFACT_RUN_ATTEMPT" == "$GITHUB_RUN_ATTEMPT" &&
  "$PACKAGE_SOURCE_SHA" == "$WORKFLOW_SHA" && "$CALLER_WORKFLOW_SHA" == "$WORKFLOW_SHA" &&
  "$WORKFLOW_REF" == "refs/heads/$DEFAULT_BRANCH" ]] || {
  echo "Privileged artifacts require the current trusted producer run, attempt, and source SHA." >&2
  exit 1
}

case "$CALLER_WORKFLOW_REF" in
  "$GITHUB_REPOSITORY/.github/workflows/openclaw-release-checks.yml@$WORKFLOW_REF")
    producer_path=.github/workflows/openclaw-release-checks.yml
    # These overrides select an external payload even when it advertises our source SHA.
    jq -e '(.inputs // {}) |
      (.candidate_artifact_json // "") == "" and
      (.release_package_spec // "") == "" and
      (.package_acceptance_package_spec // "") == ""' "$GITHUB_EVENT_PATH" >/dev/null
    ;;
  "$GITHUB_REPOSITORY/.github/workflows/package-acceptance.yml@$WORKFLOW_REF")
    producer_path=.github/workflows/package-acceptance.yml
    jq -e '.inputs.source == "ref"' "$GITHUB_EVENT_PATH" >/dev/null
    if [[ "$artifact_kind" != "package" ]]; then
      jq -e '(.inputs.candidate_artifact_json // "") == ""' "$GITHUB_EVENT_PATH" >/dev/null
    fi
    ;;
  "$GITHUB_REPOSITORY/.github/workflows/openclaw-live-and-e2e-checks-reusable.yml@$WORKFLOW_REF")
    [[ "$artifact_kind" == "docker-e2e-image" || "$artifact_kind" == "plugin-registry" ]]
    producer_path=.github/workflows/openclaw-live-and-e2e-checks-reusable.yml
    jq -e '(.inputs // {}) |
      (.shared_image_artifact_id // "") == "" and
      (.docker_e2e_bare_image // "") == "" and
      (.docker_e2e_functional_image // "") == "" and
      (.package_artifact_id // "") == "" and
      (.prepared_npm_bundle_json // "") == "" and
      (.prepublish_plugin_registry_artifact_id // "") == ""' "$GITHUB_EVENT_PATH" >/dev/null
    ;;
  *)
    echo "Artifact producer workflow is not an authorized same-run source builder." >&2
    exit 1
    ;;
esac

case "$artifact_kind:$ARTIFACT_NAME" in
  "package:release-package-under-test-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT")
    [[ "$producer_path" == .github/workflows/openclaw-release-checks.yml ]]
    producer_job='Prepare release package artifact'
    ;;
  "package:package-under-test-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT")
    producer_job='Resolve package candidate'
    ;;
  "plugin-registry:docker-e2e-prepublish-plugin-registry-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT")
    if [[ "$producer_path" == .github/workflows/openclaw-release-checks.yml ]]; then
      producer_job='Prepare release package artifact'
    else
      producer_job='Prepare shared Docker E2E image'
    fi
    ;;
  "plugin-registry:package-acceptance-telegram-plugin-registry-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT")
    [[ "$producer_path" == .github/workflows/package-acceptance.yml ]]
    producer_job='Resolve package candidate'
    ;;
  docker-e2e-image:docker-e2e-shared-images-*)
    [[ "$ARTIFACT_NAME" =~ ^docker-e2e-shared-images-[a-z0-9][a-z0-9-]{0,47}-${WORKFLOW_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}$ ]]
    producer_job='Prepare shared Docker E2E image'
    ;;
  *)
    echo "Artifact name is not owned by an authorized same-run source builder." >&2
    exit 1
    ;;
esac

artifact_json="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$ARTIFACT_ID")"
jq -e --arg id "$ARTIFACT_ID" --arg name "$ARTIFACT_NAME" \
  --arg digest "sha256:$ARTIFACT_DIGEST" --arg run "$GITHUB_RUN_ID" --arg sha "$WORKFLOW_SHA" '
  (.id | tostring) == $id and .name == $name and .expired == false and .digest == $digest and
  (.workflow_run.id | tostring) == $run and .workflow_run.head_sha == $sha
' <<< "$artifact_json" >/dev/null

attempt_json="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT")"
jq -e --arg run "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" \
  --arg sha "$WORKFLOW_SHA" --arg path "$producer_path" --arg branch "$DEFAULT_BRANCH" '
  (.id | tostring) == $run and (.run_attempt | tostring) == $attempt and
  .head_sha == $sha and .path == $path and .head_branch == $branch and
  (.event == "workflow_dispatch" or .event == "schedule")
' <<< "$attempt_json" >/dev/null

jobs_json="$(gh api --paginate "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID/attempts/$GITHUB_RUN_ATTEMPT/jobs?per_page=100")"
jq -se --arg name "$producer_job" --arg sha "$WORKFLOW_SHA" '
  any(.[].jobs[];
    (.name == $name or (.name | endswith(" / " + $name))) and
    .head_sha == $sha and .status == "completed" and .conclusion == "success")
' <<< "$jobs_json" >/dev/null || {
  echo "The authorized same-run artifact producer has not completed successfully." >&2
  exit 1
}

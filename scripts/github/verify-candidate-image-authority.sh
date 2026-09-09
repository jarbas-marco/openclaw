#!/usr/bin/env bash
set -euo pipefail

# No image code may share default-branch privileges merely because its package is trusted.
if [[ "$WORKFLOW_REF" != "refs/heads/$DEFAULT_BRANCH" || "${IMAGE_EXECUTION_SELECTED:-false}" != "true" ]]; then
  exit 0
fi
if [[ -n "${PREPARED_NPM_BUNDLE_JSON:-}" ]]; then
  node "$(dirname "${BASH_SOURCE[0]}")/verify-candidate-npm-bundle.mjs"
fi
if [[ -n "${REGISTRY_ARTIFACT_ID:-}${REGISTRY_ARTIFACT_NAME:-}${REGISTRY_ARTIFACT_DIGEST:-}${REGISTRY_ARTIFACT_RUN_ID:-}${REGISTRY_ARTIFACT_RUN_ATTEMPT:-}${REGISTRY_MANIFEST_SHA256:-}" ]]; then
  [[ "${REGISTRY_MANIFEST_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Plugin registry manifest digest must be a full SHA-256." >&2
    exit 1
  }
  ARTIFACT_KIND=plugin-registry \
    ARTIFACT_ID="${REGISTRY_ARTIFACT_ID:-}" ARTIFACT_NAME="${REGISTRY_ARTIFACT_NAME:-}" \
    ARTIFACT_DIGEST="${REGISTRY_ARTIFACT_DIGEST:-}" ARTIFACT_RUN_ID="${REGISTRY_ARTIFACT_RUN_ID:-}" \
    ARTIFACT_RUN_ATTEMPT="${REGISTRY_ARTIFACT_RUN_ATTEMPT:-}" PACKAGE_SOURCE_SHA="$CANDIDATE_SHA" \
    bash "$(dirname "${BASH_SOURCE[0]}")/verify-same-run-candidate-artifact.sh"
fi
if [[ -n "${PROVIDED_BARE_IMAGE:-}" || -n "${PROVIDED_FUNCTIONAL_IMAGE:-}" || "$SHARED_IMAGE_POLICY" != "no-push-artifact" ]]; then
  echo "Registry image selection has no same-run producer authority. Use no-push-artifact or an isolated nondefault context." >&2
  exit 1
fi

if [[ -n "${IMAGE_ARTIFACT_ID:-}${IMAGE_ARTIFACT_NAME:-}${IMAGE_ARTIFACT_DIGEST:-}${IMAGE_ARTIFACT_RUN_ID:-}${IMAGE_ARTIFACT_RUN_ATTEMPT:-}${IMAGE_ARCHIVE_SHA256:-}" ]]; then
  [[ "$IMAGE_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
    echo "Image archive digest must be a full SHA-256." >&2
    exit 1
  }
  ARTIFACT_KIND=docker-e2e-image \
    ARTIFACT_ID="$IMAGE_ARTIFACT_ID" ARTIFACT_NAME="$IMAGE_ARTIFACT_NAME" \
    ARTIFACT_DIGEST="$IMAGE_ARTIFACT_DIGEST" ARTIFACT_RUN_ID="$IMAGE_ARTIFACT_RUN_ID" \
    ARTIFACT_RUN_ATTEMPT="$IMAGE_ARTIFACT_RUN_ATTEMPT" PACKAGE_SOURCE_SHA="$CANDIDATE_SHA" \
    bash "$(dirname "${BASH_SOURCE[0]}")/verify-same-run-candidate-artifact.sh"
fi

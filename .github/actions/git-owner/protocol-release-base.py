"""Select a provenance-checked protocol baseline for downstream release imports."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

from ci_git_owner import GitFailure, git_output, run_git


workspace = os.getcwd()
upstream = "https://github.com/openclaw/openclaw.git"


class ProtocolBaselineError(Exception):
    pass


def git_text(*arguments):
    return git_output(workspace, *arguments, timeout=120).strip()


def commit_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ProtocolBaselineError("Protocol baseline requires a full commit SHA")
    return value


def is_ancestor(source, target):
    try:
        run_git(workspace, "merge-base", "--is-ancestor", source, target,
                timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except GitFailure as error:
        if error.code != 1:
            raise
        return False


def fetch(remote, revision, depth):
    run_git(workspace, "fetch", "--no-tags", "--no-recurse-submodules",
            "--filter=blob:none", "--refmap=", f"--depth={depth}", remote, revision,
            timeout=120, reclaim_locks=True)


def select_baseline():
    base = commit_sha(os.environ["PROTOCOL_SINCE_BASE_SHA"])
    if git_text("rev-parse", "refs/remotes/origin/ci-ratchet-base^{commit}") != base:
        raise ProtocolBaselineError("Prepared protocol ratchet base does not match the selected diff base")
    repository = os.environ["GITHUB_REPOSITORY"]
    if repository == "openclaw/openclaw":
        return base
    event_name = os.environ["GITHUB_EVENT_NAME"]
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    if event.get("repository", {}).get("full_name") != repository:
        raise ProtocolBaselineError("Protocol baseline event repository does not match the workflow")
    target = commit_sha(git_text("rev-parse", "HEAD"))
    if target != commit_sha(os.environ["PROTOCOL_TARGET_SHA"]):
        raise ProtocolBaselineError("Protocol baseline target does not match the selected checkout")
    if event_name == "pull_request":
        pr = event["pull_request"]
        if any(pr[side].get("repo", {}).get("full_name") != repository
               for side in ("head", "base")):
            return base
        branch = pr["head"]["ref"]
        candidate = commit_sha(pr["head"]["sha"])
    elif event_name in ("push", "workflow_dispatch"):
        branch = os.environ.get("GITHUB_REF", "").removeprefix("refs/heads/")
        candidate = commit_sha(os.environ["GITHUB_SHA"])
        if candidate != target:
            return base
    else:
        return base
    if not re.fullmatch(r"release/[0-9]{4}\.[0-9]+\.[0-9]+(?:-[1-9][0-9]*)?", branch):
        return base
    version = json.loads(git_text("show", f"{target}:package.json")).get("version")
    if not isinstance(version, str) or not re.fullmatch(
            r"[0-9]{4}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*(?:-[1-9][0-9]*)?", version):
        raise ProtocolBaselineError("Protocol baseline target has an invalid stable release version")
    if branch != f"release/{version}":
        raise ProtocolBaselineError("Protocol baseline release branch does not match the package version")
    tag_ref = f"refs/tags/v{version}"
    advertisement = git_text("ls-remote", upstream, tag_ref, f"{tag_ref}^{{}}")
    if not advertisement:
        return base
    refs = {}
    for line in advertisement.splitlines():
        sha, ref = line.split()
        if ref not in (tag_ref, f"{tag_ref}^{{}}") or ref in refs:
            raise ProtocolBaselineError("Invalid canonical release tag advertisement")
        refs[ref] = commit_sha(sha)
    if set(refs) != {tag_ref, f"{tag_ref}^{{}}"}:
        raise ProtocolBaselineError("Canonical release baseline must be an annotated tag")
    tag_object = refs[tag_ref]
    release = refs[f"{tag_ref}^{{}}"]
    # Fetch immutable advertised objects, never a second read of the mutable tag.
    fetch(upstream, tag_object, 1)
    if (git_text("cat-file", "-t", tag_object) != "tag"
            or git_text("rev-parse", f"{tag_object}^{{commit}}") != release):
        raise ProtocolBaselineError("Canonical release tag does not peel to the advertised commit")
    if json.loads(git_text("show", f"{release}:package.json")).get("version") != version:
        raise ProtocolBaselineError("Canonical release tag package version does not match the target")
    # CI starts at depth one. Hydrate only the immutable selected target, with
    # bounded depth; incomplete or unrelated ancestry never grants a baseline.
    for depth in (0, 128, 512, 2048):
        if depth:
            fetch(f"https://github.com/{repository}.git", target, depth)
        if is_ancestor(release, target) and is_ancestor(candidate, target):
            return release
        if git_text("rev-parse", "--is-shallow-repository") == "false":
            break
    raise ProtocolBaselineError("Canonical release and release candidate must be ancestors of the selected target")


try:
    baseline = select_baseline()
except ProtocolBaselineError as error:
    print(f"::error::{error}", file=sys.stderr, flush=True)
    raise SystemExit(1)
with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
    output.write(f"sha={baseline}\n")

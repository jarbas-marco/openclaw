import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflows = [
  "openclaw-live-and-e2e-checks-reusable",
  "openclaw-performance",
  "openclaw-release-checks",
  "openclaw-release-telegram-qa",
  "package-acceptance",
  "plugin-clawhub-release",
  "plugin-npm-release",
  "qa-live-transports-convex",
];
type Step = { name: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { needs?: string[]; if?: string; steps?: Step[] };
function workflow(name: string) {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as {
    jobs: Record<string, Job>;
  };
}
function candidateGate(name: string) {
  const gate = workflow(name).jobs.candidate_execution;
  if (!gate) {
    throw new Error(`${name} must define the candidate execution gate`);
  }
  return gate;
}
function fixture() {
  const root = tempDirs.make("candidate-execution-");
  const repo = join(root, ".candidate-policy");
  mkdirSync(join(repo, "scripts/github"), { recursive: true });
  copyFileSync(
    resolve("scripts/github/classify-candidate-execution.mjs"),
    join(repo, "scripts/github/classify-candidate-execution.mjs"),
  );
  for (const name of [
    "verify-candidate-image-authority.sh",
    "verify-same-run-candidate-artifact.sh",
  ]) {
    copyFileSync(resolve("scripts/github", name), join(repo, "scripts/github", name));
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_COUNT: "0" },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("-c", "core.hooksPath=/dev/null", "add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "trusted policy");
  const trustedSha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", trustedSha);
  writeFileSync(join(repo, "candidate.txt"), "unreviewed candidate");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "candidate");
  const candidateSha = git("rev-parse", "HEAD");
  return { root, trustedSha, candidateSha };
}

describe("candidate execution cache scope boundary", () => {
  it.each(workflows)(
    "%s rejects default-scope mismatches before candidate execution and retains isolated validation",
    (name) => {
      const { root, trustedSha, candidateSha } = fixture();
      const gate = candidateGate(name);
      const run = gate.steps?.find(
        (step) => step.name === "Classify candidate before checkout or execution",
      )?.run;
      expect(run).toBeDefined();
      for (const [ref, candidate, success, privileged] of [
        ["refs/heads/main", trustedSha, true, "true"],
        ["refs/heads/main", candidateSha, false, ""],
        ["refs/heads/release-ci/fixture", candidateSha, true, "false"],
        ["refs/heads/release-ci/fixture", trustedSha, true, "false"],
        ["refs/tags/v2026.9.3", candidateSha, true, "false"],
        ["refs/pull/21/merge", candidateSha, false, ""],
      ] as const) {
        const output = join(root, "output");
        writeFileSync(output, "");
        const result = spawnSync("bash", ["-c", run!], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            CANDIDATE_REF: candidate,
            WORKFLOW_SHA: trustedSha,
            WORKFLOW_REF: ref,
            DEFAULT_BRANCH: "main",
            GITHUB_OUTPUT: output,
            BASELINE_REF: "",
            PACKAGE_SOURCE: "ref",
            PACKAGE_REF: candidate,
            KOVA_REF: "",
            ARTIFACT_ID: "",
          },
        });
        expect(result.status === 0, result.stderr).toBe(success);
        if (success) {
          const outputs = readFileSync(output, "utf8");
          expect(outputs).toContain(`privileged=${privileged}\n`);
          expect(outputs).toContain(`cache_mode=${privileged === "true" ? "restore" : "off"}\n`);
          expect(outputs).toContain(`candidate_sha=${candidate}\n`);
        }
      }
      const output = join(root, "untrusted-output");
      const result = spawnSync("bash", ["-c", run!], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CANDIDATE_REF: candidateSha,
          WORKFLOW_SHA: candidateSha,
          WORKFLOW_REF: "refs/heads/release-ci/fixture",
          DEFAULT_BRANCH: "main",
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.status).not.toBe(0);
    },
  );

  it.each(workflows)(
    "%s makes the classifier a prerequisite even for always jobs and fixes the complete setup graph",
    (name) => {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        if (id === "candidate_execution") {
          continue;
        }
        expect(job.needs).toContain("candidate_execution");
        expect(job.if).toContain("needs.candidate_execution.result == 'success'");
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith("actions/checkout@")) {
            expect(step.with?.["persist-credentials"]).toBe(false);
          }
          if (step.uses?.endsWith("/setup-node-env")) {
            expect(step.uses).toBe("./.candidate-setup/.github/actions/setup-node-env");
          }
        }
      }
      const setup = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8")) as {
        runs: { steps: Step[] };
      };
      expect(setup.runs.steps.some((step) => step.uses?.startsWith("./"))).toBe(false);
      expect(setup.runs.steps.find((step) => step.name === "Setup pnpm")?.run).toContain(
        "$GITHUB_ACTION_PATH/../setup-pnpm-store-cache/setup-pnpm.sh",
      );
    },
  );
});

it("shared pnpm setup never loads the candidate's nested action and keeps cache-off free of store probes", () => {
  const root = tempDirs.make("trusted-pnpm-setup-");
  const trusted = join(root, "trusted");
  const candidate = join(root, "candidate");
  const bin = join(root, "bin");
  for (const directory of [trusted, candidate, bin]) {
    mkdirSync(directory);
  }
  for (const name of ["setup-pnpm.sh", "ensure-node.sh"]) {
    copyFileSync(resolve(".github/actions/setup-pnpm-store-cache", name), join(trusted, name));
  }
  mkdirSync(join(candidate, ".github/actions/setup-pnpm-store-cache"), { recursive: true });
  writeFileSync(
    join(candidate, ".github/actions/setup-pnpm-store-cache/ensure-node.sh"),
    "exit 99\n",
  );
  writeFileSync(join(candidate, "package.json"), JSON.stringify({ packageManager: "pnpm@12.3.4" }));
  const log = join(root, "calls");
  writeFileSync(join(bin, "corepack"), '#!/bin/sh\nprintf "corepack %s\\n" "$*" >> "$CALL_LOG"\n', {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\nprintf "pnpm %s\\n" "$*" >> "$CALL_LOG"\nif [ "$1" = "store" ]; then echo "$TEST_STORE"; else echo 12.3.4; fi\n',
    { mode: 0o755 },
  );
  for (const mode of ["off", "restore"]) {
    writeFileSync(log, "");
    const output = join(root, `output-${mode}`);
    const result = spawnSync("bash", [join(trusted, "setup-pnpm.sh")], {
      cwd: candidate,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CACHE_MODE: mode,
        PNPM_HOME: join(root, "pnpm-home"),
        PACKAGE_MANAGER_FILE: "package.json",
        REQUESTED_NODE_VERSION: process.versions.node,
        RUNNER_OS: "Linux",
        CALL_LOG: log,
        TEST_STORE: join(root, "store"),
        GITHUB_OUTPUT: output,
        GITHUB_ENV: join(root, "env"),
        GITHUB_PATH: join(root, "path"),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("corepack prepare pnpm@12.3.4 --activate");
    expect(calls.includes("pnpm store path --silent")).toBe(mode === "restore");
    expect(readFileSync(output, "utf8")).toContain("pnpm-version=12.3.4");
  }
});

it("admits only completed same-run source producers after verifying GitHub metadata", () => {
  const root = tempDirs.make("candidate-artifact-authority-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
  *actions/artifacts/*) cat "$MOCK_ARTIFACT" ;;
  *jobs?per_page=100*) cat "$MOCK_JOBS" ;;
  *) cat "$MOCK_ATTEMPT" ;;
esac
`,
    { mode: 0o755 },
  );
  const sha = "a".repeat(40);
  const artifact = {
    id: 99,
    name: "release-package-under-test-123-1",
    expired: false,
    digest: `sha256:${"b".repeat(64)}`,
    workflow_run: { id: 123, head_sha: sha },
  };
  const attempt = {
    id: 123,
    run_attempt: 1,
    head_sha: sha,
    head_branch: "main",
    path: ".github/workflows/openclaw-release-checks.yml",
    event: "workflow_dispatch",
  };
  const producer = {
    name: "Prepare release package artifact",
    head_sha: sha,
    status: "completed",
    conclusion: "success",
  };
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ARTIFACT_ID: "99",
    ARTIFACT_DIGEST: "b".repeat(64),
    ARTIFACT_NAME: artifact.name,
    ARTIFACT_RUN_ID: "123",
    ARTIFACT_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    PACKAGE_SOURCE_SHA: sha,
    WORKFLOW_SHA: sha,
    CALLER_WORKFLOW_SHA: sha,
    WORKFLOW_REF: "refs/heads/main",
    DEFAULT_BRANCH: "main",
    GITHUB_REPOSITORY: "example/repo",
    CALLER_WORKFLOW_REF:
      "example/repo/.github/workflows/openclaw-release-checks.yml@refs/heads/main",
    GITHUB_EVENT_PATH: join(root, "event"),
    MOCK_ARTIFACT: join(root, "artifact"),
    MOCK_ATTEMPT: join(root, "attempt"),
    MOCK_JOBS: join(root, "jobs"),
  };
  const check = (
    overrides: {
      env?: Record<string, string>;
      inputs?: Record<string, string>;
      artifact?: Partial<typeof artifact>;
      attempt?: Partial<typeof attempt>;
      producer?: Partial<typeof producer>;
      imageSelection?: boolean;
    } = {},
  ) => {
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({ inputs: overrides.inputs ?? {} }));
    writeFileSync(env.MOCK_ARTIFACT, JSON.stringify({ ...artifact, ...overrides.artifact }));
    writeFileSync(env.MOCK_ATTEMPT, JSON.stringify({ ...attempt, ...overrides.attempt }));
    writeFileSync(
      env.MOCK_JOBS,
      JSON.stringify({ jobs: [{ ...producer, ...overrides.producer }] }),
    );
    return spawnSync(
      "bash",
      [
        resolve(
          `scripts/github/${overrides.imageSelection ? "verify-candidate-image-authority.sh" : "verify-same-run-candidate-artifact.sh"}`,
        ),
      ],
      {
        encoding: "utf8",
        env: { ...env, ...overrides.env },
      },
    );
  };
  const imageName = `docker-e2e-shared-images-release-${sha.slice(0, 12)}-123-1`;
  const imageEnv = {
    IMAGE_EXECUTION_SELECTED: "true",
    SHARED_IMAGE_POLICY: "no-push-artifact",
    CANDIDATE_SHA: sha,
    IMAGE_ARTIFACT_ID: "99",
    IMAGE_ARTIFACT_NAME: imageName,
    IMAGE_ARTIFACT_DIGEST: "b".repeat(64),
    IMAGE_ARTIFACT_RUN_ID: "123",
    IMAGE_ARTIFACT_RUN_ATTEMPT: "1",
    IMAGE_ARCHIVE_SHA256: "d".repeat(64),
  };
  const imageCheck = (extra: Parameters<typeof check>[0] = {}) =>
    check({
      ...extra,
      imageSelection: true,
      env: { ...imageEnv, ...extra.env },
      artifact: { name: imageName, ...extra.artifact },
      producer: { name: "Prepare shared Docker E2E image", ...extra.producer },
    });
  const image = imageCheck();
  expect(image.status, image.stderr).toBe(0);
  const packageImage = imageCheck({
    env: {
      CALLER_WORKFLOW_REF: "example/repo/.github/workflows/package-acceptance.yml@refs/heads/main",
    },
    inputs: { source: "ref" },
    attempt: { path: ".github/workflows/package-acceptance.yml" },
  });
  expect(packageImage.status, packageImage.stderr).toBe(0);
  const rejectedImages: NonNullable<Parameters<typeof check>[0]>[] = [
    { env: { PROVIDED_BARE_IMAGE: "attacker/image@sha256:abc" } },
    { env: { PROVIDED_FUNCTIONAL_IMAGE: "attacker/image:latest" } },
    { env: { SHARED_IMAGE_POLICY: "existing-only" } },
    { env: { IMAGE_ARTIFACT_RUN_ID: "122" } },
    { env: { IMAGE_ARTIFACT_RUN_ATTEMPT: "2" } },
    { env: { IMAGE_ARCHIVE_SHA256: "" } },
    { env: { PREPARED_NPM_BUNDLE_JSON: "{}" } },
    { artifact: { digest: `sha256:${"c".repeat(64)}` } },
    { artifact: { name: "release-package-under-test-123-1" } },
    { producer: { name: "Prepare release package artifact" } },
    { artifact: { workflow_run: { id: 122, head_sha: sha } } },
    { producer: { conclusion: "failure" } },
    { attempt: { run_attempt: 2 } },
    { inputs: { candidate_artifact_json: "{}" } },
    { inputs: { release_package_spec: "untrusted@1" } },
  ];
  for (const extra of rejectedImages) {
    expect(imageCheck(extra).status).not.toBe(0);
  }
  const admittedImages: NonNullable<Parameters<typeof check>[0]>[] = [
    { env: { WORKFLOW_REF: "refs/heads/isolated", PROVIDED_BARE_IMAGE: "attacker/image:latest" } },
    { env: { IMAGE_EXECUTION_SELECTED: "false", SHARED_IMAGE_POLICY: "existing-only" } },
    {
      env: {
        IMAGE_ARTIFACT_ID: "",
        IMAGE_ARTIFACT_NAME: "",
        IMAGE_ARTIFACT_DIGEST: "",
        IMAGE_ARTIFACT_RUN_ID: "",
        IMAGE_ARTIFACT_RUN_ATTEMPT: "",
        IMAGE_ARCHIVE_SHA256: "",
      },
    },
  ];
  for (const extra of admittedImages) {
    const result = imageCheck(extra);
    expect(result.status, result.stderr).toBe(0);
  }
  const registryName = "docker-e2e-prepublish-plugin-registry-123-1";
  const registry = check({
    imageSelection: true,
    env: {
      IMAGE_EXECUTION_SELECTED: "true",
      SHARED_IMAGE_POLICY: "no-push-artifact",
      CANDIDATE_SHA: sha,
      REGISTRY_ARTIFACT_ID: "99",
      REGISTRY_ARTIFACT_NAME: registryName,
      REGISTRY_ARTIFACT_DIGEST: "b".repeat(64),
      REGISTRY_ARTIFACT_RUN_ID: "123",
      REGISTRY_ARTIFACT_RUN_ATTEMPT: "1",
      REGISTRY_MANIFEST_SHA256: "d".repeat(64),
    },
    artifact: { name: registryName },
  });
  expect(registry.status, registry.stderr).toBe(0);
  const forgedRegistry = imageCheck({
    env: { REGISTRY_ARTIFACT_ID: "99", REGISTRY_MANIFEST_SHA256: "d".repeat(64) },
  });
  expect(forgedRegistry.status).not.toBe(0);
  // The same prepared package is admitted by both the live and Package Acceptance consumers.
  for (const consumer of ["openclaw-live-and-e2e-checks-reusable", "package-acceptance"]) {
    const run = candidateGate(consumer).steps?.find(
      (step) => step.name === "Classify candidate before checkout or execution",
    )?.run;
    expect(run).toContain("bash scripts/github/verify-same-run-candidate-artifact.sh");
    const result = check();
    expect(result.status, result.stderr).toBe(0);
  }
  const packageName = "package-under-test-123-1";
  const directPackage = check({
    env: {
      ARTIFACT_NAME: packageName,
      CALLER_WORKFLOW_REF: "example/repo/.github/workflows/package-acceptance.yml@refs/heads/main",
    },
    inputs: { source: "ref" },
    artifact: { name: packageName },
    attempt: { path: ".github/workflows/package-acceptance.yml" },
    producer: { name: "Resolve package candidate" },
  });
  expect(directPackage.status, directPackage.stderr).toBe(0);
  const rejectedPackages: NonNullable<Parameters<typeof check>[0]>[] = [
    { inputs: { release_package_spec: "arbitrary@1" } },
    { inputs: { candidate_artifact_json: "{}" } },
    { inputs: { package_acceptance_package_spec: "arbitrary@1" } },
    { env: { ARTIFACT_RUN_ID: "122" } },
    { env: { ARTIFACT_RUN_ATTEMPT: "2" } },
    { env: { PACKAGE_SOURCE_SHA: "c".repeat(40) } },
    { env: { CALLER_WORKFLOW_SHA: "c".repeat(40) } },
    { artifact: { digest: `sha256:${"c".repeat(64)}` } },
    { artifact: { workflow_run: { id: 122, head_sha: sha } } },
    { attempt: { head_sha: "c".repeat(40) } },
    { attempt: { run_attempt: 2 } },
    { producer: { conclusion: "failure" } },
    { producer: { status: "in_progress" } },
    { producer: { name: "Unknown producer" } },
  ];
  for (const overrides of rejectedPackages) {
    expect(check(overrides).status).not.toBe(0);
  }
});

it("classifies performance baselines and independent Kova source overrides before checkout", () => {
  const { root, trustedSha, candidateSha } = fixture();
  const run = candidateGate("openclaw-performance").steps?.find(
    (step) => step.name === "Classify candidate before checkout or execution",
  )?.run;
  expect(run).toBeDefined();
  for (const [ref, baseline, kova, success] of [
    ["refs/heads/main", trustedSha, "", true],
    ["refs/heads/main", candidateSha, "", false],
    ["refs/heads/isolated", candidateSha, "", true],
    ["refs/heads/main", "", candidateSha, false],
    ["refs/heads/isolated", "", candidateSha, true],
    ["refs/heads/main", "", "e4d865f55f655a77df169a7be01877608c3260b9", true],
  ] as const) {
    const result = spawnSync("bash", ["-c", run!], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_REF: trustedSha,
        WORKFLOW_SHA: trustedSha,
        WORKFLOW_REF: ref,
        DEFAULT_BRANCH: "main",
        GITHUB_OUTPUT: join(root, "output"),
        BASELINE_REF: baseline,
        KOVA_REF: kova,
      },
    });
    expect(result.status === 0, result.stderr).toBe(success);
  }
});

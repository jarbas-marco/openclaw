import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { verifyCandidateNpmBundle } from "../../scripts/github/verify-candidate-npm-bundle.mjs";
import {
  describeNpmBundle,
  describeNpmQualificationProof,
  downloadPreparedNpmBundle,
  NPM_PACKAGE_PRODUCER_WORKFLOW,
  NPM_SOURCE_CHECK_SCHEMA,
  NPM_QUALIFICATION_PROOF_SCHEMA,
  PREPARED_NPM_BUNDLE_SCHEMA,
  prepareNpmPackageBundle,
  qualifyNpmPackageBundle,
  validatePreparedNpmBundleDescriptor,
  verifyNpmBundleProducer,
  verifyPreparedNpmBundleFiles,
  verifyNpmSourceCheck,
} from "../../scripts/npm-prepared-bundle.mjs";
import { validatePreflightManifest } from "../../scripts/release-candidate-checklist.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "openclaw/openclaw";
const sourceSha = "a".repeat(40);
const toolingSha = "b".repeat(40);
const workflowPath = ".github/workflows/full-release-validation.yml";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function packageProducer(callerWorkflowPath = workflowPath) {
  return {
    repository,
    workflowRef: `${repository}/${callerWorkflowPath}@refs/heads/main`,
    workflowSha: toolingSha,
    runId: "12",
    runAttempt: "2",
    jobId: "45",
    jobName: "Prepare npm package / Prepare publishable npm package",
    producerWorkflowPath: NPM_PACKAGE_PRODUCER_WORKFLOW,
  };
}

function packageSourceFixture(
  packageVersion: string,
  baseTag?: "same-source" | "different-source",
) {
  const sourceDir = tempDirs.make("npm-source-");
  const outputDir = join(tempDirs.make("npm-package-output-"), "prepared");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        sourceDir,
        "-c",
        "user.name=Release fixture",
        "-c",
        "user.email=release-fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  git("init", "--quiet");
  writeFileSync(
    join(sourceDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: packageVersion }),
  );
  git("add", "package.json");
  git("commit", "--quiet", "-m", "release package fixture");
  if (baseTag) {
    git("tag", `v${packageVersion}`);
    if (baseTag === "different-source") {
      git("commit", "--quiet", "--allow-empty", "-m", "different release source");
    }
  }
  const runPack = vi.fn((directory: string, destination: string) => {
    const staging = tempDirs.make("npm-package-staging-");
    mkdirSync(join(staging, "package"));
    copyFileSync(join(directory, "package.json"), join(staging, "package/package.json"));
    return execFileSync("tar", [
      "-czf",
      join(destination, `openclaw-${packageVersion}.tgz`),
      "-C",
      staging,
      "package",
    ]);
  });
  return {
    sourceDir,
    outputDir,
    releaseRef: git("rev-parse", "HEAD"),
    npmDistTag: "beta",
    producer: packageProducer(),
    runPack,
  };
}

async function bundleFixture(
  callerWorkflowPath = workflowPath,
  selectedSourceSha = sourceSha,
  selectedToolingSha = toolingSha,
) {
  const producer = { ...packageProducer(callerWorkflowPath), workflowSha: selectedToolingSha };
  const tarball = Buffer.from("exact publishable root archive");
  const aiTarball = Buffer.from("exact publishable AI archive");
  const corePackage = {
    packageName: "@openclaw/ai",
    packageVersion: "2026.8.1",
    tarballName: "openclaw-ai-2026.8.1.tgz",
    tarballSha256: hash(aiTarball),
  };
  const manifest = {
    schema: "openclaw.npm-package-bundle/v1",
    producer,
    releaseTag: "v2026.8.1",
    releaseSha: selectedSourceSha,
    npmDistTag: "beta",
    packageName: "openclaw",
    packageVersion: "2026.8.1",
    tarballName: "openclaw-2026.8.1.tgz",
    tarballSha256: hash(tarball),
    corePackageTarballs: [corePackage],
    dependencyTarballs: [corePackage],
  };
  const files = new Map([
    ["package-bundle.json", Buffer.from(`${JSON.stringify(manifest)}\n`)],
    [manifest.tarballName, tarball],
    [corePackage.tarballName, aiTarball],
  ]);
  const zip = new JSZip();
  for (const [name, bytes] of files) {
    zip.file(name, bytes);
  }
  const archive = await zip.generateAsync({
    type: "nodebuffer",
    compression: "STORE",
    platform: "UNIX",
  });
  const descriptor = {
    schema: PREPARED_NPM_BUNDLE_SCHEMA,
    source: { sha: selectedSourceSha },
    artifact: {
      id: "78",
      name: "openclaw-npm-package-12-2",
      digest: hash(archive),
      runId: "12",
      runAttempt: "2",
    },
    package: {
      name: "openclaw",
      fileName: manifest.tarballName,
      sha256: hash(tarball),
      version: manifest.packageVersion,
      sourceSha: selectedSourceSha,
    },
    corePackages: [corePackage],
    manifestSha256: hash(files.get("package-bundle.json")!),
    producer,
  };
  const run = {
    id: 12,
    run_attempt: 2,
    head_sha: selectedToolingSha,
    path: callerWorkflowPath,
    head_branch: "main",
    event: "workflow_dispatch",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    status: "in_progress",
    conclusion: null,
  };
  const job = {
    id: 45,
    run_id: 12,
    run_attempt: 2,
    head_sha: selectedToolingSha,
    name: producer.jobName,
    status: "completed",
    conclusion: "success",
  };
  const metadata = {
    id: 78,
    name: descriptor.artifact.name,
    digest: `sha256:${descriptor.artifact.digest}`,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2026-10-01T00:00:00Z",
    workflow_run: { id: 12, head_sha: selectedToolingSha },
  };
  const runGh = (args: string[]) => {
    const endpoint = args[1];
    if (!endpoint) {
      throw new Error("GitHub request endpoint is required");
    }
    if (endpoint.includes("/jobs?")) {
      return JSON.stringify({ total_count: 1, jobs: [job] });
    }
    if (endpoint.endsWith("/attempts/2")) {
      return JSON.stringify(run);
    }
    if (endpoint.endsWith("/artifacts/78")) {
      return JSON.stringify(metadata);
    }
    throw new Error(`Unexpected GitHub request: ${endpoint}`);
  };
  const fetchImpl: typeof fetch = async (url) => {
    if (typeof url !== "string") {
      throw new Error("Expected a URL string");
    }
    return url.endsWith("/zip") ? new Response(new Uint8Array(archive)) : Response.json(metadata);
  };
  return { archive, descriptor, fetchImpl, files, job, manifest, metadata, run, runGh };
}

type PreparedFixtureDescriptor = Awaited<ReturnType<typeof bundleFixture>>["descriptor"];

async function qualificationFixture<
  Descriptor extends Pick<PreparedFixtureDescriptor, "source" | "producer">,
>(
  descriptor: Descriptor,
  pluginSdkApi: object = {},
  dependencyReports: Record<string, object | string> = {},
) {
  const source = descriptor.source;
  const makeProducer = (jobId: string, jobName: string) => ({
    ...descriptor.producer,
    jobId,
    jobName,
  });
  const sourceCheck = {
    schema: NPM_SOURCE_CHECK_SCHEMA,
    source,
    producer: makeProducer("46", "Check npm release source"),
  };
  const contentsProof = {
    schema: NPM_QUALIFICATION_PROOF_SCHEMA,
    kind: "contents",
    source,
    releaseTag: "v2026.8.1",
    npmDistTag: "beta",
    producer: makeProducer("47", "Check npm package contents"),
    files: [],
    preparedBundle: descriptor,
  };
  const archives = new Map<string, { archive: Buffer; metadata: object }>();
  const makeArtifactProof = async (
    kind: string,
    id: string,
    producer: ReturnType<typeof makeProducer>,
    files: Record<string, object | string>,
  ) => {
    const entries = Object.entries(files).map(
      ([name, value]) =>
        [
          name,
          Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value)}\n`),
        ] as const,
    );
    const zip = new JSZip();
    for (const [name, bytes] of entries) {
      zip.file(name, bytes);
    }
    const archive = await zip.generateAsync({
      type: "nodebuffer",
      compression: "STORE",
      platform: "UNIX",
    });
    const artifact = {
      id,
      name: `openclaw-npm-${kind}-proof-${producer.runId}-${producer.runAttempt}`,
      digest: hash(archive),
      runId: producer.runId,
      runAttempt: producer.runAttempt,
    };
    const metadata = {
      id: Number(id),
      name: artifact.name,
      digest: `sha256:${artifact.digest}`,
      size_in_bytes: archive.length,
      expired: false,
      expires_at: "2026-10-01T00:00:00Z",
      workflow_run: { id: Number(producer.runId), head_sha: toolingSha },
    };
    archives.set(id, { archive, metadata });
    const { preparedBundle: _preparedBundle, ...identity } = contentsProof;
    return {
      ...identity,
      kind,
      producer,
      artifact,
      files: entries.map(([name, bytes]) => ({ name, sha256: hash(bytes) })),
    };
  };
  const sdkProof = await makeArtifactProof(
    "sdk",
    "79",
    makeProducer("48", "Check npm Plugin SDK"),
    {
      "plugin-sdk-api-release-evidence.json": pluginSdkApi,
      "plugin-sdk-api-release-diff.json": {},
    },
  );
  const dependencyProof = await makeArtifactProof(
    "dependencies",
    "80",
    makeProducer("49", "Check npm dependencies"),
    {
      "dependency-evidence-manifest.json": { releaseSha: source.sha },
      ...dependencyReports,
    },
  );
  const jobs = [sourceCheck, contentsProof, sdkProof, dependencyProof].map(({ producer }) => ({
    id: Number(producer.jobId),
    run_id: Number(producer.runId),
    run_attempt: Number(producer.runAttempt),
    head_sha: toolingSha,
    name: producer.jobName,
    status: "completed",
    conclusion: "success",
  }));
  const runGh = (args: string[]) => {
    const endpoint = args[1] ?? "";
    if (endpoint.includes("/jobs?")) {
      return JSON.stringify({ total_count: jobs.length, jobs });
    }
    if (endpoint.endsWith("/attempts/2")) {
      return JSON.stringify({
        id: 12,
        run_attempt: 2,
        head_sha: toolingSha,
        path: workflowPath,
        head_branch: "main",
        event: "workflow_dispatch",
        repository: { full_name: repository },
        head_repository: { full_name: repository },
        status: "in_progress",
        conclusion: null,
      });
    }
    const artifact = archives.get(endpoint.split("/").at(-1) ?? "");
    if (artifact) {
      return JSON.stringify(artifact.metadata);
    }
    throw new Error(`Unexpected GitHub request: ${endpoint}`);
  };
  const fetchImpl: typeof fetch = async (url) => {
    const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const match = requestUrl.match(/\/artifacts\/(\d+)(\/zip)?$/);
    const artifact = archives.get(match?.[1] ?? "");
    if (!artifact) {
      throw new Error(`Unexpected artifact request: ${requestUrl}`);
    }
    return match?.[2]
      ? new Response(new Uint8Array(artifact.archive))
      : Response.json(artifact.metadata);
  };
  return {
    sourceCheck,
    contentsProof,
    sdkProof,
    dependencyProof,
    runGh,
    fetchImpl,
    jobs,
    archives,
    token: "test-token",
  };
}

type QualificationFixture = Awaited<
  ReturnType<typeof qualificationFixture<PreparedFixtureDescriptor>>
>;

describe("prepared npm bundle", () => {
  it.each(["failure", "cancelled"])(
    "reuses successful preparation and source jobs after parent %s",
    async (conclusion) => {
      const fixture = await bundleFixture(".github/workflows/openclaw-npm-release.yml");
      Object.assign(fixture.run, { status: "completed", conclusion });
      const downloaded = await downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir: join(tempDirs.make("npm-retry-"), "prepared"),
        token: "test-token",
        npmDistTag: "beta",
        releaseTag: fixture.manifest.releaseTag,
      });
      expect(readFileSync(downloaded.tarballPath)).toEqual(
        fixture.files.get(fixture.manifest.tarballName),
      );
      const descriptor = {
        schema: NPM_SOURCE_CHECK_SCHEMA,
        source: { sha: sourceSha },
        producer: { ...fixture.descriptor.producer, jobName: "Check npm release source" },
      };
      fixture.job.name = descriptor.producer.jobName;
      const source = { descriptor, repository, sourceSha, toolingSha, runGh: fixture.runGh };
      expect(verifyNpmSourceCheck(source).job.id).toBe(fixture.job.id);
      fixture.job.run_attempt += 1;
      expect(() => verifyNpmSourceCheck(source)).toThrow("unique exact completed producer job");
    },
  );

  it.each([
    ["completed", "failure"],
    ["completed", "cancelled"],
    ["in_progress", null],
  ])("requires a successful parent for publication (%s/%s)", async (status, conclusion) => {
    const fixture = await bundleFixture(".github/workflows/openclaw-npm-release.yml");
    Object.assign(fixture.run, { status, conclusion });
    fixture.job.name = "Qualify prepared npm package";
    const options = {
      producer: { ...fixture.descriptor.producer, jobName: fixture.job.name },
      repository,
      toolingSha,
      qualified: true,
      requireCompletedParent: true,
      runGh: fixture.runGh,
    };
    expect(() => verifyNpmBundleProducer(options)).toThrow("parent");
    Object.assign(fixture.run, { status: "completed", conclusion: "success" });
    expect(verifyNpmBundleProducer(options).job.id).toBe(fixture.job.id);
    fixture.job.conclusion = "failure";
    expect(() => verifyNpmBundleProducer(options)).toThrow("unique exact completed producer job");
  });

  it.each([
    ["2026.8.1", "v2026.8.1-2", "same-source"],
    ["2026.8.1-2", "v2026.8.1-2", undefined],
    ["2026.8.1", undefined, undefined],
  ] as const)(
    "preserves package %s and requested tag %s through preparation and qualification",
    async (packageVersion, releaseTag, baseTag) => {
      const fixture = packageSourceFixture(packageVersion, baseTag);
      const prepared = prepareNpmPackageBundle({ ...fixture, releaseTag });
      const expectedTag = releaseTag ?? `v${packageVersion}`;
      expect(prepared.releaseTag).toBe(expectedTag);
      expect(prepared.releaseSha).toBe(fixture.releaseRef);
      const descriptor = describeNpmBundle({
        directory: fixture.outputDir,
        artifact: {
          id: "78",
          name: "openclaw-npm-package-12-2",
          digest: "c".repeat(64),
          runId: "12",
          runAttempt: "2",
        },
      });
      validatePreparedNpmBundleDescriptor({
        descriptor,
        repository,
        sourceSha: fixture.releaseRef,
        toolingSha,
      });
      const proof = await qualificationFixture(descriptor);
      for (const entry of [proof.sdkProof, proof.dependencyProof, proof.contentsProof]) {
        const directory = tempDirs.make("npm-qualification-evidence-");
        const artifact = "artifact" in entry ? entry.artifact : undefined;
        if (artifact) {
          const archive = await JSZip.loadAsync(proof.archives.get(artifact.id)!.archive);
          for (const file of entry.files) {
            writeFileSync(
              join(directory, file.name),
              await archive.file(file.name)!.async("nodebuffer"),
            );
          }
        }
        Object.assign(
          entry,
          describeNpmQualificationProof({
            ...fixture,
            kind: entry.kind,
            releaseTag,
            directory,
            producer: entry.producer,
            artifact,
            preparedBundle: descriptor,
          }),
        );
      }
      const outputDir = join(tempDirs.make("npm-qualified-output-"), "qualified");
      const qualified = await qualifyNpmPackageBundle({
        descriptor,
        inputDir: fixture.outputDir,
        outputDir,
        producer: { ...fixture.producer, jobId: "50", jobName: "Qualify prepared npm package" },
        ...proof,
      });
      expect(qualified.releaseTag).toBe(expectedTag);
      expect(qualified.packageVersion).toBe(packageVersion);
      const params = { tag: expectedTag, targetSha: fixture.releaseRef, npmDistTag: "beta" };
      expect(() => validatePreflightManifest(qualified, params)).not.toThrow();
      expect(() => validatePreflightManifest(qualified, { ...params, tag: "v2026.8.1-3" })).toThrow(
        "npm preflight tag mismatch",
      );
      expect(
        JSON.parse(
          execFileSync(
            "tar",
            ["-xOf", join(outputDir, qualified.tarballName), "package/package.json"],
            { encoding: "utf8" },
          ),
        ).version,
      ).toBe(packageVersion);
      expect(readFileSync(join(outputDir, qualified.tarballName))).toEqual(
        readFileSync(join(fixture.outputDir, prepared.tarballName)),
      );
    },
  );

  it.each([
    ["missing base tag", "2026.8.1", undefined, false],
    ["base tag at another source", "2026.8.1", "different-source", false],
    ["different package base", "2026.8.2", "same-source", false],
    ["different requested source", "2026.8.1", "same-source", true],
  ] as const)(
    "rejects a correction with %s before packing",
    (_label, version, baseTag, wrongSource) => {
      const fixture = packageSourceFixture(version, baseTag);
      expect(() =>
        prepareNpmPackageBundle({
          ...fixture,
          releaseTag: "v2026.8.1-2",
          releaseRef: wrongSource ? "f".repeat(40) : fixture.releaseRef,
        }),
      ).toThrow();
      expect(fixture.runPack).not.toHaveBeenCalled();
      expect(existsSync(fixture.outputDir)).toBe(false);
    },
  );

  it("accepts descriptor JSON whose object keys were reordered without changing its contents", async () => {
    const { descriptor, files, manifest } = await bundleFixture();
    const reordered = JSON.parse(
      JSON.stringify(descriptor, (_key, value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).toReversed())
          : value,
      ),
    );
    expect(JSON.stringify(reordered.producer)).not.toBe(JSON.stringify(descriptor.producer));
    expect(verifyPreparedNpmBundleFiles({ descriptor: reordered, files })).toEqual(manifest);
  });

  it.each([undefined, "v2026.8.1"])(
    "qualifies exact package bytes with large SDK and npm lock evidence (release tag=%s)",
    async (releaseTag) => {
      const fixture = await bundleFixture();
      const directory = tempDirs.make("npm-bundle-");
      const inputDir = join(directory, "prepared");
      const outputDir = join(directory, "qualified");
      const downloaded = await downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir: inputDir,
        token: "test-token",
        npmDistTag: "beta",
        releaseTag,
      });
      expect(readFileSync(downloaded.tarballPath)).toEqual(
        fixture.files.get(fixture.manifest.tarballName),
      );
      const npmLocks = `${JSON.stringify({ packages: [{ lock: { packages: { "": { description: "x".repeat(3 * 1024 * 1024) } } } }] })}\n`;
      const dependencyReports = {
        ...Object.fromEntries(
          [
            "dependency-vulnerability-gate",
            "transitive-manifest-risk-report",
            "dependency-ownership-surface-report",
            "dependency-changes-report",
          ].flatMap((name) => [
            [`${name}.json`, {}],
            [`${name}.md`, "# Report\n"],
          ]),
        ),
        "dependency-evidence-summary.md": "# Dependency evidence\n",
        "npm-package-locks.json": npmLocks,
        "npm-package-locks.md": "# npm package-lock mirrors\n",
      };
      const proof = await qualificationFixture(
        fixture.descriptor,
        {
          baseline: "published",
          // Successful releases can carry multi-megabyte declaration diffs.
          diff: { exports: [{ before: "export type Previous = unknown;\n".repeat(150_000) }] },
        },
        dependencyReports,
      );
      const manifest = await qualifyNpmPackageBundle({
        descriptor: fixture.descriptor,
        inputDir,
        outputDir,
        producer: {
          ...fixture.descriptor.producer,
          jobId: "50",
          jobName: "Qualify prepared npm package",
        },
        ...proof,
      });
      expect(manifest.version).toBe(3);
      expect(manifest.preparedBundle).toEqual(fixture.descriptor);
      for (const [name, value] of Object.entries(dependencyReports)) {
        expect(readFileSync(join(outputDir, "dependency-evidence", name), "utf8")).toBe(
          typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
        );
      }
      for (const entry of [
        fixture.descriptor.package.fileName,
        ...fixture.descriptor.corePackages.map((pkg) => pkg.tarballName),
      ]) {
        expect(readFileSync(join(outputDir, entry))).toEqual(fixture.files.get(entry));
      }
      expect(
        describeNpmBundle({
          directory: outputDir,
          artifact: fixture.descriptor.artifact,
          qualified: true,
        }),
      ).toMatchObject({
        schema: "openclaw.qualified-npm-preflight/v1",
        source: { sha: sourceSha },
        preparedBundle: fixture.descriptor,
      });
    },
  );

  it("rejects a valid bundle for another publication tag before extracting artifacts", async () => {
    const fixture = await bundleFixture();
    const outputDir = join(tempDirs.make("npm-wrong-release-"), "output");
    await expect(
      downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir,
        token: "test-token",
        npmDistTag: "beta",
        releaseTag: "v2026.8.1-2",
      }),
    ).rejects.toThrow("release tag mismatch");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("rejects an unfinished package producer before downloading or extracting artifacts", async () => {
    const fixture = await bundleFixture();
    fixture.job.status = "in_progress";
    const outputDir = join(tempDirs.make("npm-unfinished-"), "output");
    await expect(
      downloadPreparedNpmBundle({
        ...fixture,
        repository,
        sourceSha,
        toolingSha,
        outputDir,
        token: "test-token",
        npmDistTag: "beta",
        releaseTag: fixture.manifest.releaseTag,
        fetchImpl: async () => {
          throw new Error("must not download before producer success");
        },
      }),
    ).rejects.toThrow("unique exact completed producer job");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("rejects a substituted tarball before sealing qualification", async () => {
    const fixture = await bundleFixture();
    const inputDir = tempDirs.make("npm-substitution-");
    for (const [name, bytes] of fixture.files) {
      writeFileSync(join(inputDir, name), bytes);
    }
    writeFileSync(join(inputDir, fixture.manifest.tarballName), "replacement archive");
    const outputDir = join(inputDir, "qualified");
    const proof = await qualificationFixture(fixture.descriptor);
    await expect(
      qualifyNpmPackageBundle({
        descriptor: fixture.descriptor,
        inputDir,
        outputDir,
        producer: {
          ...fixture.descriptor.producer,
          jobId: "50",
          jobName: "Qualify prepared npm package",
        },
        ...proof,
      }),
    ).rejects.toThrow("tarball digest mismatch");
    expect(existsSync(outputDir)).toBe(false);
  });

  it("rejects a descriptor for another source or reusable owner", async () => {
    const { descriptor } = await bundleFixture();
    expect(() =>
      validatePreparedNpmBundleDescriptor({
        descriptor,
        repository,
        sourceSha: "c".repeat(40),
        toolingSha,
      }),
    ).toThrow("source SHA mismatch");
    descriptor.producer.producerWorkflowPath = ".github/workflows/ci.yml";
    expect(() =>
      validatePreparedNpmBundleDescriptor({ descriptor, repository, sourceSha, toolingSha }),
    ).toThrow("trusted preflight owner");
  });

  it("requires source proof from its exact completed source-check job", async () => {
    const fixture = await bundleFixture();
    const descriptor = {
      schema: NPM_SOURCE_CHECK_SCHEMA,
      source: { sha: sourceSha },
      producer: { ...fixture.descriptor.producer, jobName: "Check npm release source" },
    };
    fixture.job.name = descriptor.producer.jobName;
    expect(
      verifyNpmSourceCheck({ descriptor, repository, sourceSha, toolingSha, runGh: fixture.runGh })
        .job.id,
    ).toBe(45);
    fixture.job.run_attempt = 1;
    expect(() =>
      verifyNpmSourceCheck({ descriptor, repository, sourceSha, toolingSha, runGh: fixture.runGh }),
    ).toThrow("unique exact completed producer job");
  });

  it.each([
    [
      "source check still running",
      (proof: QualificationFixture) => {
        proof.jobs[0]!.status = "in_progress";
      },
      "unique exact completed producer job",
    ],
    [
      "dependency check failed",
      (proof: QualificationFixture) => {
        proof.jobs[3]!.conclusion = "failure";
      },
      "unique exact completed producer job",
    ],
    [
      "SDK proof from another attempt",
      (proof: QualificationFixture) => {
        proof.jobs[2]!.run_attempt = 1;
      },
      "unique exact completed producer job",
    ],
    [
      "contents checked another tarball",
      (proof: QualificationFixture) => {
        proof.contentsProof.preparedBundle = structuredClone(proof.contentsProof.preparedBundle);
        proof.contentsProof.preparedBundle.package.sha256 = "f".repeat(64);
      },
      "Package contents proof input",
    ],
    [
      "dependency proof from another source",
      (proof: QualificationFixture) => {
        proof.dependencyProof.source = { sha: "c".repeat(40) };
      },
      "dependencies proof source",
    ],
    [
      "SDK archive replaced",
      (proof: QualificationFixture) => {
        const artifact = proof.archives.get("79")!;
        artifact.archive = Buffer.alloc(artifact.archive.length);
      },
      "GitHub Actions artifact digest",
    ],
    [
      "SDK proof rebound to another tag",
      (proof: QualificationFixture) => {
        proof.sdkProof.releaseTag = "v2026.8.1-2";
      },
      "sdk proof release tag",
    ],
  ] as const)("does not seal while %s", async (_name, mutate, expectedError) => {
    const fixture = await bundleFixture();
    const inputDir = tempDirs.make("npm-proof-input-");
    for (const [name, bytes] of fixture.files) {
      writeFileSync(join(inputDir, name), bytes);
    }
    const outputDir = join(inputDir, "qualified");
    const proof = await qualificationFixture(fixture.descriptor);
    mutate(proof);
    await expect(
      qualifyNpmPackageBundle({
        descriptor: fixture.descriptor,
        inputDir,
        outputDir,
        producer: {
          ...fixture.descriptor.producer,
          jobId: "50",
          jobName: "Qualify prepared npm package",
        },
        ...proof,
      }),
    ).rejects.toThrow(expectedError);
    expect(existsSync(outputDir)).toBe(false);
  });
});

it("admits the exact trusted full-release fresh candidate bundle from its separate npm producer run", async () => {
  const fixture = await bundleFixture(".github/workflows/full-release-artifacts.yml", toolingSha);
  const outputDir = join(tempDirs.make("candidate-npm-authority-"), "bundle");
  const result = await verifyCandidateNpmBundle({
    descriptor: fixture.descriptor,
    repository,
    candidateSha: toolingSha,
    workflowSha: toolingSha,
    workflowRef: "refs/heads/main",
    defaultBranch: "main",
    callerWorkflowSha: toolingSha,
    outputDir,
    token: "fixture-token",
    runGh: fixture.runGh,
    fetchImpl: fixture.fetchImpl,
  });
  expect(readFileSync(result.tarballPath)).toEqual(fixture.files.get(fixture.manifest.tarballName));
  const core = fixture.descriptor.corePackages[0];
  if (!core) {
    throw new Error("Expected core package fixture");
  }
  expect(readFileSync(join(result.coreTarballDir, core.tarballName))).toEqual(
    fixture.files.get(core.tarballName),
  );
  const gate = readFileSync("scripts/github/verify-candidate-image-authority.sh", "utf8");
  expect(gate).toContain('node "$(dirname "${BASH_SOURCE[0]}")/verify-candidate-npm-bundle.mjs"');
});

it.each([
  "candidate source",
  "isolated producer",
  "forged job",
  "producer run",
  "producer attempt",
  "artifact digest",
  "artifact run",
  "manifest source",
  "forged manifest source",
  "root bytes",
  "core bytes",
] as const)("rejects unproven prepared candidate bundle: %s", async (attack) => {
  const fixture = await bundleFixture(
    ".github/workflows/full-release-artifacts.yml",
    attack === "forged manifest source" ? sourceSha : toolingSha,
  );
  const descriptor = structuredClone(fixture.descriptor);
  if (attack === "forged manifest source") {
    descriptor.source.sha = toolingSha;
    descriptor.package.sourceSha = toolingSha;
  }
  let candidateSha = toolingSha;
  if (attack === "candidate source") {
    candidateSha = sourceSha;
  }
  if (attack === "isolated producer") {
    descriptor.producer.workflowRef = `${repository}/.github/workflows/full-release-artifacts.yml@refs/heads/isolated`;
  }
  if (attack === "forged job") {
    fixture.job.id = 46;
  }
  if (attack === "producer run") {
    fixture.run.id = 13;
  }
  if (attack === "producer attempt") {
    fixture.run.run_attempt = 3;
  }
  if (attack === "artifact digest") {
    fixture.metadata.digest = `sha256:${"f".repeat(64)}`;
  }
  if (attack === "artifact run") {
    fixture.metadata.workflow_run.id = 13;
  }
  if (attack === "manifest source") {
    descriptor.source.sha = sourceSha;
    descriptor.package.sourceSha = sourceSha;
  }
  if (attack === "root bytes") {
    descriptor.package.sha256 = "f".repeat(64);
  }
  if (attack === "core bytes") {
    const core = descriptor.corePackages[0];
    if (!core) {
      throw new Error("Expected core package fixture");
    }
    core.tarballSha256 = "f".repeat(64);
  }
  await expect(
    verifyCandidateNpmBundle({
      descriptor,
      repository,
      candidateSha,
      workflowSha: toolingSha,
      workflowRef: "refs/heads/main",
      defaultBranch: "main",
      callerWorkflowSha: toolingSha,
      outputDir: join(tempDirs.make("candidate-npm-denied-"), "bundle"),
      token: "fixture-token",
      runGh: fixture.runGh,
      fetchImpl: fixture.fetchImpl,
    }),
  ).rejects.toThrow();
});

it("runs the trusted LIVE candidate gate through the npm CLI and complete archive authority on a fresh miss", async () => {
  const root = tempDirs.make("fresh-candidate-gate-");
  const policy = join(root, ".candidate-policy");
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of [
    "github/classify-candidate-execution.mjs",
    "github/verify-candidate-image-authority.sh",
    "github/verify-candidate-npm-bundle.mjs",
    "github/verify-same-run-candidate-artifact.sh",
    "npm-prepared-bundle.mjs",
    "release-tooling-identity.mjs",
    "lib/actions-artifact-archive.mjs",
    "lib/record-shared.mjs",
    "lib/release-version.mjs",
    "lib/npm-core-release-packages.json",
  ]) {
    const target = join(policy, "scripts", name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve("scripts", name), target);
  }
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        policy,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: "0" } },
    ).trim();
  git("init", "--quiet", "-b", "main");
  git("add", ".");
  git("commit", "--quiet", "-m", "trusted gate");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", sha);
  const fixture = await bundleFixture(".github/workflows/full-release-artifacts.yml", sha, sha);
  for (const [name, value] of Object.entries({
    run: fixture.run,
    jobs: { total_count: 1, jobs: [fixture.job] },
    metadata: fixture.metadata,
  })) {
    writeFileSync(join(root, name), JSON.stringify(value));
  }
  writeFileSync(join(root, "archive"), fixture.archive);
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
 *jobs?*) cat "$FIXTURE_ROOT/jobs" ;;
 *actions/artifacts/*) cat "$FIXTURE_ROOT/metadata" ;;
 *) cat "$FIXTURE_ROOT/run" ;;
esac
`,
    { mode: 0o755 },
  );
  const preload = join(root, "fetch.mjs");
  writeFileSync(
    preload,
    `import { readFileSync } from "node:fs";
globalThis.fetch = async (url) => String(url).endsWith("/zip")
  ? new Response(readFileSync(process.env.FIXTURE_ROOT + "/archive"))
  : Response.json(JSON.parse(readFileSync(process.env.FIXTURE_ROOT + "/metadata", "utf8")));
`,
  );
  const live = parse(
    readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
  ) as {
    jobs: {
      candidate_execution: {
        steps: { name: string; run?: string; with?: Record<string, unknown> }[];
      };
    };
  };
  const checkout = live.jobs.candidate_execution.steps.find(
    (step) => step.name === "Checkout immutable candidate policy",
  );
  expect(checkout?.with?.["sparse-checkout"]).toBeUndefined();
  const gate = live.jobs.candidate_execution.steps.find(
    (step) => step.name === "Classify candidate before checkout or execution",
  )?.run;
  if (!gate) {
    throw new Error("Expected real candidate gate");
  }
  const result = spawnSync("bash", ["-c", gate], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${preload}`,
      FIXTURE_ROOT: root,
      CANDIDATE_REF: sha,
      WORKFLOW_SHA: sha,
      CALLER_WORKFLOW_SHA: sha,
      WORKFLOW_REF: "refs/heads/main",
      DEFAULT_BRANCH: "main",
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: "99",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_OUTPUT: join(root, "output"),
      ARTIFACT_ID: "",
      IMAGE_EXECUTION_SELECTED: "true",
      SHARED_IMAGE_POLICY: "no-push-artifact",
      PREPARED_NPM_BUNDLE_JSON: JSON.stringify(fixture.descriptor),
      GH_TOKEN: "fixture-token",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(root, "output"), "utf8")).toContain("privileged=true\n");
});

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const workflow = parse(readFileSync(".github/workflows/codeql-critical-quality.yml", "utf8")) as {
  on: { pull_request: { paths?: string[]; "paths-ignore"?: string[] } };
  jobs: Record<string, { steps: { id?: string; name: string; run?: string }[] }>;
};
const steps = [
  ...expectDefined(workflow.jobs["quality-shards"], "CodeQL shard selection job").steps,
  ...expectDefined(workflow.jobs["network-runtime-boundary"], "network CodeQL job").steps,
];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const qaOwner = "extensions/qa-lab/src/gateway-child-setup.ts";
const codexTransport = "extensions/codex/src/app-server/transport-websocket.ts";

function runStep(name: string, root: string, env: Record<string, string>) {
  const script = steps.find((step) => step.id === name || step.name === name)?.run;
  if (!script) {
    throw new Error(`Missing workflow script: ${name}`);
  }
  return spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, ...env },
    timeout: 10_000,
  });
}

function scan(
  files: { filename: string; previous_filename?: string; patch?: string | null }[],
  failCall = 0,
  response?: string,
  step = "network-diff-scan",
  declaredFileCount: number | null = files.length,
) {
  const root = tempDirs.make("codeql-network-scan-");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(root, "files.json"), response ?? JSON.stringify(files));
  writeFileSync(path.join(root, "calls"), "0");
  writeFileSync(path.join(root, "pr.json"), JSON.stringify({ changed_files: declaredFileCount }));
  const output = path.join(root, "output");
  writeFileSync(output, "");
  // Execute the workflow's own jq filters, replacing only the GitHub API boundary.
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]]
call=$(( $(cat calls) + 1 ))
echo "$call" > calls
if [[ "$call" == "$FAIL_CALL" ]]; then
  echo "synthetic GitHub fetch failure" >&2
  exit 7
fi
if [[ "$2" == repos/openclaw/openclaw/pulls/123 ]]; then
  [[ "$#" == 4 && "$3" == --jq ]]
  exec jq -er "$4" pr.json
fi
[[ "$2" == --paginate && "$3" == repos/openclaw/openclaw/pulls/123/files ]]
if [[ "$#" == 3 ]]; then
  cat files.json
else
  [[ "$#" == 5 && "$4" == --jq ]]
  exec jq -r "$5" files.json
fi
`,
    { mode: 0o755 },
  );
  const result = runStep(step, root, {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    PR_NUMBER: "123",
    REPOSITORY: "openclaw/openclaw",
    GITHUB_OUTPUT: output,
    FAIL_CALL: String(failCall),
    EVENT_NAME: "pull_request",
  });
  return {
    result,
    output: readFileSync(output, "utf8"),
    calls: Number(readFileSync(path.join(root, "calls"), "utf8")),
  };
}

describe("network CodeQL PR routing", () => {
  it("admits PRs before applying complete security path selection", () => {
    expect(workflow.on.pull_request.paths).toBeUndefined();
    expect(workflow.on.pull_request["paths-ignore"]).toBeUndefined();
  });

  it.each(["network-diff-scan", "detect"])(
    "requires full coverage when the PR file list is truncated in %s",
    (step) => {
      const files = Array.from({ length: 3000 }, (_, index) => ({ filename: `docs/${index}.md` }));
      const { result, output } = scan(files, 0, undefined, step, 18360);
      expect(result.status, result.stderr).toBe(0);
      const selections = output.trim().split("\n");
      expect(selections.length).toBeGreaterThan(0);
      expect(selections.every((selection) => selection.endsWith("=true"))).toBe(true);
    },
  );

  it.each(["network-diff-scan", "detect"])(
    "requires full coverage for an incomplete list below the API cap in %s",
    (step) => {
      const { result, output } = scan([{ filename: "docs/example.md" }], 0, undefined, step, 2);
      expect(result.status, result.stderr).toBe(0);
      expect(
        output
          .trim()
          .split("\n")
          .every((selection) => selection.endsWith("=true")),
      ).toBe(true);
    },
  );

  it.each(["network-diff-scan", "detect"])(
    "keeps the original security boundary when a file is renamed away in %s",
    (step) => {
      const { result, output } = scan(
        [{ filename: "docs/removed.txt", previous_filename: "src/infra/net/client.ts", patch: "" }],
        0,
        undefined,
        step,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(output.split("\n")).toContain(
        step === "detect" ? "network_runtime=true" : "full_codeql=true",
      );
    },
  );

  it.each(["network-diff-scan", "detect"])(
    "fails closed when the declared file count is unavailable in %s",
    (step) => {
      const { result, output } = scan([], 0, undefined, step, null);
      expect(result.status).not.toBe(0);
      expect(output).toBe("");
    },
  );

  it.each([
    ["tests/network-runtime/packages/net-policy/src/client.ts", true],
    ["tests/unrelated/example.qlref", false],
    ["tests/network-runtime-extra/example.qlref", false],
  ])("selects the network shard only for its own semantic fixtures: %s", (file, selected) => {
    const { result, output } = scan(
      [{ filename: `.github/codeql/openclaw-boundary/${file}` }],
      0,
      undefined,
      "detect",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(output.split("\n")).toContain(`network_runtime=${selected}`);
  });

  it.each([
    ["ordinary network change", qaOwner, "+const ready = true;", false],
    ["unrelated source", "src/example.ts", '+import net from "node:net";', false],
    [
      "test-only import",
      "extensions/qa-lab/src/example.e2e.test.tsx",
      '+import net from "node:net";',
      false,
    ],
    ["removed import", qaOwner, '-import net from "node:net";', false],
    ["net import", qaOwner, '+import net from "node:net";', true],
    ["tls require", "extensions/irc/src/client.ts", '+const tls = require("tls");', true],
    ["http2 import", "src/infra/push-apns-http2.ts", '+import http2 from "node:http2";', true],
    ["raw connection", "src/infra/net/client.ts", "+net.createConnection(options);", true],
    ["socket constructor", "src/infra/jsonl-socket.ts", "+new Socket();", true],
    [
      "transport path as data",
      "packages/net-policy/src/client.ts",
      `+net.connect(options); // ${codexTransport}: `,
      true,
    ],
    [
      "unrelated query",
      ".github/codeql/openclaw-boundary/queries/example.ql",
      "+select example",
      false,
    ],
    [
      "similar query name",
      ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql.bak",
      "+select example",
      false,
    ],
  ])("routes %s", (_name, filename, patch, fullCodeql) => {
    const { result, output } = scan([{ filename, patch }]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe(`full_codeql=${fullCodeql}`);
  });

  it.each([undefined, null])("routes unavailable patches (%s) by source scope", (patch) => {
    for (const [filename, fullCodeql] of [
      [qaOwner, true],
      ["packages/net-policy/src/client.ts", true],
      ["src/infra/net/client.ts", true],
      ["extensions/qa-lab/src/example.e2e.test.tsx", false],
      ["src/infra/net/client.test.ts", false],
      ["src/example.ts", false],
    ] as const) {
      const { result, output } = scan([{ filename, ...(patch === undefined ? {} : { patch }) }]);
      expect(result.status, result.stderr).toBe(0);
      expect(output.trim(), filename).toBe(`full_codeql=${fullCodeql}`);
    }
  });

  it.each(["network-diff-scan", "detect"])("consumes one paginated snapshot in %s", (step) => {
    const response = `${JSON.stringify([{ filename: "src/example.ts", patch: "+const ok = true;" }])}\n${JSON.stringify([{ filename: qaOwner, patch: null }])}`;
    const { result, output, calls } = scan([], 0, response, step, 2);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toBe(2);
    expect(output.split("\n")).toContain(
      step === "detect" ? "network_runtime=true" : "full_codeql=true",
    );
  });

  it.each([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "OPENCLAW_PROXY_ACTIVE",
  ])("escalates added %s references", (key) => {
    const { result, output } = scan([
      { filename: "src/infra/net/proxy/proxy-lifecycle.ts", patch: `+process.env.${key} = value;` },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it.each([
    ".github/codeql/codeql-network-runtime-boundary-critical-quality.yml",
    ".github/codeql/openclaw-boundary/queries/raw-socket-callsite-classification.ql",
    ".github/codeql/openclaw-boundary/queries/managed-proxy-runtime-mutation.ql",
    ".github/codeql/openclaw-boundary/tests/network-runtime/raw-socket-callsite-classification.qlref",
    codexTransport,
  ])("always escalates contract owner %s", (filename) => {
    const { result, output } = scan([{ filename }]);
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it("keeps semantic escalation when a contract edit also adds proxy policy tokens", () => {
    const { result, output } = scan([
      { filename: codexTransport, patch: "+process.env.HTTP_PROXY = value;" },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(output.trim()).toBe("full_codeql=true");
  });

  it.each(["network-diff-scan", "detect"])(
    "fails closed when GitHub metadata fails in %s",
    (step) => {
      const { result, output } = scan(
        [{ filename: qaOwner, patch: "+const ready = true;" }],
        1,
        undefined,
        step,
      );
      expect(result.status).toBe(7);
      expect(result.stderr).toContain("synthetic GitHub fetch failure");
      expect(output).toBe("");
    },
  );

  it.each(["network-diff-scan", "detect"])("fails closed on malformed metadata in %s", (step) => {
    const { result, output } = scan([], 0, "{", step);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("parse error");
    expect(output).toBe("");
  });
});

describe("network CodeQL findings gate", () => {
  it.each([
    ["clean SARIF", JSON.stringify({ runs: [{ results: [] }] }), true],
    [
      "error finding",
      JSON.stringify({
        runs: [{ results: [{ level: "error", message: { text: "unclassified socket" } }] }],
      }),
      false,
    ],
    [
      "warning finding",
      JSON.stringify({
        runs: [{ results: [{ level: "warning", message: { text: "proxy mutation" } }] }],
      }),
      false,
    ],
    ["missing SARIF", undefined, false],
    ["invalid SARIF", "{", false],
  ])("enforces %s", (_name, sarif, succeeds) => {
    const root = tempDirs.make("codeql-network-findings-");
    if (sarif !== undefined) {
      writeFileSync(path.join(root, "result.sarif"), sarif);
    }
    const result = runStep("Fail on network runtime boundary findings", root, {
      SARIF_OUTPUT: root,
    });
    expect(result.error).toBeUndefined();
    expect(result.status === 0, result.stderr).toBe(succeeds);
  });
});

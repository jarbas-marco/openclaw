import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { CodexAppServerClient } from "./client.js";
import {
  createNativeRunParams as createParams,
  runCodexAppServerAttempt,
  seedRunSessionOwnerForTest,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  resetSharedCodexAppServerClientForTests,
  retainSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();

describe("Codex app-server failed thread retirement", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });
  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  it("gracefully retires a shared Codex client when a failed turn cannot unsubscribe", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionKey = "agent:main:dashboard:incognito-failed-unsubscribe";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    const contaminated = createClientHarness();
    const replacement = createClientHarness();
    const startClient = vi
      .spyOn(CodexAppServerClient, "start")
      .mockResolvedValueOnce(contaminated.client)
      .mockResolvedValueOnce(replacement.client);

    const failedRun = runCodexAppServerAttempt(
      createParams(sessionFile, workspaceDir, sessionKey),
      { bindingStore: testCodexAppServerBindingStore },
    );
    const observedFailure = failedRun.then(
      () => undefined,
      (error: unknown) => error,
    );
    const initialize = await waitForHarnessRequest(contaminated, "initialize");
    contaminated.send({
      id: initialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const threadStart = await waitForHarnessRequest(contaminated, "thread/start");
    contaminated.send({ id: threadStart.id, result: threadStartResult() });

    const turnStart = await waitForHarnessRequest(contaminated, "turn/start");
    const releaseSiblingLease = retainSharedCodexAppServerClientIfCurrent(contaminated.client);
    if (!releaseSiblingLease) {
      throw new Error("Codex harness did not acquire the real shared client");
    }
    contaminated.send({
      id: turnStart.id,
      error: { code: -32000, message: "turn start exploded" },
    });
    const unsubscribe = await waitForHarnessRequest(contaminated, "thread/unsubscribe");
    contaminated.send({
      id: unsubscribe.id,
      error: { code: -32000, message: "thread unsubscribe failed" },
    });

    const turnStartError = await observedFailure;
    expect(turnStartError).toBeInstanceOf(Error);
    expect(turnStartError).toMatchObject({ message: "turn start exploded" });
    expect(contaminated.stdinDestroyed).toBe(false);
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();

    const replacementRun = runCodexAppServerAttempt(
      createParams(sessionFile, workspaceDir, sessionKey),
      { bindingStore: testCodexAppServerBindingStore },
    );
    const replacementInitialize = await waitForHarnessRequest(replacement, "initialize");
    replacement.send({
      id: replacementInitialize.id,
      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
    });
    const replacementThread = await waitForHarnessRequest(replacement, "thread/start");
    replacement.send({ id: replacementThread.id, result: threadStartResult("thread-2") });
    const replacementTurn = await waitForHarnessRequest(replacement, "turn/start");
    replacement.send({ id: replacementTurn.id, result: turnStartResult("turn-2") });
    replacement.send({
      method: "turn/completed",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        turn: { id: "turn-2", status: "completed" },
      },
    });

    expect(readAttemptTerminal(await replacementRun)).toMatchObject({
      aborted: false,
      timedOut: false,
    });
    expect(startClient).toHaveBeenCalledTimes(2);
    expect(contaminated.stdinDestroyed).toBe(false);
    releaseSiblingLease();
    await vi.waitFor(() => expect(contaminated.stdinDestroyed).toBe(true), {
      interval: 1,
      timeout: 5_000,
    });
  });
});

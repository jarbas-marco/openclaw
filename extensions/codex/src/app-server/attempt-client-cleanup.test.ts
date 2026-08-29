// Codex tests cover attempt client cleanup plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  interruptCodexTurnBestEffort,
  stopCodexTurnAndBackgroundTerminalsBestEffort,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import { createClientHarness } from "./test-support.js";

describe("Codex app-server attempt client cleanup", () => {
  it("interrupts turns with optional request timeout", () => {
    const request = vi.fn(async () => ({}));

    interruptCodexTurnBestEffort({ request } as never, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 123,
    });

    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 123 },
    );
  });

  it("swallows unsubscribe cleanup failures", async () => {
    const request = vi.fn(async () => {
      throw new Error("already gone");
    });

    await expect(
      unsubscribeCodexThreadBestEffort({ request } as never, {
        threadId: "thread-1",
        timeoutMs: 123,
      }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 123 },
    );
  });

  it("waits for interruption before cleaning background terminals", async () => {
    const harness = createClientHarness();
    const cleanup = stopCodexTurnAndBackgroundTerminalsBestEffort(harness.client, {
      threadId: "thread-1",
      turnId: "turn-1",
      timeoutMs: 123,
    });
    const interrupt = JSON.parse(harness.writes[0] ?? "{}") as { id?: number | string };
    harness.send({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "interrupted" },
      },
    });
    harness.send({ id: interrupt.id, result: {} });
    await vi.waitFor(() => expect(harness.writes).toHaveLength(2));
    const clean = JSON.parse(harness.writes[1] ?? "{}") as {
      id?: number | string;
      method?: string;
    };
    expect(clean.method).toBe("thread/backgroundTerminals/clean");
    harness.send({ id: clean.id, result: {} });

    await expect(cleanup).resolves.toBe(true);
    harness.client.close();
  });
});

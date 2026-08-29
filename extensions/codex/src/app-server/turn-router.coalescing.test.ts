import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

const COALESCIBLE_DELTA_CASES: Array<{
  metadata: Record<string, number>;
  method: string;
}> = [
  { method: "item/agentMessage/delta", metadata: {} },
  { method: "item/reasoning/summaryTextDelta", metadata: { summaryIndex: 0 } },
  { method: "item/reasoning/textDelta", metadata: { contentIndex: 0 } },
  { method: "item/plan/delta", metadata: {} },
  { method: "item/commandExecution/outputDelta", metadata: {} },
];

describe("CodexAppServerTurnRouter delta coalescing", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("coalesces adjacent queued deltas without losing receipt or control events", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const received: string[] = [];
    const handled: Array<{ method: string; delta?: string }> = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-coalesced",
      onNotificationReceived: (notification) => {
        received.push(notification.method);
      },
      onNotification: async (notification) => {
        handled.push(summarizeNotification(notification));
        if (notification.method === "item/started") {
          await firstReleased;
        }
      },
    });
    harness.send({
      method: "item/started",
      params: {
        threadId: "thread-coalesced",
        turnId: "turn-coalesced",
        item: { id: "message-coalesced", type: "agentMessage" },
      },
    });
    await vi.waitFor(() => expect(handled).toHaveLength(1));

    const deltas = Array.from({ length: 100 }, (_, index) => `[${index}]`);
    for (const delta of deltas) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-coalesced",
          turnId: "turn-coalesced",
          itemId: "message-coalesced",
          delta,
        },
      });
    }
    harness.send({
      method: "item/completed",
      params: {
        threadId: "thread-coalesced",
        turnId: "turn-coalesced",
        item: { id: "message-coalesced", type: "agentMessage" },
      },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(received).toHaveLength(102);
    releaseFirst();
    await route.drain();
    expect(handled).toEqual([
      { method: "item/started" },
      { method: "item/agentMessage/delta", delta: deltas.join("") },
      { method: "item/completed" },
    ]);
  });

  it("keeps coalescing with the native monitor while an RPC bypasses backpressure", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const monitorRegistration = codexNativeSubagentMonitorRuntime.register({
      client: harness.client,
      parentThreadId: "thread-coalesced-rpc",
    });
    let received = 0;
    const handled: Array<{ method: string; delta?: string }> = [];
    let startRpc!: () => void;
    const rpcMayStart = new Promise<void>((resolve) => {
      startRpc = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-coalesced-rpc",
      onNotificationReceived: () => {
        received += 1;
      },
      onNotification: async (notification) => {
        handled.push(summarizeNotification(notification));
        if (notification.method === "item/started") {
          await rpcMayStart;
          await harness.client.request("model/list", {});
        }
      },
    });
    harness.send({
      method: "item/started",
      params: {
        threadId: "thread-coalesced-rpc",
        turnId: "turn-coalesced-rpc",
        item: { id: "message-coalesced-rpc", type: "agentMessage" },
      },
    });
    await vi.waitFor(() => expect(handled).toHaveLength(1));

    const notificationCount = 512;
    for (let index = 0; index < notificationCount; index += 1) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-coalesced-rpc",
          turnId: "turn-coalesced-rpc",
          itemId: "message-coalesced-rpc",
          delta: "x",
        },
      });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(received).toBeLessThan(notificationCount + 1);
    expect(harness.process.stdout.isPaused()).toBe(true);

    startRpc();
    let rpcRequest: { id?: number | string; method?: string } | undefined;
    await vi.waitFor(() => {
      rpcRequest = harness.writes
        .map((write) => JSON.parse(write) as { id?: number | string; method?: string })
        .find((message) => message.method === "model/list");
      expect(rpcRequest?.id).toBeDefined();
      expect(received).toBe(notificationCount + 1);
    });
    harness.send({ id: rpcRequest?.id, result: { data: [] } });

    await route.drain();
    expect(handled[0]).toEqual({ method: "item/started" });
    const deltaChunks = handled.slice(1).map((entry) => entry.delta ?? "");
    expect(deltaChunks.map((chunk) => chunk.length)).toEqual([256, 256]);
    expect(deltaChunks.join("")).toBe("x".repeat(notificationCount));
    await vi.waitFor(() => expect(harness.process.stdout.isPaused()).toBe(false));
    expect(harness.process.stdin.destroyed).toBe(false);
    monitorRegistration.unregister();
  });

  it("preserves a route across a large non-coalescible burst during an RPC", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const request = harness.client.request("model/list", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number | string };
    let handled = 0;
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-bounded-controls",
      onNotification: async () => {
        handled += 1;
      },
    });

    const notificationCount = 768;
    for (let index = 0; index < notificationCount; index += 1) {
      harness.send({
        method: "item/started",
        params: {
          threadId: "thread-bounded-controls",
          turnId: "turn-bounded-controls",
          item: { id: `item-${index}`, type: "agentMessage" },
        },
      });
    }

    expect(route.signal.aborted).toBe(false);
    harness.send({ id: outbound.id, result: { data: [] } });
    await expect(request).resolves.toEqual({ data: [] });
    await route.drain();
    expect(handled).toBe(notificationCount);
    expect(route.signal.aborted).toBe(false);
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("bounds empty-delta chunks while preserving every original receipt", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const request = harness.client.request("model/list", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number | string };
    let received = 0;
    const handled: Array<{ method: string; delta?: string }> = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-empty-deltas",
      onNotificationReceived: () => {
        received += 1;
      },
      onNotification: async (notification) => {
        handled.push(summarizeNotification(notification));
        if (notification.method === "item/started") {
          await firstReleased;
        }
      },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-empty-deltas", turnId: "turn-empty-deltas" },
    });

    const notificationCount = 600;
    for (let index = 0; index < notificationCount; index += 1) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-empty-deltas",
          turnId: "turn-empty-deltas",
          itemId: "message-empty-deltas",
          delta: "",
        },
      });
    }

    expect(received).toBe(notificationCount + 1);
    harness.send({ id: outbound.id, result: { data: [] } });
    await expect(request).resolves.toEqual({ data: [] });
    releaseFirst();
    await route.drain();
    expect(handled).toEqual([
      { method: "item/started" },
      { method: "item/agentMessage/delta", delta: "" },
      { method: "item/agentMessage/delta", delta: "" },
      { method: "item/agentMessage/delta", delta: "" },
    ]);
    expect(route.signal.aborted).toBe(false);
  });

  it.each(COALESCIBLE_DELTA_CASES)(
    "coalesces adjacent $method events with equivalent metadata",
    async ({ method, metadata }) => {
      const harness = createClientHarness();
      clients.push(harness.client);
      const handled: Array<{ method: string; delta?: string }> = [];
      let releaseFirst!: () => void;
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
        threadId: "thread-method-matrix",
        onNotification: async (notification) => {
          handled.push(summarizeNotification(notification));
          if (notification.method === "item/started") {
            await firstReleased;
          }
        },
      });
      harness.send({
        method: "item/started",
        params: { threadId: "thread-method-matrix", turnId: "turn-method-matrix" },
      });
      await vi.waitFor(() => expect(handled).toHaveLength(1));

      for (const delta of ["a", "b"]) {
        harness.send({
          method,
          params: {
            threadId: "thread-method-matrix",
            turnId: "turn-method-matrix",
            itemId: "item-method-matrix",
            ...metadata,
            delta,
          },
        });
      }

      releaseFirst();
      await route.drain();
      expect(handled).toEqual([{ method: "item/started" }, { method, delta: "ab" }]);
    },
  );

  it("keeps adjacent deltas for different items separate and ordered", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const handled: Array<{ method: string; delta?: string }> = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-distinct-items",
      onNotification: async (notification) => {
        handled.push(summarizeNotification(notification));
        if (notification.method === "item/started") {
          await firstReleased;
        }
      },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-distinct-items", turnId: "turn-distinct-items" },
    });
    await vi.waitFor(() => expect(handled).toHaveLength(1));

    for (const [itemId, delta] of [
      ["message-a", "a"],
      ["message-b", "b"],
      ["message-a", "c"],
    ]) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-distinct-items",
          turnId: "turn-distinct-items",
          itemId,
          delta,
        },
      });
    }

    releaseFirst();
    await route.drain();
    expect(handled).toEqual([
      { method: "item/started" },
      { method: "item/agentMessage/delta", delta: "a" },
      { method: "item/agentMessage/delta", delta: "b" },
      { method: "item/agentMessage/delta", delta: "c" },
    ]);
  });

  it.each([
    ["item/reasoning/summaryTextDelta", "summaryIndex"],
    ["item/reasoning/textDelta", "contentIndex"],
  ])("keeps adjacent %s events with different %s values separate", async (method, indexKey) => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const handled: Array<{ method: string; delta?: string }> = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-distinct-indexes",
      onNotification: async (notification) => {
        handled.push(summarizeNotification(notification));
        if (notification.method === "item/started") {
          await firstReleased;
        }
      },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-distinct-indexes", turnId: "turn-distinct-indexes" },
    });
    await vi.waitFor(() => expect(handled).toHaveLength(1));

    for (const [index, delta] of [
      [0, "a"],
      [1, "b"],
      [0, "c"],
    ] as const) {
      harness.send({
        method,
        params: {
          threadId: "thread-distinct-indexes",
          turnId: "turn-distinct-indexes",
          itemId: "reasoning-distinct-indexes",
          [indexKey]: index,
          delta,
        },
      });
    }

    releaseFirst();
    await route.drain();
    expect(handled).toEqual([
      { method: "item/started" },
      { method, delta: "a" },
      { method, delta: "b" },
      { method, delta: "c" },
    ]);
  });
});

function summarizeNotification(notification: CodexServerNotification): {
  method: string;
  delta?: string;
} {
  const delta = isJsonObject(notification.params) ? notification.params.delta : undefined;
  return {
    method: notification.method,
    ...(typeof delta === "string" ? { delta } : {}),
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";
import { getCodexAppServerTurnRouter } from "./turn-router.js";

describe("Codex app-server turn router coalescing", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("coalesces adjacent deltas without changing their text", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const notifications: Array<{ method: string; delta?: unknown }> = [];
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-coalesce",
      onNotification: (notification) => {
        const params = notification.params as { delta?: unknown } | undefined;
        notifications.push({ method: notification.method, delta: params?.delta });
      },
    });

    for (let index = 0; index < 100; index += 1) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-coalesce",
          turnId: "turn-coalesce",
          itemId: "item-coalesce",
          delta: String(index % 10),
        },
      });
    }
    await route.drain();

    expect(notifications).toEqual([
      { method: "item/agentMessage/delta", delta: "0123456789".repeat(10) },
    ]);
  });

  it("does not coalesce across control notifications or different metadata", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const methods: string[] = [];
    const deltas: unknown[] = [];
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-order",
      onNotification: (notification) => {
        methods.push(notification.method);
        deltas.push((notification.params as { delta?: unknown } | undefined)?.delta);
      },
    });
    harness.send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-order", turnId: "turn-order", itemId: "a", delta: "A" },
    });
    harness.send({
      method: "item/started",
      params: { threadId: "thread-order", turnId: "turn-order", item: { id: "control" } },
    });
    harness.send({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-order", turnId: "turn-order", itemId: "b", delta: "B" },
    });
    await route.drain();

    expect(methods).toEqual(["item/agentMessage/delta", "item/started", "item/agentMessage/delta"]);
    expect(deltas).toEqual(["A", undefined, "B"]);
  });

  it("bounds coalescing by chunk count and byte-sized string length", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const deltas: string[] = [];
    const route = getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-bounds",
      onNotification: (notification) => {
        deltas.push(String((notification.params as { delta?: unknown }).delta ?? ""));
      },
    });
    for (let index = 0; index < 300; index += 1) {
      harness.send({
        method: "item/plan/delta",
        params: { threadId: "thread-bounds", turnId: "turn-bounds", itemId: "p", delta: "" },
      });
    }
    harness.send({
      method: "item/plan/delta",
      params: {
        threadId: "thread-bounds",
        turnId: "turn-bounds",
        itemId: "large",
        delta: "x".repeat(40 * 1024),
      },
    });
    harness.send({
      method: "item/plan/delta",
      params: {
        threadId: "thread-bounds",
        turnId: "turn-bounds",
        itemId: "large",
        delta: "y".repeat(40 * 1024),
      },
    });
    await route.drain();
    await vi.waitFor(() => expect(deltas).toHaveLength(4));
    expect(deltas.slice(0, 2)).toEqual(["", ""]);
    expect(deltas[2]).toHaveLength(40 * 1024);
    expect(deltas[3]).toHaveLength(40 * 1024);
  });

  it("preserves a long ordered control burst", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const ids: number[] = [];
    getCodexAppServerTurnRouter(harness.client).reserveThread({
      threadId: "thread-controls",
      onNotification: (notification) => {
        const item = (notification.params as { item?: { id?: number } }).item;
        if (typeof item?.id === "number") {
          ids.push(item.id);
        }
      },
    });
    for (let index = 0; index < 768; index += 1) {
      harness.send({
        method: "item/started",
        params: { threadId: "thread-controls", turnId: "turn-controls", item: { id: index } },
      });
    }

    await vi.waitFor(() => expect(ids).toHaveLength(768));
    expect(ids).toEqual(Array.from({ length: 768 }, (_, index) => index));
  });
});

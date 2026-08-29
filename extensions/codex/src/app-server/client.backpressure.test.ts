import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

describe("CodexAppServerClient notification backpressure", () => {
  const clients: CodexAppServerClient[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("pauses notification ingress while async handlers are backlogged", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    let releaseHandlers!: () => void;
    const handlersReleased = new Promise<void>((resolve) => {
      releaseHandlers = resolve;
    });
    let started = 0;
    harness.client.addNotificationHandler(async () => {
      started += 1;
      await handlersReleased;
    });

    const notificationCount = 512;
    for (let index = 0; index < notificationCount; index += 1) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-backpressure",
          turnId: "turn-backpressure",
          itemId: "message-backpressure",
          delta: String(index),
        },
      });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    try {
      expect(started).toBeGreaterThan(0);
      expect(started).toBeLessThan(notificationCount);
      expect(harness.process.stdout.isPaused()).toBe(true);
    } finally {
      releaseHandlers();
    }

    await vi.waitFor(() => expect(started).toBe(notificationCount));
    expect(harness.process.stdout.isPaused()).toBe(false);
  });

  it("keeps RPC responses flowing while notification ingress is backpressured", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    let startRpc!: () => void;
    const rpcMayStart = new Promise<void>((resolve) => {
      startRpc = resolve;
    });
    let started = 0;
    let rpcCompleted = false;
    let sharedCompletion: Promise<void> | undefined;
    harness.client.addNotificationHandler(() => {
      started += 1;
      sharedCompletion ??= (async () => {
        await rpcMayStart;
        await harness.client.request("model/list", {});
        rpcCompleted = true;
      })();
      return sharedCompletion;
    });

    for (let index = 0; index < 512; index += 1) {
      harness.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-rpc-backpressure",
          turnId: "turn-rpc-backpressure",
          itemId: "message-rpc-backpressure",
          delta: String(index),
        },
      });
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(harness.process.stdout.isPaused()).toBe(true);

    startRpc();
    let rpcRequest: { id?: number | string; method?: string } | undefined;
    await vi.waitFor(() => {
      rpcRequest = harness.writes
        .map((write) => JSON.parse(write) as { id?: number | string; method?: string })
        .find((message) => message.method === "model/list");
      expect(rpcRequest?.id).toBeDefined();
    });
    expect(harness.process.stdout.isPaused()).toBe(false);
    harness.send({ id: rpcRequest?.id, result: { data: [] } });
    await vi.waitFor(() => expect(rpcCompleted).toBe(true));

    await vi.waitFor(() => expect(started).toBe(512));
    await vi.waitFor(() => expect(harness.process.stdout.isPaused()).toBe(false));
  });

  it("bounds independent completions during an RPC without closing the client", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    const releaseHandlers: Array<() => void> = [];
    harness.client.addNotificationHandler(
      () =>
        new Promise<void>((resolve) => {
          releaseHandlers.push(resolve);
        }),
    );
    const request = harness.client.request("model/list", {});
    const outbound = JSON.parse(harness.writes[0] ?? "{}") as { id?: number | string };
    let requestSettled = false;
    void request.finally(() => {
      requestSettled = true;
    });

    for (let index = 0; index < 1_024; index += 1) {
      harness.send({
        method: "item/started",
        params: {
          threadId: "thread-independent-completions",
          turnId: "turn-independent-completions",
          item: { id: `item-${index}`, type: "agentMessage" },
        },
      });
    }
    harness.send({ id: outbound.id, result: { data: [] } });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(releaseHandlers).toHaveLength(1_024);
    expect(harness.process.stdout.isPaused()).toBe(true);
    expect(requestSettled).toBe(false);
    expect(harness.process.stdin.destroyed).toBe(false);

    for (const release of releaseHandlers) {
      release();
    }
    await expect(request).resolves.toEqual({ data: [] });
    await vi.waitFor(() => expect(harness.process.stdout.isPaused()).toBe(false));
    expect(harness.process.stdin.destroyed).toBe(false);
  });

  it("times out an RPC that cannot reach its response through the bounded bypass", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    const releaseHandlers: Array<() => void> = [];
    harness.client.addNotificationHandler(
      () =>
        new Promise<void>((resolve) => {
          releaseHandlers.push(resolve);
        }),
    );
    const request = harness.client.request("model/list", {});
    const rejected = expect(request).rejects.toThrow("model/list timed out");

    for (let index = 0; index < 1_024; index += 1) {
      harness.send({
        method: "item/started",
        params: {
          threadId: "thread-stalled-rpc",
          turnId: "turn-stalled-rpc",
          item: { id: `item-${index}`, type: "agentMessage" },
        },
      });
    }

    expect(harness.process.stdout.isPaused()).toBe(true);
    expect(harness.process.stdin.destroyed).toBe(false);
    const secondRequest = harness.client.request("thread/list", {});
    const secondRejected = expect(secondRequest).rejects.toThrow("thread/list timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([rejected, secondRejected]);
    expect(harness.process.stdin.destroyed).toBe(false);

    for (const release of releaseHandlers) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.process.stdout.isPaused()).toBe(false);
  });

  it("arms a deadline when one input chunk overshoots before its handler starts an RPC", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    let startRpc!: () => void;
    const rpcMayStart = new Promise<void>((resolve) => {
      startRpc = resolve;
    });
    let releaseOtherHandlers!: () => void;
    const otherHandlersReleased = new Promise<void>((resolve) => {
      releaseOtherHandlers = resolve;
    });
    let first = true;
    let rpc: Promise<unknown> | undefined;
    harness.client.addNotificationHandler(() => {
      if (!first) {
        return otherHandlersReleased;
      }
      first = false;
      return (async () => {
        await rpcMayStart;
        rpc = harness.client.request("model/list", {});
        await rpc;
      })();
    });
    const input = Array.from({ length: 1_200 }, (_, index) =>
      JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-single-chunk",
          turnId: "turn-single-chunk",
          item: { id: `item-${index}`, type: "agentMessage" },
        },
      }),
    ).join("\n");

    harness.process.stdout.write(`${input}\n`);
    expect(harness.process.stdout.isPaused()).toBe(true);
    startRpc();
    await vi.advanceTimersByTimeAsync(0);
    if (!rpc) {
      throw new Error("notification handler did not start its RPC");
    }
    const rejected = expect(rpc).rejects.toThrow("model/list timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(harness.process.stdin.destroyed).toBe(false);

    releaseOtherHandlers();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.process.stdout.isPaused()).toBe(false);
  });

  it("reopens normal-pause headroom for a new RPC inside the hysteresis band", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    const releaseHandlers: Array<() => void> = [];
    harness.client.addNotificationHandler(
      () =>
        new Promise<void>((resolve) => {
          releaseHandlers.push(resolve);
        }),
    );
    const controller = new AbortController();
    const firstRequest = harness.client.request("model/list", {}, { signal: controller.signal });
    const firstRejected = expect(firstRequest).rejects.toThrow("model/list aborted");
    for (let index = 0; index < 1_024; index += 1) {
      harness.send({
        method: "item/started",
        params: {
          threadId: "thread-hysteresis",
          turnId: "turn-hysteresis",
          item: { id: `item-${index}`, type: "agentMessage" },
        },
      });
    }
    expect(harness.process.stdout.isPaused()).toBe(true);

    for (const release of releaseHandlers.slice(0, 224)) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await firstRejected;
    expect(harness.process.stdout.isPaused()).toBe(true);

    const secondRequest = harness.client.request("thread/list", {});
    const secondOutbound = JSON.parse(harness.writes.at(-1) ?? "{}") as {
      id?: number | string;
    };
    expect(harness.process.stdout.isPaused()).toBe(false);
    harness.send({ id: secondOutbound.id, result: { data: [] } });
    await expect(secondRequest).resolves.toEqual({ data: [] });

    for (const release of releaseHandlers.slice(224)) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.process.stdout.isPaused()).toBe(false);
  });
});

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
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    harness.client.addNotificationHandler(async () => {
      started += 1;
      await released;
    });

    for (let index = 0; index < 512; index += 1) {
      harness.send({ method: "item/started", params: { threadId: "t", item: { id: index } } });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThan(512);
    expect(harness.process.stdout.isPaused()).toBe(true);

    release();
    await vi.waitFor(() => expect(started).toBe(512));
    expect(harness.process.stdout.isPaused()).toBe(false);
  });

  it("keeps RPC responses flowing through ordinary notification pressure", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    let startRpc!: () => void;
    const rpcMayStart = new Promise<void>((resolve) => {
      startRpc = resolve;
    });
    let sharedCompletion: Promise<void> | undefined;
    let rpcCompleted = false;
    harness.client.addNotificationHandler(() => {
      sharedCompletion ??= (async () => {
        await rpcMayStart;
        await harness.client.request("model/list", {});
        rpcCompleted = true;
      })();
      return sharedCompletion;
    });

    for (let index = 0; index < 512; index += 1) {
      harness.send({ method: "item/started", params: { threadId: "t", item: { id: index } } });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.process.stdout.isPaused()).toBe(true);

    startRpc();
    let outbound: { id?: number | string; method?: string } | undefined;
    await vi.waitFor(() => {
      outbound = harness.writes
        .map((write) => JSON.parse(write) as { id?: number | string; method?: string })
        .find((message) => message.method === "model/list");
      expect(outbound?.id).toBeDefined();
    });
    expect(harness.process.stdout.isPaused()).toBe(false);
    harness.send({ id: outbound?.id, result: { data: [] } });
    await vi.waitFor(() => expect(rpcCompleted).toBe(true));
  });

  it("times out an RPC whose response cannot cross the bounded bypass", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    const releaseHandlers: Array<() => void> = [];
    harness.client.addNotificationHandler(
      () => new Promise<void>((resolve) => releaseHandlers.push(resolve)),
    );
    const request = harness.client.request("model/list", {});
    const rejected = expect(request).rejects.toThrow("model/list timed out");

    for (let index = 0; index < 1_024; index += 1) {
      harness.send({ method: "item/started", params: { threadId: "t", item: { id: index } } });
    }
    expect(harness.process.stdout.isPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(harness.process.stdin.destroyed).toBe(false);

    for (const release of releaseHandlers) {
      release();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.process.stdout.isPaused()).toBe(false);
  });

  it("arms the RPC deadline after one input chunk overshoots the bypass", async () => {
    vi.useFakeTimers();
    const harness = createClientHarness();
    clients.push(harness.client);
    let startRpc!: () => void;
    const rpcMayStart = new Promise<void>((resolve) => {
      startRpc = resolve;
    });
    let releaseOthers!: () => void;
    const othersReleased = new Promise<void>((resolve) => {
      releaseOthers = resolve;
    });
    let first = true;
    let rpc: Promise<unknown> | undefined;
    harness.client.addNotificationHandler(() => {
      if (!first) {
        return othersReleased;
      }
      first = false;
      return (async () => {
        await rpcMayStart;
        rpc = harness.client.request("model/list", {});
        await rpc;
      })();
    });
    const input = Array.from({ length: 1_200 }, (_, index) =>
      JSON.stringify({ method: "item/started", params: { threadId: "t", item: { id: index } } }),
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

    releaseOthers();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.process.stdout.isPaused()).toBe(false);
  });
});

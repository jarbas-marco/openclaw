/**
 * Gateway server lane configuration tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  resetCommandQueueStateForTest,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { createDeferred } from "../test-utils/deferred.js";
import { applyGatewayLaneConcurrency, startGatewayLaneAdmissionMonitor } from "./server-lanes.js";

function concurrencyConfig(main: number, subagent: number, cron: number): OpenClawConfig {
  return {
    agents: { defaults: { maxConcurrent: main, subagents: { maxConcurrent: subagent } } },
    cron: { maxConcurrentRuns: cron },
  } as OpenClawConfig;
}

describe("applyGatewayLaneConcurrency", () => {
  afterEach(() => {
    vi.useRealTimers();
    applyGatewayLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });
    resetCommandQueueStateForTest();
  });

  it("uses the higher cron default when maxConcurrentRuns is unset", async () => {
    applyGatewayLaneConcurrency({} as OpenClawConfig);

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const allRunsStarted = createDeferred();
    const releaseRuns = createDeferred();

    const run = async () => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (peakActiveRuns >= DEFAULT_CRON_MAX_CONCURRENT_RUNS) {
        allRunsStarted.resolve();
      }
      try {
        await releaseRuns.promise;
      } finally {
        activeRuns -= 1;
      }
    };

    const runs = Array.from({ length: DEFAULT_CRON_MAX_CONCURRENT_RUNS }, () =>
      enqueueCommandInLane(CommandLane.CronNested, run, { warnAfterMs: 10_000 }),
    );
    const timeout = setTimeout(() => {
      allRunsStarted.reject(new Error("timed out waiting for default cron concurrency"));
    }, 250);

    try {
      await allRunsStarted.promise;
      expect(peakActiveRuns).toBe(DEFAULT_CRON_MAX_CONCURRENT_RUNS);
    } finally {
      clearTimeout(timeout);
      releaseRuns.resolve();
      await Promise.all(runs);
    }
  });

  it("applies cron maxConcurrentRuns to the cron-nested lane used by cron agent turns", async () => {
    applyGatewayLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig);

    let activeRuns = 0;
    let peakActiveRuns = 0;
    const bothRunsStarted = createDeferred();
    const releaseRuns = createDeferred();

    const run = async () => {
      activeRuns += 1;
      peakActiveRuns = Math.max(peakActiveRuns, activeRuns);
      if (peakActiveRuns >= 2) {
        bothRunsStarted.resolve();
      }
      try {
        await releaseRuns.promise;
      } finally {
        activeRuns -= 1;
      }
    };

    const first = enqueueCommandInLane(CommandLane.CronNested, run, { warnAfterMs: 10_000 });
    const second = enqueueCommandInLane(CommandLane.CronNested, run, { warnAfterMs: 10_000 });
    const timeout = setTimeout(() => {
      bothRunsStarted.reject(
        new Error("timed out waiting for nested cron work to run in parallel"),
      );
    }, 250);

    try {
      await bothRunsStarted.promise;
      expect(peakActiveRuns).toBe(2);
    } finally {
      clearTimeout(timeout);
      releaseRuns.resolve();
      await Promise.all([first, second]);
    }
  });

  it("keeps the shared nested lane at its default concurrency", async () => {
    applyGatewayLaneConcurrency({ cron: { maxConcurrentRuns: 2 } } as OpenClawConfig);

    let startedRuns = 0;
    const releaseRuns = createDeferred();
    const run = async () => {
      startedRuns += 1;
      await releaseRuns.promise;
    };

    const first = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
    const second = enqueueCommandInLane(CommandLane.Nested, run, { warnAfterMs: 10_000 });
    await Promise.resolve();

    expect(startedRuns).toBe(1);

    releaseRuns.resolve();
    await Promise.all([first, second]);
  });

  it("reduces only new admissions under pressure and restores configured ceilings", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(concurrencyConfig(8, 4, 8), { gatewayStart: true });
    let health: { degraded: boolean; reasons: Array<"cpu"> } = {
      degraded: true,
      reasons: ["cpu"],
    };
    const transition = vi.fn();
    const monitor = startGatewayLaneAdmissionMonitor(() => ({ ...health }), transition);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(6);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent).toBe(3);
    expect(getCommandLaneSnapshot(CommandLane.CronNested).maxConcurrent).toBe(6);

    applyGatewayLaneConcurrency(concurrencyConfig(12, 8, 12));
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(9);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent).toBe(6);

    health = { degraded: false, reasons: [] };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(9);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(12);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent).toBe(8);
    expect(transition).toHaveBeenCalledTimes(2);
    monitor.stop();
  });

  it("keeps in-flight work running while pressure ratchets new admission down", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(concurrencyConfig(4, 2, 4), { gatewayStart: true });
    const monitor = startGatewayLaneAdmissionMonitor(() => ({ degraded: true }));
    const allStarted = createDeferred();
    const releaseRuns = createDeferred();
    let started = 0;
    const run = async () => {
      started += 1;
      if (started === 4) {
        allStarted.resolve();
      }
      await releaseRuns.promise;
    };
    const initial = Array.from({ length: 4 }, () =>
      enqueueCommandInLane(CommandLane.Main, run, { warnAfterMs: 10_000 }),
    );
    await allStarted.promise;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getCommandLaneSnapshot(CommandLane.Main)).toMatchObject({
      activeCount: 4,
      maxConcurrent: 1,
    });
    const queued = enqueueCommandInLane(CommandLane.Main, run, { warnAfterMs: 10_000 });
    await Promise.resolve();
    expect(started).toBe(4);

    monitor.stop();
    releaseRuns.resolve();
    await Promise.all([...initial, queued]);
    expect(started).toBe(5);
  });

  it("survives failures in the health probe and transition logger", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(concurrencyConfig(8, 4, 8), { gatewayStart: true });
    let calls = 0;
    const sample = vi.fn(() => {
      calls += 1;
      if (calls === 2) {
        throw new Error("probe failed");
      }
      return { degraded: true };
    });
    const transition = vi.fn(() => {
      throw new Error("logger failed");
    });
    const monitor = startGatewayLaneAdmissionMonitor(sample, transition);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(transition).toHaveBeenCalledTimes(2);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(4);
    monitor.stop();
  });
});

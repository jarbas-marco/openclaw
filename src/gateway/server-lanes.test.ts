/**
 * Gateway server lane configuration tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import {
  applyGatewayLaneConcurrency,
  resolveGatewayLaneConcurrency,
  startGatewayLaneAdmissionMonitor,
} from "./server-lanes.js";

function applyConfigLaneConcurrency(
  config: OpenClawConfig,
  opts: { gatewayStart?: boolean } = {},
): void {
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(config), opts);
}

describe("applyGatewayLaneConcurrency", () => {
  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runOnlyPendingTimersAsync();
      vi.clearAllTimers();
    }
    vi.useRealTimers();
    // Gateway startup drains the process-global suspension cleanup state.
    // Reset between tests so lane assertions only see this test's setup.
    const { resetSessionSuspensionStateForTest } =
      await import("../agents/session-suspension.test-support.js");
    resetSessionSuspensionStateForTest();
    applyConfigLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });
    resetCommandQueueStateForTest();
  });

  it("uses the built-in cron concurrency", async () => {
    applyConfigLaneConcurrency({} as OpenClawConfig);

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

  it("keeps the shared nested lane at its default concurrency", async () => {
    applyConfigLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });

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

  it("restores a suspended shared nested lane on gateway startup", async () => {
    setCommandLaneConcurrency(CommandLane.Nested, 0);
    applyConfigLaneConcurrency({} as OpenClawConfig, { gatewayStart: true });

    let started = false;
    await enqueueCommandInLane(
      CommandLane.Nested,
      async () => {
        started = true;
      },
      { warnAfterMs: 10_000 },
    );

    expect(started).toBe(true);
  });

  it("does not resume a suspended shared nested lane during live config publication", async () => {
    setCommandLaneConcurrency(CommandLane.Nested, 0);
    applyConfigLaneConcurrency({} as OpenClawConfig);

    let started = false;
    const nestedRun = enqueueCommandInLane(
      CommandLane.Nested,
      async () => {
        started = true;
      },
      { warnAfterMs: 10_000 },
    );
    await Promise.resolve();

    expect(started).toBe(false);

    setCommandLaneConcurrency(CommandLane.Nested, 1);
    await nestedRun;
    expect(started).toBe(true);
  });

  it("reduces only new admissions under pressure and restores configured ceilings", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(
      { cron: 8, hookDispatch: 0, main: 8, subagent: 4 },
      { gatewayStart: true },
    );
    let health: { degraded: boolean; reasons: Array<"cpu"> } = {
      degraded: true,
      reasons: ["cpu"],
    };
    const onPressureTransition = vi.fn();
    const monitor = startGatewayLaneAdmissionMonitor(() => ({ ...health }), onPressureTransition);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(6);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent).toBe(3);
    expect(getCommandLaneSnapshot(CommandLane.CronNested).maxConcurrent).toBe(6);
    expect(onPressureTransition).toHaveBeenNthCalledWith(1, {
      configured: { cron: 8, hookDispatch: 0, main: 8, subagent: 4 },
      degraded: true,
      effective: { cron: 6, hookDispatch: 0, main: 6, subagent: 3 },
      pressureFactor: 0.75,
      pressureLevel: 1,
      reasons: ["cpu"],
    });

    applyGatewayLaneConcurrency({ cron: 12, hookDispatch: 0, main: 12, subagent: 8 });
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(9);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent).toBe(6);

    health = { degraded: false, reasons: [] };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(9);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(12);
    expect(getCommandLaneSnapshot(CommandLane.Subagent).maxConcurrent).toBe(8);
    expect(getCommandLaneSnapshot(CommandLane.CronNested).maxConcurrent).toBe(12);
    expect(onPressureTransition).toHaveBeenNthCalledWith(2, {
      configured: { cron: 12, hookDispatch: 0, main: 12, subagent: 8 },
      degraded: false,
      effective: { cron: 12, hookDispatch: 0, main: 12, subagent: 8 },
      pressureFactor: 1,
      pressureLevel: 0,
      reasons: [],
    });
    monitor.stop();
  });

  it("keeps in-flight work running while pressure ratchets new admission down", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(
      { cron: 4, hookDispatch: 0, main: 4, subagent: 2 },
      { gatewayStart: true },
    );
    let degraded = true;
    const monitor = startGatewayLaneAdmissionMonitor(() => ({ degraded }));
    const allInitialRunsStarted = createDeferred();
    const releaseRuns = createDeferred();
    let started = 0;
    const run = async () => {
      started += 1;
      if (started === 4) {
        allInitialRunsStarted.resolve();
      }
      await releaseRuns.promise;
    };
    const initialRuns = Array.from({ length: 4 }, () =>
      enqueueCommandInLane(CommandLane.Main, run, { warnAfterMs: 10_000 }),
    );
    await allInitialRunsStarted.promise;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(getCommandLaneSnapshot(CommandLane.Main)).toMatchObject({
      activeCount: 4,
      maxConcurrent: 1,
    });
    const queuedRun = enqueueCommandInLane(CommandLane.Main, run, { warnAfterMs: 10_000 });
    await Promise.resolve();
    expect(started).toBe(4);

    degraded = false;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(4);

    monitor.stop();
    releaseRuns.resolve();
    await Promise.all([...initialRuns, queuedRun]);
    expect(started).toBe(5);
  });

  it("samples lane pressure on a stoppable unref'ed gateway monitor", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(
      { cron: 8, hookDispatch: 0, main: 8, subagent: 4 },
      { gatewayStart: true },
    );
    const sample = vi.fn(() => ({ degraded: true }));
    const monitor = startGatewayLaneAdmissionMonitor(sample);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sample).toHaveBeenCalledOnce();
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(6);

    monitor.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sample).toHaveBeenCalledOnce();
  });

  it("keeps sampling when the health probe or transition observer throws", async () => {
    vi.useFakeTimers();
    applyGatewayLaneConcurrency(
      { cron: 8, hookDispatch: 0, main: 8, subagent: 4 },
      { gatewayStart: true },
    );
    let sampleCount = 0;
    const sample = vi.fn(() => {
      sampleCount += 1;
      if (sampleCount === 2) {
        throw new Error("probe failed");
      }
      return { degraded: true };
    });
    const onPressureTransition = vi.fn(() => {
      throw new Error("observer failed");
    });
    const monitor = startGatewayLaneAdmissionMonitor(sample, onPressureTransition);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sample).toHaveBeenCalledTimes(3);
    expect(onPressureTransition).toHaveBeenCalledTimes(2);
    expect(getCommandLaneSnapshot(CommandLane.Main).maxConcurrent).toBe(4);

    monitor.stop();
  });
});

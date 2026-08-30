// Delivery queue health tests cover independent inbound and outbound diagnostic reads.
import { beforeEach, describe, expect, it, vi } from "vitest";

const countOutbound = vi.fn();
const countIngressFailed = vi.fn();
const countIngressPressure = vi.fn();
const readOnlySnapshot = vi.fn();

vi.mock("../../state/openclaw-state-db-readonly.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-readonly.js")>();
  return {
    ...actual,
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: (
      read: (database: never) => unknown,
    ) => readOnlySnapshot(read),
  };
});

vi.mock("../../infra/delivery-queue-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/delivery-queue-sqlite.js")>();
  return {
    ...actual,
    countFailedDeliveryQueueEntriesInDatabase: () => countOutbound(),
  };
});

vi.mock("../../channels/message/ingress-queue-health.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../channels/message/ingress-queue-health.js")>();
  return {
    ...actual,
    countFailedChannelIngressQueueEntriesInDatabase: () => countIngressFailed(),
    countChannelIngressQueuePressureInDatabase: () => countIngressPressure(),
  };
});

const { buildDeliveryQueueHealthSummary, buildDeliveryQueueStatusSummary } =
  await import("./delivery-queue.js");
const outboundFailed = [{ queueName: "outbound", count: 2, oldestFailedAt: 1_000 }];
const ingressFailed = [
  { channelId: "telegram", accountId: "ops", count: 1, oldestFailedAt: 2_000 },
];
const ingressPressure = [
  {
    channelId: "telegram",
    accountId: "ops",
    laneCount: 1,
    pendingCount: 56,
    claimedCount: 0,
    blockedCount: 55,
    oldestReceivedAt: 1_000,
  },
];

describe("buildDeliveryQueueHealthSummary", () => {
  beforeEach(() => {
    countOutbound.mockReset().mockReturnValue([]);
    countIngressFailed.mockReset().mockReturnValue([]);
    countIngressPressure.mockReset().mockReturnValue([]);
    readOnlySnapshot.mockReset().mockImplementation((read) => read({}));
  });

  it.each([
    {
      name: "outbound failures when the ingress dead-letter read fails",
      arrange: () => {
        countOutbound.mockReturnValue(outboundFailed);
        countIngressFailed.mockImplementation(() => {
          throw new Error("ingress database unavailable");
        });
      },
      expected: {
        deliveryQueuesComplete: false,
        deliveryQueues: { failed: outboundFailed },
      },
    },
    {
      name: "ingress failures when the outbound read fails",
      arrange: () => {
        countOutbound.mockImplementation(() => {
          throw new Error("outbound database unavailable");
        });
        countIngressFailed.mockReturnValue(ingressFailed);
      },
      expected: {
        deliveryQueuesComplete: false,
        deliveryQueues: { failed: [], ingressFailed },
      },
    },
    {
      name: "dead letters when the ingress pressure read fails",
      arrange: () => {
        countIngressFailed.mockReturnValue(ingressFailed);
        countIngressPressure.mockImplementation(() => {
          throw new Error("ingress pressure read unavailable");
        });
      },
      expected: {
        deliveryQueuesComplete: false,
        deliveryQueues: { failed: [], ingressFailed },
      },
    },
    {
      name: "ingress pressure when the dead-letter read fails",
      arrange: () => {
        countIngressFailed.mockImplementation(() => {
          throw new Error("ingress failed read unavailable");
        });
        countIngressPressure.mockReturnValue(ingressPressure);
      },
      expected: {
        deliveryQueuesComplete: false,
        deliveryQueues: { failed: [], ingressPressure },
      },
    },
  ])("preserves $name", ({ arrange, expected }) => {
    arrange();
    expect(buildDeliveryQueueHealthSummary()).toEqual(expected);
  });

  it("marks the snapshot incomplete when all queue readers fail", () => {
    countOutbound.mockImplementation(() => {
      throw new Error("outbound database unavailable");
    });
    countIngressFailed.mockImplementation(() => {
      throw new Error("ingress dead-letter database unavailable");
    });
    countIngressPressure.mockImplementation(() => {
      throw new Error("ingress pressure database unavailable");
    });

    expect(buildDeliveryQueueHealthSummary()).toEqual({ deliveryQueuesComplete: false });
  });

  it("recomputes ingress pressure instead of retaining a stale cached value", () => {
    countIngressPressure.mockReturnValue(ingressPressure);
    expect(buildDeliveryQueueHealthSummary()).toEqual({
      deliveryQueuesComplete: true,
      deliveryQueues: { failed: [], ingressPressure },
    });
    expect(countIngressPressure).toHaveBeenCalledOnce();
  });

  it("uses one existing read-only snapshot for all three queries", () => {
    expect(buildDeliveryQueueHealthSummary()).toEqual({ deliveryQueuesComplete: true });
    expect(readOnlySnapshot).toHaveBeenCalledOnce();
    expect(countOutbound).toHaveBeenCalledOnce();
    expect(countIngressFailed).toHaveBeenCalledOnce();
    expect(countIngressPressure).toHaveBeenCalledOnce();
  });

  it("marks queue health incomplete when snapshot preparation fails", () => {
    readOnlySnapshot.mockImplementation(() => {
      throw new Error("snapshot unavailable");
    });

    expect(buildDeliveryQueueHealthSummary()).toEqual({ deliveryQueuesComplete: false });
  });

  it("derives degraded local status without changing the health snapshot contract", () => {
    countIngressPressure.mockReturnValue(ingressPressure);

    expect(buildDeliveryQueueStatusSummary()).toEqual({
      ok: false,
      deliveryQueuesComplete: true,
      deliveryQueues: { failed: [], ingressPressure },
    });
  });
});

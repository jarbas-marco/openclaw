import {
  countChannelIngressQueuePressureInDatabase,
  countFailedChannelIngressQueueEntriesInDatabase,
} from "../../channels/message/ingress-queue-health.js";
import { countFailedDeliveryQueueEntriesInDatabase } from "../../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";

const healthLog = createSubsystemLogger("health");

const debugHealth = (message: string, error: unknown) => {
  if (isDiagnosticFlagEnabled("health")) {
    healthLog.info(message, { error: formatErrorMessage(error) });
  }
};

function readQueueHealth<T>(message: string, read: () => T[]): { complete: boolean; value: T[] } {
  try {
    return { complete: true, value: read() };
  } catch (error) {
    debugHealth(message, error);
    return { complete: false, value: [] };
  }
}

function readDeliveryQueueHealthSnapshot(database: OpenClawStateDatabase["db"]) {
  return {
    failed: readQueueHealth("outbound delivery queue health read failed", () =>
      countFailedDeliveryQueueEntriesInDatabase(database),
    ),
    ingressFailed: readQueueHealth("channel ingress failed queue health read failed", () =>
      countFailedChannelIngressQueueEntriesInDatabase(database),
    ),
    ingressPressure: readQueueHealth("channel ingress pressure health read failed", () =>
      countChannelIngressQueuePressureInDatabase(database),
    ),
  };
}

/** Builds redacted inbound pressure and dead-letter health for gateway snapshots. */
export function buildDeliveryQueueHealthSummary() {
  // Queue health reads are diagnostic, but an unreadable queue is degraded,
  // not empty. Every reader stays read-only and reports its own completeness.
  let result: ReturnType<typeof readDeliveryQueueHealthSnapshot> | undefined;
  try {
    result = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly((database) =>
      readDeliveryQueueHealthSnapshot(database.db),
    );
  } catch (error) {
    debugHealth("delivery queue health snapshot read failed", error);
    return { ok: false, deliveryQueuesComplete: false };
  }

  const failed = result?.failed ?? { complete: true, value: [] };
  const ingressFailed = result?.ingressFailed ?? { complete: true, value: [] };
  const ingressPressure = result?.ingressPressure ?? { complete: true, value: [] };

  const deliveryQueuesComplete =
    failed.complete && ingressFailed.complete && ingressPressure.complete;
  const deliveryQueues =
    failed.value.length === 0 &&
    ingressFailed.value.length === 0 &&
    ingressPressure.value.length === 0
      ? undefined
      : {
          failed: failed.value,
          ...(ingressFailed.value.length > 0 ? { ingressFailed: ingressFailed.value } : {}),
          ...(ingressPressure.value.length > 0 ? { ingressPressure: ingressPressure.value } : {}),
        };
  return {
    ok: deliveryQueuesComplete && deliveryQueues === undefined,
    deliveryQueuesComplete,
    ...(deliveryQueues ? { deliveryQueues } : {}),
  };
}

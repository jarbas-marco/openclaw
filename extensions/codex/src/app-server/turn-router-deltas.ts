import { isJsonObject, type CodexServerNotification, type JsonValue } from "./protocol.js";
import type { CodexThreadRouteScope } from "./turn-router-types.js";

// Bound each delayed string join so coalescing removes promise pressure without
// replacing it with a single large allocation or long handler latency spike.
const MAX_COALESCED_DELTA_LENGTH = 64 * 1024;
// Empty and tiny deltas also need a count bound; byte length alone would let an
// arbitrary number of chunks accumulate inside one queue entry.
const MAX_COALESCED_DELTA_CHUNKS = 256;
const COALESCIBLE_DELTA_METHODS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
]);

export type QueuedNotification = {
  notification: CodexServerNotification;
  scope: CodexThreadRouteScope;
  deltaChunks?: string[];
  deltaLength?: number;
};

export function coalesceQueuedDelta(
  previous: QueuedNotification,
  next: QueuedNotification,
): boolean {
  if (
    previous.notification.method !== next.notification.method ||
    !COALESCIBLE_DELTA_METHODS.has(next.notification.method) ||
    previous.scope.threadId !== next.scope.threadId ||
    previous.scope.turnId !== next.scope.turnId ||
    !isJsonObject(previous.notification.params) ||
    !isJsonObject(next.notification.params)
  ) {
    return false;
  }
  const previousDelta = previous.notification.params.delta;
  const nextDelta = next.notification.params.delta;
  if (
    typeof previousDelta !== "string" ||
    typeof nextDelta !== "string" ||
    comparableDeltaParams(previous.notification.params) !==
      comparableDeltaParams(next.notification.params)
  ) {
    return false;
  }
  const previousLength = previous.deltaLength ?? previousDelta.length;
  const previousChunkCount = previous.deltaChunks?.length ?? 1;
  if (
    previousLength + nextDelta.length > MAX_COALESCED_DELTA_LENGTH ||
    previousChunkCount >= MAX_COALESCED_DELTA_CHUNKS
  ) {
    return false;
  }
  previous.deltaChunks ??= [previousDelta];
  previous.deltaChunks.push(nextDelta);
  previous.deltaLength = previousLength + nextDelta.length;
  return true;
}

function comparableDeltaParams(params: Record<string, JsonValue>): string {
  return JSON.stringify(Object.entries(params).filter(([key]) => key !== "delta"));
}

export function materializeQueuedNotification(queued: QueuedNotification): CodexServerNotification {
  if (!queued.deltaChunks || !isJsonObject(queued.notification.params)) {
    return queued.notification;
  }
  return {
    ...queued.notification,
    params: {
      ...queued.notification.params,
      delta: queued.deltaChunks.join(""),
    },
  };
}

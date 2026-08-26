import { WAMessageStatus, type WAMessage, type WAMessageUpdate } from "baileys";

type PendingAck = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ObservedAck = {
  code?: string;
  status: number;
};

const MAX_OBSERVED_ACKS = 500;

function getMessageId(message: WAMessage | undefined): string | undefined {
  const id = message?.key?.id?.trim();
  return id || undefined;
}

function rejectionError(messageId: string, ack: ObservedAck): Error {
  const suffix = ack.code ? ` (${ack.code})` : "";
  return new Error(`WhatsApp rejected message ${messageId}${suffix}`);
}

export function createWhatsAppOutboundAckTracker(options: { timeoutMs: number }) {
  const observed = new Map<string, ObservedAck>();
  const pending = new Map<string, PendingAck>();

  const settle = (messageId: string, ack: ObservedAck) => {
    const waiter = pending.get(messageId);
    if (!waiter) {
      observed.delete(messageId);
      observed.set(messageId, ack);
      while (observed.size > MAX_OBSERVED_ACKS) {
        const oldest = observed.keys().next();
        if (oldest.done) {
          break;
        }
        observed.delete(oldest.value);
      }
      return;
    }
    pending.delete(messageId);
    clearTimeout(waiter.timer);
    if (ack.status === WAMessageStatus.ERROR) {
      waiter.reject(rejectionError(messageId, ack));
    } else if (ack.status >= WAMessageStatus.SERVER_ACK) {
      waiter.resolve();
    }
  };

  return {
    observe: (updates: WAMessageUpdate[]) => {
      for (const { key, update } of updates) {
        const messageId = key.id?.trim();
        const status = update.status;
        if (!messageId || typeof status !== "number") {
          continue;
        }
        if (status !== WAMessageStatus.ERROR && status < WAMessageStatus.SERVER_ACK) {
          continue;
        }
        settle(messageId, {
          status,
          code: update.messageStubParameters?.[0],
        });
      }
    },
    waitForServerAck: async (message: WAMessage | undefined): Promise<void> => {
      const messageId = getMessageId(message);
      if (!messageId) {
        return;
      }
      const initialStatus = message?.status;
      if (initialStatus === WAMessageStatus.ERROR) {
        throw rejectionError(messageId, { status: initialStatus });
      }
      if (typeof initialStatus === "number" && initialStatus >= WAMessageStatus.SERVER_ACK) {
        return;
      }
      if (initialStatus !== WAMessageStatus.PENDING) {
        return;
      }
      const prior = observed.get(messageId);
      if (prior) {
        observed.delete(messageId);
        if (prior.status === WAMessageStatus.ERROR) {
          throw rejectionError(messageId, prior);
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(messageId);
          resolve();
        }, options.timeoutMs);
        timer.unref?.();
        pending.set(messageId, { resolve, reject, timer });
      });
    },
    close: () => {
      for (const [messageId, waiter] of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`WhatsApp connection closed before ACK for ${messageId}`));
      }
      pending.clear();
      observed.clear();
    },
  } as const;
}

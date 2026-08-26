import { WAMessageStatus, type WAMessage, type WAMessageUpdate } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { createWhatsAppOutboundAckTracker } from "./outbound-ack.js";

const message = (status = WAMessageStatus.PENDING): WAMessage =>
  ({ key: { id: "msg-1", remoteJid: "123@g.us", fromMe: true }, status }) as WAMessage;

const update = (status: number, code?: string): WAMessageUpdate => ({
  key: { id: "msg-1", remoteJid: "123@g.us", fromMe: true },
  update: {
    status,
    messageStubParameters: code ? [code] : undefined,
  },
});

describe("createWhatsAppOutboundAckTracker", () => {
  it("rejects a pending send when WhatsApp later reports an error", async () => {
    const tracker = createWhatsAppOutboundAckTracker({ timeoutMs: 1_000 });
    const pending = tracker.waitForServerAck(message());

    tracker.observe([update(WAMessageStatus.ERROR, "479")]);

    await expect(pending).rejects.toThrow(/479/);
  });

  it("handles an ACK update that races ahead of send result registration", async () => {
    const tracker = createWhatsAppOutboundAckTracker({ timeoutMs: 1_000 });
    tracker.observe([update(WAMessageStatus.SERVER_ACK)]);

    await expect(tracker.waitForServerAck(message())).resolves.toBeUndefined();
  });

  it("does not turn a missing optional ACK into an ambiguous duplicate retry", async () => {
    vi.useFakeTimers();
    try {
      const tracker = createWhatsAppOutboundAckTracker({ timeoutMs: 25 });
      const pending = tracker.waitForServerAck(message());
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

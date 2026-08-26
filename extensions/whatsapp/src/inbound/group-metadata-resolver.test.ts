import type { GroupMetadata, WASocket } from "baileys";
import { describe, expect, it, vi } from "vitest";
import { createCachedGroupMetadataResolver } from "./group-metadata-resolver.js";

describe("createCachedGroupMetadataResolver", () => {
  it("fetches and caches live metadata when the reconnect cache is empty", async () => {
    const metadata = {
      id: "123@g.us",
      subject: "Equipe",
      participants: [{ id: "1@s.whatsapp.net", admin: null }],
    } as GroupMetadata;
    const groupMetadata = vi.fn(async () => metadata);
    const cache = new Map<string, GroupMetadata>();
    const resolve = createCachedGroupMetadataResolver({
      getSocket: () => ({ groupMetadata }) as unknown as WASocket,
      read: (jid) => cache.get(jid),
      remember: (jid, value) => cache.set(jid, value),
    });

    await expect(resolve("123@g.us")).resolves.toBe(metadata);
    await expect(resolve("123@g.us")).resolves.toBe(metadata);
    expect(groupMetadata).toHaveBeenCalledOnce();
  });
});

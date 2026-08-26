import type { GroupMetadata, WASocket } from "baileys";

export function createCachedGroupMetadataResolver(options: {
  getSocket: () => Pick<WASocket, "groupMetadata"> | undefined;
  read: (jid: string) => GroupMetadata | undefined;
  remember: (jid: string, metadata: GroupMetadata) => void;
  onFetchError?: (jid: string, error: unknown) => void;
}) {
  return async (jid: string): Promise<GroupMetadata | undefined> => {
    const cached = options.read(jid);
    if (cached?.participants?.length) {
      return cached;
    }
    const socket = options.getSocket();
    if (!socket) {
      return undefined;
    }
    try {
      const metadata = await socket.groupMetadata(jid);
      if (!metadata?.participants?.length) {
        return undefined;
      }
      options.remember(jid, metadata);
      return metadata;
    } catch (error) {
      options.onFetchError?.(jid, error);
      return undefined;
    }
  };
}

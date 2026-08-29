// Codex tests cover transport websocket plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { CodexAppServerClient } from "./client.js";
import { createWebSocketTransport } from "./transport-websocket.js";

describe("Codex app-server websocket transport", () => {
  const clients: CodexAppServerClient[] = [];
  const servers: WebSocketServer[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("can speak JSON-RPC over websocket transport", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    const authHeaders: Array<string | undefined> = [];
    server.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToText(data)) as { id?: number; method?: string };
        if (message.method === "initialize") {
          socket.send(
            JSON.stringify({ id: message.id, result: { userAgent: "openclaw/0.143.0" } }),
          );
          return;
        }
        if (message.method === "model/list") {
          socket.send(JSON.stringify({ id: message.id, result: { data: [] } }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const client = CodexAppServerClient.start({
      transport: "websocket",
      url: `ws://127.0.0.1:${address.port}`,
      authToken: "secret",
    });
    clients.push(client);

    await expect(client.initialize()).resolves.toBeUndefined();
    await expect(client.request("model/list", {})).resolves.toEqual({ data: [] });
    expect(authHeaders).toEqual(["Bearer secret"]);
  });

  it("pauses websocket ingress and resumes ordered delivery when stdout drains", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    let serverSocket: WebSocket | undefined;
    const connected = new Promise<void>((resolve) => {
      server.once("connection", (socket) => {
        serverSocket = socket;
        resolve();
      });
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected websocket test server port");
    }
    const transport = createWebSocketTransport({
      transport: "websocket",
      command: "codex",
      args: [],
      url: `ws://127.0.0.1:${address.port}`,
      headers: {},
    });
    await connected;
    const pause = vi.spyOn(WebSocket.prototype, "pause");
    const resume = vi.spyOn(WebSocket.prototype, "resume");
    const payloads = [`first:${"a".repeat(512 * 1024)}`, `second:${"b".repeat(512 * 1024)}`];

    for (const payload of payloads) {
      serverSocket?.send(payload);
    }
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());

    let output = "";
    transport.stdout.setEncoding("utf8");
    transport.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(output.length).toBe(
        payloads.reduce((total, payload) => total + payload.length + 1, 0),
      ),
    );
    expect(output).toBe(payloads.map((payload) => `${payload}\n`).join(""));
    transport.kill?.();
  });
});

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

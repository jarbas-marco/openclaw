import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex source-reply finalization", () => {
  it.each(
    (["channel", "internal-ui"] as const).flatMap((delivery) =>
      [undefined, true, false].map((final) => ({ delivery, final })),
    ),
  )(
    "settles a $delivery receipt with final=$final before recovery",
    async ({ delivery, final }) => {
      const params = createTestParams();
      params.sourceReplyDeliveryMode = "message_tool_only";
      params.messageChannel = delivery === "internal-ui" ? "webchat" : "telegram";
      params.currentChannelId = "chat:123";
      params.currentMessagingTarget = "chat:123";
      params.toolsAllow = ["message"];
      params.runtimePlan = createCodexRuntimePlanFixture();
      setCodexTestModelSupportsTools(params, true);
      await attachSqliteSessionTarget(params, path.join(tempDir, "reply.sqlite"), "source-reply");
      const target = params.sessionTarget!;
      // A long but valid conversation cannot be replayed by the bounded finalizer.
      // Successful final delivery must not make this unrelated limit a turn warning.
      for (let index = 0; index < 201; index += 1) {
        await appendSessionTranscriptMessageByIdentity({
          ...target,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey!,
          message: userMessage(`Prior message ${index}`, index + 1),
          now: index + 1,
        });
      }
      const execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Sent." }],
        details:
          delivery === "internal-ui"
            ? {
                status: "ok",
                deliveryStatus: "sent",
                sourceReplySink: "internal-ui",
                sourceReply: { text: "Visible reply." },
              }
            : { messageId: "receipt-1" },
      }));
      dynamicToolBuildState.openClawCodingToolsFactory = () => [
        {
          ...createRuntimeDynamicTool("message"),
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["send"] },
              message: { type: "string" },
              final: { type: "boolean" },
            },
            required: ["action", "message"],
            additionalProperties: false,
          },
          execute,
        },
      ];
      const warn = vi.spyOn(embeddedAgentLog, "warn");
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        return method === "mcpServerStatus/list" ? { data: [], nextCursor: null } : undefined;
      });
      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        harness.waitForMethod("turn/start"),
        run.then((result) => {
          throw new Error("Codex attempt ended before turn/start", { cause: result });
        }),
      ]);
      const argumentsValue = {
        action: "send",
        message: "Visible reply.",
        ...(final !== undefined ? { final } : {}),
      };
      const item = {
        type: "dynamicToolCall",
        id: "source-message",
        namespace: "openclaw_direct",
        tool: "message",
        arguments: argumentsValue,
      };
      await harness.notify(itemNotification("item/started", { ...item, status: "inProgress" }));
      const response = await harness.handleServerRequest({
        id: "source-message-request",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: item.id,
          namespace: item.namespace,
          tool: item.tool,
          arguments: argumentsValue,
        },
      });
      expect(response).toEqual({
        contentItems: [{ type: "inputText", text: "Sent." }],
        success: true,
      });
      await harness.notify(
        itemNotification("item/completed", {
          ...item,
          status: "completed",
          contentItems: [{ type: "inputText", text: "Sent." }],
          success: true,
          durationMs: 1,
        }),
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      expect(execute).toHaveBeenCalledOnce();
      expect(result.terminal).toEqual({ kind: "ok" });
      expect(result.assistantTexts).toEqual([]);
      expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
      const deliveries =
        delivery === "internal-ui"
          ? result.messagingToolSourceReplyPayloads
          : result.messagingToolSentTargets;
      expect(deliveries).toEqual([expect.objectContaining({ sourceReplyFinal: final !== false })]);
      if (final === false) {
        expect(result.settledTurnFinalizationContext).toEqual({ source: "unavailable" });
        expect(warn).toHaveBeenCalledWith(
          "codex settled-turn finalization context capture failed",
          { reason: "item_limit" },
        );
      } else {
        expect(result.agentHarnessResultClassification).toBeUndefined();
        expect(result.settledTurnFinalizationContext).toBeUndefined();
        expect(warn.mock.calls.map(([message]) => message)).not.toContain(
          "codex settled-turn finalization context capture failed",
        );
        expect(warn.mock.calls.map(([message]) => message)).not.toContain(
          "codex settled-turn finalization context is unavailable",
        );
      }
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    },
  );
});

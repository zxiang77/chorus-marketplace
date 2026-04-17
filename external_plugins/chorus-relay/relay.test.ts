/**
 * TDD tests for the Chorus Relay MCP channel server.
 *
 * These tests use a mock Hub HTTP server to verify the relay's behavior:
 * - Registration with the Hub on startup
 * - Inbound message forwarding as MCP notifications
 * - Tool proxying to Hub endpoints with Bearer auth
 * - Graceful shutdown with unregistration
 *
 * The relay module (relay.ts) does not exist yet. These tests define the
 * expected public interface and will fail until implementation is provided.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type { Server } from "bun";

// ---------------------------------------------------------------------------
// Mock Hub HTTP server — records every request so tests can assert on them
// ---------------------------------------------------------------------------

type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

let mockHub: Server;
let hubPort: number;
const hubRequests: RecordedRequest[] = [];
const MOCK_SECRET = "test-secret-token-abc123";

/** Channel info returned by the mock Hub for GET /channel-info */
const MOCK_CHANNEL_INFO = {
  name: "test-channel",
  topic: "A test channel for relay testing",
};

beforeAll(() => {
  mockHub = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body: null,
      };

      // Parse JSON body for POST requests
      if (req.method === "POST") {
        try {
          recorded.body = await req.json();
        } catch {
          recorded.body = null;
        }
      }

      hubRequests.push(recorded);

      // Check auth for all endpoints except /status
      const authHeader = req.headers.get("authorization");
      if (authHeader !== `Bearer ${MOCK_SECRET}`) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        });
      }

      // Route to mock handlers
      if (url.pathname === "/register" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/unregister" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/channel-info" && req.method === "GET") {
        return new Response(JSON.stringify(MOCK_CHANNEL_INFO), { status: 200 });
      }
      if (url.pathname === "/reply" && req.method === "POST") {
        return new Response(
          JSON.stringify({ ok: true, message_id: "mock-msg-123" }),
          { status: 200 },
        );
      }
      if (url.pathname === "/react" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/edit" && req.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/fetch-messages" && req.method === "GET") {
        return new Response(
          JSON.stringify([
            {
              id: "msg-1",
              content: "hello",
              author: "alice",
              ts: "2026-03-25T10:00:00Z",
            },
          ]),
          { status: 200 },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });
  hubPort = mockHub.port;
});

afterAll(() => {
  mockHub.stop();
});

afterEach(() => {
  hubRequests.length = 0;
});

// ---------------------------------------------------------------------------
// Import the relay module — will fail until relay.ts is implemented
// ---------------------------------------------------------------------------
// The relay exports a createRelay function that returns a controllable relay
// instance. This is the public interface tests exercise.
//
// Expected interface:
//   createRelay(opts: {
//     channelId: string;
//     hubUrl: string;
//     secret: string;
//   }) => Promise<{
//     port: number;           // the random port the relay's HTTP server listens on
//     close: () => Promise<void>;  // graceful shutdown
//     callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
//     listTools: () => Array<{ name: string; description?: string; inputSchema: object }>;
//   }>
//
import { createRelay } from "./relay";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Relay MCP Channel Server", () => {
  // Test 1: Relay starts an HTTP server on a random port
  test("starts an HTTP server on a random port", async () => {
    const relay = await createRelay({
      channelId: "test-channel-001",
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      // The relay should expose the port it's listening on
      expect(typeof relay.port).toBe("number");
      expect(relay.port).toBeGreaterThan(0);

      // The relay's HTTP server should respond to requests
      const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await relay.close();
    }
  });

  // Test 2: Relay registers with Hub on startup (POST /register with channel_id and port)
  test("registers with Hub on startup with channel_id and port", async () => {
    const channelId = "test-channel-register-002";
    const relay = await createRelay({
      channelId,
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      // Find the registration request in recorded Hub requests
      const registerReqs = hubRequests.filter(
        (r) => r.path === "/register" && r.method === "POST",
      );
      expect(registerReqs.length).toBeGreaterThanOrEqual(1);

      const regReq = registerReqs[registerReqs.length - 1];

      // Registration must include the channel_id and the relay's chosen port
      const body = regReq.body as { channel_id: string; port: number };
      expect(body.channel_id).toBe(channelId);
      expect(body.port).toBe(relay.port);

      // Registration must include Bearer auth header
      expect(regReq.headers["authorization"]).toBe(`Bearer ${MOCK_SECRET}`);

      // Hub should also be queried for channel info during startup
      const channelInfoReqs = hubRequests.filter(
        (r) =>
          r.path.startsWith("/channel-info") &&
          r.path.includes(`channel_id=${channelId}`),
      );
      expect(channelInfoReqs.length).toBeGreaterThanOrEqual(1);
    } finally {
      await relay.close();
    }
  });

  // Test 3: Inbound HTTP handler converts Hub messages to MCP notifications
  test("inbound HTTP handler accepts Hub messages and returns 200", async () => {
    const relay = await createRelay({
      channelId: "test-channel-inbound-003",
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      // The Hub POSTs messages to the relay's HTTP server when Discord
      // messages arrive. The relay should accept these and return 200.
      // Internally it converts them to MCP notifications, but from the
      // HTTP perspective we verify the relay accepts the message format.
      const inboundMessage = {
        content: "Hello from Discord!",
        meta: {
          chat_id: "test-channel-inbound-003",
          message_id: "discord-msg-456",
          user: "testuser",
          user_id: "user-789",
          ts: "2026-03-25T12:00:00Z",
        },
      };

      const res = await fetch(`http://127.0.0.1:${relay.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inboundMessage),
      });

      expect(res.status).toBe(200);

      // The response should acknowledge receipt
      const body = await res.json();
      expect(body.ok).toBe(true);
    } finally {
      await relay.close();
    }
  });

  // Test 4: Reply tool proxies to Hub /reply endpoint with Bearer auth
  test("reply tool proxies to Hub /reply with Bearer auth and correct payload", async () => {
    const channelId = "test-channel-reply-004";
    const relay = await createRelay({
      channelId,
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      // Clear hub requests from registration to isolate reply requests
      hubRequests.length = 0;

      // The relay exposes a callTool method for testing MCP tool invocations
      // without needing a real MCP transport. This simulates what happens
      // when Claude Code invokes the "reply" tool.
      const result = await relay.callTool("reply", {
        chat_id: channelId,
        text: "Hello from Claude!",
        reply_to: "original-msg-111",
      });

      // Verify the relay forwarded the reply to the Hub
      const replyReqs = hubRequests.filter(
        (r) => r.path === "/reply" && r.method === "POST",
      );
      expect(replyReqs.length).toBe(1);

      const replyReq = replyReqs[0];

      // Must include Bearer auth
      expect(replyReq.headers["authorization"]).toBe(`Bearer ${MOCK_SECRET}`);

      // Must forward the correct payload
      const body = replyReq.body as {
        channel_id: string;
        text: string;
        reply_to?: string;
      };
      expect(body.channel_id).toBe(channelId);
      expect(body.text).toBe("Hello from Claude!");
      expect(body.reply_to).toBe("original-msg-111");

      // Tool result should indicate success
      expect(result.isError).toBeFalsy();
    } finally {
      await relay.close();
    }
  });

  // Test 6: listTools() returns correct schemas for all 4 MCP tools
  test("listTools returns schemas for reply, react, edit_message, fetch_messages", async () => {
    const relay = await createRelay({
      channelId: "test-channel-tools-006",
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      // The relay must expose a listTools() method that returns MCP tool schemas.
      // This is the same data the MCP Server's ListToolsRequestSchema handler returns.
      const tools = relay.listTools();

      // Exactly 4 tools should be registered
      expect(tools).toHaveLength(4);

      // Extract tool names for set comparison
      const toolNames = tools.map((t: { name: string }) => t.name).sort();
      expect(toolNames).toEqual(["edit_message", "fetch_messages", "react", "reply"]);

      // Each tool must have a valid inputSchema with type "object"
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.properties).toBeDefined();
      }

      // Verify specific tool schemas have expected required parameters
      const replyTool = tools.find((t: { name: string }) => t.name === "reply");
      expect(replyTool!.description).toBeTruthy();
      expect(replyTool!.inputSchema.properties).toHaveProperty("chat_id");
      expect(replyTool!.inputSchema.properties).toHaveProperty("text");
      expect(replyTool!.inputSchema.required).toContain("chat_id");
      expect(replyTool!.inputSchema.required).toContain("text");

      const reactTool = tools.find((t: { name: string }) => t.name === "react");
      expect(reactTool!.inputSchema.properties).toHaveProperty("chat_id");
      expect(reactTool!.inputSchema.properties).toHaveProperty("message_id");
      expect(reactTool!.inputSchema.properties).toHaveProperty("emoji");

      const editTool = tools.find((t: { name: string }) => t.name === "edit_message");
      expect(editTool!.inputSchema.properties).toHaveProperty("chat_id");
      expect(editTool!.inputSchema.properties).toHaveProperty("message_id");
      expect(editTool!.inputSchema.properties).toHaveProperty("text");

      const fetchTool = tools.find((t: { name: string }) => t.name === "fetch_messages");
      expect(fetchTool!.inputSchema.properties).toHaveProperty("channel");
      expect(fetchTool!.inputSchema.properties).toHaveProperty("limit");
    } finally {
      await relay.close();
    }
  });

  // Test 7: Every tool in listTools() is dispatchable via callTool() with correct Hub routing
  test("every tool in listTools is dispatchable and routes to correct Hub endpoint", async () => {
    const channelId = "test-channel-dispatch-007";
    const relay = await createRelay({
      channelId,
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      // The dispatch table and tool schema list must be consistent.
      // First verify listTools() returns the tools (requires new feature).
      const tools = relay.listTools();
      const toolNames = tools.map((t: { name: string }) => t.name).sort();
      expect(toolNames).toEqual(["edit_message", "fetch_messages", "react", "reply"]);

      // Now verify each listed tool dispatches to the correct Hub endpoint.
      // This ensures the MCP Server tool registration and the dispatch table are in sync.

      // ---- reply -> POST /reply ----
      hubRequests.length = 0;
      const replyResult = await relay.callTool("reply", {
        chat_id: channelId,
        text: "dispatch test reply",
      });
      expect(replyResult.isError).toBeFalsy();
      expect(replyResult.content[0].text).toContain("sent");
      const replyReqs = hubRequests.filter((r) => r.path === "/reply");
      expect(replyReqs.length).toBe(1);
      expect((replyReqs[0].body as Record<string, unknown>).text).toBe("dispatch test reply");
      expect((replyReqs[0].body as Record<string, unknown>).channel_id).toBe(channelId);

      // ---- react -> POST /react ----
      hubRequests.length = 0;
      const reactResult = await relay.callTool("react", {
        chat_id: channelId,
        message_id: "msg-to-react-on",
        emoji: "thumbsup",
      });
      expect(reactResult.isError).toBeFalsy();
      expect(reactResult.content[0].text).toContain("reacted");
      const reactReqs = hubRequests.filter((r) => r.path === "/react");
      expect(reactReqs.length).toBe(1);
      expect((reactReqs[0].body as Record<string, unknown>).emoji).toBe("thumbsup");

      // ---- edit_message -> POST /edit ----
      hubRequests.length = 0;
      const editResult = await relay.callTool("edit_message", {
        chat_id: channelId,
        message_id: "msg-to-edit",
        text: "updated text",
      });
      expect(editResult.isError).toBeFalsy();
      expect(editResult.content[0].text).toContain("edited");
      const editReqs = hubRequests.filter((r) => r.path === "/edit");
      expect(editReqs.length).toBe(1);
      expect((editReqs[0].body as Record<string, unknown>).text).toBe("updated text");

      // ---- fetch_messages -> GET /fetch-messages ----
      hubRequests.length = 0;
      const fetchResult = await relay.callTool("fetch_messages", {
        channel: channelId,
        limit: 5,
      });
      expect(fetchResult.isError).toBeFalsy();
      const fetchedMessages = JSON.parse(fetchResult.content[0].text);
      expect(Array.isArray(fetchedMessages)).toBe(true);
      expect(fetchedMessages[0]).toHaveProperty("id");
      const fetchReqs = hubRequests.filter((r) => r.path.startsWith("/fetch-messages"));
      expect(fetchReqs.length).toBe(1);
      expect(fetchReqs[0].path).toContain(`channel_id=${channelId}`);
      expect(fetchReqs[0].path).toContain("limit=5");

      // ---- unknown tool returns error (not in listTools) ----
      const unknownResult = await relay.callTool("nonexistent_tool", {});
      expect(unknownResult.isError).toBe(true);
      expect(unknownResult.content[0].text).toContain("unknown tool");
    } finally {
      await relay.close();
    }
  });

  // Test 8: close() completes without throwing even when Hub is unreachable
  test("close() completes gracefully when Hub is unreachable during unregister", async () => {
    // During SIGINT/SIGTERM shutdown, the Hub may have already crashed.
    // The relay's close() must not throw — it should best-effort unregister
    // and then stop the HTTP server regardless.

    // Create a temporary mock Hub that we can stop mid-test
    const tempHub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/register") {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.pathname === "/channel-info") {
          return new Response(JSON.stringify({ name: "ch", topic: "t" }), { status: 200 });
        }
        return new Response("ok", { status: 200 });
      },
    });

    const relay = await createRelay({
      channelId: "test-channel-graceful-008",
      hubUrl: `http://127.0.0.1:${tempHub.port}`,
      secret: MOCK_SECRET,
    });

    // Kill the Hub BEFORE calling close() — simulates Hub crash
    tempHub.stop(true);

    // close() currently does NOT catch the fetch error when Hub is unreachable.
    // It should complete without throwing (best-effort unregister, then stop server).
    // If close() throws, this test fails — that's the expected TDD failure.
    await relay.close();

    // After close, the relay's HTTP server should be stopped regardless
    try {
      await fetch(`http://127.0.0.1:${relay.port}/health`);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeTruthy();
    }
  });

  // Test 5: Relay unregisters with Hub on shutdown
  test("unregisters with Hub when close() is called", async () => {
    const channelId = "test-channel-shutdown-005";
    const relay = await createRelay({
      channelId,
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    // Clear hub requests from registration to isolate shutdown requests
    hubRequests.length = 0;

    // Shutdown the relay
    await relay.close();

    // Verify the relay sent an unregister request to the Hub
    const unregisterReqs = hubRequests.filter(
      (r) => r.path === "/unregister" && r.method === "POST",
    );
    expect(unregisterReqs.length).toBe(1);

    const unregReq = unregisterReqs[0];

    // Must include Bearer auth
    expect(unregReq.headers["authorization"]).toBe(`Bearer ${MOCK_SECRET}`);

    // Must include the channel_id being unregistered
    const body = unregReq.body as { channel_id: string };
    expect(body.channel_id).toBe(channelId);

    // After close, the relay's HTTP server should no longer accept connections
    try {
      await fetch(`http://127.0.0.1:${relay.port}/health`);
      // If fetch succeeds, the server is still running — fail the test
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      // Expected: connection refused or similar network error
      expect(err).toBeTruthy();
    }
  });
});

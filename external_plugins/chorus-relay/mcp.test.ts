/**
 * Tests for MCP integration: onMessage callback, session_id, channel push.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import type { Server } from "bun";
import { createRelay } from "./relay";
import { makeChannelPushCallback } from "./relay";

type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

let mockHub: Server;
let hubPort: number;
const hubRequests: RecordedRequest[] = [];
const MOCK_SECRET = "test-secret-mcp";

beforeAll(() => {
  mockHub = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const recorded: RecordedRequest = {
        method: req.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(req.headers.entries()),
        body: null,
      };
      if (req.method === "POST") {
        try { recorded.body = await req.json(); } catch { recorded.body = null; }
      }
      hubRequests.push(recorded);

      if (url.pathname === "/register") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.pathname === "/channel-info") return new Response(JSON.stringify({ name: "test", topic: "MCP test" }), { status: 200 });
      if (url.pathname === "/unregister") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("ok", { status: 200 });
    },
  });
  hubPort = mockHub.port;
});

afterAll(() => { mockHub.stop(); });
afterEach(() => { hubRequests.length = 0; });

describe("createRelay onMessage callback", () => {
  test("onMessage is called when /message is POSTed", async () => {
    const receivedMessages: unknown[] = [];

    const relay = await createRelay({
      channelId: "mcp-test-001",
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
      onMessage: async (payload) => {
        receivedMessages.push(payload);
      },
    });

    try {
      const message = {
        content: "Hello from Hub!",
        meta: {
          chat_id: "mcp-test-001",
          message_id: "msg-100",
          user: "testuser",
          user_id: "uid-200",
          ts: "2026-04-09T10:00:00Z",
        },
      };

      await fetch(`http://127.0.0.1:${relay.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(receivedMessages).toHaveLength(1);
      expect((receivedMessages[0] as any).content).toBe("Hello from Hub!");
      expect((receivedMessages[0] as any).meta.user).toBe("testuser");
    } finally {
      await relay.close();
    }
  });

  test("no onMessage callback still returns 200", async () => {
    const relay = await createRelay({
      channelId: "mcp-test-002",
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${relay.port}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test", meta: {} }),
      });
      expect(res.status).toBe(200);
    } finally {
      await relay.close();
    }
  });
});

describe("relay registration includes session_id", () => {
  test("register request includes session_id field", async () => {
    const relay = await createRelay({
      channelId: "mcp-test-sid",
      hubUrl: `http://127.0.0.1:${hubPort}`,
      secret: MOCK_SECRET,
    });

    try {
      const regReqs = hubRequests.filter(
        (r) => r.path === "/register" && r.method === "POST",
      );
      expect(regReqs.length).toBeGreaterThanOrEqual(1);

      const body = regReqs[regReqs.length - 1].body as Record<string, unknown>;
      expect(body.session_id).toBeDefined();
      expect(typeof body.session_id).toBe("string");
      expect((body.session_id as string).length).toBeGreaterThan(0);
    } finally {
      await relay.close();
    }
  });
});

describe("MCP server capability declaration", () => {
  test("capabilities includes experimental claude/channel", async () => {
    // Read the compiled source to assert the literal capability declaration.
    // This is a structural test — we don't need a running Server, just proof
    // that the string appears in the file exactly where main() constructs it.
    const src = await Bun.file(
      new URL("./relay.ts", import.meta.url),
    ).text();
    const serverConstructorRegion = src.slice(src.indexOf("new Server("));
    expect(serverConstructorRegion).toContain("experimental");
    expect(serverConstructorRegion).toContain("'claude/channel'");
  });
});

describe("makeChannelPushCallback", () => {
  test("calls mcp.notification with claude/channel method and payload shape", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeMcp = {
      notification: async (n: { method: string; params: unknown }) => {
        calls.push(n);
      },
    };

    const push = makeChannelPushCallback(fakeMcp as any);

    await push({
      content: "hello world",
      meta: {
        chat_id: "c1",
        message_id: "m1",
        user: "alice",
        user_id: "u1",
        ts: "2026-04-14T00:00:00Z",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("notifications/claude/channel");
    const params = calls[0].params as {
      content: string;
      meta: Record<string, string>;
    };
    expect(params.content).toBe("hello world");
    expect(params.meta.chat_id).toBe("c1");
    expect(params.meta.message_id).toBe("m1");
    expect(params.meta.user).toBe("alice");
    expect(params.meta.user_id).toBe("u1");
    expect(params.meta.ts).toBe("2026-04-14T00:00:00Z");
  });

  test("swallows notification errors without throwing", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const fakeMcp = {
      notification: async (n: { method: string; params: unknown }) => {
        calls.push(n);
        throw new Error("transport closed");
      },
    };

    const push = makeChannelPushCallback(fakeMcp as any);

    // Must not throw — relay's HTTP /message handler treats onMessage as
    // fire-and-forget and can't propagate errors back to the Hub.
    await push({
      content: "x",
      meta: {
        chat_id: "c",
        message_id: "m",
        user: "u",
        user_id: "uid",
        ts: "t",
      },
    });

    // Behavior assertion: notification() was called with the right method —
    // a regression that short-circuits (e.g., wraps push in `.catch(() => {})`
    // before the await) would skip this and the test would catch it.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("notifications/claude/channel");
  });
});

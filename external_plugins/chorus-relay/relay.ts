/**
 * Chorus Relay — MCP channel server that bridges a Hub to Claude Code.
 *
 * On startup: starts an HTTP server on a random port, registers with the Hub,
 * and fetches channel info for MCP instructions.
 *
 * Inbound: Hub POSTs messages to /message; the relay converts them to MCP
 * notifications.
 *
 * Outbound: MCP tools (reply, react, edit_message, fetch_messages) proxy to
 * Hub endpoints with Bearer auth.
 *
 * On shutdown: unregisters with Hub and stops the HTTP server.
 */

import type { Server as BunServer } from "bun";

// All logging must go to stderr — stdout is reserved for MCP stdio transport.
// When CHORUS_LOG is set, also append to that file for debugging.
import { appendFileSync } from "fs";
const LOG_FILE = process.env.CHORUS_LOG || "/tmp/chorus-relay.log";

function log(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] [chorus.relay] ${args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ")}`;
  console.error(line);
  if (LOG_FILE) {
    try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InboundMessage = {
  content: string;
  meta: {
    chat_id: string;
    message_id: string;
    user: string;
    user_id: string;
    ts: string;
  };
};

type RelayOpts = {
  channelId: string;
  hubUrl: string;
  secret: string;
  onMessage?: (payload: InboundMessage) => Promise<void>;
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
};

type RelayInstance = {
  port: number;
  close: () => Promise<void>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  listTools: () => ToolSchema[];
};

// ---------------------------------------------------------------------------
// Hub HTTP helpers
// ---------------------------------------------------------------------------

function hubHeaders(secret: string): Record<string, string> {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
  };
}

async function hubPost(
  hubUrl: string,
  path: string,
  secret: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: hubHeaders(secret),
    body: JSON.stringify(body),
  });
}

async function hubGet(
  hubUrl: string,
  path: string,
  secret: string,
): Promise<Response> {
  return fetch(`${hubUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${secret}` },
  });
}

// ---------------------------------------------------------------------------
// Tool handlers — proxy to Hub endpoints
// ---------------------------------------------------------------------------

async function handleReply(
  hubUrl: string,
  secret: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const res = await hubPost(hubUrl, "/reply", secret, {
    channel_id: args.chat_id as string,
    text: args.text as string,
    ...(args.reply_to ? { reply_to: args.reply_to as string } : {}),
    ...(args.files ? { files: args.files } : {}),
  });
  const data = await res.json();
  const messageId = (data as Record<string, unknown>).message_id ?? "";
  return {
    content: [{ type: "text", text: `sent (id: ${messageId})` }],
  };
}

async function handleReact(
  hubUrl: string,
  secret: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await hubPost(hubUrl, "/react", secret, {
    channel_id: args.chat_id as string,
    message_id: args.message_id as string,
    emoji: args.emoji as string,
  });
  return { content: [{ type: "text", text: "reacted" }] };
}

async function handleEditMessage(
  hubUrl: string,
  secret: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  await hubPost(hubUrl, "/edit", secret, {
    channel_id: args.chat_id as string,
    message_id: args.message_id as string,
    text: args.text as string,
  });
  return { content: [{ type: "text", text: "edited" }] };
}

async function handleFetchMessages(
  hubUrl: string,
  secret: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const channel = args.channel as string;
  const limit = (args.limit as number) ?? 20;
  const res = await hubGet(
    hubUrl,
    `/fetch-messages?channel_id=${channel}&limit=${limit}`,
    secret,
  );
  const messages = await res.json();
  return {
    content: [{ type: "text", text: JSON.stringify(messages) }],
  };
}

// ---------------------------------------------------------------------------
// MCP tool schemas — returned by listTools() and used by MCP ListToolsRequest
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "reply",
    description: "Send a message to the Discord channel",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID to send the reply to" },
        text: { type: "string", description: "Message text to send" },
        reply_to: { type: "string", description: "Message ID to reply to (optional)" },
      },
      required: ["chat_id", "text"],
    },
  },
  {
    name: "react",
    description: "Add an emoji reaction to a message",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "Message ID to react to" },
        emoji: { type: "string", description: "Emoji name to react with" },
      },
      required: ["chat_id", "message_id", "emoji"],
    },
  },
  {
    name: "edit_message",
    description: "Edit an existing message in the Discord channel",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Channel ID containing the message" },
        message_id: { type: "string", description: "Message ID to edit" },
        text: { type: "string", description: "New text for the message" },
      },
      required: ["chat_id", "message_id", "text"],
    },
  },
  {
    name: "fetch_messages",
    description: "Fetch recent messages from a Discord channel",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Channel ID to fetch messages from" },
        limit: { type: "number", description: "Maximum number of messages to fetch" },
      },
      required: ["channel"],
    },
  },
];

// ---------------------------------------------------------------------------
// Channel push — experimental claude/channel notification
// ---------------------------------------------------------------------------
// Minimal interface of the MCP Server we depend on: just `notification`.
// Typed as an interface so tests can pass a spy without constructing a real
// Server (which would require a transport).
interface ChannelNotifier {
  notification(n: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<void>;
}

export function makeChannelPushCallback(
  mcp: ChannelNotifier,
): (payload: InboundMessage) => Promise<void> {
  return async (payload: InboundMessage) => {
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: payload.content,
          meta: {
            chat_id: payload.meta.chat_id,
            message_id: payload.meta.message_id,
            user: payload.meta.user,
            user_id: payload.meta.user_id,
            ts: payload.meta.ts,
          },
        },
      });
      log("notification sent chat_id=" + payload.meta.chat_id);
    } catch (err) {
      log("notification FAILED chat_id=" + payload.meta.chat_id + " (continuing):", err);
    }
  };
}

// ---------------------------------------------------------------------------
// createRelay — public entry point
// ---------------------------------------------------------------------------

export async function createRelay(opts: RelayOpts): Promise<RelayInstance> {
  const { channelId, hubUrl, secret } = opts;

  // Tool dispatch table
  const toolHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<ToolResult>
  > = {
    reply: (args) => handleReply(hubUrl, secret, args),
    react: (args) => handleReact(hubUrl, secret, args),
    edit_message: (args) => handleEditMessage(hubUrl, secret, args),
    fetch_messages: (args) => handleFetchMessages(hubUrl, secret, args),
  };

  // Start HTTP server on a random port
  const server: BunServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/message" && req.method === "POST") {
        const body = (await req.json()) as InboundMessage;
        log(
          "/message received from Hub: chat_id=" + body.meta.chat_id,
          "user=" + body.meta.user,
          "content=" + JSON.stringify(body.content.slice(0, 120)),
        );
        if (opts.onMessage) {
          opts.onMessage(body).catch((err) => {
            log("onMessage callback error:", err);
          });
        } else {
          log("WARNING: no onMessage callback registered");
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const relayPort = server.port;
  log("HTTP server listening on 127.0.0.1:" + relayPort);

  // Register with Hub
  const sessionId = `relay-${channelId}-${Date.now()}`;
  log("Registering with Hub at " + hubUrl, "channel=" + channelId, "port=" + relayPort);
  const regRes = await hubPost(hubUrl, "/register", secret, {
    channel_id: channelId,
    port: relayPort,
    session_id: sessionId,
  });
  log("Register response: status=" + regRes.status);
  if (!regRes.ok) {
    log("REGISTER FAILED body=" + (await regRes.text()));
  }

  // Fetch channel info from Hub for MCP instructions
  const infoRes = await hubGet(hubUrl, `/channel-info?channel_id=${channelId}`, secret);
  log("channel-info response: status=" + infoRes.status);

  // callTool dispatches to the appropriate tool handler
  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const handler = toolHandlers[name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }],
      };
    }
    try {
      return await handler(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `${name} failed: ${msg}` }],
      };
    }
  }

  // close — unregister with Hub (best-effort) and stop HTTP server
  async function close(): Promise<void> {
    try {
      await hubPost(hubUrl, "/unregister", secret, {
        channel_id: channelId,
      });
    } catch {
      // Best-effort unregister — Hub may already be down
    }
    server.stop(true);
  }

  // listTools — returns MCP tool schemas for all registered tools
  function listTools(): ToolSchema[] {
    return TOOL_SCHEMAS;
  }

  return {
    port: relayPort,
    close,
    callTool,
    listTools,
  };
}

// ---------------------------------------------------------------------------
// MCP stdio server — main() entry point for running as an MCP channel server
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function readSecret(): string {
  const secretPath =
    process.env.CHORUS_SECRET_PATH ||
    join(homedir(), ".chorus", ".secret");
  return readFileSync(secretPath, "utf-8").trim();
}

async function main(): Promise<void> {
  log("Relay starting (pid=" + process.pid + ")");
  const channelId = process.env.CHORUS_CHANNEL;
  if (!channelId) {
    log("FATAL: CHORUS_CHANNEL environment variable is required");
    process.exit(1);
  }

  const hubUrl = process.env.CHORUS_HUB || "http://127.0.0.1:8799";
  log("Config: channel=" + channelId + " hub=" + hubUrl);
  const secret = readSecret();
  log("Secret loaded (len=" + secret.length + ")");

  const mcpServer = new Server(
    { name: "chorus-relay", version: "0.2.0" },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
        },
      },
      instructions: [
        'The sender reads Discord, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.',
        '',
        'Messages from Discord arrive as <channel source="chorus-relay" chat_id="..." message_id="..." user="..." ts="...">. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.',
        '',
        'reply accepts file paths (files: ["/abs/path.png"]) for attachments. Use react to add emoji reactions, and edit_message for interim progress updates. Edits don\'t trigger push notifications — when a long task completes, send a new reply so the user\'s device pings.',
        '',
        'fetch_messages pulls real Discord history. Discord\'s search API isn\'t available to bots — if the user asks you to find an old message, fetch more history or ask them roughly when it was.',
      ].join('\n'),
    }
  );

  let relay: RelayInstance;

  relay = await createRelay({
    channelId,
    hubUrl,
    secret,
    onMessage: makeChannelPushCallback(mcpServer),
  });

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: relay.listTools(),
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await relay.callTool(name, (args ?? {}) as Record<string, unknown>);
  });

  const transport = new StdioServerTransport();
  log("Connecting MCP stdio transport...");
  await mcpServer.connect(transport);
  log("MCP stdio transport connected — ready to receive tool calls");

  process.on("SIGINT", async () => {
    await relay.close();
    await mcpServer.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await relay.close();
    await mcpServer.close();
    process.exit(0);
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Relay startup failed:", err);
    process.exit(1);
  });
}

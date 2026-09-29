import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const MCP_PATH = "/mcp";
const AION_API_KEY = process.env.AION_API_KEY;
const AION_MODEL = process.env.AION_MODEL || "aion-labs/aion-3.5";
const AION_URL = "https://api.aionlabs.ai/v1/chat/completions";

async function callAion({ prompt, context = "", reasoning_effort = "high", max_tokens = 8000 }) {
  if (!AION_API_KEY) throw new Error("AION_API_KEY is not configured.");

  const messages = [];
  if (context.trim()) {
    messages.push({
      role: "system",
      content:
        "Use the following user-supplied context when relevant. Preserve the user's current request as the controlling task. Do not claim facts from the context were independently verified.\n\n" +
        context.trim(),
    });
  }
  messages.push({ role: "user", content: prompt.trim() });

  const upstream = await fetch(AION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AION_API_KEY}`,
    },
    body: JSON.stringify({
      model: AION_MODEL,
      messages,
      reasoning_effort,
      reasoning_split: true,
      max_tokens,
    }),
    signal: AbortSignal.timeout(120000),
  });

  const raw = await upstream.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { raw }; }

  if (!upstream.ok) {
    const err = new Error(`Aion request failed with HTTP ${upstream.status}`);
    err.details = data;
    throw err;
  }

  const msg = data?.choices?.[0]?.message || {};
  return {
    model: data?.model || AION_MODEL,
    response: msg.content || "",
    usage: data?.usage || null,
    finish_reason: data?.choices?.[0]?.finish_reason || null,
  };
}

function createAionServer() {
  const server = new McpServer(
    { name: "aion-video-specialist", version: "2.0.0" },
    {
      instructions:
        "Use ask_aion when the user explicitly asks to consult Aion or when the Aion Video Specialist is invoked. Pass permanent video context and current-series context in the context field. Return Aion's visible answer; do not invent or expose hidden reasoning.",
    }
  );

  server.registerTool(
    "ask_aion",
    {
      title: "Ask Aion",
      description:
        "Send a prompt and optional video-development context to Aion 3.5 and return Aion's visible response. Use for Aion-assisted ideation, research synthesis, script development, critique, and production-package generation.",
      inputSchema: {
        prompt: z.string().min(1).describe("The current instruction or question for Aion."),
        context: z.string().optional().default("").describe(
          "Optional permanent Aion Video Context plus any current video/series context."
        ),
        reasoning_effort: z.enum(["low", "high", "max"]).optional().default("high"),
        max_tokens: z.number().int().min(1).max(32768).optional().default(8000),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await callAion(args);
        return {
          content: [{ type: "text", text: result.response }],
          structuredContent: result,
        };
      } catch (error) {
        const detail = error?.details ? `\n${JSON.stringify(error.details)}` : "";
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Ask Aion failed: ${error?.message || String(error)}${detail}`,
          }],
        };
      }
    }
  );

  return server;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "Aion Video Specialist", version: "2.0.0", mcp: MCP_PATH }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      version: "2.0.0",
      aion_key_configured: Boolean(AION_API_KEY),
      model: AION_MODEL,
      mcp_endpoint: MCP_PATH,
    }));
    return;
  }

  // During unauthenticated development, explicitly return 404 for OAuth discovery.
  if (
    url.pathname === "/.well-known/oauth-protected-resource" ||
    url.pathname === "/.well-known/oauth-authorization-server"
  ) {
    res.writeHead(404).end("Not Found");
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === MCP_PATH && ["POST", "GET", "DELETE"].includes(req.method || "")) {
    setCors(res);
    const server = createAionServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request error:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal MCP server error" }));
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Aion Video Specialist v2 listening on ${PORT}${MCP_PATH}`);
});

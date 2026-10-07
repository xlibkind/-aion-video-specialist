import { createServer } from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT || 10000);
const MCP_PATH = "/mcp";
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;
const QUICK_WAIT_MS = 18000;
function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
}
function submitJob(args) {
  pruneJobs();
  const id = crypto.randomUUID();
  const job = { id, createdAt: Date.now(), status: "running" };
  jobs.set(id, job);
  job.promise = callAion(args).then(result => {
    if (!result.response?.trim()) {
      job.status = "failed";
      job.error = result.finish_reason === "length"
        ? "Aion exhausted max_tokens before producing visible text. Retry with a larger max_tokens budget or break the assignment into smaller parts."
        : "Aion returned no visible text.";
      job.usage = result.usage;
    } else { job.status = "completed"; job.result = result; }
  }).catch(error => { job.status = "failed"; job.error = error?.message || String(error); });
  return job;
}
function jobPayload(job) {
  if (job.status === "completed") return { job_id: job.id, status: job.status, ...job.result };
  if (job.status === "failed") return { job_id: job.id, status: job.status, error: job.error, usage: job.usage || null };
  return { job_id: job.id, status: "running", message: "Aion is still processing. Call get_aion_result with this job_id." };
}
function toolResult(payload) { return { content: [{ type: "text", text: payload.response || JSON.stringify(payload) }], structuredContent: payload }; }
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
    signal: AbortSignal.timeout(300000),
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
      const job = submitJob(args);
      await Promise.race([
        job.promise,
        new Promise(resolve => setTimeout(resolve, QUICK_WAIT_MS)),
      ]);
      return toolResult(jobPayload(job));
    }
  );

  server.registerTool(
    "get_aion_result",
    {
      title: "Get Aion Result",
      description: "Retrieve the result of an Aion request that returned a running job_id. Poll until status is completed or failed.",
      inputSchema: { job_id: z.string().uuid() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      pruneJobs();
      const job = jobs.get(job_id);
      return toolResult(job ? jobPayload(job) : { job_id, status: "not_found", message: "Job not found or expired; try submitting the request again." });
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

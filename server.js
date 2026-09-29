import express from "express";
import crypto from "crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;
const AION_API_KEY = process.env.AION_API_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const AION_MODEL = process.env.AION_MODEL || "aion-labs/aion-3.5";
const AION_URL = "https://api.aionlabs.ai/v1/chat/completions";

function secureEqual(a = "", b = "") {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorize(req, res, next) {
  if (!BRIDGE_API_KEY) {
    return res.status(503).json({ error: "Bridge authentication is not configured." });
  }
  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!secureEqual(supplied, BRIDGE_API_KEY)) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

app.get("/", (_req, res) => {
  res.json({ service: "Aion Video Specialist", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    aion_key_configured: Boolean(AION_API_KEY),
    bridge_auth_configured: Boolean(BRIDGE_API_KEY),
    model: AION_MODEL
  });
});

app.post("/ask-aion", authorize, async (req, res) => {
  try {
    if (!AION_API_KEY) {
      return res.status(503).json({ error: "AION_API_KEY is not configured." });
    }

    const { prompt, context = "", reasoning_effort = "high", max_tokens = 8000 } = req.body || {};

    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required." });
    }
    if (typeof context !== "string") {
      return res.status(400).json({ error: "context must be a string." });
    }

    const allowedEffort = new Set(["low", "high", "max"]);
    if (!allowedEffort.has(reasoning_effort)) {
      return res.status(400).json({ error: "reasoning_effort must be low, high, or max." });
    }

    const boundedMaxTokens = Math.max(1, Math.min(Number(max_tokens) || 8000, 32768));

    const messages = [];
    if (context.trim()) {
      messages.push({
        role: "system",
        content:
          "The following is durable and/or project-specific context supplied by the user. Use it when relevant, but follow the user's current request as the task.\n\n" +
          context.trim()
      });
    }
    messages.push({ role: "user", content: prompt.trim() });

    const upstream = await fetch(AION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AION_API_KEY}`
      },
      body: JSON.stringify({
        model: AION_MODEL,
        messages,
        reasoning_effort,
        reasoning_split: true,
        max_tokens: boundedMaxTokens
      }),
      signal: AbortSignal.timeout(120000)
    });

    const raw = await upstream.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { raw };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: "Aion request failed.",
        upstream_status: upstream.status,
        details: data
      });
    }

    const message = data?.choices?.[0]?.message || {};
    return res.json({
      model: data?.model || AION_MODEL,
      response: message.content || "",
      usage: data?.usage || null,
      finish_reason: data?.choices?.[0]?.finish_reason || null
    });
  } catch (err) {
    const timeout = err?.name === "TimeoutError";
    return res.status(timeout ? 504 : 500).json({
      error: timeout ? "Aion request timed out." : "Bridge request failed.",
      message: err?.message || String(err)
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aion Video Specialist listening on ${PORT}`);
});

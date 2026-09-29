# Aion Video Specialist v2

A stateless MCP Streamable HTTP server that exposes one tool, `ask_aion`, to ChatGPT and forwards the tool's prompt/context to Aion 3.5.

## Render environment

Required:
- `AION_API_KEY` — keep this only in Render.
- `AION_MODEL` — `aion-labs/aion-3.5`.

The old `BRIDGE_API_KEY` is not used by v2. It may remain in Render temporarily, but the code does not read it.

## Endpoints

- `GET /health`
- MCP Streamable HTTP: `/mcp`

## Deployment

Replace the repository's existing files with the v2 files and commit to `main`. Render should redeploy automatically.

After deployment:
1. Check `/health` and confirm `version` is `2.0.0` and `aion_key_configured` is `true`.
2. Connect `https://aion-video-specialist.onrender.com/mcp` as an MCP server in ChatGPT.
3. During this development phase the MCP endpoint itself has no user authentication. Do not treat this as the final security configuration.
4. After MCP connectivity is confirmed, add the appropriate private-access/authentication layer before relying on it long-term.

## Tool

`ask_aion` inputs:
- `prompt` (required)
- `context` (optional)
- `reasoning_effort`: low | high | max
- `max_tokens`: 1–32768

The tool returns Aion's visible response plus structured metadata. Hidden reasoning is not returned.

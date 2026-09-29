# Aion Video Specialist

A small authenticated bridge between ChatGPT and the Aion Labs API.

## Endpoints

- `GET /health` — deployment/configuration check. Does not expose secret values.
- `POST /ask-aion` — sends a prompt plus optional context to Aion 3.5.

## Required Render secrets

- `AION_API_KEY` — your Aion Labs API key. Enter this only in Render.
- `BRIDGE_API_KEY` — a separate secret protecting this bridge from unauthorized use.
- `AION_MODEL` — defaults to `aion-labs/aion-3.5`.

Never commit real secret values to GitHub.

## Request shape

POST `/ask-aion`

Authorization header:

`Bearer <BRIDGE_API_KEY>`

JSON body:

```json
{
  "prompt": "Develop the next three caregiver video ideas.",
  "context": "Permanent Aion Video Context plus any current-series context.",
  "reasoning_effort": "high",
  "max_tokens": 8000
}
```

The bridge returns Aion's visible response, usage data, model, and finish reason. It deliberately does not return Aion's private reasoning field.

## Deploy on Render

1. Upload these files to the GitHub repository.
2. In Render, create a Web Service from that repository, or use the included `render.yaml` as a Blueprint.
3. Enter the real `AION_API_KEY` in Render's environment settings.
4. Keep `BRIDGE_API_KEY` secret. If Render does not generate it automatically, create a long random value.
5. Deploy.
6. Open `/health` on the Render service URL and verify both configuration flags are `true`.
7. Connect the deployed service to the ChatGPT plugin. Configure the plugin to call `POST /ask-aion` with Bearer authentication using `BRIDGE_API_KEY`.

## Security

The Aion key is never accepted from request bodies and is never returned by the service. The `/ask-aion` endpoint requires a separate bridge secret so strangers cannot spend your Aion credits.

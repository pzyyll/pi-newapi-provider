# Pi NewAPI Provider

A pi custom provider template for NewAPI/OpenAI-compatible gateways.

## Usage

```bash
export NEWAPI_BASE_URL="http://localhost:3000/v1"
export NEWAPI_API_KEY="sk-..."

# Test this local package directly
pi -e .
```

Then select a model from the `newapi/...` provider in `/model`.

## Model discovery

On startup, the extension calls `GET $NEWAPI_BASE_URL/models` when `NEWAPI_API_KEY` is set. If discovery fails, it falls back to `NEWAPI_MODELS`.

```bash
export NEWAPI_MODELS="gpt-4o-mini,qwen3-coder"
export NEWAPI_FETCH_MODELS=false
```

## Useful settings

- `NEWAPI_BASE_URL` — OpenAI-compatible base URL, usually ending in `/v1`.
- `NEWAPI_API_KEY` — gateway API key.
- `NEWAPI_INPUTS` — comma-separated inputs: `text` or `text,image`.
- `NEWAPI_REASONING` — set `true` if all configured models support reasoning.
- `NEWAPI_THINKING_FORMAT` — one of `openai`, `openrouter`, `deepseek`, `together`, `zai`, `qwen`, or `qwen-chat-template`.
- `NEWAPI_HEADERS` — JSON object of additional headers.

For per-model metadata, edit `toProviderModel()` in `index.ts`.

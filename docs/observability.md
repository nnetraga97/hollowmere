# Structured logging

Hollowmere writes one JSON object per server-side event. Every entry includes:

- `timestamp` — UTC ISO-8601 time
- `service` — `hollowmere-web`, `hollowmere-scheduler`, or an explicit `SERVICE_NAME`
- `level` — `debug`, `info`, `warn`, or `error`
- `event` — a stable machine-searchable event name

`LOG_LEVEL` controls emission and defaults to `info`. Supported values are
`debug`, `info`, `warn`, `error`, and `silent`.

## Operational coverage

- Process lifecycle: `web_process_starting`, `scheduler_process_ready`, shutdown events
- Database: pool lifecycle, query failures, transaction retries and retry exhaustion
- Inference: client configuration and completion, stream, and embedding outcomes
- Scheduler: claims, ticks, lease renewal failures, sweeps, and runner failures
- Web mutations: session/world lifecycle, movement, conversation, and romance actions
- HTTP failures: `web_request_rejected` and `web_request_failed` with route and method
- Guardrails: `conversation_response_rejected` with the exact rejection code and detail

Successful live-provider calls are logged at `info`. Successful stub calls are
logged at `debug` to keep offline/test output quiet. Provider prompts and API
credentials are never logged.

Rejected conversation output is the deliberate exception: the warning includes
up to 4,000 characters of the raw provider response so a fallback can be
diagnosed after the fact. It may echo player-provided text, so production log
access and retention should be treated as sensitive.

Example:

```json
{"timestamp":"2026-07-27T17:00:00.000Z","service":"hollowmere-web","level":"warn","event":"conversation_response_rejected","modelId":"hollowmere-gpt-5-mini","rejectionCode":"unknown_claim_key","rejectionDetail":"received \"invented_claim\""}
```

Useful local filters:

```bash
npm run azure:web | jq -R 'fromjson? | select(.level == "warn" or .level == "error")'
npm run azure:scheduler | jq -R 'fromjson? | select(.event | startswith("inference_"))'
```

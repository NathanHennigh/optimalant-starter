# Local reference API

Base URL: `http://127.0.0.1:8787`. This contract belongs to the standalone starter, **not** `optimalant.ai`. Start it with `npm start`. [openapi.json](openapi.json) describes the same routes and schemas.

This API is a single-process, local-only reference with no authentication. An enrollment ID is not a secret or access token. Read [SECURITY.md](SECURITY.md) before using it.

## Routes

| Method and path | Request | Response (HTTP 200) |
| --- | --- | --- |
| `GET /health` | None | Status, reference mode, SQLite storage, API version |
| `GET /v1/programs` | None | `{programs}`: currently loaded definitions and fingerprints |
| `POST /v1/enrollments` | `{id, programId, parameters?, context?}` | `{enrollment, progress}` |
| `GET /v1/enrollments/{id}` | None | `{enrollment, progress}` |
| `POST /v1/enrollments/{id}/checkins` | `{id, values}` | `{checkin, enrollment, progress, duplicate}` |
| `POST /v1/enrollments/{id}/coach` | `{id}` | `{trace, duplicate}` |
| `GET /v1/enrollments/{id}/traces` | None | `{traces, outcomes}` |
| `POST /v1/enrollments/{id}/outcomes` | `{id, traceId, note}` | `{outcome, duplicate}` |

There are no list-all-enrollments, arbitrary evaluation, delete, prompt-upload, or provider-selection routes. The older starter's `POST /v1/evaluations` is not served by `npm start` in this version. Replay evaluation is a local command described in [docs/evaluation.md](docs/evaluation.md).

## Try a full loop

Run these in a second terminal from the repository root. Use a new enrollment ID to start a different round.

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/programs

curl -X POST http://127.0.0.1:8787/v1/enrollments -H "Content-Type: application/json" -d '{"id":"focus-demo","programId":"focus-7","context":{"goal":"Finish one small task","constraints":["I have twenty minutes today"]}}'

curl -X POST http://127.0.0.1:8787/v1/enrollments/focus-demo/checkins -H "Content-Type: application/json" -d '{"id":"focus-day1","values":{"focus":20}}'

curl -X POST http://127.0.0.1:8787/v1/enrollments/focus-demo/coach -H "Content-Type: application/json" -d '{"id":"focus-coach1"}'

curl -X POST http://127.0.0.1:8787/v1/enrollments/focus-demo/outcomes -H "Content-Type: application/json" -d '{"id":"focus-outcome1","traceId":"focus-coach1","note":"Synthetic report: setting a start time helped me begin."}'

curl http://127.0.0.1:8787/v1/enrollments/focus-demo/traces
curl http://127.0.0.1:8787/v1/enrollments/focus-demo
```

In Windows PowerShell, use native requests to avoid differences in command-line JSON escaping:

```powershell
$base = 'http://127.0.0.1:8787'
$headers = @{ 'Content-Type' = 'application/json' }

$join = @{
  id = 'focus-demo'
  programId = 'focus-7'
  context = @{
    goal = 'Finish one small task'
    constraints = @('I have twenty minutes today')
  }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod "$base/v1/enrollments" -Method Post -Headers $headers -Body $join

$checkin = @{ id = 'focus-day1'; values = @{ focus = 20 } } | ConvertTo-Json
Invoke-RestMethod "$base/v1/enrollments/focus-demo/checkins" -Method Post -Headers $headers -Body $checkin

$coach = @{ id = 'focus-coach1' } | ConvertTo-Json
Invoke-RestMethod "$base/v1/enrollments/focus-demo/coach" -Method Post -Headers $headers -Body $coach

$outcome = @{
  id = 'focus-outcome1'
  traceId = 'focus-coach1'
  note = 'Synthetic report: setting a start time helped me begin.'
} | ConvertTo-Json
Invoke-RestMethod "$base/v1/enrollments/focus-demo/outcomes" -Method Post -Headers $headers -Body $outcome
Invoke-RestMethod "$base/v1/enrollments/focus-demo/traces"
```

Stop and restart the server, then fetch the same enrollment to see its saved state. The default database is `.data/plane.sqlite`; the separate `npm run example` command instead uses and removes a temporary database.

## Request rules

Every POST requires `Content-Type: application/json`. Maximum body size is 32 KiB. Compressed bodies and unknown fields are rejected. Query strings and trailing slashes are not part of these routes.

- Record IDs: 1–80 characters; start with a letter or digit, then letters, digits, underscores, or hyphens.
- Program IDs: the IDs returned by `GET /v1/programs`.
- `parameters`: numeric overrides for the selected program's settings; omitted values use its defaults.
- `context.goal` and `context.startingPoint`: optional nonempty strings, at most 500 characters each.
- `context.notes`: optional nonempty text, at most 1,000 characters.
- `context.constraints`: optional array of up to eight nonempty strings, at most 200 characters each.
- `values`: an object of known action IDs with their boolean or numeric values. An empty or partial snapshot is allowed. Numeric bounds and integer rules come from the program.
- `note`: nonempty participant-reported text, at most 1,000 characters.

The API sets all timestamps and local calendar dates using the server clock and the program's time zone. Callers cannot supply a start date, backdate an event, or override progress. A check-in outside the round's active dates returns 409.

For `consistency-14`, an example enrollment override is `{"protein-goal":160,"strength-days":3}`; a complete daily snapshot is `{"protein":160,"movement":true,"sleep":true,"strength":false}`. Strength is a weekly counter and does not gate daily completion. See [the program guide](docs/programs.md) for grace and week boundaries.

### Corrections and retries

Each saved check-in is a complete snapshot, not a patch. To correct today's values, send a **new** event ID and all values that should remain. A missing action in the new snapshot no longer contributes to that day's completion. Earlier events remain in storage; the latest event is used for progress.

IDs are unique within each record collection across enrollments. Repeating the same ID with the same request content and enrollment returns the original saved event without duplicating it; different content returns 409. Object key order does not matter. Semantically similar requests that differ in fields, such as omitted defaults versus explicitly supplied defaults, are different request content.

Check-in and outcome replies expose `duplicate`. Enrollment creation instead returns the saved enrollment and progress recomputed at the current time. A duplicate check-in also returns current progress, so an identical retry can show a different current day later without changing the saved event.

A coaching request ID caches its original trace. Retrying it does not call the provider again or re-read changed progress. Use a new ID to request coaching on newer check-ins. Concurrent identical requests in one process share the same in-flight call. A completed trace survives restart; a crash after a provider response but before saving the trace can still cause another provider call on retry. This is not an exactly-once provider guarantee or a distributed job queue.

## Response objects

### Enrollment and progress

An enrollment stores `id`, `programId`, `programVersion`, `programFingerprint`, `startDate`, resolved `parameters`, `context`, and `createdAt`. Its program version and files are pinned. Existing enrollments do not silently adopt new rules or prompts.

| Progress field | Meaning |
| --- | --- |
| `asOfDate`, `endDate` | Evaluation's local date and inclusive final round date |
| `dayNumber` | Calendar position, bounded between 0 and duration |
| `completedDays` | Days whose required daily targets were actually met |
| `consistencyDays` | Current consistency span, including grace gaps bridged by a later completion |
| `graceUsed`, `graceRemaining` | Round allowance consumed and left |
| `tier` | Highest milestone reached by consistency, or `Begin again` |
| `days` | Every round date, status, completion, latest values, and missing required actions |
| `weekly` | Monday–Sunday windows and each weekly action's completed count, target, and `met` |

Daily status is `future`, `open`, `complete`, `grace`, or `missed`. An incomplete current day remains open until local midnight. Full rules are in [docs/programs.md](docs/programs.md).

### Coach trace

A trace records its ID, enrollment, creation time, pinned program information, the input snapshot, and a `result`. The input includes the enrollment, computed progress, and latest check-in snapshot for each recorded day.

`result` contains `responseVersion: 1`, `adapter`, `model` (null for the local template), `promptHash`, `programFingerprint`, `response`, and `fallback`. A response looks like:

```json
{
  "message": "1 consistency day recorded. The daily targets are complete.",
  "nextAction": {
    "actionId": "focus",
    "text": "Choose a time for your next focus check-in."
  }
}
```

The example text is illustrative; actual replies include the evaluated date and program label. A message is at most 800 characters; the next-action text is at most 400 and its ID must belong to the program. Render all text as text, never as HTML.

When an enabled provider fails or returns invalid output, `fallback: true` records a local response plus `requestedAdapter`, `requestedModel`, and a sanitized `errorCode`. HTTP 200 in that case means a usable trace was saved; it does not mean Claude succeeded. See [docs/evaluation.md](docs/evaluation.md) for explicit provider configuration and comparison behavior.

### Outcome

An outcome has `id`, `enrollmentId`, `traceId`, `note`, `reportedAt`, `source: "participant-report"`, and `causalClaim: false`. The trace must belong to the same enrollment. A report does not alter a check-in, prove the recommendation worked, or train a model.

Each enrollment supports up to 1,000 check-in events, 1,000 coach traces, and 1,000 outcomes as local storage bounds. These are not spend budgets or hosted-service allowances.

## Errors

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Unexpected field.",
    "field": "startDate"
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Malformed JSON or interrupted request |
| 403 | Nonlocal Host or cross-origin/cross-site browser request |
| 404 | Unknown route, enrollment, or linked trace |
| 405 | Wrong method; the `Allow` header names the required method |
| 409 | Reused ID with different content; changed program without a version bump; inactive round; storage bound |
| 413 | JSON body exceeds 32 KiB |
| 415 | Unsupported content type or encoding |
| 422 | Invalid request fields, unknown program/action, or invalid values |
| 500 | Unexpected internal failure; no stack or request data returned |

Error bodies use `{error:{code,message,field?}}`. Do not depend on exact human-readable messages for control flow.

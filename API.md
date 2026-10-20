# Local reference API

Base URL: `http://127.0.0.1:8787`. These endpoints belong to this local starter. They are **not** an API contract for `optimalant.ai`.

## GET /health

```json
{ "status": "ok", "mode": "local-reference", "adapter": "local-template-v1" }
```

## POST /v1/evaluations

Content type: `application/json`. Maximum body: 16 KiB. Compressed bodies are rejected. Every field below is required; additional fields are rejected.

```json
{
  "goal": {
    "id": "evening-routine",
    "title": "A calmer evening",
    "actions": [
      { "id": "read", "label": "Read for 10 minutes" },
      { "id": "plan", "label": "Write down tomorrow's first task" }
    ]
  },
  "startDate": "2026-01-01",
  "throughDate": "2026-01-02",
  "history": [
    { "date": "2026-01-01", "completedActions": ["read", "plan"] }
  ],
  "checkIn": { "date": "2026-01-02", "completedActions": ["read", "plan"] }
}
```

| Field | Rules |
| --- | --- |
| `goal.id`, action `id` | 1–40 characters; lowercase letter first, then lowercase letters, digits, or hyphens |
| `goal.title`, action `label` | Nonempty text, maximum 100 characters, no control characters |
| `goal.actions` | 1–8 actions, unique IDs |
| `startDate`, `throughDate` | Valid `YYYY-MM-DD` dates in 2000–2100; inclusive window of 1–31 dates |
| `history` | Up to 30 events; unique dates inside the window, strictly before `throughDate` |
| `checkIn.date` | Must equal `throughDate` |
| `completedActions` | Array of known action IDs, without duplicates; an empty array is valid |

No timestamps, member identity, arbitrary note, provider, or model fields are accepted. Do not put personal information in labels. This example has no authentication, persistence, or member isolation because it stores nothing and is local-only.

### Successful response

HTTP 200:

```json
{
  "evaluation": {
    "goalId": "evening-routine",
    "startDate": "2026-01-01",
    "throughDate": "2026-01-02",
    "totalDays": 2,
    "completeDays": 2,
    "completionPercent": 100,
    "currentStreak": 2,
    "days": [
      { "date": "2026-01-01", "complete": true, "completedActions": ["read", "plan"], "missingActions": [] },
      { "date": "2026-01-02", "complete": true, "completedActions": ["read", "plan"], "missingActions": [] }
    ]
  },
  "coaching": {
    "adapter": "local-template-v1",
    "message": "All 2 actions recorded. Your streak is 2 days. Choose a time for your next check-in."
  },
  "persisted": false
}
```

`completionPercent` is rounded to a whole percent. Day output is chronological; action IDs are ordered by the goal definition. Render all text as text, never as HTML. A successful response evaluates input; it does not mark a real person's check-in complete.

### Errors

```json
{
  "error": {
    "code": "invalid_input",
    "message": "Unknown action ID.",
    "field": "checkIn.completedActions"
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Malformed JSON or interrupted request |
| 403 | Nonlocal Host or cross-origin/cross-site browser request |
| 404 | Unknown path; query strings are not supported |
| 405 | Wrong method; see `Allow` header |
| 413 | JSON body exceeds 16 KiB |
| 415 | Unsupported content type or encoding |
| 422 | Invalid schema or event semantics; includes `field` |
| 500 | Unexpected internal failure; no stack or request data returned |

## Try the complete synthetic example

With the server running, execute from the repository root:

```sh
curl -X POST http://127.0.0.1:8787/v1/evaluations -H "Content-Type: application/json" --data-binary @fixtures/evening-routine.json
```

Use `curl.exe` in Windows PowerShell. Unlike the shorter two-day request above, this fixture intentionally has one partial day: its expected result is 3 of 4 complete days, 75%, and a two-day streak.

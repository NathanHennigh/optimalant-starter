# Security and privacy boundary

This is a local reference for inspection and evaluation, not a deployable public service. Use synthetic participants and invented notes. The executable binds to `127.0.0.1`; do not expose it through a public tunnel, reverse proxy, or changed bind address.

## Local controls

- Strict JSON schemas, known action and parameter IDs, bounded text and arrays, and validated calendar dates.
- A 32 KiB HTTP request-body limit, including chunked requests; compressed bodies are rejected.
- Host and browser Origin checks, no cross-origin permission, finite HTTP timeouts, and no response caching.
- Server-controlled enrollment and event dates. HTTP callers cannot backdate a check-in or choose a different evaluation date.
- Idempotent write IDs: repeating an identical write returns the original result; changing its content while reusing the ID returns a conflict.
- Validated input is persisted in SQLite using parameterized statements. There are technical record bounds per enrollment; these are not AI spending limits.
- No request-body logging or stack traces in HTTP errors.
- Rule calculations remain independent of model output. A coach reply cannot silently mark an action complete.

These controls do not authenticate a caller. A process on the same computer can call the API, read the database with the same operating-system permissions, or forge HTTP headers. Enrollment IDs are identifiers, not passwords. There is no multi-tenant isolation.

## Data and files

The local API persists participant context, check-ins, coaching traces, and outcome notes in `.data/plane.sqlite` by default. SQLite data is not encrypted by this application. Keep database files, generated reports containing private cases, environment files, and credentials out of commits and public issues. The example and test suite use temporary databases.

There is no automatic telemetry or upload of outcomes. Reports are written locally when requested. The reference has no access to OptimalAnt production systems or member data. It has no retention scheduler or participant-facing deletion API; these are requirements for any later service handling real people.

Program definitions, prompt files, and provider adapters are trusted local configuration. HTTP callers cannot choose a filesystem path, replace program instructions, or load code. The adapter interface is not a sandbox for malicious plugins. Do not load untrusted code into this process. Treat participant notes and other supplied context as untrusted content, even when they appear inside a prompt.

## Optional external AI

The local coach makes no provider calls. An API key alone does not activate Claude: the server requires an explicit provider selection, and live evaluation requires `--claude`. Keep credentials in the process environment; never put them in program files, prompts, requests, reports, or Git.

Before any local, custom, Claude, or fallback adapter runs, the program's `coach.visibleFields` allowlist filters participant data. Omitted or empty lists share no participant fields. Static program configuration and `coach.md` always remain visible, so keep participant-specific information out of those files. The full replay snapshot is still stored locally; the allowlist is not a storage-deletion or authentication mechanism.

When Claude is enabled, those static instructions and explicitly allowed participant fields are sent to Anthropic. Responses are bounded and validated, and provider failures use a recorded local fallback with the same projection. The application does not let model output execute tools or alter the rules. Field filtering, prompt separation, and validation do not guarantee resistance to every prompt injection, prevent every invented claim, or make advice clinically reliable.

There is no monthly budget control or per-person AI allowance in this reference. A timeout, payload limit, or record bound is not a cost cap. Anyone who can access the local endpoint can trigger enabled coaching calls, so do not expose it. Review the provider's data handling and costs before using real data or enabling calls.

## Before a hosted service

Separately design authentication and authorization, tenant isolation, consent, encrypted storage, retention and deletion, abuse and cost controls, audit trails, monitoring, deployment hardening, and an approved provider/data policy. Real integrations also require verification of sender identity and explicit handling of user consent and external side effects. The included local Host/Origin checks are not substitutes for these controls.

Report vulnerabilities privately to the repository owner. Do not include API keys or personal information in a public issue. Public reports and fixtures must use synthetic examples.

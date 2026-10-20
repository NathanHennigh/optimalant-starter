# Security boundary

This is a local reference, not a deployable public service. Run it with synthetic data. The provided executable binds to `127.0.0.1`; it does not provide a network exposure setting. Do not expose it through a public tunnel, reverse proxy, or changed bind address.

Included controls:

- No dependencies, external requests, model credentials, database, or filesystem writes.
- Strict input schema, calendar-date validation, known action IDs, bounded strings and windows.
- 16 KiB request-body limit, including chunked requests; compressed bodies rejected.
- Host and browser Origin checks, no CORS permission, finite HTTP timeouts.
- No request-body logging, no cached responses, and no internal stack traces in HTTP errors.
- Coach output is text only; computation does not trust a model to decide completion.

These do not replace authentication. A process running on the same machine can call the endpoint or supply HTTP headers. The adapter interface is for trusted code; freezing its input is not isolation against malicious plug-ins.

Before any public service, separately build authentication and authorization, tenant isolation, rate and resource controls, encrypted durable storage, deletion/retention policies, audit logging, abuse handling, deployment monitoring, and a versioned contract. A model integration also needs user consent, provider-specific privacy review, safe prompting, timeouts, bounded costs, and validated output. A real check-in save requires explicit user review and server-side identity checks.

If you discover a problem, contact the repository owner privately. Do not include account keys or personal information in a public issue. This starter has no access to OptimalAnt production data or systems.

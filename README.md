# OptimalAnt developer starter

Clone this repository to run a complete local example:

**Goal + check-in → rules evaluate progress → coach returns a reply.**

Investors can see the flow run with invented data. Builders can inspect the rules, adapter interface, and local HTTP endpoint. This is a standalone reference, with no access to the private OptimalAnt application, live API, or member data.

## Try it in about two minutes

With **Node.js 22+ and Git installed**, cloning and running the example should take about two minutes. No dependency installs, accounts, API keys, or server startup are needed.

```sh
git clone https://github.com/NathanHennigh/optimalant-starter.git
cd optimalant-starter
npm run example
```

You'll see JSON for an invented four-day evening routine: **3 of 4 days complete, 75% completion, and a current streak of 2**, followed by:

> All 2 actions recorded. Your streak is 2 days. Choose a time for your next check-in.

The reply comes from **a local template, not Claude or another AI model**. Nothing is sent to a provider or saved; the output includes `persisted: false`.

Start reading with the [synthetic input](fixtures/evening-routine.json), [rules engine](src/evaluation.mjs), and [coach adapter](src/coach.mjs).

## Run the tests and local API

After trying the example:

```sh
npm test
npm start
```

The optional server binds only to `127.0.0.1:8787`; set `PORT` if that local port is occupied. It exposes the same evaluation through HTTP. See [API.md](API.md) for the request format and errors.

From a second terminal:

```sh
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/v1/evaluations -H "Content-Type: application/json" --data-binary @fixtures/evening-routine.json
```

In Windows PowerShell, use `curl.exe` for those commands. Run them from the repository root.

## What this demonstrates

- Strict validation of a goal, earlier daily records, and a new check-in event.
- A pure rules engine with predictable results, independent of AI or the server clock.
- A coach adapter that sees a frozen projection and returns text only.
- A small HTTP interface with bounded JSON input and useful errors.
- Unit and local HTTP tests that require no accounts or external services.

The new event must match `throughDate`; history must precede it. One date is complete only when every configured action is present. Missing dates are incomplete. The current streak ends at `throughDate`, and an incomplete final date makes it zero. Dates are explicit calendar labels, evaluated as closed days; UTC is used only for calendar arithmetic.

These deliberately simple rules are **not a copy of the live challenge's business rules**. There are no grace days, time-zone deadlines, scheduled strength rules, rewards, payments, or renewals in this starter. Repeated requests evaluate the supplied data again; they do not create or update an account.

## Coach boundary

`src/coach.mjs` defines the `reply(context)` interface. `runEvaluation(input, adapter)` accepts a trusted adapter from application code; HTTP callers cannot select a provider, supply a system prompt, or inject tools. The context contains only the validated goal, the new check-in, and its computed evaluation. Adapter output cannot override progress.

The default is deterministic. A real model adapter is **not included**. Before adding one, design consent, sensitive-data handling, server-held credentials, timeouts, output validation, budget controls, and a fallback. Treat goal text and future user notes as untrusted data. A read-only context prevents accidental mutation; it is not a sandbox for untrusted plug-in code. Do not load user-submitted adapters into this process.

## Files

| File | Purpose |
| --- | --- |
| `src/evaluation.mjs` | Validation and pure consistency evaluation |
| `src/coach.mjs` | Text-only adapter boundary and local template |
| `src/server.mjs` | Local HTTP server |
| `src/example.mjs` | Direct, no-server example |
| `fixtures/evening-routine.json` | Synthetic request |
| `test/` | Rules, adapter boundary, and HTTP tests |
| [API.md](API.md) | Request, response, errors, and curl usage |
| [SECURITY.md](SECURITY.md) | Local-only security boundary and production gaps |

## What is not built here

This is not an agent marketplace, model registry, wearable integration, health recommendation engine, SMS gateway, or social inbox bot. It has no accounts, authentication, database, durable events, API keys, billing, or access to the OptimalAnt service. It does not share the application's code, data, images, or documents.

Possible future work includes a versioned authenticated developer API, reviewed coaching packs, and permissioned wearable connections. Those are roadmap ideas, not capabilities of this repository or commitments to a release date.

## Reuse

You may clone and run this reference locally for inspection and evaluation. Broader reuse terms are undecided; this repository has no open-source license. See [RIGHTS.md](RIGHTS.md). `private: true` in `package.json` prevents accidental npm publication; GitHub visibility is a separate setting.

# OptimalAnt plane reference

A small local foundation for programs, check-ins, coaching, and outcome evaluation:

**Define a program → record a check-in → calculate progress → coach → record the outcome → compare a change.**

The same engine runs a 14-day consistency challenge and a 7-day focus sprint. Programs supply data, coaching instructions, and sample cases; the engine owns validation, progress, and persistence. This is a standalone reference with synthetic examples, not the private OptimalAnt application or a hosted API.

**Reuse terms are still pending.** You may clone and run this repository locally for inspection and evaluation. It has no open-source license or permission for redistribution or incorporation into another product. See [RIGHTS.md](RIGHTS.md).

## Try the complete loop

With **Git and Node.js 22.13 or newer installed**, the offline example requires no dependency installation, accounts, or API keys:

```sh
git clone https://github.com/NathanHennigh/optimalant-starter.git
cd optimalant-starter
npm run example
```

The example runs both programs with invented participants and a temporary SQLite database. It demonstrates saved check-ins, calculated progress, a local coach reply, and a reported outcome. The local coach is a deterministic template, not an AI model. Node may print an experimental SQLite warning.

Then inspect the program definitions and run the evaluation harness:

```sh
npm run check:programs
npm run evaluate
npm test
```

The harness checks rules against explicit expected results and compares coach behavior on fixed cases. An offline pass does **not** mean a model has been tested or that a program improves real-world health or habits. See [the evaluation guide](docs/evaluation.md).

## Start the local API

```sh
npm start
```

The server binds to `127.0.0.1:8787`. Enrollment, check-in, coach-trace, and outcome records persist in `.data/plane.sqlite` across restarts. Use synthetic data; the database is a local unencrypted file. Do not publish this server or expose it through a tunnel.

From a second terminal:

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/programs
```

PowerShell users can use the native request examples in [API.md](API.md). That guide covers the complete check-in → coach → outcome sequence. [openapi.json](openapi.json) is the machine-readable local API contract.

When forwarding CLI options from PowerShell, use `npm.cmd`, for example `npm.cmd run evaluate -- --program focus-7`, so the npm PowerShell wrapper does not drop option names.

## What makes another program possible

Each program lives in a directory with three files:

| File | Purpose |
| --- | --- |
| `program.json` | Duration, parameters, daily and weekly actions, consistency rules, milestones, and which participant fields the coach may see |
| `coach.md` | Program-specific instructions for the coach |
| `cases.json` | Synthetic cases with expected progress and coaching checks |

The [program guide](docs/programs.md) explains the supported building blocks and how to try a third program locally without changing the engine. The shipped focus program is the second example of this boundary; it is not a separate implementation.

This is a bounded configuration format, not a general-purpose programming language. A new kind of rule may require an engine change and tests. Program folders are trusted local files loaded at startup; there is no HTTP upload or execution of third-party code.

## Rules and coaching are separate

- The rules engine determines completion, streaks, grace use, weekly progress, and milestones.
- A coach receives static program instructions and only the participant fields explicitly listed in `coach.visibleFields`. Omitted or empty lists share no participant data, including with the offline coach or fallback.
- The coach returns a message and a proposed next action. It cannot rewrite check-ins, award milestones, or change the rules.
- A saved trace records what was recommended and the program/coach information used. A later outcome attaches a participant-reported note to that trace.
- The evaluation harness replays fixed cases to help review a proposed change. It never automatically promotes a prompt, model, or rule into production.

Self-reported outcomes are observations, not proof that a recommendation caused improvement. The reference does not train or fine-tune a model.

The local database retains the full replay snapshot for each trace; the visibility list controls the narrower input passed to an adapter. Static program defaults remain visible and are separate from a participant's personal overrides. See [the program guide](docs/programs.md#coach-visible-fields) for the exact supported paths and how older definitions behave.

## Optional Claude connection

The default remains offline even if an API key happens to exist in the environment. To make real provider calls, explicitly set all three:

```text
COACH_PROVIDER=claude
ANTHROPIC_API_KEY=<your own key>
ANTHROPIC_MODEL=<a model ID available to your account>
```

For the evaluation harness, opt in separately with `--claude`; follow [the evaluation guide](docs/evaluation.md). Never commit a key. Claude calls transmit static program instructions and the explicitly allowed participant fields to Anthropic and can incur charges. Use invented data while evaluating this reference. The implementation bounds and validates replies, records failures, and falls back to the local coach. Field filtering limits the data supplied to a coach; it does not guarantee that model-generated text cannot invent a claim. Tests mock the provider and do not establish that a live key or model is available.

## Configuration

| Variable | Default / use |
| --- | --- |
| `PORT` | `8787`; local HTTP port |
| `PLANE_DB_PATH` | `.data/plane.sqlite`; local SQLite file |
| `PROGRAMS_DIR` | `programs`; trusted local program directories, loaded at startup |
| `COACH_PROVIDER` | `local`; explicitly choose `claude` for live coaching |
| `ANTHROPIC_API_KEY` | Required only for explicitly enabled Claude calls |
| `ANTHROPIC_MODEL` | Required explicit model ID for Claude; no hidden model default |

## Boundaries

This release has no authentication, hosted developer service, public deployment configuration, payment processing, SMS, wearable connections, social inboxes, model marketplace, or automatic self-improvement. It has no access to OptimalAnt production data, keys, card artwork, or private coaching prompts. The challenge definition demonstrates the current consistency rules; it does not grant free rounds, charge for renewals, or generate production cards.

Read [SECURITY.md](SECURITY.md) before running the API, [API.md](API.md) for the local contract, [docs/programs.md](docs/programs.md) for program definitions, [docs/evaluation.md](docs/evaluation.md) for comparisons, and [CONTRIBUTING.md](CONTRIBUTING.md) for reporting an issue.

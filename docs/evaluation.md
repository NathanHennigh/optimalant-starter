# Evaluation and human review

The harness compares a baseline and candidate version of the **same program** against fixed synthetic cases. Both sides receive the baseline's inputs, expected results, and rubric. Candidate changes cannot quietly weaken their own test expectations.

It checks exact progress fields and narrow coach-output assertions. It does not measure real user outcomes, automatically improve a model, or approve a deployment.

## Offline commands

```sh
npm run evaluate
npm run evaluate -- --program focus-7
npm run evaluate -- --baseline programs/focus-7 --candidate experiments/focus-candidate --output artifacts/focus-comparison.json
```

In Windows PowerShell, use `npm.cmd` instead of `npm` in commands that forward options: `npm.cmd run evaluate -- --program focus-7`. The npm PowerShell wrapper can otherwise strip option names. Direct `node src/cli.mjs evaluate --program focus-7` also works.

The first command runs every program against itself as a smoke check. The second selects one program. For the third command, first copy the focus directory to `experiments/focus-candidate` and make a candidate change. Keep its program ID `focus-7`; use a new version for changed content.

Both `--baseline` and `--candidate` are required together. Do not combine that pair with `--program`. Paths are trusted local directories, never API input. `--output` writes a report only if the output file does not already exist; choose a new name for each run.

A failed rule assertion or coaching check makes the command exit with a nonzero status. Baseline failures also fail the run: an already-broken reference should not make a candidate look good. Errors loading configuration or writing a report also exit nonzero.

The offline coach is a template that uses the program definition and only the computed progress fields allowed by `coach.visibleFields`. It does not interpret `coach.md`. Changing only that prompt will therefore not demonstrate improved coaching in an offline comparison.

The harness applies each version's visibility policy before calling its coach, including local templates and fallback. A comparison keeps the underlying case inputs fixed; changing the allowlist can intentionally change the subset the coach receives. Omitted or empty lists share no participant fields and produce generic local coaching. Inspect visibility changes alongside prompt and rule changes rather than treating a smaller input as identical coaching context. The full local case and computed results remain available to evaluate rules; the allowlist is an adapter-input boundary, not a test-data deletion rule.

## Case format

`cases.json` contains `schemaVersion: 1` and 1–100 cases. Case IDs are unique lowercase identifiers. Here is a complete minimal file:

```json
{
  "schemaVersion": 1,
  "cases": [
    {
      "id": "complete-first-session",
      "description": "Twenty minutes completes the first focus day.",
      "input": {
        "startDate": "2026-10-19",
        "asOf": "2026-10-19T22:00:00Z",
        "parameters": { "focus-minutes": 20 },
        "context": {
          "goal": "Finish one small task",
          "constraints": ["I only have twenty minutes today"]
        },
        "checkins": [
          {
            "id": "first-session",
            "date": "2026-10-19",
            "recordedAt": "2026-10-19T21:00:00Z",
            "values": { "focus": 20 }
          }
        ]
      },
      "expected": {
        "completedDays": 1,
        "consistencyDays": 1,
        "graceRemaining": 1,
        "tier": "Started"
      },
      "rubric": {
        "allowedActionIds": ["focus"],
        "mustMention": ["consistency"],
        "mustAvoid": ["guaranteed"]
      }
    }
  ]
}
```

Required input fields are `startDate`, `asOf`, and `checkins`; `parameters` and `context` are optional. Explicit dates belong to replay cases and the pure engine, not to the HTTP write API. A snapshot's local `date` must match `recordedAt` in the program time zone, lie within the round, and not be recorded after `asOf`.

`expected` is a subset of progress fields. Objects are compared recursively. An asserted array must have the exact length and order expected; omitted fields are not checked. Include assertions for the behavior a case is intended to protect.

The optional rubric provides exact, case-insensitive phrase checks and a list of allowed next-action IDs. It is not a semantic grader. Avoid using a phrase check as a proxy for clinical safety, instruction adherence, or whether a recommendation is useful.

## What the report means

The JSON file wraps comparisons in `{"schemaVersion":1,"reports":[...]}`. Each comparison includes:

- Baseline and candidate program IDs, versions, fingerprints, prompt hashes, adapter IDs, and model names.
- A fingerprint of the pinned baseline cases and `casesSource: "baseline"`.
- Per-case progress, exact rule differences, coach responses, fallback information, and automated checks.
- Counts of baseline/candidate rule failures, coaching-check failures, and regressions.
- An explicit human-review requirement and review questions.

GitHub CI also saves the full synthetic offline comparison. Open the repository's **Actions** tab, select a completed **Reference checks** run, and download an `offline-comparison-node-<version>` artifact. It contains `offline-comparison.json` with both versions' coach responses and rule checks. Artifacts are retained for 14 days. These reports use the local template; they do not contain real Claude calls or participant data.

A regression is counted when a baseline case passed a rule or coaching check group and the candidate failed that group. The overall result also fails if either version fails any required group.

Automated coaching checks verify a valid known next action, no provider fallback, optional literal rubric phrases, and a few explicit numerical claim patterns such as “3 consistency days.” They do **not** recognize every way a coach could misstate a fact, ignore a constraint, or give poor advice. A provider failure is visible as a fallback and fails the coaching-success check rather than being presented as successful AI.

Before accepting a candidate, review whether each response is useful, relevant to the participant's context, consistent with computed progress, and free of unsupported causal claims. Read differences, not just the pass count.

## Explicit Claude comparison

Set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` securely in the shell, then explicitly opt in:

```sh
npm run evaluate -- --program focus-7 --claude --output artifacts/focus-live-comparison.json
```

Or provide a baseline/candidate pair together with `--claude`. Without that flag, the CLI remains offline even when provider environment variables exist. The server's separate switch is `COACH_PROVIDER=claude`.

Each case calls the baseline and candidate sequentially, using the same configured model and key; even comparing a program against itself makes two calls per case. Responses can differ between runs. This implementation does not provide a random seed or guarantee deterministic model output. The report records the model and prompt fingerprints for review.

Provider calls send static program instructions and only the synthetic participant fields declared in that program's `coach.visibleFields` to Anthropic and can incur charges. Static program defaults are visible independently of personal parameter overrides. Use your own key; no OptimalAnt credits are provided. The adapter has a timeout, reply-size bounds, structured validation, and a recorded local fallback using the same filtered context. These are technical bounds, not an account spending cap or a guarantee against invented claims.

The test suite mocks the provider. Passing tests is not evidence that a live credential, account, model, or network connection works.

## From traces to evidence

The local API stores the full local replay snapshot and the recommendation, with the program version and response metadata. That snapshot can contain fields the coach was not allowed to see: the adapter receives a filtered projection according to the pinned program's `coach.visibleFields`. A participant can attach an outcome note to the trace. A note is stored as `source: "participant-report"` and `causalClaim: false`; it does not automatically change completion, become a training example, or update a prompt.

Turning real outcomes into evaluation cases requires a deliberate review and privacy process. No private participant data is uploaded to this public repository or published as a case by this reference.

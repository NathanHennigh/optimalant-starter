# Program definitions

A program is a trusted local directory containing `program.json`, `coach.md`, and `cases.json`. `PROGRAMS_DIR` selects the parent directory before server startup. Programs are loaded once at startup; HTTP callers cannot upload or edit them.

The two shipped examples use the same engine:

| Program | Daily completion | Weekly tracking | Grace | Milestones |
| --- | --- | --- | --- | --- |
| `consistency-14` | Protein at the personal target; movement and sleep both true | Strength sessions, default 3 per Monday–Sunday week | 2 per 14-day round | Ember 1, Spark 3, Steady 7, Locked 14 |
| `focus-7` | Focus minutes at the personal target, default 20 | None | 1 per 7-day round | Started 1, Building 3, Finished 7 |

The challenge's movement checkbox means 8,000 steps **or** 30 minutes of cardio; sleep means at least seven hours. The engine evaluates the reported checkbox, not wearable data or exercise intensity. The default protein setting is an example, not a personal nutrition recommendation.

## Definition format

See [the focus definition](../programs/focus-7/program.json) for the smallest shipped example. All top-level fields below are required and unknown fields are rejected.

| Field | Meaning and bounds |
| --- | --- |
| `schemaVersion` | Exactly `1` |
| `id` | Lowercase letter followed by lowercase letters, numbers, or hyphens; 1–40 characters |
| `version` | Numeric `major.minor.patch` string, at most 30 characters |
| `name` | Nonempty text, at most 120 characters |
| `durationDays` | Integer from 1 to 90 |
| `calendar` | Supported IANA `timeZone`; `weekStartsOn: 1` (Monday) |
| `parameters` | Up to 12 named numeric settings, each with `label`, `default`, `min`, and `max` |
| `actions` | 1–12 uniquely named actions; at least one required daily action |
| `consistency` | `graceDays`: integer from 0 to the smaller of 14 and duration; `graceMode: "bridge"` |
| `milestones` | Up to 12 ascending `{at, label}` thresholds, from 1 to the program duration |
| `coach` | Required `promptFile: "coach.md"` and `responseVersion: 1`; optional `visibleFields` list, described below |

An action has `id`, `label`, `type` (`number` or `boolean`), `cadence` (`daily` or `weekly`), `target`, and `requiredForDay`. A number meets its target when it is greater than or equal to it. A boolean must equal its target. Numeric targets can be fixed numbers or `{"parameter":"setting-id"}`. Boolean targets are literal booleans.

Numeric actions can also specify `unit` and `integer: true`. A weekly action requires `weeklyTarget`, a fixed or parameterized integer from 1 to 7; it counts days when the action target is met. Weekly actions must set `requiredForDay: false`.

Numeric parameters and reported values are finite and nonnegative, with a maximum of 1,000,000. Parameter overrides must stay inside their configured range. Settings used by integer actions or weekly targets must remain integers. Unknown settings or action IDs are rejected.

There are no executable expressions, custom network requests, prompt file paths, or dynamic plugins in the schema. New programs can vary these building blocks; new rule types require an engine change and tests.

## Calendar, snapshots, and consistency

The API assigns the enrollment start date and each check-in date using the server clock in the program's time zone. The start date is day 1; the last day is start plus duration minus one, inclusive. A round does not pause or extend when a day is missed. Daylight saving changes use local calendar boundaries.

Each check-in is a **complete snapshot for that day**, even if it contains only some actions. The latest snapshot replaces the earlier snapshot's values; omitted actions are not merged back in. Send every value you want to retain when correcting a day. Later `recordedAt` wins; append order breaks an exact timestamp tie. The API retains earlier events for audit and prevents writing a new check-in outside an active round.

Day status is one of:

- `future`: after the evaluation's local date.
- `open`: today, with at least one required action incomplete; yesterday's consistency count is preserved.
- `complete`: every required daily target is met.
- `grace`: a closed incomplete day covered by an available grace day.
- `missed`: a closed incomplete day with no grace remaining.

The earliest closed incomplete days consume grace, up to the round's allowance. Grace does not replenish after a reset. Trailing grace protects the existing consistency count but does not increase it. A later completed day bridges those grace days into the count. For example, complete → grace → complete yields **2 completed days and 3 consistency days**. A third missed day in the challenge breaks consistency once the two grace days are used.

Milestones use `consistencyDays`, not `completedDays`. With bridge grace, Locked can mean a 14-day consistency span containing covered gaps; it is not a claim of 14 completed check-ins. A grace day alone cannot unlock a new level. The focus example allows one grace day per round, with the same bridge behavior; its second closed missed day breaks consistency.

Weekly strength uses Monday–Sunday calendar weeks. The target is not prorated for a partial first or last week; only dates inside the program round are counted. A day counts at most one strength session, based on its latest snapshot. Weekly strength progress never gates daily completion or consumes grace.

## Coaching instructions and saved versions

`coach.md` describes the program's coaching approach. The Claude adapter uses it as trusted configuration, while allowed participant fields remain separate untrusted input. The offline template uses static program data and whichever progress fields are allowed; it does **not** interpret arbitrary instructions in `coach.md`.

The coaching response has a plain-text `message` and one `nextAction` with a known `actionId` and plain-text `text`. It cannot award completion, alter the program, or execute tools. See [evaluation.md](evaluation.md) for testing prompt changes.

An enrollment pins the program version, instructions, and fingerprint it started with. A fingerprint covers the validated definition, prompt, and cases. Changing any of those files requires a version bump before creating a new enrollment in the same database; existing enrollments continue using their saved version. The starter does not migrate live participants to candidate rules automatically.

## Coach-visible fields

`coach.visibleFields` is an optional array of up to 100 distinct supported paths. It controls the participant data passed to **every** adapter: local, custom, Claude, and the local fallback. Omitted or empty arrays pass no participant data. Older `schemaVersion: 1` definitions remain valid with that private default; unknown schema versions are rejected. Both shipped program versions explicitly declare the fields they use.

For example, a focus coach can be given only the personal goal, focus target, and consistency count:

```json
{
  "promptFile": "coach.md",
  "responseVersion": 1,
  "visibleFields": [
    "enrollment.context.goal",
    "enrollment.parameters.focus-minutes",
    "progress.consistencyDays"
  ]
}
```

The supported paths are:

| Area | Exact supported paths |
| --- | --- |
| Enrollment | `enrollment.startDate`; `enrollment.parameters.<declared parameter ID>` |
| Participant context | `enrollment.context.goal`, `enrollment.context.startingPoint`, `enrollment.context.constraints`, `enrollment.context.notes` |
| Progress totals | `progress.asOfDate`, `progress.endDate`, `progress.dayNumber`, `progress.completedDays`, `progress.consistencyDays`, `progress.graceUsed`, `progress.graceRemaining`, `progress.tier` |
| Daily rows | `progress.days[].date`, `progress.days[].status`, `progress.days[].complete`, `progress.days[].missingActions`, `progress.days[].values.<declared action ID>` |
| Weekly rows | `progress.weekly[].weekStart`, `progress.weekly[].weekEnd`, `progress.weekly[].actions[].id`, `progress.weekly[].actions[].completed`, `progress.weekly[].actions[].target`, `progress.weekly[].actions[].met` |
| Check-in rows | `checkins[].date`, `checkins[].recordedAt`, `checkins[].values.<declared action ID>` |

`[]` means the named field on each row of that array. It is not an arbitrary wildcard, and broad paths such as `progress`, `enrollment.context.*`, or `checkins[]` are rejected. Unknown paths, duplicates, and references to another program's parameter or action IDs are rejected at validation.

Static program configuration and `coach.md` remain visible to adapters. A configured default target is not a participant's personal override; the override is shared only when its `enrollment.parameters.<id>` path is allowed. Do not put participant-specific information into static program files or prompts to bypass the policy.

With no visible fields, adapters receive empty enrollment/progress objects and an empty check-in array. The local template offers a generic next step without asserting a personal day count or completion. The projection limits supplied data, not what a model could invent in its reply; output review remains necessary.

Full enrollment and progress records remain in the local database and saved replay trace. The allowlist limits what reaches the coach; it is not a deletion policy, encryption mechanism, or authorization system. A trace's pinned program fingerprint identifies the visibility policy used. Existing enrollments keep their saved policy until a separate migration is designed.

## Try a third program locally

This exercise is for local inspection and evaluation under [the current reuse terms](../RIGHTS.md).

1. Copy `programs/focus-7` to `programs/reading-7`.
2. In the copy's `program.json`, set `id` to `reading-7`, `name` to `7-day reading sprint`, and rename `focus-minutes` to `reading-minutes` everywhere. Set its default to 10.
3. Rename the action `focus` to `read`, use a reading label, and point its target at `reading-minutes`. Also rename those IDs inside `coach.visibleFields`, including `enrollment.parameters.focus-minutes`, `progress.days[].values.focus`, and `checkins[].values.focus` wherever present. Keep the existing daily cadence, calendar, one-grace-day allowance, and milestone format.
4. Write reading-specific guidance in the copied `coach.md`.
5. Update the copied `cases.json` to use `read` and `reading-minutes`. Include a complete 10-minute day, a partial 9-minute day, a covered grace day, and a second missed day. Each expected result should match the scenario, not merely copy an old result.
6. Run:

```sh
npm run check:programs
npm run evaluate -- --program reading-7
npm test
```

In Windows PowerShell, use `npm.cmd run evaluate -- --program reading-7` to preserve the forwarded option name.

Restart `npm start` and select `reading-7` when creating an enrollment. No engine file should need editing. A real prompt-behavior comparison requires explicit Claude use or another trusted adapter; the offline run verifies data/rules and the response contract.

Use the same program ID for a baseline/candidate comparison. Different programs have their own relevant cases, but both run through the same evaluation harness and schema.

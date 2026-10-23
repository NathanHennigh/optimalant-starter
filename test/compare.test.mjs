import test from "node:test";
import assert from "node:assert/strict";
import { comparePrograms } from "../src/compare.mjs";

function pack() {
  return {
    definition: {
      schemaVersion: 1, id: "focus", version: "1.0.0", name: "Focus sprint", durationDays: 7,
      calendar: { timeZone: "America/New_York", weekStartsOn: 1 },
      parameters: { minutes: { label: "Minutes", default: 20, min: 1, max: 120 } },
      actions: [{ id: "focus", label: "Focused work", type: "number", cadence: "daily", target: { parameter: "minutes" }, requiredForDay: true, unit: "minutes" }],
      consistency: { graceDays: 0, graceMode: "bridge" }, milestones: [{ at: 1, label: "Started" }, { at: 7, label: "Finished" }],
      coach: { promptFile: "coach.md", responseVersion: 1, visibleFields: [
        "enrollment.startDate", "enrollment.parameters.minutes", "enrollment.context.constraints",
        "progress.asOfDate", "progress.consistencyDays", "progress.days[].date", "progress.days[].complete", "progress.days[].missingActions", "progress.days[].values.focus",
        "checkins[].date", "checkins[].recordedAt", "checkins[].values.focus",
      ] },
    },
    prompt: "Help with focused work and respect constraints.",
    cases: { schemaVersion: 1, cases: [{
      id: "first-complete", description: "One target met on the first day.",
      input: { startDate: "2026-10-23", parameters: {}, asOf: "2026-10-23T20:00:00Z", context: { constraints: ["No audio"] }, checkins: [{ id: "e1", date: "2026-10-23", values: { focus: 20 }, recordedAt: "2026-10-23T19:00:00Z" }] },
      expected: { completedDays: 1, consistencyDays: 1, tier: "Started" },
      rubric: { allowedActionIds: ["focus"], mustAvoid: ["listen to music"] },
    }] },
  };
}

test("default comparison is offline and separates exact rules from human quality review", async () => {
  const baseline = pack();
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: structuredClone(baseline) });
  assert.equal(report.passed, true);
  assert.equal(report.summary.cases, 1);
  assert.equal(report.summary.regressions, 0);
  assert.equal(report.humanReview.required, true);
  assert.match(report.humanReview.limitation, /does not prove/);
  assert.equal(report.cases[0].baseline.rules.passed, true);
  assert.equal(report.baseline.model, null);
  assert.match(report.casesFingerprint, /^[a-f0-9]{64}$/);
});

test("candidate cannot weaken the pinned baseline cases when it changes rules", async () => {
  const baseline = pack();
  const candidate = structuredClone(baseline);
  candidate.definition.version = "1.1.0";
  candidate.definition.parameters.minutes.default = 30;
  candidate.cases.cases[0].expected = { consistencyDays: 0 };
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: candidate });
  assert.equal(report.passed, false);
  assert.equal(report.casesSource, "baseline");
  assert.equal(report.summary.candidateRuleFailures, 1);
  assert.deepEqual(report.cases[0].regressions, ["rules"]);
  assert.ok(report.cases[0].candidate.rules.differences.some(item => item.path === "progress.consistencyDays" && item.expected === 1 && item.actual === 0));
});

test("baseline and candidate see identical participant data, with versioned prompts", async () => {
  const baseline = pack();
  const candidate = structuredClone(baseline);
  candidate.prompt = "Offer one small practical focus action.";
  const seen = [];
  const adapter = { id: "recording-adapter", model: "test-model", async reply(context) {
    seen.push(context);
    return { message: "1 consistency day recorded.", nextAction: { actionId: "focus", text: "Choose a quiet place to read." } };
  } };
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: candidate, baselineCoach: adapter, candidateCoach: adapter });
  assert.equal(report.passed, true);
  assert.deepEqual(seen[0].enrollment, seen[1].enrollment);
  assert.deepEqual(seen[0].checkins, seen[1].checkins);
  assert.notEqual(seen[0].prompt, seen[1].prompt);
  assert.notEqual(report.baseline.promptHash, report.candidate.promptHash);
  assert.equal(report.candidate.model, "test-model");
});

test("replay coaching resolves default targets and receives the same latest snapshots as the API", async () => {
  const baseline = pack();
  const sample = baseline.cases.cases[0];
  delete sample.input.parameters;
  sample.input.checkins[0].id = "z-earlier";
  sample.input.checkins.push({ ...sample.input.checkins[0], id: "a-correction", values: { focus: 10 } });
  sample.expected = { completedDays: 0, consistencyDays: 0 };
  const seen = [];
  const adapter = { id: "projection-check", async reply(context) {
    seen.push(context);
    return { message: "Your check-in is not complete yet.", nextAction: { actionId: "focus", text: "Choose a quiet place to continue." } };
  } };
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: baseline, baselineCoach: adapter, candidateCoach: adapter });
  assert.equal(report.passed, true);
  for (const value of seen) {
    assert.deepEqual(value.enrollment.parameters, { minutes: 20 });
    assert.equal(value.checkins.length, 1);
    assert.equal(value.checkins[0].id, undefined);
    assert.equal(value.checkins[0].values.focus, 10);
    assert.equal(value.progress.days[0].values.focus, value.checkins[0].values.focus);
  }
});

test("explicit false numeric claims and named constraint violations surface as regressions", async () => {
  const baseline = pack();
  const bad = { id: "factually-wrong", async reply() { return { message: "99 consistency days recorded.", nextAction: { actionId: "focus", text: "Listen to music while you work." } }; } };
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: baseline, candidateCoach: bad });
  assert.equal(report.passed, false);
  assert.equal(report.summary.candidateCoachingFailures, 1);
  const failures = report.cases[0].candidate.automatedCoaching.checks.filter(check => !check.passed);
  assert.ok(failures.some(check => check.id === "reported-fact:consistency-days"));
  assert.ok(failures.some(check => check.id === "avoids:listen to music"));
  assert.deepEqual(report.cases[0].regressions, ["automated-coaching-checks"]);
});

test("a valid local fallback does not conceal a failed candidate provider", async () => {
  const baseline = pack();
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: baseline, candidateCoach: { id: "broken", async reply() { throw new Error("secret provider error"); } } });
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].candidate.coaching.fallback, true);
  assert.doesNotMatch(JSON.stringify(report), /secret provider error/);
});

test("a bad baseline is reported even when no candidate regression is introduced", async () => {
  const baseline = pack();
  baseline.cases.cases[0].expected.completedDays = 77;
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: baseline });
  assert.equal(report.passed, false);
  assert.equal(report.summary.baselineRuleFailures, 1);
  assert.equal(report.summary.candidateRuleFailures, 1);
  assert.equal(report.summary.regressions, 0);
});

test("a third program uses the same runner with only data and prompts changed", async () => {
  const reading = pack();
  reading.definition.id = "reading";
  reading.definition.name = "Reading sprint";
  reading.definition.actions[0].id = "reading";
  reading.definition.actions[0].label = "Reading";
  reading.definition.coach.visibleFields = reading.definition.coach.visibleFields.map(path => path.replace(/\.focus$/, ".reading"));
  reading.prompt = "Support a daily reading habit.";
  reading.cases.cases[0].input.checkins[0].values = { reading: 20 };
  reading.cases.cases[0].rubric.allowedActionIds = ["reading"];
  const report = await comparePrograms({ baselinePack: reading, candidatePack: structuredClone(reading) });
  assert.equal(report.passed, true);
  assert.equal(report.cases[0].candidate.coaching.response.nextAction.actionId, "reading");
});

test("comparisons require the same program and a nonempty baseline suite", async () => {
  const baseline = pack();
  const candidate = pack();
  candidate.definition.id = "other";
  await assert.rejects(() => comparePrograms({ baselinePack: baseline, candidatePack: candidate }), /same program/);
  baseline.cases.cases = [];
  await assert.rejects(() => comparePrograms({ baselinePack: baseline, candidatePack: baseline }), /sample cases/);
});

test("unsupported candidate rules fail the case without hiding baseline success", async () => {
  const baseline = pack();
  const candidate = structuredClone(baseline);
  candidate.definition.consistency.graceMode = "execute-code";
  const report = await comparePrograms({ baselinePack: baseline, candidatePack: candidate });
  assert.equal(report.passed, false);
  assert.equal(report.cases[0].candidate.rules.errorCode, "PROGRAM_EVALUATION_FAILED");
  assert.deepEqual(report.cases[0].regressions, ["rules", "automated-coaching-checks"]);
});

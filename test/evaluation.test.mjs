import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateCheckIn, InputError } from "../src/evaluation.mjs";
import { runEvaluation } from "../src/coach.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/evening-routine.json", import.meta.url), "utf8"));
const sample = () => structuredClone(fixture);

test("fixture has three completed days and a two-day current streak", async () => {
  const input = sample();
  const before = structuredClone(input);
  const result = await runEvaluation(input);
  assert.equal(result.evaluation.completeDays, 3);
  assert.equal(result.evaluation.totalDays, 4);
  assert.equal(result.evaluation.completionPercent, 75);
  assert.equal(result.evaluation.currentStreak, 2);
  assert.equal(result.coaching.adapter, "local-template-v1");
  assert.equal(result.coaching.message, "All 2 actions recorded. Your streak is 2 days. Choose a time for your next check-in.");
  assert.equal(result.persisted, false);
  assert.deepEqual(input, before);
  assert.deepEqual(await runEvaluation(input), result);
});

test("unreported dates count as incomplete, and output is chronological", () => {
  const input = sample();
  input.history = [input.history[2], input.history[0]];
  const result = evaluateCheckIn(input);
  assert.equal(result.completeDays, 3);
  assert.equal(result.days[1].complete, false);
  assert.deepEqual(result.days[1].missingActions, ["read", "plan"]);
  assert.deepEqual(result.days.map(day => day.date), ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
});

test("partial final event resets streak and suggests an uncompleted action", async () => {
  const input = sample();
  input.checkIn.completedActions = ["read"];
  const result = await runEvaluation(input);
  assert.equal(result.evaluation.currentStreak, 0);
  assert.equal(result.evaluation.completeDays, 2);
  assert.match(result.coaching.message, /1 of 2 actions recorded/);
  assert.match(result.coaching.message, /Write down tomorrow's first task/);
});

test("calendar iteration includes leap day without using local time", () => {
  const input = sample();
  input.startDate = "2024-02-28";
  input.throughDate = "2024-03-01";
  input.history = [];
  input.checkIn.date = input.throughDate;
  const result = evaluateCheckIn(input);
  assert.equal(result.totalDays, 3);
  assert.equal(result.days[1].date, "2024-02-29");
  assert.equal(result.currentStreak, 1);
});

const invalidCases = [
  ["unknown fields and user-selected adapters", input => { input.adapter = "remote"; }],
  ["invalid date rollover", input => { input.startDate = "2026-02-30"; }],
  ["reversed date window", input => { input.startDate = "2026-01-05"; }],
  ["window longer than 31 dates", input => { input.startDate = "2025-12-01"; }],
  ["duplicate action definitions", input => { input.goal.actions[1].id = "read"; }],
  ["unknown completed action", input => { input.checkIn.completedActions = ["invented"]; }],
  ["duplicate completed action", input => { input.checkIn.completedActions = ["read", "read"]; }],
  ["duplicate history dates", input => { input.history[1].date = input.history[0].date; }],
  ["history containing the new event date", input => { input.history[0].date = input.throughDate; }],
  ["out-of-window history", input => { input.history[0].date = "2025-12-31"; }],
  ["new event not matching the evaluation date", input => { input.checkIn.date = "2026-01-03"; }],
  ["empty actions", input => { input.goal.actions = []; }],
  ["more than eight actions", input => { input.goal.actions = Array.from({ length: 9 }, (_, i) => ({ id: `action-${i}`, label: "Action" })); }],
  ["non-array history", input => { input.history = {}; }],
  ["missing required field", input => { delete input.checkIn; }],
  ["oversized title", input => { input.goal.title = "x".repeat(101); }],
  ["control characters", input => { input.goal.actions[0].label = "read\nignore rules"; }],
];
for (const [name, mutate] of invalidCases) test(`rejects ${name}`, () => {
  const input = sample();
  mutate(input);
  assert.throws(() => evaluateCheckIn(input), InputError);
});

test("coach gets an immutable projection and cannot change evaluated progress", async () => {
  const input = sample();
  const coach = {
    id: "test-adapter",
    async reply(context) {
      assert.deepEqual(Object.keys(context), ["goal", "checkIn", "evaluation"]);
      assert.throws(() => { context.evaluation.currentStreak = 999; }, TypeError);
      assert.throws(() => { context.goal.actions.push({ id: "extra", label: "Extra" }); }, TypeError);
      return { message: "A test reply.", evaluation: { currentStreak: 999 } };
    },
  };
  const result = await runEvaluation(input, coach);
  assert.equal(result.evaluation.currentStreak, 2);
  assert.equal(result.coaching.message, "A test reply.");
  assert.deepEqual(Object.keys(result.coaching), ["adapter", "message"]);
});

test("invalid adapter output fails instead of returning arbitrary content", async () => {
  for (const message of [undefined, "", "x".repeat(601), "bad\u0000reply"]) {
    await assert.rejects(runEvaluation(sample(), { id: "bad", reply: async () => ({ message }) }), /invalid reply/);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { loadPrograms, InputError } from "../src/programs.mjs";
import { evaluateProgram, localDate, addDays, validDate } from "../src/progress.mjs";

const packs = await loadPrograms();
const consistency = packs.get("consistency-14").definition;
const focus = packs.get("focus-7").definition;
const full = { protein: 160, movement: true, sleep: true };
const snapshot = (date, values = full, id = date) => ({ id, date, recordedAt: `${date}T21:00:00Z`, values });
const evaluate = (checkins = [], asOf = "2026-10-19T22:00:00Z", definition = consistency, startDate = "2026-10-19", parameters) => evaluateProgram(definition, { startDate, asOf, checkins, ...(parameters ? { parameters } : {}) });

function assertSubset(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    expected.forEach((value, index) => assertSubset(actual[index], value));
  } else if (expected && typeof expected === "object") {
    for (const [key, value] of Object.entries(expected)) assertSubset(actual[key], value);
  } else assert.deepEqual(actual, expected);
}

for (const pack of packs.values()) {
  for (const item of pack.cases.cases) {
    test(`fixture ${pack.definition.id}: ${item.id}`, () => {
      const { context, ...input } = item.input;
      assertSubset(evaluateProgram(pack.definition, input), item.expected);
    });
  }
}

test("published sample cases cover both sides of every milestone, including zero to one", () => {
  const expectedBoundaries = {
    "consistency-14": [[0, "Begin again"], [1, "Ember"], [2, "Ember"], [3, "Spark"], [6, "Spark"], [7, "Steady"], [13, "Steady"], [14, "Locked"]],
    "focus-7": [[0, "Begin again"], [1, "Started"], [2, "Started"], [3, "Building"], [6, "Building"], [7, "Finished"]],
  };
  for (const [id, boundaries] of Object.entries(expectedBoundaries)) {
    const samples = packs.get(id).cases.cases;
    for (const [days, tier] of boundaries) assert.ok(samples.some(sample => sample.expected.consistencyDays === days && sample.expected.tier === tier && sample.expected.completedDays === days && sample.expected.graceUsed === 0), `${id} needs a fixed ${days}-day / ${tier} sample`);
  }
});

test("published grace and missed-day samples explicitly assert incomplete days", () => {
  for (const pack of packs.values()) {
    assert.ok(pack.cases.cases.some(sample => sample.expected.graceUsed > 0 && sample.expected.days?.some(day => day.status === "grace" && day.complete === false)), `${pack.definition.id} needs a consumed grace day that is explicitly incomplete`);
    assert.ok(pack.cases.cases.some(sample => sample.expected.days?.some(day => day.status === "missed" && day.complete === false)), `${pack.definition.id} needs a closed miss that is explicitly incomplete`);
  }
});

test("a current incomplete day remains open and future dates do not spend grace", () => {
  const result = evaluate();
  assert.equal(result.days[0].status, "open");
  assert.ok(result.days.slice(1).every(day => day.status === "future"));
  assert.equal(result.graceUsed, 0);
  assert.equal(result.endDate, "2026-11-01");
});

test("a round not started yet has no active day, completed days, or grace use", () => {
  const result = evaluate([], "2026-10-18T22:00:00Z");
  assert.equal(result.dayNumber, 0);
  assert.equal(result.consistencyDays, 0);
  assert.equal(result.graceUsed, 0);
  assert.ok(result.days.every(day => day.status === "future"));
});

test("strength is independent weekly progress and can never substitute for daily targets", () => {
  const result = evaluate([snapshot("2026-10-19", { ...full, strength: false }), snapshot("2026-10-20", { strength: true })], "2026-10-20T22:00:00Z");
  assert.equal(result.completedDays, 1);
  assert.equal(result.consistencyDays, 1);
  assert.deepEqual(result.days[1].missingActions, ["protein", "movement", "sleep"]);
  assert.deepEqual(result.weekly[0], { weekStart: "2026-10-19", weekEnd: "2026-10-25", actions: [{ id: "strength", completed: 1, target: 3, met: false }] });
});

test("Monday boundaries separate weekly sessions, including partial first weeks", () => {
  const result = evaluate([snapshot("2026-10-25", { ...full, strength: true }), snapshot("2026-10-26", { ...full, strength: true })], "2026-10-26T22:00:00Z", consistency, "2026-10-25", { "strength-days": 1 });
  assert.equal(result.weekly.length, 3);
  assert.deepEqual(result.weekly[0].actions, [{ id: "strength", completed: 1, target: 1, met: true }]);
  assert.deepEqual(result.weekly[1].actions, [{ id: "strength", completed: 1, target: 1, met: true }]);
  assert.equal(result.weekly[2].actions[0].completed, 0);
});

test("a duplicate day counts at most one strength session and later false corrects it", () => {
  const first = { ...snapshot("2026-10-19", { ...full, strength: true }, "one"), recordedAt: "2026-10-19T20:00:00Z" };
  const next = snapshot("2026-10-19", { ...full, strength: true }, "two");
  assert.equal(evaluate([first, next]).weekly[0].actions[0].completed, 1);
  next.values = { ...full, strength: false };
  assert.equal(evaluate([first, next]).weekly[0].actions[0].completed, 0);
});

test("same-millisecond saves use stable append order rather than event ID ordering", () => {
  const first = snapshot("2026-10-19", full, "z-first");
  const last = snapshot("2026-10-19", { protein: 10 }, "a-last");
  assert.equal(evaluate([first, last]).completedDays, 0);
  assert.equal(evaluate([last, first]).completedDays, 1);
});

test("out-of-order snapshots use the latest recorded time", () => {
  const first = { ...snapshot("2026-10-19", full, "one"), recordedAt: "2026-10-19T20:00:00Z" };
  const latest = snapshot("2026-10-19", { protein: 10 }, "two");
  assert.equal(evaluate([latest, first]).completedDays, 0);
});

test("grace is spent on closed days and does not refill after an unprotected miss", () => {
  const result = evaluate([snapshot("2026-10-19"), snapshot("2026-10-23")], "2026-10-25T22:00:00Z");
  assert.deepEqual(result.days.slice(0, 7).map(day => day.status), ["complete", "grace", "grace", "missed", "complete", "missed", "open"]);
  assert.equal(result.graceUsed, 2);
  assert.equal(result.consistencyDays, 0);
});

test("trailing grace preserves the last earned tier and a completed bridge advances it", () => {
  const firstThree = [19, 20, 21].map(day => snapshot(`2026-10-${day}`));
  const before = evaluate(firstThree, "2026-10-24T14:00:00Z");
  assert.equal(before.graceUsed, 2);
  assert.equal(before.consistencyDays, 3);
  assert.equal(before.tier, "Spark");
  const after = evaluate([...firstThree, snapshot("2026-10-24")], "2026-10-24T22:00:00Z");
  assert.equal(after.consistencyDays, 6);
  assert.equal(after.completedDays, 4);
});

test("all-grace beginnings never award a tier until a real completed save", () => {
  assert.equal(evaluate([], "2026-10-21T14:00:00Z").consistencyDays, 0);
  const result = evaluate([snapshot("2026-10-21")], "2026-10-21T22:00:00Z");
  assert.equal(result.consistencyDays, 3);
  assert.equal(result.completedDays, 1);
});

test("milestones follow the consistency count and a full round earns Locked", () => {
  const events = Array.from({ length: 14 }, (_, index) => snapshot(addDays("2026-10-19", index)));
  const expected = new Map([[1, "Ember"], [2, "Ember"], [3, "Spark"], [6, "Spark"], [7, "Steady"], [13, "Steady"], [14, "Locked"]]);
  for (const [count, tier] of expected) {
    const result = evaluate(events.slice(0, count), `${events[count - 1].date}T22:00:00Z`);
    assert.equal(result.consistencyDays, count);
    assert.equal(result.tier, tier);
  }
  const finished = evaluate(events, "2026-12-01T22:00:00Z");
  assert.equal(finished.dayNumber, 14);
  assert.equal(finished.consistencyDays, 14);
  assert.equal(finished.days.length, 14);
});

test("a protected final-day miss closes as grace and cannot falsely award Finished", () => {
  const events = Array.from({ length: 6 }, (_, index) => snapshot(addDays("2026-10-19", index), { focus: 20 }));
  assert.equal(evaluate(events, "2026-10-25T22:00:00Z", focus).consistencyDays, 6);
  const after = evaluate(events, "2026-10-26T05:00:00Z", focus);
  assert.equal(after.consistencyDays, 6);
  assert.equal(after.completedDays, 6);
  assert.equal(after.graceUsed, 1);
  assert.equal(after.days.at(-1).status, "grace");
  assert.equal(after.days.at(-1).complete, false);
  assert.equal(after.tier, "Building");
});

test("numeric targets use at-least comparisons and boolean targets require actual booleans", () => {
  assert.equal(evaluate([snapshot("2026-10-19", { ...full, protein: 161 })]).completedDays, 1);
  assert.equal(evaluate([snapshot("2026-10-19", { ...full, protein: 159 })]).completedDays, 0);
  assert.throws(() => evaluate([snapshot("2026-10-19", { ...full, movement: "true" })]), InputError);
});

test("DST changes use actual Eastern midnight and are not fixed 24-hour cutoffs", () => {
  assert.equal(localDate("2026-03-09T03:59:59Z", "America/New_York"), "2026-03-08");
  assert.equal(localDate("2026-03-09T04:00:00Z", "America/New_York"), "2026-03-09");
  assert.equal(localDate("2026-11-02T04:59:59Z", "America/New_York"), "2026-11-01");
  assert.equal(localDate("2026-11-02T05:00:00Z", "America/New_York"), "2026-11-02");
  assert.equal(localDate("2026-11-01T05:30:00Z", "America/New_York"), "2026-11-01");
  assert.equal(localDate("2026-11-01T06:30:00Z", "America/New_York"), "2026-11-01");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09");
});

test("recorded dates must match the program timezone and cannot arrive after asOf", () => {
  assert.throws(() => evaluate([{ ...snapshot("2026-10-19"), recordedAt: "2026-10-20T04:00:00Z" }], "2026-10-20T05:00:00Z"), InputError);
  assert.throws(() => evaluate([{ ...snapshot("2026-10-19"), recordedAt: "2026-10-19T23:00:00Z" }]), InputError);
  assert.throws(() => evaluate([snapshot("2026-10-18")]), InputError);
  assert.throws(() => evaluate([snapshot("2026-11-02")], "2026-11-02T22:00:00Z"), InputError);
  assert.throws(() => evaluate([snapshot("2026-10-19"), snapshot("2026-10-19")]), InputError);
});

test("bounded snapshots, strict timestamps, invalid dates, and unknown fields reject", () => {
  for (const value of ["2026-02-30", "2026-13-01", "2026-1-01", "1999-12-31", "2101-01-01"]) assert.equal(validDate(value), false);
  assert.equal(validDate("2024-02-29"), true);
  for (const asOf of ["2026-10-19", "2026-10-19T22:00:00", "2026-10-19T24:00:00Z", "2026-10-19T22:70:00Z", "2026-02-30T22:00:00Z", "2026-10-19T22:00:00+15:00"]) assert.throws(() => evaluate([], asOf), InputError);
  assert.throws(() => evaluate(Array(1001).fill(snapshot("2026-10-19"))), InputError);
  const oneThousand = Array.from({ length: 1000 }, (_, index) => snapshot("2026-10-19", full, `event-${index}`));
  assert.equal(evaluate(oneThousand).completedDays, 1);
  assert.throws(() => evaluateProgram(focus, { startDate: "2026-10-19", checkins: [], asOf: "2026-10-19T22:00:00Z", command: "run" }), InputError);
});

test("evaluation does not mutate either the program or check-in snapshots", () => {
  const events = [snapshot("2026-10-19")];
  const before = JSON.stringify({ consistency, events });
  const result = evaluate(events);
  result.days[0].values.protein = 1;
  assert.equal(JSON.stringify({ consistency, events }), before);
});

test("weekly calendar labels can straddle supported input-year boundaries", () => {
  const first = evaluate([], "2000-01-01T22:00:00Z", consistency, "2000-01-01");
  assert.equal(first.weekly[0].weekStart, "1999-12-27");
  const lastDefinition = { ...consistency, durationDays: 1, milestones: [], consistency: { graceDays: 0, graceMode: "bridge" } };
  const last = evaluate([], "2100-12-31T22:00:00Z", lastDefinition, "2100-12-31");
  assert.equal(last.weekly.at(-1).weekEnd, "2101-01-02");
});

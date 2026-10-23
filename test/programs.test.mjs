import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InputError, loadProgram, loadPrograms, validateProgram, resolveParameters, validateValues } from "../src/programs.mjs";
import { evaluateProgram } from "../src/progress.mjs";

const source = fileURLToPath(new URL("../programs/focus-7/", import.meta.url));
const programs = await loadPrograms();
const focus = programs.get("focus-7").definition;
const consistency = programs.get("consistency-14").definition;
const change = (definition, fn) => { const copy = structuredClone(definition); fn(copy); return copy; };

async function temporaryPack(t) {
  const parent = await mkdtemp(join(tmpdir(), "optimalant-program-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const folder = join(parent, "focus-7");
  await mkdir(folder);
  for (const filename of ["program.json", "coach.md", "cases.json"]) await copyFile(join(source, filename), join(folder, filename));
  return { parent, folder };
}

test("bundled packs load without network access and have content fingerprints", () => {
  assert.deepEqual([...programs.keys()], ["consistency-14", "focus-7"]);
  for (const pack of programs.values()) {
    assert.match(pack.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(pack.prompt.length > 100);
    assert.equal(pack.cases.schemaVersion, 1);
    assert.ok(pack.cases.cases.length >= 5);
  }
});

test("parameter defaults are explicit and overrides stay within their bounds", () => {
  assert.deepEqual(resolveParameters(consistency), { "protein-goal": 160, "strength-days": 3 });
  assert.deepEqual(resolveParameters(focus, { "focus-minutes": 45 }), { "focus-minutes": 45 });
  for (const value of [0, 241, 1.5, "20", null, NaN, Infinity]) assert.throws(() => resolveParameters(focus, { "focus-minutes": value }), InputError);
  assert.throws(() => resolveParameters(focus, { unknown: 10 }), InputError);
});

test("check-in values preserve absent fields and distinguish false from missing", () => {
  assert.deepEqual(validateValues(consistency, { protein: 160, movement: false }), { protein: 160, movement: false });
  assert.deepEqual(validateValues(consistency, {}), {});
  for (const value of [{ protein: 1.2 }, { protein: -1 }, { protein: "160" }, { movement: 1 }, { sleep: "true" }, { unknown: true }, { strength: null }, null]) assert.throws(() => validateValues(consistency, value), InputError);
});

test("program schema rejects unknown fields, expressions, malformed references, and daily-gated weekly actions", () => {
  const invalid = [
    def => { def.expression = "process.exit()"; },
    def => { def.actions[0].target = { expression: "minutes * 2" }; },
    def => { def.actions[0].target = { parameter: "missing" }; },
    def => { def.actions[0].type = "code"; },
    def => { def.durationDays = 91; },
    def => { def.calendar.timeZone = "Mars/Olympus"; },
    def => { def.calendar.weekStartsOn = 0; },
    def => { def.parameters["focus-minutes"].default = 500; },
    def => { def.actions.push(structuredClone(def.actions[0])); },
    def => { def.actions[0].requiredForDay = false; },
    def => { def.consistency.graceMode = "execute"; },
    def => { def.milestones.reverse(); },
    def => { def.coach.promptFile = "../../secret.txt"; },
    def => { def.schemaVersion = 2; },
  ];
  for (const mutation of invalid) assert.throws(() => validateProgram(change(focus, mutation)), InputError);
  assert.throws(() => validateProgram(change(consistency, def => { def.actions[3].requiredForDay = true; })), InputError);
  assert.throws(() => validateProgram(change(consistency, def => { def.parameters["strength-days"].max = 8; })), InputError);
});

test("a third reading program loads and evaluates using data and prompts alone", async t => {
  const { folder } = await temporaryPack(t);
  const definition = {
    schemaVersion: 1, id: "reading-5", version: "1.0.0", name: "Five days of reading", durationDays: 5,
    calendar: { timeZone: "Europe/London", weekStartsOn: 1 },
    parameters: { pages: { label: "Pages each day", default: 8, min: 1, max: 100 } },
    actions: [{ id: "read", label: "Read a few pages", type: "number", unit: "pages", integer: true, cadence: "daily", target: { parameter: "pages" }, requiredForDay: true }],
    consistency: { graceDays: 0, graceMode: "bridge" }, milestones: [{ at: 1, label: "Reading" }, { at: 5, label: "Finished" }],
    coach: { promptFile: "coach.md", responseVersion: 1 },
  };
  const input = { startDate: "2026-10-19", asOf: "2026-10-19T22:00:00Z", checkins: [{ id: "read1", date: "2026-10-19", recordedAt: "2026-10-19T21:00:00Z", values: { read: 8 } }] };
  await writeFile(join(folder, "program.json"), JSON.stringify(definition));
  await writeFile(join(folder, "coach.md"), "Offer one practical reading suggestion based on the reported pages.");
  await writeFile(join(folder, "cases.json"), JSON.stringify({ schemaVersion: 1, cases: [{ id: "read-enough", description: "Reaches the pages target.", input, expected: { consistencyDays: 1 } }] }));
  const pack = await loadProgram(folder);
  const result = evaluateProgram(pack.definition, pack.cases.cases[0].input);
  assert.equal(result.consistencyDays, 1);
  assert.equal(result.tier, "Reading");
  assert.deepEqual(result.weekly, []);
  assert.equal(result.days.length, 5);
});

test("fractional numeric programs can opt out of integer-only measurements", () => {
  const definition = change(focus, def => { def.actions[0].integer = false; });
  assert.deepEqual(validateValues(definition, { focus: 20.5 }), { focus: 20.5 });
});

test("pack fingerprints change with coaching instructions", async t => {
  const { folder } = await temporaryPack(t);
  const first = await loadProgram(folder);
  await writeFile(join(folder, "coach.md"), `${first.prompt}\nUse shorter sentences.\n`);
  const next = await loadProgram(folder);
  assert.notEqual(first.fingerprint, next.fingerprint);
});

test("malformed, oversized, empty, and duplicate packs fail clearly", async t => {
  const { parent, folder } = await temporaryPack(t);
  const original = await readFile(join(folder, "program.json"), "utf8");
  await writeFile(join(folder, "program.json"), "{broken");
  await assert.rejects(loadProgram(folder), InputError);
  await writeFile(join(folder, "program.json"), original);
  await writeFile(join(folder, "coach.md"), "x".repeat(16_385));
  await assert.rejects(loadProgram(folder), InputError);
  await writeFile(join(folder, "coach.md"), "A short coaching prompt.");
  const other = join(parent, "other-pack");
  await mkdir(other);
  for (const filename of ["program.json", "coach.md", "cases.json"]) await copyFile(join(folder, filename), join(other, filename));
  await assert.rejects(loadPrograms(parent), /unique/);
  const empty = join(parent, "empty");
  await mkdir(empty);
  await assert.rejects(loadPrograms(empty), /No programs/);
});

test("program pack directories and ancestor paths may not be symlinks", async t => {
  const { parent, folder } = await temporaryPack(t);
  const link = join(parent, "linked-pack");
  await symlink(folder, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadProgram(link), InputError);
  await assert.rejects(loadPrograms(parent), InputError);
  const wrapper = join(parent, "wrapper");
  await mkdir(wrapper);
  const nested = join(wrapper, "child");
  await mkdir(nested);
  for (const filename of ["program.json", "coach.md", "cases.json"]) await copyFile(join(folder, filename), join(nested, filename));
  const ancestorLink = join(parent, "linked-wrapper");
  await symlink(wrapper, ancestorLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadProgram(join(ancestorLink, "child")), InputError);
});

test("evaluation fixtures require real expected results and bounded valid rubrics", async t => {
  const { folder } = await temporaryPack(t);
  const original = JSON.parse(await readFile(join(folder, "cases.json"), "utf8"));
  const mutations = [
    item => { item.expected = {}; },
    item => { item.expected = { completedDayz: 1 }; },
    item => { item.rubric = null; },
    item => { item.rubric = { mustMention: "focus" }; },
    item => { item.rubric = { mustMention: [""] }; },
    item => { item.rubric = { mustAvoid: Array(21).fill("test") }; },
    item => { item.rubric = { allowedActionIds: ["not-an-action"] }; },
    item => { item.rubric = { execute: "anything" }; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value.cases[0]);
    await writeFile(join(folder, "cases.json"), JSON.stringify(value));
    await assert.rejects(loadProgram(folder), InputError);
  }
  original.cases[0].rubric = { mustMention: ["focus"], mustAvoid: ["paid"], allowedActionIds: ["focus"] };
  await writeFile(join(folder, "cases.json"), JSON.stringify(original));
  assert.equal((await loadProgram(folder)).cases.cases[0].rubric.mustMention[0], "focus");
});

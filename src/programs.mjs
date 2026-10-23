import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { InputError } from "./evaluation.mjs";

export { InputError };
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const DEFAULT_ROOT = fileURLToPath(new URL("../programs/", import.meta.url));
const MAX_NUMBER = 1_000_000;

function object(value, required, optional, field) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError("Expected an object.", field);
  for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) throw new InputError("Unexpected field.", `${field}.${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new InputError("Required field is missing.", `${field}.${key}`);
}

function text(value, field, max = 120, identifier = false) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new InputError(`Expected nonempty text of at most ${max} characters without control characters.`, field);
  if (identifier && !ID.test(value)) throw new InputError("Use a lowercase identifier of at most 40 characters.", field);
  return value.trim();
}

function number(value, field, min = 0, max = MAX_NUMBER, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new InputError(`Expected ${integer ? "an integer" : "a number"} between ${min} and ${max}.`, field);
  return value;
}

function target(value, parameters, field, type, integer = false) {
  if (type === "boolean") {
    if (typeof value !== "boolean") throw new InputError("Expected a boolean target.", field);
    return value;
  }
  if (typeof value === "number") return number(value, field, 0, MAX_NUMBER, integer);
  object(value, ["parameter"], [], field);
  const name = text(value.parameter, `${field}.parameter`, 40, true);
  if (!Object.hasOwn(parameters, name)) throw new InputError("Unknown parameter reference.", `${field}.parameter`);
  if (integer && ![parameters[name].min, parameters[name].max, parameters[name].default].every(Number.isInteger)) throw new InputError("Integer actions require integer parameter bounds and default.", field);
  return { parameter: name };
}

/** The schema deliberately supports data, never executable expressions or code. */
export function validateProgram(raw) {
  object(raw, ["schemaVersion", "id", "version", "name", "durationDays", "calendar", "parameters", "actions", "consistency", "milestones", "coach"], [], "program");
  if (raw.schemaVersion !== 1) throw new InputError("Unsupported program schema version.", "program.schemaVersion");
  const id = text(raw.id, "program.id", 40, true);
  const version = text(raw.version, "program.version", 30);
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new InputError("Use a numeric major.minor.patch version.", "program.version");
  const name = text(raw.name, "program.name");
  const durationDays = number(raw.durationDays, "program.durationDays", 1, 90, true);
  object(raw.calendar, ["timeZone", "weekStartsOn"], [], "program.calendar");
  const timeZone = text(raw.calendar.timeZone, "program.calendar.timeZone", 80);
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(0); } catch { throw new InputError("Use a supported IANA time zone.", "program.calendar.timeZone"); }
  if (raw.calendar.weekStartsOn !== 1) throw new InputError("Schema v1 uses Monday as the start of each week.", "program.calendar.weekStartsOn");
  if (!raw.parameters || typeof raw.parameters !== "object" || Array.isArray(raw.parameters) || Object.keys(raw.parameters).length > 12) throw new InputError("Provide at most 12 named parameters.", "program.parameters");
  const parameters = Object.fromEntries(Object.entries(raw.parameters).map(([key, value]) => {
    text(key, "program.parameters", 40, true);
    object(value, ["label", "default", "min", "max"], [], `program.parameters.${key}`);
    const min = number(value.min, `program.parameters.${key}.min`);
    const max = number(value.max, `program.parameters.${key}.max`, min);
    return [key, { label: text(value.label, `program.parameters.${key}.label`), default: number(value.default, `program.parameters.${key}.default`, min, max), min, max }];
  }));
  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 12) throw new InputError("Provide 1 to 12 actions.", "program.actions");
  const ids = new Set();
  const actions = raw.actions.map((value, index) => {
    const field = `program.actions[${index}]`;
    object(value, ["id", "label", "type", "cadence", "target", "requiredForDay"], ["unit", "weeklyTarget", "integer"], field);
    const actionId = text(value.id, `${field}.id`, 40, true);
    if (ids.has(actionId)) throw new InputError("Action IDs must be unique.", `${field}.id`);
    ids.add(actionId);
    if (!["number", "boolean"].includes(value.type)) throw new InputError("Use number or boolean.", `${field}.type`);
    if (!["daily", "weekly"].includes(value.cadence)) throw new InputError("Use daily or weekly.", `${field}.cadence`);
    if (typeof value.requiredForDay !== "boolean" || (value.cadence === "weekly" && value.requiredForDay)) throw new InputError("Weekly actions cannot gate daily completion.", `${field}.requiredForDay`);
    if (Object.hasOwn(value, "integer") && (value.type !== "number" || typeof value.integer !== "boolean")) throw new InputError("integer is a boolean option for numeric actions only.", `${field}.integer`);
    const action = { id: actionId, label: text(value.label, `${field}.label`), type: value.type, cadence: value.cadence, target: target(value.target, parameters, `${field}.target`, value.type, value.integer === true), requiredForDay: value.requiredForDay };
    if (Object.hasOwn(value, "unit")) action.unit = text(value.unit, `${field}.unit`, 30);
    if (Object.hasOwn(value, "integer")) action.integer = value.integer;
    if (value.cadence === "weekly") {
      if (!Object.hasOwn(value, "weeklyTarget")) throw new InputError("Weekly actions require a session count target.", `${field}.weeklyTarget`);
      action.weeklyTarget = target(value.weeklyTarget, parameters, `${field}.weeklyTarget`, "number", true);
      const bounds = typeof action.weeklyTarget === "number" ? [action.weeklyTarget] : [parameters[action.weeklyTarget.parameter].min, parameters[action.weeklyTarget.parameter].max];
      if (bounds.some(n => n < 1 || n > 7)) throw new InputError("Weekly session targets must be between 1 and 7.", `${field}.weeklyTarget`);
    } else if (Object.hasOwn(value, "weeklyTarget")) throw new InputError("Only weekly actions have a weekly target.", `${field}.weeklyTarget`);
    return action;
  });
  if (!actions.some(action => action.cadence === "daily" && action.requiredForDay)) throw new InputError("At least one daily action must determine day completion.", "program.actions");
  object(raw.consistency, ["graceDays", "graceMode"], [], "program.consistency");
  const graceDays = number(raw.consistency.graceDays, "program.consistency.graceDays", 0, Math.min(14, durationDays), true);
  if (raw.consistency.graceMode !== "bridge") throw new InputError("Only bridge grace is supported in schema v1.", "program.consistency.graceMode");
  if (!Array.isArray(raw.milestones) || raw.milestones.length > 12) throw new InputError("Provide at most 12 milestones.", "program.milestones");
  let previous = 0;
  const milestones = raw.milestones.map((value, index) => {
    const field = `program.milestones[${index}]`;
    object(value, ["at", "label"], [], field);
    const at = number(value.at, `${field}.at`, 1, durationDays, true);
    if (at <= previous) throw new InputError("Milestones must have distinct ascending thresholds.", `${field}.at`);
    previous = at;
    return { at, label: text(value.label, `${field}.label`, 60) };
  });
  object(raw.coach, ["promptFile", "responseVersion"], [], "program.coach");
  if (raw.coach.promptFile !== "coach.md") throw new InputError("The program prompt must be coach.md in its own directory.", "program.coach.promptFile");
  if (raw.coach.responseVersion !== 1) throw new InputError("Unsupported coaching response version.", "program.coach.responseVersion");
  return { schemaVersion: 1, id, version, name, durationDays, calendar: { timeZone, weekStartsOn: 1 }, parameters, actions, consistency: { graceDays, graceMode: "bridge" }, milestones, coach: { promptFile: "coach.md", responseVersion: 1 } };
}

export function resolveParameters(definition, raw = {}) {
  const def = validateProgram(definition);
  object(raw, [], Object.keys(def.parameters), "parameters");
  return Object.fromEntries(Object.entries(def.parameters).map(([key, spec]) => {
    const integer = def.actions.some(action => (action.integer && action.target?.parameter === key) || action.weeklyTarget?.parameter === key);
    return [key, number(Object.hasOwn(raw, key) ? raw[key] : spec.default, `parameters.${key}`, spec.min, spec.max, integer)];
  }));
}

/** Partial check-ins are allowed; absence never means false or zero was reported. */
export function validateValues(definition, raw) {
  const def = validateProgram(definition);
  object(raw, [], def.actions.map(action => action.id), "values");
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const action = def.actions.find(item => item.id === key);
    if (action.type === "boolean") {
      if (typeof value !== "boolean") throw new InputError("Expected true or false.", `values.${key}`);
      return [key, value];
    }
    return [key, number(value, `values.${key}`, 0, MAX_NUMBER, action.integer === true)];
  }));
}

async function readPackFile(directory, name, maxBytes) {
  const filename = join(directory, name);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new InputError(`Expected a regular ${name} file of at most ${maxBytes} bytes.`, "programPack");
  return readFile(filename, "utf8");
}

async function realDirectory(directory) {
  const path = resolve(directory);
  const info = await lstat(path);
  const canonical = await realpath(path);
  const comparison = value => process.platform === "win32" ? value.toLowerCase() : value;
  if (!info.isDirectory() || info.isSymbolicLink() || comparison(canonical) !== comparison(path)) throw new InputError("Expected a real program directory without symbolic links in its path.", "programPack");
  return path;
}

function parseJson(source, filename) {
  try { return JSON.parse(source); } catch { throw new InputError(`Invalid JSON in ${filename}.`, "programPack"); }
}

function validateCases(raw, definition) {
  object(raw, ["schemaVersion", "cases"], [], "cases");
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.cases) || raw.cases.length < 1 || raw.cases.length > 100) throw new InputError("Provide 1 to 100 cases using schemaVersion 1.", "cases");
  const ids = new Set();
  for (const item of raw.cases) {
    object(item, ["id", "description", "input", "expected"], ["rubric"], "case");
    text(item.id, "case.id", 40, true);
    text(item.description, "case.description", 500);
    if (ids.has(item.id)) throw new InputError("Case IDs must be unique.", "case.id");
    ids.add(item.id);
    object(item.input, ["startDate", "checkins", "asOf"], ["parameters", "context"], "case.input");
    if (!item.expected || typeof item.expected !== "object" || Array.isArray(item.expected) || Object.keys(item.expected).length === 0) throw new InputError("Provide at least one expected progress field.", "case.expected");
    const progressKeys = ["asOfDate", "endDate", "dayNumber", "completedDays", "consistencyDays", "graceUsed", "graceRemaining", "tier", "days", "weekly"];
    object(item.expected, [], progressKeys, "case.expected");
    if (Object.hasOwn(item, "rubric")) {
      object(item.rubric, [], ["mustMention", "mustAvoid", "allowedActionIds"], "case.rubric");
      for (const [key, values] of Object.entries(item.rubric)) {
        if (!Array.isArray(values) || values.length > 20) throw new InputError("Provide an array of at most 20 rubric entries.", `case.rubric.${key}`);
        for (const value of values) {
          text(value, `case.rubric.${key}`, key === "allowedActionIds" ? 40 : 200, key === "allowedActionIds");
          if (key === "allowedActionIds" && !definition.actions.some(action => action.id === value)) throw new InputError("Rubric action must be defined by this program.", "case.rubric.allowedActionIds");
        }
      }
    }
  }
  return raw;
}

/** Load trusted local data packs only; a request never controls their filesystem path. */
export async function loadProgram(directory) {
  const path = await realDirectory(directory);
  const [programText, prompt, casesText] = await Promise.all([readPackFile(path, "program.json", 65_536), readPackFile(path, "coach.md", 16_384), readPackFile(path, "cases.json", 262_144)]);
  if (!prompt.trim() || /[\u0000]/.test(prompt)) throw new InputError("Provide a nonempty coaching prompt without null bytes.", "programPack");
  const definition = validateProgram(parseJson(programText, "program.json"));
  const cases = validateCases(parseJson(casesText, "cases.json"), definition);
  const fingerprint = createHash("sha256").update(JSON.stringify({ definition, prompt, cases })).digest("hex");
  return { definition, prompt, cases, fingerprint };
}

export async function loadPrograms(root = DEFAULT_ROOT) {
  const directory = await realDirectory(root);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 100) throw new InputError("At most 100 program directory entries are supported.", "programPack");
  const packs = new Map();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new InputError("Program symbolic links are not supported.", "programPack");
    if (!entry.isDirectory()) continue;
    if (!ID.test(entry.name)) throw new InputError("Program directories must use lowercase identifiers.", "programPack");
    const pack = await loadProgram(join(directory, entry.name));
    if (packs.has(pack.definition.id)) throw new InputError("Program IDs must be unique.", "programPack");
    packs.set(pack.definition.id, pack);
  }
  if (!packs.size) throw new InputError("No programs were found.", "programPack");
  return packs;
}

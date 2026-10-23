import { InputError, validateProgram, resolveParameters, validateValues } from "./programs.mjs";

export { InputError };
const DAY_MS = 86_400_000;

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "2000-01-01" || value > "2100-12-31") return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function date(value, field) {
  if (!validDate(value)) throw new InputError("Use a valid YYYY-MM-DD date between 2000 and 2100.", field);
  return value;
}

function instant(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validDate(value.slice(0, 10))) throw new InputError("Use a valid ISO timestamp with seconds and an explicit UTC offset.", field);
  const timestamp = Date.parse(value);
  const [hour, minute, second] = value.slice(11, 19).split(":").map(Number);
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (!Number.isFinite(timestamp) || hour > 23 || minute > 59 || second > 59 || (offset && (Number(offset[2]) > 14 || Number(offset[3]) > 59 || (Number(offset[2]) === 14 && Number(offset[3]) !== 0)))) throw new InputError("Use a valid ISO timestamp.", field);
  return timestamp;
}

export function localDate(value, timeZone) {
  const timestamp = instant(value, "instant");
  let formatter;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); } catch { throw new InputError("Use a supported IANA time zone.", "timeZone"); }
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  const result = `${parts.year}-${parts.month}-${parts.day}`;
  return date(result, "instant");
}

export function addDays(value, count) {
  date(value, "date");
  if (!Number.isInteger(count) || Math.abs(count) > 36600) throw new InputError("Invalid calendar day offset.", "count");
  const result = new Date(Date.parse(`${value}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
  return date(result, "date");
}

function between(from, to) { return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS); }
function shiftCalendarDate(value, count) { return new Date(Date.parse(`${value}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10); }
function resolveTarget(value, parameters) { return typeof value === "object" ? parameters[value.parameter] : value; }
function met(action, values, parameters) {
  if (!Object.hasOwn(values, action.id)) return false;
  const target = resolveTarget(action.target, parameters);
  return action.type === "boolean" ? values[action.id] === target : values[action.id] >= target;
}

function strictObject(raw, required, optional, field) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InputError("Expected an object.", field);
  for (const key of Object.keys(raw)) if (![...required, ...optional].includes(key)) throw new InputError("Unexpected field.", `${field}.${key}`);
  for (const key of required) if (!Object.hasOwn(raw, key)) throw new InputError("Required field is missing.", `${field}.${key}`);
}

/** Pure reference rules for a single bounded round. It never reads the clock or runs AI. */
export function evaluateProgram(rawDefinition, raw) {
  const definition = validateProgram(rawDefinition);
  strictObject(raw, ["startDate", "checkins", "asOf"], ["parameters"], "evaluation");
  const startDate = date(raw.startDate, "startDate");
  const endDate = addDays(startDate, definition.durationDays - 1);
  const asOfTimestamp = instant(raw.asOf, "asOf");
  const asOfDate = localDate(raw.asOf, definition.calendar.timeZone);
  const parameters = resolveParameters(definition, raw.parameters);
  if (!Array.isArray(raw.checkins) || raw.checkins.length > 1000) throw new InputError("Provide at most 1000 check-in snapshots.", "checkins");
  const snapshots = new Map();
  const ids = new Set();
  for (const [index, event] of raw.checkins.entries()) {
    const field = `checkins[${index}]`;
    strictObject(event, ["id", "date", "values", "recordedAt"], [], field);
    if (typeof event.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(event.id)) throw new InputError("Use an event ID of 1 to 80 letters, digits, underscores, or hyphens.", `${field}.id`);
    if (ids.has(event.id)) throw new InputError("Duplicate check-in ID. Deduplicate events before evaluation.", `${field}.id`);
    ids.add(event.id);
    const eventDate = date(event.date, `${field}.date`);
    if (eventDate < startDate || eventDate > endDate) throw new InputError("Check-in date must be within the program round.", `${field}.date`);
    const recordedAt = instant(event.recordedAt, `${field}.recordedAt`);
    if (recordedAt > asOfTimestamp) throw new InputError("Check-in was recorded after the evaluation time.", `${field}.recordedAt`);
    if (localDate(event.recordedAt, definition.calendar.timeZone) !== eventDate) throw new InputError("Check-in date must match its recorded time in the program time zone.", `${field}.date`);
    const values = validateValues(definition, event.values);
    const previous = snapshots.get(eventDate);
    // Stable input order breaks ties, matching append order in the event store.
    if (!previous || previous.recordedAt <= recordedAt) snapshots.set(eventDate, { id: event.id, recordedAt, values });
  }
  let graceUsed = 0;
  const required = definition.actions.filter(action => action.requiredForDay);
  const days = Array.from({ length: definition.durationDays }, (_, index) => {
    const day = addDays(startDate, index);
    const values = snapshots.get(day)?.values ?? {};
    const missingActions = required.filter(action => !met(action, values, parameters)).map(action => action.id);
    const complete = missingActions.length === 0;
    let status;
    if (day > asOfDate) status = "future";
    else if (complete) status = "complete";
    else if (day === asOfDate) status = "open";
    else if (graceUsed < definition.consistency.graceDays) { status = "grace"; graceUsed++; }
    else status = "missed";
    return { date: day, status, complete, values, missingActions };
  });
  const elapsed = days.filter(day => day.date <= asOfDate);
  let cursor = elapsed.length - 1;
  if (elapsed[cursor]?.status === "open") cursor--;
  let consistencyDays = 0;
  let completedAnchor = false;
  while (cursor >= 0 && ["complete", "grace"].includes(elapsed[cursor].status)) {
    if (elapsed[cursor].complete) completedAnchor = true;
    if (completedAnchor) consistencyDays++;
    cursor--;
  }
  const weeklyActions = definition.actions.filter(action => action.cadence === "weekly");
  const weekly = [];
  if (weeklyActions.length) {
    const weekday = new Date(`${startDate}T00:00:00Z`).getUTCDay();
    // Week boundaries are calendar dates, not fixed 168-hour intervals across DST.
    const monday = shiftCalendarDate(startDate, -(weekday + 6) % 7);
    for (let weekStart = monday; weekStart <= endDate; weekStart = shiftCalendarDate(weekStart, 7)) {
      const weekEnd = shiftCalendarDate(weekStart, 6);
      weekly.push({ weekStart, weekEnd, actions: weeklyActions.map(action => {
        const completed = days.filter(day => day.date >= weekStart && day.date <= weekEnd && day.date <= asOfDate && met(action, day.values, parameters)).length;
        const target = resolveTarget(action.weeklyTarget, parameters);
        return { id: action.id, completed, target, met: completed >= target };
      }) });
    }
  }
  const tier = [...definition.milestones].reverse().find(milestone => consistencyDays >= milestone.at)?.label ?? "Begin again";
  return { asOfDate, endDate, dayNumber: Math.min(definition.durationDays, Math.max(0, between(startDate, asOfDate) + 1)), completedDays: elapsed.filter(day => day.complete).length, consistencyDays, graceUsed, graceRemaining: definition.consistency.graceDays - graceUsed, tier, days, weekly };
}

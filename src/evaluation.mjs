const DAY_MS = 86_400_000;
const ID = /^[a-z][a-z0-9-]{0,39}$/;

export class InputError extends Error {
  constructor(message, field = "request") {
    super(message);
    this.name = "InputError";
    this.field = field;
  }
}

function object(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError("Expected an object.", field);
  }
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) throw new InputError("Unexpected field.", `${field}.${unknown}`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new InputError("Required field is missing.", `${field}.${key}`);
  }
}

function text(value, field, max, identifier = false) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new InputError(`Expected nonempty text of at most ${max} characters, without control characters.`, field);
  }
  if (identifier && !ID.test(value)) throw new InputError("Use a lowercase letter followed by lowercase letters, digits, or hyphens.", field);
  return value.trim();
}

function date(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError("Use a calendar date in YYYY-MM-DD form.", field);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value || value < "2000-01-01" || value > "2100-12-31") {
    throw new InputError("Use a valid calendar date between 2000 and 2100.", field);
  }
  return timestamp;
}

/** Validate and normalize a complete, synthetic evaluation request. */
export function parseEvaluation(value) {
  object(value, ["goal", "startDate", "throughDate", "history", "checkIn"], "request");
  object(value.goal, ["id", "title", "actions"], "goal");
  const goal = {
    id: text(value.goal.id, "goal.id", 40, true),
    title: text(value.goal.title, "goal.title", 100),
    actions: [],
  };
  if (!Array.isArray(value.goal.actions) || value.goal.actions.length < 1 || value.goal.actions.length > 8) {
    throw new InputError("Provide between 1 and 8 daily actions.", "goal.actions");
  }
  const ids = new Set();
  value.goal.actions.forEach((action, index) => {
    const field = `goal.actions[${index}]`;
    object(action, ["id", "label"], field);
    const id = text(action.id, `${field}.id`, 40, true);
    if (ids.has(id)) throw new InputError("Action IDs must be unique.", `${field}.id`);
    ids.add(id);
    goal.actions.push({ id, label: text(action.label, `${field}.label`, 100) });
  });

  const start = date(value.startDate, "startDate");
  const end = date(value.throughDate, "throughDate");
  const days = (end - start) / DAY_MS + 1;
  if (days < 1 || days > 31) throw new InputError("Evaluate between 1 and 31 inclusive calendar dates.", "throughDate");
  if (!Array.isArray(value.history) || value.history.length > 30) throw new InputError("Provide an array of at most 30 earlier check-ins.", "history");

  function event(raw, field) {
    object(raw, ["date", "completedActions"], field);
    const day = date(raw.date, `${field}.date`);
    if (day < start || day > end) throw new InputError("Date must be inside the evaluation window.", `${field}.date`);
    if (!Array.isArray(raw.completedActions) || raw.completedActions.length > goal.actions.length) {
      throw new InputError("Provide an array of completed action IDs.", `${field}.completedActions`);
    }
    const completed = new Set();
    for (const actionId of raw.completedActions) {
      if (typeof actionId !== "string" || !ids.has(actionId)) throw new InputError("Unknown action ID.", `${field}.completedActions`);
      if (completed.has(actionId)) throw new InputError("Completed action IDs must not repeat.", `${field}.completedActions`);
      completed.add(actionId);
    }
    return { date: raw.date, completedActions: goal.actions.filter(action => completed.has(action.id)).map(action => action.id) };
  }

  const history = value.history.map((raw, index) => event(raw, `history[${index}]`));
  const dates = new Set();
  for (let index = 0; index < history.length; index++) {
    const day = history[index].date;
    if (day >= value.throughDate) throw new InputError("History must precede throughDate; put the final event in checkIn.", `history[${index}].date`);
    if (dates.has(day)) throw new InputError("Only one check-in per calendar date is allowed.", `history[${index}].date`);
    dates.add(day);
  }
  const checkIn = event(value.checkIn, "checkIn");
  if (checkIn.date !== value.throughDate) throw new InputError("The new check-in must be for throughDate.", "checkIn.date");
  return { goal, startDate: value.startDate, throughDate: value.throughDate, history, checkIn };
}

/** Pure rules engine: no network, persistence, clock, AI, or side effects. */
export function evaluateCheckIn(raw) {
  const input = parseEvaluation(raw);
  const events = new Map([...input.history, input.checkIn].map(event => [event.date, event]));
  const days = [];
  let currentStreak = 0;
  for (let timestamp = date(input.startDate, "startDate"); timestamp <= date(input.throughDate, "throughDate"); timestamp += DAY_MS) {
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const completedActions = events.get(day)?.completedActions ?? [];
    const missingActions = input.goal.actions.filter(action => !completedActions.includes(action.id)).map(action => action.id);
    const complete = missingActions.length === 0;
    currentStreak = complete ? currentStreak + 1 : 0;
    days.push({ date: day, complete, completedActions, missingActions });
  }
  const completeDays = days.filter(day => day.complete).length;
  return {
    goalId: input.goal.id,
    startDate: input.startDate,
    throughDate: input.throughDate,
    totalDays: days.length,
    completeDays,
    completionPercent: Math.round(completeDays / days.length * 100),
    currentStreak,
    days,
  };
}

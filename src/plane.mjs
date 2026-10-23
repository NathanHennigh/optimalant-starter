import { InputError } from './evaluation.mjs';
import { resolveParameters, validateValues } from './programs.mjs';
import { evaluateProgram, localDate, addDays } from './progress.mjs';
import { createLocalCoach, runCoach } from './plane-coach.mjs';
import { Store, ConflictError, NotFoundError } from './store.mjs';

function object(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Expected an object.');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new InputError('Unexpected field.', key);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new InputError('Required field is missing.', key);
}
function text(value, field, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new InputError(`Expected text of 1–${max} characters.`, field);
  return value.trim();
}
export function eventId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new InputError('Use an ID of 1–80 letters, numbers, underscores or hyphens.', 'id');
  return value;
}
function context(raw = {}) {
  object(raw, ['goal', 'startingPoint', 'constraints', 'notes']);
  const result = {};
  for (const key of ['goal', 'startingPoint', 'notes']) if (Object.hasOwn(raw, key)) result[key] = text(raw[key], `context.${key}`, key === 'notes' ? 1000 : 500);
  if (Object.hasOwn(raw, 'constraints')) {
    if (!Array.isArray(raw.constraints) || raw.constraints.length > 8) throw new InputError('Provide at most eight constraints.', 'context.constraints');
    result.constraints = raw.constraints.map(value => text(value, 'context.constraints', 200));
  }
  return result;
}

export function createPlane({ programs, dbPath = ':memory:', clock = () => new Date().toISOString(), coach = createLocalCoach() }) {
  const store = new Store(dbPath);
  const inFlight = new Map();
  const now = () => {
    const value = clock();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid server clock.');
    return new Date(value).toISOString();
  };
  function state(id, asOf = now()) {
    const enrollment = store.enrollment(eventId(id));
    const pack = store.pack(enrollment.programId, enrollment.programVersion);
    const checkins = store.records('checkins', id).map(({id, date, values, recordedAt}) => ({id, date, values, recordedAt}));
    const progress = evaluateProgram(pack.definition, { startDate: enrollment.startDate, parameters: enrollment.parameters, checkins, asOf });
    return { pack, enrollment, checkins, progress };
  }
  function view(id, asOf) {
    const { enrollment, progress } = state(id, asOf);
    return { enrollment, progress };
  }
  return {
    listPrograms() {
      return [...programs.values()].map(({ definition, fingerprint }) => ({ ...definition, fingerprint }));
    },
    createEnrollment(raw) {
      object(raw, ['id', 'programId', 'parameters', 'context'], ['id', 'programId']);
      eventId(raw.id);
      const createdAt = now();
      const value = store.transaction(() => {
        const prior = store.prior('enrollments', raw.id, raw);
        if (prior) return prior;
        const pack = programs.get(raw.programId);
        if (!pack) throw new InputError('Unknown program ID.', 'programId');
        const parameters = resolveParameters(pack.definition, raw.parameters ?? {});
        const memberContext = context(raw.context);
        store.install(pack);
        const enrollment = { id: raw.id, programId: pack.definition.id, programVersion: pack.definition.version, programFingerprint: pack.fingerprint, startDate: localDate(createdAt, pack.definition.calendar.timeZone), parameters, context: memberContext, createdAt };
        store.insertEnrollment(enrollment, raw);
        return enrollment;
      });
      return view(value.id, createdAt);
    },
    getEnrollment: view,
    saveCheckIn(id, raw) {
      object(raw, ['id', 'values'], ['id', 'values']);
      eventId(raw.id);
      const asOf = now();
      return store.transaction(() => {
        const { pack, enrollment, checkins } = state(id, asOf);
        const prior = store.prior('checkins', raw.id, raw, id);
        if (prior) return { checkin: prior, ...view(id, asOf), duplicate: true };
        const date = localDate(asOf, pack.definition.calendar.timeZone);
        if (date < enrollment.startDate || date >= addDays(enrollment.startDate, pack.definition.durationDays)) throw new ConflictError('This program round is not active.');
        if (checkins.length >= 1000) throw new ConflictError('This local enrollment has reached its 1,000-record storage bound.');
        const values = validateValues(pack.definition, raw.values);
        const checkin = { id: raw.id, enrollmentId: id, date, values, recordedAt: asOf };
        // Validate the same event projection the evaluator and coach will see.
        evaluateProgram(pack.definition, { startDate: enrollment.startDate, parameters: enrollment.parameters, checkins: [...checkins, { id: raw.id, date, values, recordedAt: asOf }], asOf });
        store.insertCheckin(checkin, raw);
        return { checkin, ...view(id, asOf), duplicate: false };
      });
    },
    async coachEnrollment(id, raw) {
      object(raw, ['id'], ['id']);
      eventId(raw.id);
      eventId(id);
      const prior = store.trace(raw.id);
      if (prior) {
        if (prior.enrollmentId !== id) throw new ConflictError('Trace ID belongs to another enrollment.');
        return { trace: prior, duplicate: true };
      }
      const pending = inFlight.get(raw.id);
      if (pending) {
        if (pending.enrollmentId !== id) throw new ConflictError('Trace ID belongs to another enrollment.');
        return { trace: await pending.promise, duplicate: true };
      }
      const promise = (async () => {
        const createdAt = now();
        const input = state(id, createdAt);
        if (store.records('traces', id).length >= 1000) throw new ConflictError('This local enrollment has reached its 1,000-trace storage bound.');
        const latest = new Map();
        for (const event of input.checkins) {
          const previous = latest.get(event.date);
          if (!previous || Date.parse(event.recordedAt) >= Date.parse(previous.recordedAt)) latest.set(event.date,event);
        }
        const checkins = [...latest.values()].sort((a,b) => a.date.localeCompare(b.date));
        const result = await runCoach({...input,checkins}, coach);
        const trace = { id: raw.id, enrollmentId: id, createdAt, programId: input.pack.definition.id, programVersion: input.pack.definition.version, programFingerprint: input.pack.fingerprint, input: { enrollment: input.enrollment, progress: input.progress, checkins }, result };
        return store.transaction(() => {
          const existing = store.trace(raw.id);
          if (existing) {
            if (existing.enrollmentId !== id) throw new ConflictError('Trace ID belongs to another enrollment.');
            return existing;
          }
          if (store.records('traces', id).length >= 1000) throw new ConflictError('This local enrollment has reached its 1,000-trace storage bound.');
          store.insertTrace(trace);
          return trace;
        });
      })();
      inFlight.set(raw.id, { enrollmentId: id, promise });
      try { return { trace: await promise, duplicate: false }; }
      finally { inFlight.delete(raw.id); }
    },
    reportOutcome(id, raw) {
      object(raw, ['id', 'traceId', 'note'], ['id', 'traceId', 'note']);
      eventId(raw.id); eventId(raw.traceId);
      const note = text(raw.note, 'note', 1000);
      store.enrollment(eventId(id));
      return store.transaction(() => {
        const prior = store.prior('outcomes', raw.id, raw, id);
        if (prior) return { outcome: prior, duplicate: true };
        const trace = store.trace(raw.traceId);
        if (!trace || trace.enrollmentId !== id) throw new NotFoundError('Trace not found in this enrollment.');
        if (store.records('outcomes', id).length >= 1000) throw new ConflictError('This local enrollment has reached its 1,000-outcome storage bound.');
        const outcome = { id: raw.id, enrollmentId: id, traceId: raw.traceId, note, reportedAt: now(), source: 'participant-report', causalClaim: false };
        store.insertOutcome(outcome, raw);
        return { outcome, duplicate: false };
      });
    },
    listTraces(id) {
      store.enrollment(eventId(id));
      return { traces: store.records('traces', id), outcomes: store.records('outcomes', id) };
    },
    close() { store.close(); },
  };
}

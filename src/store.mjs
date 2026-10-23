import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Single-machine reference storage. No production accounts or remote database. */
export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Database schema is newer than this starter.'); }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS programs (
        id TEXT NOT NULL, version TEXT NOT NULL, fingerprint TEXT NOT NULL, pack TEXT NOT NULL,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        id TEXT PRIMARY KEY, program_id TEXT NOT NULL, program_version TEXT NOT NULL,
        request TEXT NOT NULL, value TEXT NOT NULL,
        FOREIGN KEY (program_id, program_version) REFERENCES programs(id, version)
      );
      CREATE TABLE IF NOT EXISTS checkins (
        id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
        request TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS checkins_enrollment ON checkins(enrollment_id);
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES enrollments(id), value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traces_enrollment ON traces(enrollment_id);
      CREATE TABLE IF NOT EXISTS outcomes (
        id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL REFERENCES enrollments(id),
        trace_id TEXT NOT NULL REFERENCES traces(id), request TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outcomes_enrollment ON outcomes(enrollment_id);
      PRAGMA user_version = 1;
    `);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  install(pack) {
    const existing = this.db.prepare('SELECT fingerprint FROM programs WHERE id=? AND version=?').get(pack.definition.id, pack.definition.version);
    if (existing && existing.fingerprint !== pack.fingerprint) throw new ConflictError('Program content changed without a version change. Bump the program version.');
    this.db.prepare('INSERT OR IGNORE INTO programs VALUES (?,?,?,?)').run(pack.definition.id, pack.definition.version, pack.fingerprint, JSON.stringify(pack));
  }
  pack(id, version) {
    const row = this.db.prepare('SELECT pack FROM programs WHERE id=? AND version=?').get(id, version);
    if (!row) throw new NotFoundError('Program version not found.');
    return JSON.parse(row.pack);
  }
  enrollment(id) {
    const row = this.db.prepare('SELECT value FROM enrollments WHERE id=?').get(id);
    if (!row) throw new NotFoundError('Enrollment not found.');
    return JSON.parse(row.value);
  }
  prior(table, id, request, enrollmentId) {
    if (!['enrollments', 'checkins', 'outcomes'].includes(table)) throw new Error('Unknown record type.');
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) return null;
    if (row.request !== canonical(request) || (enrollmentId && row.enrollment_id !== enrollmentId)) throw new ConflictError('That event ID already has different content. Use a new ID for a correction.');
    return JSON.parse(row.value);
  }
  insertEnrollment(value, request) {
    this.db.prepare('INSERT INTO enrollments VALUES (?,?,?,?,?)').run(value.id, value.programId, value.programVersion, canonical(request), JSON.stringify(value));
  }
  insertCheckin(value, request) {
    this.db.prepare('INSERT INTO checkins VALUES (?,?,?,?)').run(value.id, value.enrollmentId, canonical(request), JSON.stringify(value));
  }
  records(table, enrollmentId) {
    if (!['checkins', 'traces', 'outcomes'].includes(table)) throw new Error('Unknown record type.');
    return this.db.prepare(`SELECT value FROM ${table} WHERE enrollment_id=? ORDER BY rowid`).all(enrollmentId).map(row => JSON.parse(row.value));
  }
  trace(id) {
    const row = this.db.prepare('SELECT value FROM traces WHERE id=?').get(id);
    return row ? JSON.parse(row.value) : null;
  }
  insertTrace(value) { this.db.prepare('INSERT INTO traces VALUES (?,?,?)').run(value.id, value.enrollmentId, JSON.stringify(value)); }
  insertOutcome(value, request) { this.db.prepare('INSERT INTO outcomes VALUES (?,?,?,?,?)').run(value.id, value.enrollmentId, value.traceId, canonical(request), JSON.stringify(value)); }
  close() { this.db.close(); }
}

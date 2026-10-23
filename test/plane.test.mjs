import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrograms } from '../src/programs.mjs';
import { createPlane } from '../src/plane.mjs';

const programs = await loadPrograms();
const start = '2026-10-19T16:00:00.000Z';

test('durable state survives restart; duplicate events stay single and changed payload conflicts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'plane-test-'));
  const dbPath = join(dir, 'test.sqlite');
  let plane = createPlane({programs, dbPath, clock:() => start});
  t.after(async () => { plane.close(); await rm(dir,{recursive:true,force:true}); });
  plane.createEnrollment({id:'alice',programId:'focus-7'});
  const values = {[programs.get('focus-7').definition.actions[0].id]:20};
  assert.equal(plane.saveCheckIn('alice',{id:'event-1',values}).progress.completedDays,1);
  assert.equal(plane.saveCheckIn('alice',{id:'event-1',values}).duplicate,true);
  assert.throws(() => plane.saveCheckIn('alice',{id:'event-1',values:{}}), /different content/);
  plane.close();
  plane = createPlane({programs,dbPath,clock:() => start});
  assert.equal(plane.getEnrollment('alice').progress.completedDays,1);
  assert.equal(plane.saveCheckIn('alice',{id:'event-1',values}).duplicate,true);
});

test('new snapshots replace the day and enrollment versions stay pinned', t => {
  let clock = start;
  const plane = createPlane({programs,clock:() => clock});
  t.after(() => plane.close());
  const first = plane.createEnrollment({id:'member',programId:'focus-7'});
  assert.equal(plane.createEnrollment({id:'member',programId:'focus-7'}).enrollment.createdAt,first.enrollment.createdAt);
  const action = programs.get('focus-7').definition.actions[0].id;
  plane.saveCheckIn('member',{id:'check-1',values:{[action]:20}});
  clock = '2026-10-19T16:01:00.000Z';
  const corrected = plane.saveCheckIn('member',{id:'check-2',values:{[action]:10}});
  assert.equal(corrected.progress.completedDays,0);
  assert.equal(corrected.progress.consistencyDays,0);
  assert.throws(() => plane.createEnrollment({id:'member',programId:'consistency-14'}), /different content/);
  assert.throws(() => plane.saveCheckIn('member',{id:'check-3',values:{invented:true}}));
  assert.throws(() => plane.saveCheckIn('member',{id:'check-3',date:'2000-01-01',values:{}}), /Unexpected field/);
});

test('coach trace and later reported outcome are linked without inventing completion', async t => {
  const plane = createPlane({programs,clock:() => start});
  t.after(() => plane.close());
  plane.createEnrollment({id:'person',programId:'focus-7',context:{goal:'Read project notes',constraints:['Only twenty minutes available']}});
  const results = await Promise.all([plane.coachEnrollment('person',{id:'reply-1'}),plane.coachEnrollment('person',{id:'reply-1'})]);
  assert.deepEqual(results[0].trace,results[1].trace);
  assert.equal(plane.listTraces('person').traces.length,1);
  assert.equal(plane.getEnrollment('person').progress.completedDays,0);
  const outcome = plane.reportOutcome('person',{id:'outcome-1',traceId:'reply-1',note:'I tried the suggested block and found it easier to start.'});
  assert.equal(outcome.outcome.causalClaim,false);
  assert.equal(plane.reportOutcome('person',{id:'outcome-1',traceId:'reply-1',note:outcome.outcome.note}).duplicate,true);
  assert.equal(plane.listTraces('person').outcomes.length,1);
  plane.createEnrollment({id:'other',programId:'focus-7'});
  await assert.rejects(plane.coachEnrollment('other',{id:'reply-1'}), /another enrollment/);
  assert.throws(() => plane.reportOutcome('other',{id:'outcome-2',traceId:'reply-1',note:'wrong owner'}), /not found/);
});

test('server date owns cutoff and closed round rejects new check-ins', t => {
  let clock = '2026-10-20T03:59:59.000Z';
  const plane = createPlane({programs,clock:() => clock});
  t.after(() => plane.close());
  plane.createEnrollment({id:'et',programId:'consistency-14'});
  assert.equal(plane.getEnrollment('et').enrollment.startDate,'2026-10-19');
  clock = '2026-10-20T04:00:00.000Z';
  assert.equal(plane.saveCheckIn('et',{id:'new-day',values:{}}).checkin.date,'2026-10-20');
  clock = '2026-11-03T17:00:00.000Z';
  assert.throws(() => plane.saveCheckIn('et',{id:'too-late',values:{}}), /not active/);
});

test('published version content cannot silently change and old enrollments retain their snapshots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'plane-versions-'));
  const dbPath = join(dir,'test.sqlite');
  let plane = createPlane({programs,dbPath,clock:() => start});
  t.after(async () => {plane.close();await rm(dir,{recursive:true,force:true});});
  const original = plane.createEnrollment({id:'original',programId:'focus-7'});
  plane.close();
  const changed = structuredClone(programs.get('focus-7'));
  changed.definition.parameters['focus-minutes'].default = 30;
  changed.fingerprint = 'changed-content';
  const changedPrograms = new Map(programs);
  changedPrograms.set('focus-7',changed);
  plane = createPlane({programs:changedPrograms,dbPath,clock:() => start});
  assert.throws(() => plane.createEnrollment({id:'second',programId:'focus-7'}), /version change/);
  assert.deepEqual(plane.getEnrollment('original').enrollment.parameters,original.enrollment.parameters);
  changed.definition.version = '1.2.0';
  const next = plane.createEnrollment({id:'second',programId:'focus-7'});
  assert.equal(next.enrollment.parameters['focus-minutes'],30);
  assert.equal(plane.getEnrollment('original').enrollment.parameters['focus-minutes'],20);
  changedPrograms.delete('focus-7');
  assert.equal(plane.createEnrollment({id:'original',programId:'focus-7'}).enrollment.programVersion,programs.get('focus-7').definition.version);
});

test('pre-policy enrollments keep their saved rules and disclose no participant fields to coaches', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'plane-legacy-policy-'));
  const dbPath = join(dir, 'test.sqlite');
  const legacy = structuredClone(programs.get('focus-7'));
  legacy.definition.version = '1.0.0';
  legacy.definition.consistency.graceDays = 0;
  delete legacy.definition.coach.visibleFields;
  legacy.fingerprint = 'synthetic-legacy-snapshot';
  const oldPrograms = new Map([['focus-7', legacy]]);
  let plane = createPlane({programs:oldPrograms,dbPath,clock:() => start});
  t.after(async () => {plane.close();await rm(dir,{recursive:true,force:true});});
  plane.createEnrollment({id:'legacy',programId:'focus-7',context:{notes:'Private local note'}});
  plane.saveCheckIn('legacy',{id:'day-one',values:{focus:20}});
  plane.close();
  let visible;
  plane = createPlane({programs,dbPath,clock:() => '2026-10-21T16:00:00.000Z',coach:{id:'visibility-test',async reply(input) {
    visible = input;
    return {message:'Choose your next focus session.',nextAction:{actionId:'focus',text:'Choose a quiet time.'}};
  }}});
  const original = plane.getEnrollment('legacy');
  assert.equal(original.enrollment.programVersion,'1.0.0');
  assert.equal(original.progress.graceRemaining,0);
  assert.equal(original.progress.days[1].status,'missed');
  assert.equal(original.progress.consistencyDays,0);
  await plane.coachEnrollment('legacy',{id:'legacy-coach'});
  assert.deepEqual(visible.enrollment,{});
  assert.deepEqual(visible.progress,{});
  assert.deepEqual(visible.checkins,[]);
  assert.doesNotMatch(JSON.stringify(visible),/Private local note/);
  const current = plane.createEnrollment({id:'current',programId:'focus-7'});
  assert.equal(current.enrollment.programVersion,'1.1.0');
  assert.equal(current.progress.graceRemaining,1);
});

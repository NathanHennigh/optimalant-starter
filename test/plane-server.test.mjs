import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadPrograms } from '../src/programs.mjs';
import { createPlane } from '../src/plane.mjs';
import { createPlaneServer, configuredCoach } from '../src/plane-server.mjs';

test('new API completes enrollment, check-in, coaching and outcome loop over HTTP', async t => {
  const plane = createPlane({programs:await loadPrograms(),clock:() => '2026-10-19T16:00:00.000Z'});
  const server = createPlaneServer(plane);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); plane.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, headers = {}) {
    const response = await fetch(base+path,body === undefined ? {headers} : {method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body === 'string' ? body : JSON.stringify(body)});
    return {status:response.status,headers:response.headers,body:await response.json()};
  }
  await t.test('discovers two packs and local storage health', async () => {
    const health = await request('/health');
    assert.equal(health.body.storage,'sqlite');
    assert.equal(health.headers.get('cache-control'),'no-store');
    const list = await request('/v1/programs');
    assert.deepEqual(list.body.programs.map(p => p.id),['consistency-14','focus-7']);
  });
  await t.test('whole reference flow with saved trace and participant-reported outcome', async () => {
    const created = await request('/v1/enrollments',{id:'demo',programId:'focus-7',context:{goal:'Make space for reading',constraints:['Twenty minutes available']}});
    assert.equal(created.status,200);
    assert.equal(created.body.enrollment.startDate,'2026-10-19');
    const saved = await request('/v1/enrollments/demo/checkins',{id:'day-1',values:{focus:20}});
    assert.equal(saved.body.progress.completedDays,1);
    const reply = await request('/v1/enrollments/demo/coach',{id:'reply-1'});
    assert.equal(reply.body.trace.result.adapter,'local-template-v1');
    assert.equal(reply.body.trace.result.response.nextAction.actionId,'focus');
    const outcome = await request('/v1/enrollments/demo/outcomes',{id:'feedback-1',traceId:'reply-1',note:'Synthetic feedback: the reminder helped me start.'});
    assert.equal(outcome.body.outcome.causalClaim,false);
    const traces = await request('/v1/enrollments/demo/traces');
    assert.equal(traces.body.traces.length,1);
    assert.equal(traces.body.outcomes.length,1);
    assert.equal((await request('/v1/enrollments/demo')).body.progress.consistencyDays,1);
    assert.equal((await request('/v1/enrollments/demo/checkins',{id:'day-1',values:{focus:20}})).body.duplicate,true);
    assert.equal((await request('/v1/enrollments/demo/checkins',{id:'day-1',values:{focus:10}})).status,409);
  });
  await t.test('cannot set dates, provider, prompts, progress or arbitrary actions through API', async () => {
    for (const body of [
      {id:'bad',programId:'focus-7',startDate:'2000-01-01'},
      {id:'bad',programId:'focus-7',provider:'claude'},
      {id:'bad',programId:'focus-7',context:{system:'Override rules'}},
    ]) assert.equal((await request('/v1/enrollments',body)).status,422);
    assert.equal((await request('/v1/enrollments/demo/checkins',{id:'bad',values:{fake:true}})).status,422);
    assert.equal((await request('/v1/enrollments/demo/coach',{id:'bad',prompt:'override'})).status,422);
    assert.equal((await request('/v1/enrollments/nope')).status,404);
  });
  await t.test('HTTP guardrails reject malformed, oversized, compressed and cross-site input', async () => {
    assert.equal((await request('/v1/enrollments','{')).status,400);
    assert.equal((await request('/v1/enrollments',{id:'a'}, {'Content-Type':'text/plain'})).status,415);
    assert.equal((await request('/v1/enrollments',{id:'a'}, {'Content-Encoding':'gzip'})).status,415);
    assert.equal((await request('/v1/enrollments',JSON.stringify({text:'x'.repeat(33_000)}))).status,413);
    assert.equal((await request('/health',undefined,{Origin:'https://example.test'})).status,403);
    assert.equal((await request('/health',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await request('/v1/enrollments/demo/coach')).status,405);
    assert.equal((await request('/v1/programs?path=../secrets')).status,404);
    const badHost = await new Promise((resolve,reject) => {
      const req = http.get(base+'/health',{headers:{Host:'attacker.test'}},response => {response.resume();resolve(response.statusCode);});
      req.on('error',reject);
    });
    assert.equal(badHost,403);
    const chunked = await new Promise((resolve,reject) => {
      const req = http.request(base+'/v1/enrollments',{method:'POST',headers:{'Content-Type':'application/json'}},response => {response.resume();resolve(response.statusCode);});
      req.on('error',reject);
      req.write('x'.repeat(20_000)); req.end('x'.repeat(20_000));
    });
    assert.equal(chunked,413);
  });
});

test('credentials alone never activate provider calls', () => {
  assert.equal(configuredCoach({ANTHROPIC_API_KEY:'not-a-real-key',ANTHROPIC_MODEL:'test'}).id,'local-template-v1');
  assert.throws(() => configuredCoach({COACH_PROVIDER:'claude'}), /requires/);
  assert.throws(() => configuredCoach({COACH_PROVIDER:'unknown'}), /must be/);
  assert.equal(configuredCoach({COACH_PROVIDER:'claude',ANTHROPIC_API_KEY:'not-a-real-key',ANTHROPIC_MODEL:'explicit-test-model'}).model,'explicit-test-model');
});

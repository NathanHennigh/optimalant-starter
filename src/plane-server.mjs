import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { InputError } from './evaluation.mjs';
import { loadPrograms } from './programs.mjs';
import { createPlane } from './plane.mjs';
import { createLocalCoach, createClaudeCoach } from './plane-coach.mjs';
import { ConflictError, NotFoundError } from './store.mjs';

const MAX_BODY = 32_768;
class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, {status, code}); }
}
function json(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'unsupported_encoding', 'Compressed bodies are not accepted.');
  if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) throw new HttpError(413, 'body_too_large', 'Maximum JSON body is 32 KiB.');
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], done = false;
    const fail = error => { if (!done) { done = true; chunks = []; reject(error); } };
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) fail(new HttpError(413, 'body_too_large', 'Maximum JSON body is 32 KiB.'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'invalid_json', 'Body must contain valid JSON.')); }
    });
    request.on('aborted', () => fail(new HttpError(400, 'request_aborted', 'Request ended before its body.')));
    request.on('error', fail);
  });
}
function send(response, status, body, headers = {}) {
  if (response.destroyed) return;
  response.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  response.end(JSON.stringify(body));
}

export function configuredCoach(env = process.env) {
  if (!env.COACH_PROVIDER || env.COACH_PROVIDER === 'local') return createLocalCoach();
  if (env.COACH_PROVIDER !== 'claude') throw new Error('COACH_PROVIDER must be local or claude.');
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_MODEL) throw new Error('Claude requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL.');
  return createClaudeCoach({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
}

export function createPlaneServer(plane) {
  const server = http.createServer(async (request, response) => {
    try {
      const port = request.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(request.headers.host)) throw new HttpError(403, 'invalid_host', 'Only the local server hostname is accepted.');
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) throw new HttpError(403, 'invalid_origin', 'Cross-origin browser requests are not accepted.');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'invalid_origin', 'Cross-site browser requests are not accepted.');
      const path = request.url;
      const member = /^\/v1\/enrollments\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})(?:\/(checkins|coach|traces|outcomes))?$/.exec(path);
      let method, action;
      if (path === '/health') { method = 'GET'; action = () => ({status:'ok',mode:'local-reference',storage:'sqlite',apiVersion:'1'}); }
      else if (path === '/v1/programs') { method = 'GET'; action = () => ({programs:plane.listPrograms()}); }
      else if (path === '/v1/enrollments') { method = 'POST'; action = body => plane.createEnrollment(body); }
      else if (member) {
        const [, id, operation] = member;
        method = !operation || operation === 'traces' ? 'GET' : 'POST';
        action = !operation ? () => plane.getEnrollment(id)
          : operation === 'checkins' ? body => plane.saveCheckIn(id, body)
          : operation === 'coach' ? body => plane.coachEnrollment(id, body)
          : operation === 'traces' ? () => plane.listTraces(id)
          : body => plane.reportOutcome(id, body);
      } else throw new HttpError(404, 'not_found', 'Endpoint not found.');
      if (request.method !== method) { request.resume(); return send(response, 405, {error:{code:'method_not_allowed',message:`Use ${method}.`}}, {Allow:method}); }
      const result = await action(method === 'POST' ? await json(request) : undefined);
      return send(response, 200, result);
    } catch (error) {
      request.resume();
      if (error instanceof InputError) send(response, 422, {error:{code:'invalid_input',message:error.message,field:error.field}});
      else if (error instanceof ConflictError) send(response, 409, {error:{code:'conflict',message:error.message}});
      else if (error instanceof NotFoundError) send(response, 404, {error:{code:'not_found',message:error.message}});
      else if (error instanceof HttpError) send(response, error.status, {error:{code:error.code,message:error.message}});
      else send(response, 500, {error:{code:'internal_error',message:'The operation could not be completed.'}});
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(45_000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
    const programs = await loadPrograms(process.env.PROGRAMS_DIR);
    const coach = configuredCoach();
    const dbPath = resolve(process.env.PLANE_DB_PATH || '.data/plane.sqlite');
    const plane = createPlane({programs, dbPath, coach});
    const server = createPlaneServer(plane);
    server.on('error', error => { console.error(`Cannot start local server: ${error.code ?? 'unknown error'}`); plane.close(); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`OptimalAnt local reference API: http://127.0.0.1:${port}\nStorage: ${dbPath}\nCoach: ${process.env.COACH_PROVIDER || 'local'}\nUse synthetic data. This is not the optimalant.ai service.`));
    let closing = false;
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
      if (closing) return; closing = true;
      server.close(() => { plane.close(); });
      server.closeIdleConnections();
    });
  } catch (error) { console.error(`Cannot start: ${error instanceof InputError ? error.message : 'Check configuration and program files; no credentials are printed.'}`); process.exitCode = 1; }
}

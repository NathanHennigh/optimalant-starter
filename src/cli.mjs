import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { loadProgram, loadPrograms } from './programs.mjs';
import { createPlane } from './plane.mjs';
import { comparePrograms } from './compare.mjs';
import { createLocalCoach } from './plane-coach.mjs';
import { configuredCoach } from './plane-server.mjs';

function options(args, allowed, switches = []) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!allowed.includes(flag) || Object.hasOwn(result, flag)) throw new Error(`Unknown or repeated option: ${flag}`);
    if (switches.includes(flag)) result[flag] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      result[flag] = value;
    }
  }
  return result;
}

async function demo() {
  const programs = await loadPrograms();
  const dir = await mkdtemp(join(tmpdir(), 'optimalant-example-'));
  const dbPath = join(dir, 'example.sqlite');
  let plane;
  try {
    plane = createPlane({programs,dbPath,clock:() => '2026-10-19T16:00:00.000Z'});
    console.log('OptimalAnt plane v1 — synthetic local example. No accounts, keys or network calls.');
    for (const [id, pack] of programs) {
      const enrollmentId = `example-${id}`;
      plane.createEnrollment({id:enrollmentId,programId:id,context:{goal:`Try the ${pack.definition.name}`,constraints:['Use a small, manageable next step']}});
      const values = Object.fromEntries(pack.definition.actions.map(action => [action.id, typeof action.target === 'object' ? pack.definition.parameters[action.target.parameter].default : action.target]));
      const saved = plane.saveCheckIn(enrollmentId,{id:`check-${id}`,values});
      const {trace} = await plane.coachEnrollment(enrollmentId,{id:`coach-${id}`});
      plane.reportOutcome(enrollmentId,{id:`outcome-${id}`,traceId:trace.id,note:'Synthetic example: planning a time made starting feel easier. This is a report, not proof of an effect.'});
      console.log(`\n${pack.definition.name}: ${saved.progress.completedDays} completed day; ${saved.progress.consistencyDays} consistency day; ${saved.progress.tier}.`);
      console.log(`Coach: ${trace.result.response.message}`);
      console.log(`Next: ${trace.result.response.nextAction.text}`);
      const report = await comparePrograms({baselinePack:pack,candidatePack:pack});
      console.log(`Evaluation: ${report.summary.cases} cases; ${report.passed ? 'PASS' : 'FAIL'}. Human coaching review remains required.`);
      if (!report.passed) process.exitCode = 1;
    }
    plane.close();
    plane = createPlane({programs,dbPath,clock:() => '2026-10-19T16:00:00.000Z'});
    const restored = plane.getEnrollment('example-focus-7');
    console.log(`\nRestart check: ${restored.progress.completedDays} saved day restored, with ${plane.listTraces('example-focus-7').outcomes.length} linked outcome.`);
    console.log('Temporary example database is removed on exit. Use npm start for persistent storage.');
  } finally { plane?.close(); await rm(dir,{recursive:true,force:true}); }
}

async function evaluate(args) {
  const opt = options(args,['--program','--baseline','--candidate','--output','--claude'],['--claude']);
  if (Boolean(opt['--baseline']) !== Boolean(opt['--candidate'])) throw new Error('Provide both --baseline and --candidate directories.');
  if (opt['--program'] && opt['--baseline']) throw new Error('Use --program or a baseline/candidate pair.');
  const adapter = opt['--claude'] ? configuredCoach({...process.env,COACH_PROVIDER:'claude'}) : createLocalCoach();
  const pairs = [];
  if (opt['--baseline']) pairs.push([await loadProgram(resolve(opt['--baseline'])),await loadProgram(resolve(opt['--candidate']))]);
  else {
    const programs = await loadPrograms(process.env.PROGRAMS_DIR);
    if (opt['--program'] && !programs.has(opt['--program'])) throw new Error('Unknown program.');
    for (const [id,pack] of programs) if (!opt['--program'] || id === opt['--program']) pairs.push([pack,pack]);
  }
  if (opt['--claude']) console.log('Explicit Claude evaluation: sample contexts will be sent using your configured key; each case runs both versions.');
  const reports = [];
  for (const [baselinePack,candidatePack] of pairs) {
    const report = await comparePrograms({baselinePack,candidatePack,baselineCoach:adapter,candidateCoach:adapter});
    reports.push(report);
    console.log(`${baselinePack.definition.id}: ${report.passed ? 'PASS' : 'FAIL'} — ${report.summary.cases} cases, ${report.summary.regressions} regressions.`);
    for (const sample of report.cases) {
      if (!sample.baseline.rules.passed || !sample.candidate.rules.passed || !sample.baseline.automatedCoaching.passed || !sample.candidate.automatedCoaching.passed) {
        console.log(`  ${sample.id}: ${JSON.stringify({baselineRules:sample.baseline.rules,candidateRules:sample.candidate.rules,baselineChecks:sample.baseline.automatedCoaching,candidateChecks:sample.candidate.automatedCoaching})}`);
      }
    }
  }
  if (opt['--output']) {
    const filename = resolve(opt['--output']);
    await mkdir(dirname(filename),{recursive:true});
    await writeFile(filename,JSON.stringify({schemaVersion:1,reports},null,2)+'\n',{flag:'wx'});
    console.log(`Full comparison saved to ${filename}. Existing reports are never overwritten.`);
  }
  console.log('Exact rules and narrow output checks only. Review usefulness, factual claims and constraints before promoting a version. Offline templates do not interpret coach.md; use --claude to compare prompt behavior.');
  if (reports.some(report => !report.passed)) process.exitCode = 1;
}

try {
  const [command,...args] = process.argv.slice(2);
  if (command === 'example' && args.length === 0) await demo();
  else if (command === 'evaluate') await evaluate(args);
  else if (command === 'check-programs' && args.length === 0) {
    for (const [id,pack] of await loadPrograms(process.env.PROGRAMS_DIR)) console.log(`${id}@${pack.definition.version}: valid definition; ${pack.cases.cases.length} sample cases.`);
  } else throw new Error('Use example, evaluate [--program ID | --baseline DIR --candidate DIR] [--output FILE] [--claude], or check-programs.');
} catch (error) {
  // Configuration errors are safe; never include provider response bodies or credentials.
  console.error(error?.name === 'InputError' ? `${error.field}: ${error.message}` : (error instanceof Error && !/key|token|secret/i.test(error.message) ? error.message : 'Check local configuration; credentials are not printed.'));
  process.exitCode = 1;
}

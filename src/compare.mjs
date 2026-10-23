import { createHash } from "node:crypto";
import { evaluateProgram } from "./progress.mjs";
import { resolveParameters } from "./programs.mjs";
import { createLocalCoach, runCoach } from "./plane-coach.mjs";

const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function differences(expected, actual, path = "progress") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return [{ path, expected, actual }];
    return expected.flatMap((value, index) => differences(value, actual[index], `${path}[${index}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return [{ path, expected, actual }];
    return Object.entries(expected).flatMap(([key, value]) => Object.hasOwn(actual, key)
      ? differences(value, actual[key], `${path}.${key}`) : [{ path: `${path}.${key}`, expected: value, actual: null, missing: true }]);
  }
  return Object.is(expected, actual) ? [] : [{ path, expected, actual: actual ?? null }];
}

function lexicalChecks(coaching, progress, rubric, program) {
  const text = `${coaching.response.message} ${coaching.response.nextAction.text}`.toLowerCase();
  const checks = [{ id: "adapter-succeeded", passed: !coaching.fallback, detail: coaching.fallback ? coaching.errorCode : "No fallback used." }];
  const allowed = rubric?.allowedActionIds ?? program.actions.map(action => action.id);
  checks.push({ id: "allowed-next-action", passed: allowed.includes(coaching.response.nextAction.actionId), detail: coaching.response.nextAction.actionId });
  for (const phrase of rubric?.mustMention ?? []) checks.push({ id: `mentions:${phrase}`, passed: text.includes(phrase.toLowerCase()), detail: "Literal phrase check; not a semantic quality judgment." });
  for (const phrase of rubric?.mustAvoid ?? []) checks.push({ id: `avoids:${phrase}`, passed: !text.includes(phrase.toLowerCase()), detail: "Literal phrase check; synonyms and implied claims require review." });
  const factualPatterns = [
    ["consistency-days", /\b(\d+)\s+consistency\s+days?\b/g, progress.consistencyDays],
    ["completed-days", /\b(\d+)\s+completed\s+days?\b/g, progress.completedDays],
    ["grace-remaining", /\b(\d+)\s+grace\s+days?\s+remaining\b/g, progress.graceRemaining],
  ];
  for (const [id, regex, expected] of factualPatterns) {
    for (const match of text.matchAll(regex)) checks.push({ id: `reported-fact:${id}`, passed: Number(match[1]) === expected, detail: { reported: Number(match[1]), computed: expected } });
  }
  return checks;
}

async function runCase(pack, sample, coach) {
  const { startDate, parameters, checkins, asOf, context } = sample.input;
  let progress;
  let resolvedParameters;
  try {
    resolvedParameters = resolveParameters(pack.definition, parameters);
    progress = evaluateProgram(pack.definition, { startDate, parameters: resolvedParameters, checkins, asOf });
  }
  catch {
    return { rules: { passed: false, differences: [], errorCode: "PROGRAM_EVALUATION_FAILED" }, coaching: null, automatedCoaching: { passed: false, checks: [] } };
  }
  const mismatches = differences(sample.expected, progress);
  // Match the API projection: resolved defaults and the latest snapshot per date.
  // The rules engine still validates every event before this reduction.
  const latest = new Map();
  for (const event of checkins) {
    const previous = latest.get(event.date);
    if (!previous || Date.parse(event.recordedAt) >= Date.parse(previous.recordedAt)) latest.set(event.date, event);
  }
  const coachingCheckins = [...latest.values()].sort((a, b) => a.date.localeCompare(b.date));
  const coaching = await runCoach({ pack, enrollment: { startDate, parameters: resolvedParameters, context }, progress, checkins: coachingCheckins }, coach);
  const checks = lexicalChecks(coaching, progress, sample.rubric, pack.definition);
  return {
    progress,
    rules: { passed: mismatches.length === 0, differences: mismatches },
    coaching,
    automatedCoaching: { passed: checks.every(check => check.passed), checks },
  };
}

function metadata(pack, coach) {
  return {
    id: pack.definition.id,
    version: pack.definition.version,
    programFingerprint: pack.fingerprint ?? fingerprint(pack.definition),
    promptHash: createHash("sha256").update(pack.prompt).digest("hex"),
    adapter: coach.id,
    model: coach.model ?? null,
  };
}

/** Compare the same program's versions against baseline-pinned inputs and assertions. */
export async function comparePrograms({ baselinePack, candidatePack, baselineCoach = createLocalCoach(), candidateCoach = createLocalCoach() }) {
  if (!baselinePack?.definition || !candidatePack?.definition || baselinePack.definition.id !== candidatePack.definition.id) {
    throw new Error("Compare two versions of the same program. Each program has its own sample cases.");
  }
  const samples = baselinePack.cases?.cases;
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("The baseline program needs sample cases.");
  const cases = [];
  for (const sample of samples) {
    // Sequential requests are intentional: no unbounded provider fan-out or implicit live calls.
    const baseline = await runCase(baselinePack, sample, baselineCoach);
    const candidate = await runCase(candidatePack, sample, candidateCoach);
    cases.push({
      id: sample.id,
      description: sample.description,
      inputFingerprint: fingerprint(sample.input),
      baseline,
      candidate,
      regressions: [
        ...(baseline.rules.passed && !candidate.rules.passed ? ["rules"] : []),
        ...(baseline.automatedCoaching.passed && !candidate.automatedCoaching.passed ? ["automated-coaching-checks"] : []),
      ],
    });
  }
  const passed = cases.every(item => item.baseline.rules.passed && item.candidate.rules.passed
    && item.baseline.automatedCoaching.passed && item.candidate.automatedCoaching.passed);
  return {
    schemaVersion: 1,
    baseline: metadata(baselinePack, baselineCoach),
    candidate: metadata(candidatePack, candidateCoach),
    casesFingerprint: fingerprint(baselinePack.cases),
    casesSource: "baseline",
    passed,
    summary: {
      cases: cases.length,
      baselineRuleFailures: cases.filter(item => !item.baseline.rules.passed).length,
      candidateRuleFailures: cases.filter(item => !item.candidate.rules.passed).length,
      baselineCoachingFailures: cases.filter(item => !item.baseline.automatedCoaching.passed).length,
      candidateCoachingFailures: cases.filter(item => !item.candidate.automatedCoaching.passed).length,
      regressions: cases.filter(item => item.regressions.length > 0).length,
    },
    humanReview: {
      required: true,
      questions: [
        "Is each recommendation useful and appropriate to the participant's goals and constraints?",
        "Does the reply make unsupported factual or causal claims that the narrow automated checks missed?",
        "Does the candidate improve the intended behavior, rather than merely match literal phrases?",
      ],
      limitation: "Passing means exact rule assertions and narrow output checks passed. It does not prove coaching quality, safety, or improved real-world outcomes. No changes are deployed automatically.",
    },
    cases,
  };
}

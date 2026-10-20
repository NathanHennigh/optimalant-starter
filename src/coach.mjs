import { evaluateCheckIn, parseEvaluation } from "./evaluation.mjs";

/**
 * CoachAdapter contract: async reply(context) -> { message: string }.
 * Adapters receive the validated goal, final check-in, and a frozen evaluation.
 * They produce text only. The caller owns validation, state, and user consent.
 */
export const localCoach = {
  id: "local-template-v1",
  async reply({ goal, evaluation }) {
    const finalDay = evaluation.days.at(-1);
    if (finalDay.complete) {
      return { message: `All ${goal.actions.length} actions recorded. Your streak is ${evaluation.currentStreak} ${evaluation.currentStreak === 1 ? "day" : "days"}. Choose a time for your next check-in.` };
    }
    const next = goal.actions.find(action => action.id === finalDay.missingActions[0]);
    return { message: `${finalDay.completedActions.length} of ${goal.actions.length} actions recorded. Your next action is: ${next.label}. Review your check-in before using it elsewhere.` };
  },
};

function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child);
  return value;
}

/** Inject a trusted adapter in code; requests cannot choose providers or prompts. */
export async function runEvaluation(raw, coach = localCoach) {
  const input = parseEvaluation(raw);
  const evaluation = evaluateCheckIn(input);
  const context = freeze(structuredClone({ goal: input.goal, checkIn: input.checkIn, evaluation }));
  const reply = await coach.reply(context);
  if (!reply || typeof reply.message !== "string" || !reply.message.trim() || reply.message.length > 600 || /[\u0000-\u001f\u007f]/.test(reply.message)) {
    throw new Error("Coach adapter returned an invalid reply.");
  }
  return { evaluation, coaching: { adapter: coach.id, message: reply.message.trim() }, persisted: false };
}

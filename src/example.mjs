import { readFile } from "node:fs/promises";
import { runEvaluation } from "./coach.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/evening-routine.json", import.meta.url), "utf8"));
console.log(JSON.stringify(await runEvaluation(fixture), null, 2));

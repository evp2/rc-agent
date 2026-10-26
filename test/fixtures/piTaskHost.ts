import { type EngineAnswer } from "../../src/engine/types.ts";
import { piEngineOn, startingShell, startingSubagent, untilAborted } from "../piDoubles.ts";

const [pidFile, kind] = process.argv.slice(2);
const start =
  kind === "subagent"
    ? startingSubagent({ hang: true, record: pidFile })
    : startingShell(`echo $$ > ${pidFile}; exec sleep 60`);
const pi = piEngineOn([start, untilAborted]);
const session = await pi.engine.open({
  projectDir: pi.projectDir,
  onQuestion: () => new Promise<EngineAnswer>(() => undefined),
});
session.send("go");
for await (const event of session.events) {
  if (event.type === "task_started") console.log("ready");
}

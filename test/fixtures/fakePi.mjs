import { writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", run);

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function run() {
  const plan = JSON.parse(input);
  if (plan.record) {
    writeFileSync(plan.record, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
  }
  if (plan.ignoreTerm) process.on("SIGTERM", () => undefined);
  emit({ type: "session", version: 3, id: "fake", cwd: process.cwd() });
  if (plan.inner) {
    emit({ type: "tool_execution_start", toolCallId: "inner-1", toolName: "bash", args: { command: "echo inner-secret" } });
    emit({
      type: "tool_execution_end",
      toolCallId: "inner-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "inner-secret" }] },
      isError: false,
    });
  }
  const u = plan.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const reportUsage = () =>
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: plan.say ?? "" }],
        stopReason: "stop",
        usage: {
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
        },
      },
    });
  if (plan.hang) {
    if (plan.usage) reportUsage();
    setInterval(() => undefined, 1000);
    return;
  }
  setTimeout(() => {
    reportUsage();
    emit({ type: "agent_end", messages: [], willRetry: false });
    emit({ type: "agent_settled", aborted: false });
    if (plan.stderr) process.stderr.write(plan.stderr);
    process.exit(plan.exit ?? 0);
  }, plan.delayMs ?? 0);
}

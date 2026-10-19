import type { SessionContext } from "./context";

/** Appended, not prepended, so a slash command still parses; forgotten only once `deliver` returns. */
export function deliverWithWithdrawnNote(ctx: SessionContext, text: string, deliver: (text: string) => void): void {
  const withdrawn = text.trimStart().startsWith("/") ? [] : ctx.withdrawnQuestions.flatMap((q) => q.questions);
  if (withdrawn.length === 0) {
    deliver(text);
    return;
  }
  const [which, them] = withdrawn.length === 1 ? ["the question below", "it"] : ["the questions below", "them"];
  const header =
    `[Connector note: before this message, the human was shown ${which} and stopped the turn without answering ${them}. ` +
    `It did not fail to display. This message may answer ${them}; don't re-ask unless it doesn't.]`;
  const quoted = withdrawn.map(
    (q) => `Question: ${q.question}` + (q.options.length ? `\nOptions: ${q.options.map((o) => o.label).join(" · ")}` : ""),
  );
  deliver(`${text}\n\n${[header, ...quoted].join("\n")}`);
  ctx.withdrawnQuestions = [];
}

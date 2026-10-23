import { nodeVersionProblem } from "../nodeVersion";

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}

// Loaded after the check: main's imports would otherwise run first, and the ".js" keeps the bundler from inlining it.
await import("./main.js");

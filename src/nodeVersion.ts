export const MIN_NODE_VERSION = "22.19.0";

export function nodeVersionProblem(running: string): string | undefined {
  const parse = (v: string) =>
    v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b, c] = parse(running);
  const [x, y, z] = parse(MIN_NODE_VERSION);
  const older = a !== x ? a < x : b !== y ? b < y : c < z;
  return older
    ? `rc-agent needs Node.js ${MIN_NODE_VERSION} or later, but this is ${running}. Upgrade Node.js and run it again.`
    : undefined;
}

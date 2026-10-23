import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import type { EngineAnswer, EngineEvent, EngineSession } from "../src/engine/types.ts";
import { callingTools, freshProjectDir, piEngineOn } from "./piDoubles.ts";

const agentDir = process.env.PI_CODING_AGENT_DIR!;
const stubServer = resolve(import.meta.dirname, "fixtures", "stubMcpServer.mjs");

function stubEntry(pidFile: string): Record<string, unknown> {
  return { command: process.execPath, args: [stubServer, pidFile], exposure: "direct" };
}

function writeMcpConfig(dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mcp.json"), contents);
}

const globalConfig = () => join(agentDir, "mcp.json");
afterEach(() => writeFileSync(globalConfig(), "{}"));

function openOptions(projectDir: string) {
  return { projectDir, onQuestion: () => new Promise<EngineAnswer>(() => undefined) };
}

async function untilTurnEnds(session: EngineSession): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === "turn_ended") return events;
  }
  throw new Error("event stream ended early");
}

async function callFromModel(projectDir: string, name: string): Promise<{ text: string; isError: boolean } | undefined> {
  const model = callingTools([{ name, args: {}, id: "call-1" }]);
  const pi = piEngineOn(model.steps, { projectDir });
  const session = await pi.engine.open(openOptions(projectDir));
  session.send("hello");
  await untilTurnEnds(session);
  await session.close();
  return model.results().get("call-1");
}

async function turnEnds(projectDir: string): Promise<void> {
  const pi = piEngineOn([fauxAssistantMessage("ok")], { projectDir });
  const session = await pi.engine.open(openOptions(projectDir));
  session.send("hello");
  await untilTurnEnds(session);
  await session.close();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("PiEngine: servers in the agent's mcp.json reach the model as mcp__<server>__<tool>", async () => {
  const pidFile = join(freshProjectDir(), "pid");
  writeMcpConfig(agentDir, JSON.stringify({ mcpServers: { stub: stubEntry(pidFile) } }));
  const result = await callFromModel(freshProjectDir(), "mcp__stub__ping");
  assert.deepEqual(result, { text: "pong", isError: false });
});

test("PiEngine: the project's .pi/mcp.json loads too, since the SDK session trusts its project", async () => {
  const projectDir = freshProjectDir();
  const pidFile = join(freshProjectDir(), "pid");
  writeMcpConfig(join(projectDir, ".pi"), JSON.stringify({ mcpServers: { stub: stubEntry(pidFile) } }));
  const result = await callFromModel(projectDir, "mcp__stub__ping");
  assert.deepEqual(result, { text: "pong", isError: false });
});

test("PiEngine: close() stops the MCP server process", async () => {
  const pidFile = join(freshProjectDir(), "pid");
  writeMcpConfig(agentDir, JSON.stringify({ mcpServers: { stub: stubEntry(pidFile) } }));
  await callFromModel(freshProjectDir(), "mcp__stub__ping");
  const pid = Number(readFileSync(pidFile, "utf8"));
  await eventually(() => !isAlive(pid), `MCP server ${pid} still running after close()`);
});

test("PiEngine: verify() leaves no MCP server process running", async () => {
  const pidFile = join(freshProjectDir(), "pid");
  writeMcpConfig(agentDir, JSON.stringify({ mcpServers: { stub: stubEntry(pidFile) } }));
  await piEngineOn([]).engine.verify();
  await new Promise((r) => setTimeout(r, 1000));
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    await eventually(() => !isAlive(pid), `MCP server ${pid} still running after verify()`);
  }
});

test("PiEngine: a session opens and answers when mcp.json is invalid", async () => {
  writeMcpConfig(agentDir, "{ not json");
  await turnEnds(freshProjectDir());
});

test("PiEngine: a session opens and answers when an MCP server cannot start", async () => {
  const missing = { command: join(freshProjectDir(), "no-such-binary") };
  writeMcpConfig(agentDir, JSON.stringify({ mcpServers: { broken: missing } }));
  await turnEnds(freshProjectDir());
});

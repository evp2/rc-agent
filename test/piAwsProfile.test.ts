import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { refreshAwsProfileFiles } from "../src/engine/pi/awsProfile.ts";
import type { EngineAnswer, EngineEvent } from "../src/engine/types.ts";
import { EXPIRED_TOKEN, failingWith, FAUX_MODEL, piEngineOn, scriptedCommand } from "./piDoubles.ts";

let credentialsFile: string;

function writeKey(accessKeyId: string): void {
  writeFileSync(credentialsFile, `[src]\naws_access_key_id=${accessKeyId}\naws_secret_access_key=s\n`);
}

// A fresh client per call, the way pi-ai builds one per request with only `profile` set.
async function resolvedKey(): Promise<string | undefined> {
  const client = new BedrockRuntimeClient({ profile: "src", region: "us-east-1" });
  return (await client.config.credentials()).accessKeyId;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "aws-profile-"));
  credentialsFile = join(dir, "credentials");
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  writeFileSync(process.env.AWS_CONFIG_FILE, "");
});

afterEach(() => {
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  delete process.env.AWS_CONFIG_FILE;
});

test("a fresh client keeps the first credentials it read until the files are refreshed", async () => {
  writeKey("OLDKEY");
  assert.equal(await resolvedKey(), "OLDKEY");
  writeKey("NEWKEY");
  await refreshAwsProfileFiles();
  assert.equal(await resolvedKey(), "NEWKEY");
});

test("a Bedrock Turn rereads the AWS profile files", async () => {
  writeKey("OLDKEY");
  assert.equal(await resolvedKey(), "OLDKEY");
  writeKey("NEWKEY");

  const pi = piEngineOn([fauxAssistantMessage("ok")], {
    provider: { type: "bedrock", model: FAUX_MODEL },
    piProvider: "amazon-bedrock",
  });
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
  session.send("hello");
  for await (const event of session.events as AsyncIterable<EngineEvent>) {
    if (event.type === "turn_ended") break;
  }
  await session.close();

  assert.equal(await resolvedKey(), "NEWKEY");
});

test("a call resent after the refresh command runs uses the credentials it wrote", async () => {
  writeKey("OLDKEY");
  assert.equal(await resolvedKey(), "OLDKEY");

  let resentWith: string | undefined;
  const command = scriptedCommand([], () => writeKey("NEWKEY"));
  const pi = piEngineOn(
    [
      failingWith(EXPIRED_TOKEN),
      async () => {
        resentWith = await resolvedKey();
        return fauxAssistantMessage("ok");
      },
    ],
    {
      provider: { type: "bedrock", model: FAUX_MODEL, awsAuthRefresh: ["aws", "sso", "login"] },
      piProvider: "amazon-bedrock",
      runCommand: command.run,
    },
  );
  const session = await pi.engine.open({
    projectDir: pi.projectDir,
    onQuestion: () => new Promise<EngineAnswer>(() => undefined),
  });
  session.send("hello");
  for await (const event of session.events as AsyncIterable<EngineEvent>) {
    if (event.type === "turn_ended") break;
  }
  await session.close();

  assert.equal(command.runs.length, 1);
  assert.equal(resentWith, "NEWKEY");
});

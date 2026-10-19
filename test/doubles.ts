import { FakeEngine, sayAndFinish, type FakeEngineScript, type FakeEngineSession } from "../src/engine/fakeEngine.ts";
import type { Engine, EngineSession } from "../src/engine/types.ts";
import type { CommandRecord, EventInput, ImageUpload, RelayClient } from "../src/relay/client.ts";
import type { SessionContext } from "../src/session/context.ts";
import { createBannerDeduper } from "../src/session/engineEvents.ts";
import { InFlight, type InFlightDeps } from "../src/session/inFlight.ts";
import { showImage } from "../src/session/images.ts";
import { pumpEngineEvents } from "../src/session/pump.ts";
import { answerQuestion } from "../src/session/watchers.ts";
import type { ConnectorState } from "../src/state.ts";

/** Records what the ledger reported, so a test can assert on transitions rather than only on the final value. */
export class FakeRelay {
  readonly reports: boolean[] = [];
  readonly posted: EventInput[] = [];
  /** Every contribution reported, so a test can assert a Turn reported once, or not at all. */
  readonly contributions: { host?: string; repo?: string; added: number; deleted: number }[] = [];
  /** Set to make the next setInFlight reject, for the best-effort path. */
  failNextReport: Error | undefined;

  async setInFlight(value: boolean): Promise<void> {
    if (this.failNextReport) {
      const e = this.failNextReport;
      this.failNextReport = undefined;
      throw e;
    }
    this.reports.push(value);
  }

  getSession: () => Promise<Awaited<ReturnType<RelayClient["getSession"]>>> = async () => ({});

  async pollCommands(): Promise<CommandRecord[]> {
    return [];
  }

  /** Every Auto-compact submission, so a test can assert it fired (or didn't) without a real relay. */
  readonly postedCommands: string[] = [];
  /** Set to make the next postCommand reject, for the best-effort retry path. */
  failNextPostCommand: Error | undefined;

  async postCommand(text: string): Promise<{ seq: string; created_at: string }> {
    if (this.failNextPostCommand) {
      const e = this.failNextPostCommand;
      this.failNextPostCommand = undefined;
      throw e;
    }
    this.postedCommands.push(text);
    return { seq: `auto-${this.postedCommands.length}`, created_at: new Date().toISOString() };
  }

  /** Set to make every postEvents batch carrying an `image` Event reject, as a relay that refuses the Image would. */
  rejectImageEvents: Error | undefined;

  async postEvents(events: EventInput[]): Promise<number> {
    if (this.rejectImageEvents && events.some((e) => e.type === "image")) throw this.rejectImageEvents;
    this.posted.push(...events);
    return events.length;
  }

  /** Every upload the relay was asked to sign. */
  readonly signed: { contentType: string; byteLength: number }[] = [];
  /** Every upload sent to S3, keyed by the image id its signature carried. */
  readonly uploaded: { imageId: string; bytes: Uint8Array; contentType: string }[] = [];

  /** Set to make the next signImageUpload reject, as a relay refusing to sign would. */
  failNextSign: Error | undefined;
  /** Set to make the next uploadImage reject, as a failed S3 POST would. */
  failNextUpload: Error | undefined;

  async signImageUpload(contentType: string, byteLength: number): Promise<ImageUpload> {
    this.signed.push({ contentType, byteLength });
    if (this.failNextSign) {
      const e = this.failNextSign;
      this.failNextSign = undefined;
      throw e;
    }
    const imageId = `img-${this.signed.length}`;
    return { imageId, url: "https://bucket.s3.test/", fields: { key: `images/sess/${imageId}` } };
  }

  async uploadImage(upload: ImageUpload, bytes: Uint8Array, contentType: string): Promise<void> {
    this.uploaded.push({ imageId: upload.imageId, bytes, contentType });
    if (this.failNextUpload) {
      const e = this.failNextUpload;
      this.failNextUpload = undefined;
      throw e;
    }
  }

  /** Every putSkills call, so a test can assert what the periodic report carried. */
  readonly putSkillsCalls: {
    skills: unknown;
    localCommands: unknown;
    inactivityCompactAfterMinutes: number | undefined;
  }[] = [];

  async putSkills(
    skills: unknown,
    localCommands: unknown,
    inactivityCompactAfterMinutes: number | undefined,
  ): Promise<void> {
    this.putSkillsCalls.push({ skills, localCommands, inactivityCompactAfterMinutes });
  }

  async postContribution(input: {
    host?: string;
    repo?: string;
    added: number;
    deleted: number;
  }): Promise<void> {
    this.contributions.push(input);
  }

  get lastReport(): boolean | undefined {
    return this.reports[this.reports.length - 1];
  }

  asClient(): RelayClient {
    return this as unknown as RelayClient;
  }
}

export interface LedgerHarness {
  ledger: InFlight;
  relay: FakeRelay;
  /** Every state patch the ledger asked for, in order. */
  patches: Partial<ConnectorState>[];
  emitted: EventInput[];
}

export function makeLedger(opts: { cursor?: string } = {}): LedgerHarness {
  const relay = new FakeRelay();
  const patches: Partial<ConnectorState>[] = [];
  const emitted: EventInput[] = [];
  const deps: InFlightDeps = {
    setInFlight: (value) => relay.setInFlight(value),
    persist: (patch) => {
      patches.push(patch);
    },
    emit: (event) => {
      emitted.push(event);
    },
  };
  return { ledger: new InFlight(deps, opts), relay, patches, emitted };
}

let nextSeq = 0;

export function cmd(text: string, seq?: string, source?: "phone" | "auto"): CommandRecord {
  nextSeq += 1;
  return {
    seq: seq ?? `c${nextSeq}`,
    text,
    created_at: new Date(Date.now() - 1000).toISOString(),
    ...(source ? { source } : {}),
  };
}

export interface TurnHarness {
  ctx: SessionContext;
  ledger: InFlight;
  relay: FakeRelay;
  written: ConnectorState[];
  /** The open Engine session the harness's pump reads -- a FakeEngineSession unless `engine` was overridden. */
  session: FakeEngineSession;
  /** Closes the Engine session and waits for the pump to drain what it had left. */
  close(): Promise<void>;
}

/**
 * A SessionContext driving a fake Engine, with no relay, no state file and no
 * agent process, and the session's event pump already running. Everything a
 * Turn touches that leaves the process is a field on the context, which is
 * what makes this possible at all.
 */
export async function makeTurnHarness(
  opts: {
    /** Each Turn's scripted body -- defaults to a Turn that says "ok" and ends. */
    handlerFor?: FakeEngineScript["handlerFor"];
    /** The rest of the fake Engine's script: a resume target, an announcement, a menu, ... */
    script?: Partial<FakeEngineScript>;
    /** A real Engine to drive instead of the fake -- for a regression pinned against one adapter's own behaviour. */
    engine?: Engine;
    /** What `open()` is asked to resume, as a state file would supply it. */
    resume?: string;
    /** A real directory for the Turn to run in -- only tests of git-derived behaviour need one. */
    projectDir?: string;
    /** Overrides merged into the fake config -- e.g. `inactivityCompact` for Auto-compact tests. */
    config?: Partial<SessionContext["config"]>;
  } = {},
): Promise<TurnHarness> {
  const relay = new FakeRelay();
  const written: ConnectorState[] = [];
  const projectDir = opts.projectDir ?? "/tmp/project";
  const engine =
    opts.engine ?? new FakeEngine({ handlerFor: opts.handlerFor ?? (() => sayAndFinish("ok")), ...opts.script });

  let ctx: SessionContext;
  const ledger = new InFlight({
    setInFlight: (value) => relay.setInFlight(value),
    persist: (patch) => {
      ctx.state = { ...ctx.state, ...patch };
      written.push(ctx.state);
    },
    emit: (event) => {
      ctx.eventBuffer.push(event);
    },
  });

  const session: EngineSession = await engine.open({
    projectDir,
    resume: opts.resume,
    onQuestion: (question, signal) => answerQuestion(ctx, question, signal),
    onShowImage: (image, signal) => showImage(ctx, image, signal),
  });

  ctx = {
    client: relay.asClient(),
    config: {
      relayBaseUrl: "http://relay.test",
      connectorCredential: "s",
      projectDir,
      provider: { type: "anthropic" },
      ...opts.config,
    } as SessionContext["config"],
    engine,
    engineSession: session,
    bannerFor: createBannerDeduper(),
    writeState: (state) => {
      written.push(state);
    },
    inFlight: ledger,
    state: {
      version: 1,
      projectDir: "/tmp/project",
      relayBaseUrl: "http://relay.test",
      sessionId: "sess",
      secret: "sec",
      phoneUrl: "http://relay.test/?s=sess",
      engine: "claude",
      pid: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    lastSkillsJson: undefined,
    conversationId: opts.resume,
    eventBuffer: [],
    running: true,
    sessionEnded: false,
    runningTasks: [],
    lastHandledKillAt: undefined,
    handBackBuffer: [],
    questionPending: false,
    withdrawnQuestions: [],
    currentTurn: undefined,
    engineTurn: undefined,
    contextWarningActive: false,
    flushChain: Promise.resolve(),
  };

  const pumping = pumpEngineEvents(ctx);
  return {
    ctx,
    ledger,
    relay,
    written,
    session: session as FakeEngineSession,
    async close() {
      await session.close();
      await pumping;
    },
  };
}

/** Resolves once `condition` holds, polling every few milliseconds; throws after `timeoutMs` so a broken expectation fails fast rather than hanging. */
export async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

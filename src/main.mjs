#!/usr/bin/env node
// SangSang Play TikTok LIVE sidecar — entry point (plan docs/superpowers/plans/2026-11-08-live-3.md §2, §4). A separate AGPL
// program the server spawns once per session (`node sidecar/tiktok-live/src/main.mjs`), spoken to over stdio NDJSON:
//   stdin  (server → sidecar): {"type":"connect",sessionId,hostUniqueId,saltHex,parserMode,maxTextCodePoints} · {"type":"stop",reason}
//   stdout (sidecar → server): hello (on start) · status · comment (minimised: salted user hash, nickname ≤ 24, token, length)
//                              · stats every 5 s (received/emitted/dropped counters; LIVE-5: upstream state + lastUpstreamAt)
// Env: SIDECAR_MODE=fake|real (default fake; `--mode=real|fake` when the env is unset), SIDECAR_FIXTURE=steady-20|burst-100|stale-20|no-connect, SIDECAR_FIXTURE_FILE (JSONL, fake), EULER_API_KEY
// (real, optional). Exits on stdin EOF, `stop`, SIGTERM/SIGINT. stdout carries protocol lines only (protocol.mjs); in real mode
// every console.* is muted so a connector log line can never reach the server.
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { DEFAULT_MAX_TEXT_CODE_POINTS, MAX_TEXT_LENGTH, minimise } from "./minimise.mjs";
import { write } from "./protocol.mjs";

const ARG_MODE = process.argv.find(a => a.startsWith("--mode="))?.slice("--mode=".length);
const MODE = (process.env.SIDECAR_MODE || ARG_MODE) === "real" ? "real" : "fake";
const STATS_INTERVAL_MS = 5000;
const MAX_COMMAND_LINE = 8192;
const STOP_TIMEOUT_MS = 1000;
const DROP_KINDS = ["gift", "like", "follow", "share", "member", "other", "missing_user", "too_long"];
const HANDLE_RE = /^@?[A-Za-z0-9_.]{2,24}$/;

if (MODE === "real") for (const k of ["log", "info", "warn", "error", "debug", "trace", "dir", "table"]) console[k] = () => undefined;

const counters = { received: 0, emitted: 0, dropped: Object.fromEntries(DROP_KINDS.map(k => [k, 0])) };
/** @type {{ saltHex: string, parserMode: "strict" | "lenient", maxTextCodePoints: number } | null} */
let session = null;
/** @type {{ stop(): unknown, isUpstreamOpen?(): boolean } | null} */
let source = null;
let generation = 0;
let exiting = false;
/**
 * LIVE-5: the TikTok connection as this process sees it (distinct from "sidecar alive"), reported in every `stats`. `lastAt` =
 * last provider event, websocket frame (real) or `connected` status; 0 = never.
 */
const upstream = { state: "disconnected", lastAt: 0 };

/** "connected" downgraded to "disconnected" when the source's local probe (real: connector state + websocket readyState) says so. */
function upstreamState() {
  if (upstream.state !== "connected") return upstream.state;
  try {
    return source?.isUpstreamOpen?.() === false ? "disconnected" : "connected";
  } catch {
    return "disconnected";
  }
}

function send(msg) {
  if (exiting && msg.type !== "status") return;
  try {
    write(msg);
  } catch {
    // a programming error in a builder: never let it escape to stdout as text
  }
}

function connectorVersion() {
  if (MODE !== "real") return null;
  try {
    return createRequire(import.meta.url)("tiktok-live-connector/package.json").version ?? null;
  } catch {
    return null;
  }
}

/** Every provider event of the current source: counted, minimised, forwarded as a `comment` or counted as a drop. */
function onProviderEvent(gen, kind, raw) {
  if (gen !== generation || !session || exiting) return;
  counters.received += 1;
  upstream.lastAt = Date.now();
  let r;
  try {
    r = minimise(kind, raw, session);
  } catch {
    r = { drop: "other" };
  }
  if (r.drop !== undefined) {
    counters.dropped[DROP_KINDS.includes(r.drop) ? r.drop : "other"] += 1;
    return;
  }
  if (r.textLength > session.maxTextCodePoints) counters.dropped.too_long += 1; // forwarded as token NONE, never parsed
  send(r);
  counters.emitted += 1;
}

function onProviderStatus(gen, state, extra = {}) {
  if (gen !== generation || exiting) return;
  upstream.state = state;
  if (state === "connected") upstream.lastAt = Date.now();
  send({ type: "status", state, ...extra });
}

function onProviderFrame(gen) {
  if (gen === generation && !exiting) upstream.lastAt = Date.now();
}

async function stopSource() {
  const s = source;
  source = null;
  generation += 1;
  if (!s) return;
  await Promise.race([Promise.resolve().then(() => s.stop()).catch(() => undefined), new Promise(r => setTimeout(r, STOP_TIMEOUT_MS))]);
}

async function onConnect(cmd) {
  const handle = typeof cmd.hostUniqueId === "string" && HANDLE_RE.test(cmd.hostUniqueId) ? cmd.hostUniqueId.replace(/^@/, "") : null;
  const saltOk = typeof cmd.saltHex === "string" && /^(?:[0-9a-f]{2}){1,128}$/i.test(cmd.saltHex);
  const parserMode = cmd.parserMode === "lenient" ? "lenient" : cmd.parserMode === "strict" ? "strict" : null;
  if (!handle || !saltOk || !parserMode) {
    send({ type: "status", state: "disconnected", code: "INTERNAL", retryable: false, message: "invalid connect command" });
    return;
  }
  const max = Number.isSafeInteger(cmd.maxTextCodePoints) && cmd.maxTextCodePoints >= 1 && cmd.maxTextCodePoints <= MAX_TEXT_LENGTH ? cmd.maxTextCodePoints : DEFAULT_MAX_TEXT_CODE_POINTS;
  await stopSource();
  session = { saltHex: cmd.saltHex.toLowerCase(), parserMode, maxTextCodePoints: max };
  const gen = generation;
  const hooks = {
    handle, onEvent: (kind, raw) => onProviderEvent(gen, kind, raw), onStatus: (state, extra) => onProviderStatus(gen, state, extra),
    onFrame: () => onProviderFrame(gen),
  };
  upstream.state = "connecting";
  send({ type: "status", state: "connecting" });
  try {
    if (MODE === "real") {
      const { startReal } = await import("./real.mjs");
      const s = await startReal(hooks);
      if (gen === generation) source = s; else await s.stop();
    } else {
      const { startFake } = await import("./fake.mjs");
      source = startFake({ ...hooks, fixture: process.env.SIDECAR_FIXTURE || "steady-20", fixtureFile: process.env.SIDECAR_FIXTURE_FILE || undefined });
    }
  } catch {
    onProviderStatus(gen, "disconnected", { code: "INTERNAL", retryable: true, message: "sidecar source failed to start" });
  }
}

async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  clearInterval(statsTimer);
  await stopSource();
  process.exit(code);
}

function onLine(line) {
  if (exiting || line.length === 0 || line.length > MAX_COMMAND_LINE) return;
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd?.type === "connect") void onConnect(cmd);
  else if (cmd?.type === "stop") void shutdown(0);
}

process.stdout.on("error", () => void shutdown(0)); // EPIPE: the server is gone
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
process.on("uncaughtException", () => {
  send({ type: "status", state: "disconnected", code: "INTERNAL", retryable: true, message: "sidecar crashed" });
  void shutdown(1);
});
process.on("unhandledRejection", () => {
  send({ type: "status", state: "disconnected", code: "INTERNAL", retryable: true, message: "sidecar crashed" });
  void shutdown(1);
});

send({ type: "hello", mode: MODE, connectorVersion: connectorVersion(), pid: process.pid });
const statsTimer = setInterval(() => send({
  type: "stats", received: counters.received, emitted: counters.emitted, dropped: { ...counters.dropped }, at: Date.now(),
  upstream: upstreamState(), ...(upstream.lastAt > 0 ? { lastUpstreamAt: upstream.lastAt } : {}),
}), STATS_INTERVAL_MS);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", onLine);
rl.on("close", () => void shutdown(0));

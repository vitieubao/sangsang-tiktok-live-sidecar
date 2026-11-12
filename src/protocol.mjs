// The sidecar's ONLY stdout writer (plan 2026-11-08-live-3.md §2, S7). Every message is rebuilt from a per-type
// whitelist, so a raw provider object can never be serialised by accident; anything else on stdout would be a bug
// (main.mjs mutes console.* in real mode). The server side re-validates each line with a strict zod schema.

const DROP_KINDS = ["gift", "like", "follow", "share", "member", "other", "missing_user", "too_long"];
const STATUS_STATES = new Set(["connecting", "connected", "disconnected"]);
const STATUS_CODES = new Set(["AUTH_INVALID", "TARGET_OFFLINE", "SIGN_SERVER_RATE_LIMIT", "SIGN_SERVER_ERROR", "PROTOCOL_CHANGED", "NETWORK", "INTERNAL"]);
const TOKENS = new Set(["A", "B", "C", "D", "JOIN", "SCORE", "NONE"]);

const int = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

/** Builds the whitelisted object for one sidecar → server message; throws on an unknown type (programming error). */
export function build(msg) {
  switch (msg?.type) {
    case "hello":
      return { type: "hello", mode: msg.mode === "real" ? "real" : "fake", connectorVersion: typeof msg.connectorVersion === "string" && msg.connectorVersion ? msg.connectorVersion.slice(0, 64) : null, pid: int(msg.pid) || 1 };
    case "status": {
      if (!STATUS_STATES.has(msg.state)) throw new Error(`protocol: bad status state ${String(msg.state)}`);
      const out = { type: "status", state: msg.state };
      if (STATUS_CODES.has(msg.code)) out.code = msg.code;
      if (typeof msg.retryable === "boolean") out.retryable = msg.retryable;
      if (typeof msg.message === "string" && msg.message) out.message = msg.message.slice(0, 200);
      return out;
    }
    case "comment": {
      if (!TOKENS.has(msg.token)) throw new Error(`protocol: bad token ${String(msg.token)}`);
      const out = { type: "comment", msgId: String(msg.msgId).slice(0, 64), userHash: String(msg.userHash), nickname: String(msg.nickname), token: msg.token, textLength: Math.min(int(msg.textLength), 10_000) };
      if (Number.isSafeInteger(msg.createTime) && msg.createTime >= 0) out.createTime = msg.createTime;
      return out;
    }
    case "stats": {
      const dropped = {};
      for (const k of DROP_KINDS) dropped[k] = int(msg.dropped?.[k]);
      const out = { type: "stats", received: int(msg.received), emitted: int(msg.emitted), dropped, at: int(msg.at) };
      // LIVE-5, optional: the server accepts stats with or without them (a pre-LIVE-5 server's strict schema would reject them —
      // the sidecar and the server ship from the same repository revision).
      if (STATUS_STATES.has(msg.upstream)) out.upstream = msg.upstream;
      if (Number.isSafeInteger(msg.lastUpstreamAt) && msg.lastUpstreamAt > 0) out.lastUpstreamAt = msg.lastUpstreamAt;
      return out;
    }
    default:
      throw new Error(`protocol: unknown message type ${String(msg?.type)}`);
  }
}

/** One NDJSON line. */
export const encode = msg => `${JSON.stringify(build(msg))}\n`;

/** Writes one message to `out` (default process.stdout). The single place the sidecar writes to stdout. */
export function write(msg, out = process.stdout) {
  out.write(encode(msg));
}

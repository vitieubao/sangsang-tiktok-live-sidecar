// Real provider of the sidecar (plan 2026-11-08-live-3.md §4, D-L3-11): TikTok-Live-Connector (AGPL, pinned in package.json),
// imported lazily so fake mode needs no dependency. Subscribes ONLY to chat + connection events (LIVE-5: plus `websocketData`
// as a bare liveness tick, its payload is never read) — never gift, like, follow, share or member (S9). Raw chat payloads go straight to main.mjs → minimise(); nothing here writes to stdout. Errors map to the
// fixed protocol codes with fixed messages (no provider text, no URLs, no keys). This is the only path not exercised by CI:
// field names and error classes are confirmed in private session 1 (README LIVE-3 "Chưa kiểm chứng").

/** Error → `{ code, retryable, message }` of the sidecar protocol. */
export function mapError(err) {
  const name = String(err?.constructor?.name ?? err?.name ?? "Error");
  const msg = String(err?.message ?? err ?? "");
  const status = Number(err?.response?.status ?? err?.status ?? err?.statusCode ?? 0);
  const out = (code, retryable, message) => ({ code, retryable, message: `${message} (${name})`.slice(0, 200) });
  if (name === "SignatureRateLimitError" || status === 429 || /rate.?limit/i.test(msg)) {
    return out("SIGN_SERVER_RATE_LIMIT", false, "Euler sign-server rate limit (free tier?) — switch source to companion");
  }
  if (name === "UserOfflineError" || /offline|not live|isn't online|user not found|stream end/i.test(msg)) return out("TARGET_OFFLINE", true, "host is not live");
  if (status === 401 || status === 403 || name === "PremiumFeatureError" || name === "AuthenticatedWebSocketConnectionError" || /unauthori|forbidden|api key/i.test(msg)) {
    return out("AUTH_INVALID", false, "sign-server refused the request (key/permission)");
  }
  if (name === "SchemaDecodeError" || name === "InvalidSchemaNameError" || /decode|protobuf|schema/i.test(msg)) return out("PROTOCOL_CHANGED", false, "webcast payload could not be decoded");
  if (name === "SignAPIError" || name === "SignatureMissingTokensError") return out("SIGN_SERVER_ERROR", true, "sign-server error");
  return out("NETWORK", true, "connection error");
}

/** LIVE-5: Euler sign-server request timeout (axios ms) and the `ws` opening-handshake timeout. */
export const SIGN_REQUEST_TIMEOUT_MS = 10_000;
export const WS_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * @param {{ handle: string, onEvent: (kind: string, raw: unknown) => void, onFrame?: () => void,
 *           onStatus: (state: "connecting" | "connected" | "disconnected", extra?: object) => void }} opts
 * @returns {Promise<{ stop(): Promise<void>, isUpstreamOpen?(): boolean }>}
 */
export async function startReal({ handle, onEvent, onStatus, onFrame = () => undefined }) {
  let mod;
  try {
    mod = await import("tiktok-live-connector");
  } catch {
    onStatus("disconnected", { code: "INTERNAL", retryable: false, message: "tiktok-live-connector is not installed (npm ci in sidecar/tiktok-live)" });
    return { stop: async () => undefined };
  }
  const { TikTokLiveConnection, WebcastEvent, ControlEvent, SignConfig } = mod;
  // LIVE-5 timeouts, read from the installed 2.5.0 sources (README LIVE-5):
  // - The Euler sign-server client (tiktok-live-api-sdk, axios) has NO timeout: a hung sign request hangs connect() forever.
  //   `SignConfig.baseOptions` is copied into every Euler request; it must be set before the first connection creates the
  //   cached client (one sidecar process = one session, so this runs before that).
  // - `wsClientOptions` is spread into the `ws` 8 constructor → `handshakeTimeout`.
  // - `webClientOptions.timeout` is DROPPED by 2.5.0 (destructured out by WebcastHttpClient), so it is not passed: TikTok HTTP
  //   requests use env TIKTOK_CLIENT_TIMEOUT (default 10 s), the websocket open waits WS_CONNECT_TIMEOUT_MS (default 20 s).
  if (SignConfig?.baseOptions && SignConfig.baseOptions.timeout === undefined) SignConfig.baseOptions.timeout = SIGN_REQUEST_TIMEOUT_MS;
  const conn = new TikTokLiveConnection(handle, {
    ...(process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {}),
    processInitialData: false,
    enableExtendedGiftInfo: false,
    wsClientOptions: { handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS },
  });
  let stopped = false;
  let reported = false;
  const fail = info => {
    if (stopped || reported) return;
    reported = true;
    onStatus("disconnected", info);
    conn.disconnect().catch(() => undefined);
  };
  conn.on(WebcastEvent.CHAT, data => { if (!stopped) onEvent("chat", data); });
  conn.on(ControlEvent.CONNECTED, () => { if (!stopped) onStatus("connected"); });
  conn.on(ControlEvent.DISCONNECTED, () => fail({ code: "NETWORK", retryable: true, message: "webcast connection closed" }));
  conn.on(ControlEvent.ERROR, err => fail(mapError(err)));
  conn.on(WebcastEvent.STREAM_END, () => fail({ code: "TARGET_OFFLINE", retryable: true, message: "the LIVE stream ended" }));
  // LIVE-5 liveness: `websocketData` fires for every received websocket frame (payload ignored here) → `lastUpstreamAt`.
  conn.on(ControlEvent.WEBSOCKET_DATA, () => { if (!stopped) onFrame(); });
  conn.connect().catch(err => fail(mapError(err)));
  return {
    stop: async () => {
      stopped = true;
      await conn.disconnect().catch(() => undefined);
    },
    /** Local check, no network call: the connector's own state and the websocket readyState (`wsClient.open`). */
    isUpstreamOpen: () => conn.isConnected === true && conn.wsClient?.open === true,
  };
}

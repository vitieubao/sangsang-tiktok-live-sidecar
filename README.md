# SangSang Play — TikTok LIVE sidecar (`sidecar/tiktok-live/`)

A **separate program** (AGPL-3.0-only, see `LICENSE` and `NOTICE.md`) that the SangSang Play server starts as a child process,
one per TikTok LIVE session (plan `docs/superpowers/plans/2026-11-08-live-3.md`, ADR-15). It wraps
[TikTok-Live-Connector](https://github.com/zerodytrash/TikTok-Live-Connector) (`tiktok-live-connector`, pinned **2.5.0**,
unofficial Webcast client, AGPL) and emits **minimised, hashed comment tokens** over stdio. `server/` never imports, bundles or
depends on this code or the connector.

## Modes

| Mode | Start | What it does |
|---|---|---|
| `fake` (default) | `npm run start:fake` or `SIDECAR_MODE=fake node src/main.mjs` | Built-in raw-shaped fixtures (`steady-20`, `burst-100`) or a JSONL file; **no dependency needed** (works without `npm install`). Used by `server/scripts/smoke-live3.mjs`. Refused by the server in production. |
| `real` | `npm ci` once, then `npm start` or `SIDECAR_MODE=real node src/main.mjs` | Lazily imports the connector, connects to the host's LIVE by `@handle`. Only for private test sessions after the owner's S1–S10 sign-off. |

Env (set by the server's `SidecarProcessTransport`; the child gets only these plus `PATH`/`NODE_ENV`):
`SIDECAR_MODE` (`fake`|`real`; `--mode=` when unset), `SIDECAR_FIXTURE` (`steady-20`|`burst-100`|`stale-20`|`no-connect`), `SIDECAR_FIXTURE_FILE` (fake, JSONL
lines `{ "at": msFromConnect, "kind": "chat"|"gift"|"like"|"member"|"social", "raw": {…} }`), `EULER_API_KEY` (real, optional on the
Euler free tier; never logged). Server side: `LIVE_TIKTOK_ENABLED`, `LIVE_TIKTOK_SIDECAR_PATH`, `LIVE_TIKTOK_HOST_UNIQUE_ID`,
`LIVE_TIKTOK_SIDECAR_STDERR` (see `server/.env.example`).

## Protocol (NDJSON, one object per line)

- server → sidecar (stdin): `{"type":"connect","sessionId","hostUniqueId","saltHex","parserMode":"strict"|"lenient","maxTextCodePoints"}` ·
  `{"type":"stop","reason"}`
- sidecar → server (stdout): `hello { mode, connectorVersion, pid }` on start · `status { state: connecting|connected|disconnected,
  code?, retryable?, message? }` · `comment { msgId, userHash, nickname, token, textLength, createTime? }` · `stats { received,
  emitted, dropped: { gift, like, follow, share, member, other, missing_user, too_long }, at, upstream?, lastUpstreamAt? }` every 5 s.
- LIVE-5 `stats` fields (optional; the server accepts stats without them): `upstream` = `connecting|connected|disconnected`, the
  TikTok connection as this process sees it (last status it reported; in real mode `connected` is downgraded to `disconnected`
  when the connector's `isConnected` is false or its websocket is not open — a local check, no network call); `lastUpstreamAt` =
  epoch ms of the last provider event, websocket frame (real) or `connected` status (omitted until the first one). The server's
  adapter reconnects when `upstream` stays ≠ `connected` for 30 s while it believes it is connected, and times out a connect
  after 20 s on its own clock. Real mode also sets the Euler sign request timeout (10 s, `SignConfig.baseOptions.timeout`) and the
  `ws` handshake timeout (10 s, `wsClientOptions.handshakeTimeout`); see `server/README.md` "LIVE-5" for what is not detected.
- Fake fixtures `stale-20` (steady-20 + 5 "Stale fan" viewers whose answers carry a 60 s old `createTime`) and `no-connect`
  (never reports `connected`) are test-only (smoke-live3 steps 8–9); `steady-20`/`burst-100` are unchanged.
- Error codes: `AUTH_INVALID`, `TARGET_OFFLINE`, `SIGN_SERVER_RATE_LIMIT`, `SIGN_SERVER_ERROR`, `PROTOCOL_CHANGED`, `NETWORK`,
  `INTERNAL` (fixed messages, never provider text). The server stops at once on rate limit / auth / protocol errors and backs off on
  the others (`server/src/modules/live-platform/backoff.ts`).
- Lifecycle: exits on stdin EOF, on `stop`, on SIGTERM/SIGINT. The server sends `stop`, then SIGTERM after 2 s, SIGKILL 2 s later.
- stdout is written only by `src/protocol.mjs` (per-type whitelist); the server re-validates each line with a strict zod schema
  and rejects unknown keys. In real mode every `console.*` is muted.

## Data statement (S7, S9)

Sent to the server, per comment: `sha256(sessionSalt ‖ providerUserId)` (the salt is per session, sent by the server), a sanitised
nickname (NFC, control/zero-width characters removed, ≤ 24 code points), the parsed token (`A`–`D`, `JOIN`, `SCORE`, `NONE`), the
text length, the provider message id and timestamp. **Never sent:** comment text, user id, `secUid`, `uniqueId`, avatars, gifts,
likes, follows, shares, member joins (real mode does not even subscribe to them; fake mode generates them so the drop counters are
smoked). Nothing is stored by the sidecar.

## Files

`src/main.mjs` (stdin reader, dispatcher, stats, exit) · `src/minimise.mjs` (the only reader of raw payloads) · `src/parser.mjs`
(copy of `server/src/modules/live-session/core/parser.ts`, parity-tested) · `src/protocol.mjs` (single stdout writer) ·
`src/fake.mjs` (fixtures) · `src/real.mjs` (connector, chat + connection events only, error mapping).

## License

AGPL-3.0-only. The source of this program is published with the repository, as the AGPL requires when the server uses it for a
network-facing service. TikTok is a trademark of its owner; this program is not affiliated with or endorsed by TikTok.

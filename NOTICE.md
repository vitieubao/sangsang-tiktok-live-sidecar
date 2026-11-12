# NOTICE — SangSang Play TikTok LIVE sidecar

This directory (`sidecar/tiktok-live/`) is a **separate program**, licensed **AGPL-3.0-only** (see `LICENSE`).

- It uses **TikTok-Live-Connector** (`tiktok-live-connector` on npm, https://github.com/zerodytrash/TikTok-Live-Connector),
  an unofficial TikTok LIVE Webcast client licensed under the GNU AGPL v3. The dependency is installed only here and
  imported only in real mode.
- It is **separate from `server/`**: the SangSang Play server starts it as a child process and exchanges newline-delimited
  JSON over stdin/stdout only (protocol: `docs/superpowers/plans/2026-11-08-live-3.md` §2). `server/` never imports,
  bundles or links this code or the connector, and `server/package.json` does not depend on it (ADR-15, S4).
- The sidecar's source is published with the repository, as the AGPL requires for a network-facing deployment.
- What it sends to the server: a salted SHA-256 of the provider user id, a sanitised nickname (≤ 24 code points), the
  parsed answer token (`A`–`D`, `JOIN`, `SCORE`, `NONE`), the text length, the message id and timestamp, and counters.
  It never forwards comment text, user ids, `secUid`, `uniqueId`, avatars, gifts or likes.

TikTok is a trademark of its owner; this program is not affiliated with or endorsed by TikTok.

# Published source of the SangSang Play TikTok LIVE sidecar

This repository publishes the complete source of the TikTok LIVE sidecar used by SangSang Play, as required by the
GNU Affero General Public License v3.0 (see `LICENSE` and `NOTICE.md`). The sidecar is a separate program: the SangSang Play
server starts it as a child process and exchanges NDJSON messages with it over stdio; no server code is linked with it.

- Source revision of the SangSang Play repository this copy was taken from: `dac62ad`.
- How it works, its messages and its privacy measures (comment text never leaves the sidecar; viewer ids are salted hashes;
  gifts, likes and other events are dropped): see `README.md` and `NOTICE.md`.
- Updates to the sidecar are published here before they run in production.

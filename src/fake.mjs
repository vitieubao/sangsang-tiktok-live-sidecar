// Fake provider of the sidecar (plan 2026-11-08-live-3.md §4): generates RAW-SHAPED TikTok-Live-Connector events (secUid,
// uniqueId, numeric userId, avatar URLs, comment text, gifts, likes, member joins) and hands them to main.mjs, which runs them
// through the same `minimise()` as real mode. So the smoke proves that none of those raw fields ever reaches server/ and that
// gifts/likes are dropped (S7, S9). No dependency: fake mode works without `npm install`.
//
// Fixtures:
// - `steady-20`: 20 users; each sends JOIN (100 ms apart, from 200 ms), then one comment every 400 ms round-robin, texts cycling
//   JOIN, A, B, "Đáp án C xin chào", "hello", D, "A B" (staggered per user); a gift every 2 s, likes every 1 s, member joins,
//   one 40-code-point nickname full of zero-width characters; mostly the tiktok-live-proto v3 shape of connector 2.5.0
//   (`user.id`, `user.displayId`, `user.secUid`, `user.avatarThumb`, `content`, `common.msgId/createTime`), every 4th chat v1 (flat).
// - `burst-100`: 100 users join within ~1 s, then every 4 s all of them comment within 400 ms; same gifts/likes.
// - LIVE-5, test-only: `stale-20` = `steady-20` plus 5 "Stale fan N" users who JOIN with a fresh createTime and then answer "A"
//   every 4 s each with a createTime 60 s in the past (an answer meant for an earlier question, delivered late) → server STALE;
//   `no-connect` = never reports `connected` and emits nothing (stats keep flowing) → the server's connect timeout.
// - `SIDECAR_FIXTURE_FILE` (optional): JSONL `{ "at": msFromConnect, "kind": "chat"|"gift"|"like"|"member"|"social", "raw": {…} }`,
//   replayed once instead of the built-in fixture.
import { readFileSync } from "node:fs";

export const FIXTURES = ["steady-20", "burst-100", "stale-20", "no-connect"];
const STALE_FANS = 5;
const STALE_AGE_MS = 60_000;
const TEXTS = ["JOIN", "A", "B", "Đáp án C xin chào", "hello", "D", "A B"];
const USER_ID_BASE = 7_000_000_000_001n;
const MSG_ID_BASE = 7_400_000_000_000_000_000n;
/** 40 code points: visible letters interleaved with zero-width space / joiner / BOM (sanitised to ≤ 24 visible). */
const ZERO_WIDTH_NICK = Array.from({ length: 20 }, (_, i) => `${"ZeroWidthFanNickname"[i]}${["​", "‍", "﻿", "⁠"][i % 4]}`).join("");

function makeUsers(n) {
  return Array.from({ length: n }, (_, i) => {
    const userId = String(USER_ID_BASE + BigInt(i));
    return {
      userId,
      secUid: `MS4wLjABAAAA${userId}fakeSecUid${i}`,
      uniqueId: `fan_account_${i}`,
      nickname: i === 7 ? ZERO_WIDTH_NICK : `Fan số ${i + 1}`,
      profilePictureUrl: `https://p16-sign.tiktokcdn.com/fake-avatar/${userId}.jpeg`,
    };
  });
}

/** Mostly the v3 `WebcastChatMessage` shape of tiktok-live-connector 2.5.0; every 4th chat the legacy v1 flat shape. */
function chatRaw(user, text, seq, now) {
  const msgId = String(MSG_ID_BASE + BigInt(seq));
  const createTime = now - 50 - (seq % 7) * 50; // 50–350 ms of fake provider lag
  if (seq % 4 === 0) {
    return { comment: text, userId: user.userId, secUid: user.secUid, uniqueId: user.uniqueId, nickname: user.nickname, profilePictureUrl: user.profilePictureUrl, msgId, createTime };
  }
  return {
    common: { method: "WebcastChatMessage", msgId, roomId: "7399999999999999999", createTime: String(createTime) },
    user: {
      id: user.userId, nickname: user.nickname, displayId: user.uniqueId, secUid: user.secUid,
      avatarThumb: { urlList: [user.profilePictureUrl] }, followInfo: { followingCount: "12", followerCount: "34" },
    },
    content: text,
  };
}

const giftRaw = (user, seq) => ({ giftId: 5655, repeatCount: 1, diamondCount: 1, giftName: "Rose", userId: user.userId, uniqueId: user.uniqueId, msgId: `g${seq}` });
const likeRaw = user => ({ likeCount: 3, totalLikeCount: 1000, userId: user.userId, uniqueId: user.uniqueId });
const memberRaw = user => ({ actionId: 1, userId: user.userId, uniqueId: user.uniqueId, nickname: user.nickname });

/**
 * @param {{ fixture?: string, fixtureFile?: string, onEvent: (kind: string, raw: unknown) => void,
 *           onStatus: (state: "connecting" | "connected" | "disconnected", extra?: object) => void }} opts
 * @returns {{ stop(): void }}
 */
export function startFake({ fixture = "steady-20", fixtureFile, onEvent, onStatus }) {
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const every = (ms, fn) => { const t = setInterval(fn, ms); timers.add(t); };
  const stop = () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); };

  if (fixtureFile) {
    let lines;
    try {
      lines = readFileSync(fixtureFile, "utf8").split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    } catch {
      onStatus("disconnected", { code: "INTERNAL", retryable: false, message: "SIDECAR_FIXTURE_FILE unreadable" });
      return { stop };
    }
    later(200, () => onStatus("connected"));
    for (const l of lines) later(200 + Math.max(0, Number(l.at) || 0), () => onEvent(String(l.kind ?? "chat"), l.raw));
    return { stop };
  }

  if (!FIXTURES.includes(fixture)) {
    onStatus("disconnected", { code: "INTERNAL", retryable: false, message: "unknown fake fixture" });
    return { stop };
  }
  if (fixture === "no-connect") return { stop }; // connect never completes; main.mjs keeps sending stats (upstream "connecting")
  const burst = fixture === "burst-100";
  const users = makeUsers(burst ? 100 : 20);
  let seq = 0;
  const chat = (user, text, ageMs = 0) => onEvent("chat", chatRaw(user, text, seq++, Date.now() - ageMs));
  if (fixture === "stale-20") {
    const fans = Array.from({ length: STALE_FANS }, (_, i) => {
      const userId = String(USER_ID_BASE + 1000n + BigInt(i));
      return { userId, secUid: `MS4wLjABAAAA${userId}fakeSecUidStale`, uniqueId: `fan_account_stale_${i}`, nickname: `Stale fan ${i + 1}`, profilePictureUrl: `https://p16-sign.tiktokcdn.com/fake-avatar/${userId}.jpeg` };
    });
    fans.forEach((u, i) => later(2500 + i * 100, () => chat(u, "JOIN")));
    let s = 0;
    later(3200, () => every(800, () => { chat(fans[s % fans.length], "A", STALE_AGE_MS); s += 1; }));
  }

  later(200, () => onStatus("connected"));
  const joinGap = burst ? 10 : 100;
  users.forEach((u, i) => later(200 + i * joinGap, () => { onEvent("member", memberRaw(u)); chat(u, "JOIN"); }));
  const start = 200 + users.length * joinGap + 300;

  if (burst) {
    let round = 0;
    later(start, () => every(4000, () => {
      round += 1;
      users.forEach((u, i) => later(Math.floor((i * 400) / users.length), () => chat(u, TEXTS[(round + i) % TEXTS.length])));
    }));
  } else {
    let tick = 0;
    later(start, () => every(400, () => {
      const i = tick % users.length;
      const text = TEXTS[(Math.floor(tick / users.length) + i) % TEXTS.length];
      tick += 1;
      chat(users[i], text);
    }));
  }
  let g = 0;
  every(2000, () => { const u = users[g % users.length]; onEvent("gift", giftRaw(u, g)); g += 1; });
  let l = 0;
  every(1000, () => { onEvent("like", likeRaw(users[l % users.length])); l += 1; });
  every(3000, () => onEvent("social", { displayType: "pm_mt_guidance_share", userId: users[0].userId }));
  return { stop };
}

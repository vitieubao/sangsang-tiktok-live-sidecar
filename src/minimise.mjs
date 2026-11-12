// Data minimisation of provider events (plan 2026-11-08-live-3.md D-L3-3/4/11, S7, S9). This is the ONLY place the
// sidecar reads raw TikTok-Live-Connector payloads: it keeps a whitelist, hashes the provider userId with the
// per-session salt (same formula as server/src/modules/live-platform/mock-live.adapter.ts `hashExternalUser`),
// replaces the comment text with a parsed token + length, and drops gifts/likes/follows/shares/member events.
// Raw `userId`, `secUid`, `uniqueId`, avatar fields and the comment text never leave this function.
// Both raw shapes are handled: v1 flat `{ comment, userId, secUid, uniqueId, nickname, msgId, createTime }` and the
// tiktok-live-proto v3 `WebcastChatMessage` emitted by tiktok-live-connector 2.5.0
// `{ content, user: { id, nickname, displayId, secUid, avatarThumb, … }, common: { msgId, createTime } }`
// (`user.userId` is also accepted). Real payloads unverified until private session 1 — README LIVE-3 "Chưa kiểm chứng".
import { createHash } from "node:crypto";
import { parseToken, tokenLabel } from "./parser.mjs";

export const NICKNAME_MAX = 24;
export const DEFAULT_MAX_TEXT_CODE_POINTS = 200;
export const MAX_TEXT_LENGTH = 10_000;
export const FALLBACK_NICKNAME = "Khán giả";
/** 2100-01-01 in ms. */
const MAX_TS = 4_102_444_800_000;
const DROP_KINDS = new Set(["gift", "like", "follow", "share", "member"]);

/** Control, format (zero-width, bidi, BOM), line/paragraph separators, variation selectors and invisible fillers. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{FE00}-\u{FE0F}\u{180E}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/** `sha256(salt ‖ providerUserId)` hex — byte-identical to the server's `hashExternalUser` (spec case 2). */
export function hashUser(saltHex, userId) {
  return createHash("sha256").update(Buffer.concat([Buffer.from(saltHex, "hex"), Buffer.from(userId, "utf8")])).digest("hex");
}

/** NFC, invisible/control characters removed, spaces collapsed, ≤ 24 code points AND ≤ 24 UTF-16 units; empty → fallback. */
export function sanitizeNickname(raw) {
  if (typeof raw !== "string") return FALLBACK_NICKNAME;
  const clean = raw.normalize("NFC").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
  const kept = [];
  let units = 0;
  for (const cp of clean) {
    if (kept.length >= NICKNAME_MAX || units + cp.length > NICKNAME_MAX) break;
    kept.push(cp);
    units += cp.length;
  }
  const out = kept.join("").trim();
  return out || FALLBACK_NICKNAME;
}

const isObj = v => typeof v === "object" && v !== null;
const idString = v =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "bigint" || (typeof v === "number" && Number.isSafeInteger(v)) ? String(v) : undefined;

/** Below this a timestamp is taken as SECONDS (1e11 s ≈ year 5138; 1e11 ms ≈ 1973). */
const SECONDS_BELOW = 1e11;

/**
 * Provider `createTime` → epoch ms. v3 sends a string whose unit (ms vs s) is UNVERIFIED: heuristic `< 1e11` → seconds ×1000.
 * Private session 1 must confirm the unit (README LIVE-3 "Chưa kiểm chứng / cần duyệt (L3)").
 */
function timestamp(v) {
  let n = typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : typeof v === "bigint" ? Number(v) : v;
  if (Number.isSafeInteger(n) && n > 0 && n < SECONDS_BELOW) n *= 1000;
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_TS ? n : undefined;
}

/**
 * One chat event → the whitelisted `comment` message, or `{ drop: kind }`.
 * Over-long text (> maxTextCodePoints) → token NONE without parsing, `textLength` kept (the caller counts `too_long`).
 * Missing provider userId → `{ drop: "missing_user" }` (no identity, no hash). Missing/oversized msgId → a salted
 * hash of (userId, createTime, text) so a redelivery still dedups server-side.
 * @param {unknown} raw
 * @param {{ saltHex: string, parserMode: "strict" | "lenient", maxTextCodePoints?: number }} opts
 */
export function minimiseChat(raw, opts) {
  if (!isObj(raw)) return { drop: "other" };
  if ("giftId" in raw || "repeatCount" in raw || "diamondCount" in raw) return { drop: "gift" };
  if ("likeCount" in raw || "totalLikeCount" in raw) return { drop: "like" };
  const user = isObj(raw.user) ? raw.user : null;
  const common = isObj(raw.common) ? raw.common : null;
  const userId = idString(raw.userId) ?? idString(user?.userId) ?? idString(user?.id);
  if (!userId) return { drop: "missing_user" };

  const rawText = typeof raw.comment === "string" ? raw.comment : typeof raw.content === "string" ? raw.content : "";
  const text = rawText.trim();
  const textLength = Array.from(text).length;
  const max = opts.maxTextCodePoints ?? DEFAULT_MAX_TEXT_CODE_POINTS;
  const token = textLength > max ? "NONE" : tokenLabel(parseToken(text, opts.parserMode));
  const createTime = timestamp(raw.createTime ?? common?.createTime);
  let msgId = idString(raw.msgId) ?? idString(common?.msgId);
  if (!msgId || msgId.length > 64) {
    const seed = [opts.saltHex, userId, String(createTime ?? ""), text].join("\u0000");
    msgId = `h${createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
  }

  const out = {
    type: "comment",
    msgId,
    userHash: hashUser(opts.saltHex, userId),
    nickname: sanitizeNickname(typeof raw.nickname === "string" ? raw.nickname : user?.nickname),
    token,
    textLength: Math.min(textLength, MAX_TEXT_LENGTH),
  };
  if (createTime !== undefined) out.createTime = createTime;
  return out;
}

/**
 * Dispatch by connector event name. Only `chat` is ever minimised; gifts, likes, follows, shares and member joins
 * are dropped by kind (S9 — real.mjs does not even subscribe to them; fake mode generates them to smoke this path).
 */
export function minimise(kind, raw, opts) {
  if (kind === "chat") return minimiseChat(raw, opts);
  if (kind === "social") return { drop: "follow" };
  return { drop: DROP_KINDS.has(kind) ? kind : "other" };
}

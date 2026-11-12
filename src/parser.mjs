// ORIGIN: faithful ESM copy of server/src/modules/live-session/core/parser.ts (SangSang Play, main @ c4f33fe).
// The sidecar parses the comment into a token so raw text never crosses into server/ (plan 2026-11-08-live-3.md
// D-L3-4). Keep both files identical in behaviour: server/src/modules/live-platform/live-adapter.spec.ts case 3
// compares them on the same inputs. Comment grammar: docs/LIVE_EVENT_PROCESSING.md §3.2. Pure functions, no I/O.

/** @typedef {{ kind: "ANSWER", option: 0 | 1 | 2 | 3 } | { kind: "JOIN" } | { kind: "SCORE" } | { kind: "NONE" }} ParsedToken */
/** @typedef {"strict" | "lenient"} ParserMode */

/** @type {Record<string, 0 | 1 | 2 | 3>} */
const LETTERS = { A: 0, B: 1, C: 2, D: 3 };
/** Digits map to options in lenient mode only (strict never maps numbers). @type {Record<string, 0 | 1 | 2 | 3>} */
const DIGITS = { "1": 0, "2": 1, "3": 2, "4": 3 };
/** Closed prefix list, longest first so `CHỌN` does not shadow `TÔI CHỌN`. */
const LENIENT_PREFIXES = ["CÂU TRẢ LỜI", "MÌNH CHỌN", "TÔI CHỌN", "EM CHỌN", "ĐÁP ÁN", "DAP AN", "CHỌN", "CHON"];
const MAX_TRAILING_TOKENS = 3;

const SYMBOLS = /[\p{So}\p{Sk}\p{Cs}\u{FE00}-\u{FE0F}\u{200D}\u{200B}\u{200C}\u{2060}]/gu;
const EDGE_PUNCT = /^[.,!?:;()\[\]"']+|[.,!?:;()\[\]"']+$/gu;

/** NFC → strip symbols/emoji (So/Sk/Cs), variation selectors, ZWJ → strip edge punctuation → trim → collapse spaces → uppercase. */
export function normalizeText(text) {
  return text.normalize("NFC").replace(SYMBOLS, "").trim().replace(EDGE_PUNCT, "").trim().replace(/\s+/gu, " ").toUpperCase();
}

/** @returns {ParsedToken | null} */
const exact = s => {
  const letter = LETTERS[s];
  if (letter !== undefined) return { kind: "ANSWER", option: letter };
  if (s === "JOIN") return { kind: "JOIN" };
  if (s === "SCORE") return { kind: "SCORE" };
  return null;
};

function stripPrefix(s) {
  for (const prefix of LENIENT_PREFIXES) {
    if (s === prefix) return "";
    if (s.startsWith(prefix + " ")) return s.slice(prefix.length + 1);
  }
  return s;
}

/**
 * strict: the normalized text must equal `A|B|C|D|JOIN|SCORE`.
 * lenient: additionally strips a Vietnamese prefix, then takes the first token when it is `A–D` or `1–4` (→ A–D)
 * with ≤ 3 trailing tokens; a second option-like token (`A B`) is ambiguous → NONE; `JOIN`/`SCORE` with a suffix → NONE.
 * @param {string} text
 * @param {ParserMode} mode
 * @returns {ParsedToken}
 */
export function parseToken(text, mode) {
  const s = normalizeText(text);
  if (s.length === 0) return { kind: "NONE" };
  const direct = exact(s);
  if (direct) return direct;
  if (mode === "strict") return { kind: "NONE" };

  const stripped = stripPrefix(s);
  const tokens = stripped.split(" ").filter(t => t.length > 0);
  const first = tokens[0];
  if (first === undefined) return { kind: "NONE" };
  const option = LETTERS[first] ?? DIGITS[first];
  if (option === undefined) return { kind: "NONE" }; // includes `JOIN A`, `SCORE X`
  const rest = tokens.slice(1);
  if (rest.length > MAX_TRAILING_TOKENS) return { kind: "NONE" };
  if (rest.some(t => LETTERS[t] !== undefined || DIGITS[t] !== undefined)) return { kind: "NONE" }; // `A B`, `1 2`
  return { kind: "ANSWER", option };
}

/** @param {ParsedToken} token @returns {"A" | "B" | "C" | "D" | "JOIN" | "SCORE" | "NONE"} */
export const tokenLabel = token => (token.kind === "ANSWER" ? ["A", "B", "C", "D"][token.option] : token.kind);

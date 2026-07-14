/**
 * Version de-duplication.
 *
 * A DJ library is full of near-duplicates: Clean / Dirty / Intro / Acapella / Instrumental /
 * Extended Mix / Radio Edit of the *same* song. Left alone, the top suggestions become six
 * edits of one track. We collapse them by a normalised "song key" = primary artist + base
 * title, so the engine surfaces distinct songs.
 *
 * Design choice: any marker that denotes ANOTHER version of the SAME song — edits
 * (clean/dirty/intro/…) AND alternate productions (remix/bootleg/flip/vip/refix/rework/live) — is
 * stripped, so a song and its remixes collapse to ONE suggestion (a DJ knows the versions exist;
 * listing them all just wastes slots). Only genuinely different TRACKS (mashup / blend = two songs
 * combined, cover = a different artist's recording) keep their own identity.
 */

import type { Track } from "./types.ts";

// Words that mark another version of the same song. Stripped from the title.
const EDIT_MARKERS = [
  "clean", "dirty", "explicit", "intro", "outro", "acapella", "a cappella", "acap",
  "instrumental", "inst", "extended", "radio", "edit", "reedit", "re-edit", "redrum",
  "quick hit", "quickhit", "quickhitter", "short", "snippet", "snip", "transition", "trans", "starter",
  "ending", "version", "ver", "mm edit", "mmedit", "dub edit", "club edit", "no tag", "notag",
  "hype", "loop", "extended mix", "radio edit", "main", "album version", "single version",
  // alternate productions of the same song — now collapsed too (per DJ feedback)
  "remix", "rmx", "bootleg", "flip", "vip", "refix", "rework", "live", "remaster", "remastered",
];
// Markers that denote a genuinely DIFFERENT track. Kept as part of identity.
const KEEP_MARKERS = ["mashup", "blend", "cover"];

const editWordRe = new RegExp(
  "\\b(" + EDIT_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
  "i",
);
const keepWordRe = new RegExp("\\b(" + KEEP_MARKERS.join("|") + ")\\b", "i");

/** True if a text chunk contains an edit marker but no keep-marker. */
function isEditChunk(chunk: string): boolean {
  return editWordRe.test(chunk) && !keepWordRe.test(chunk);
}

/**
 * Strip ALL parenthetical/bracket/brace chunks — `(…)`, `[…]`, `{…}` — regardless of content, the
 * way the reference app's `normalizeForMatch` does. Record-pool titles bury version, edit, producer
 * (`(DJ Mustard)`, `[Prod. By …]`), arrangement (`{Cold Drop}`, `(Acc Out)`) and featured
 * (`(Feat. …)`) tags in brackets; wholesale stripping collapses every edit of a song without a
 * curated marker list. Chunks that name a genuinely DIFFERENT track (mashup/blend/cover) are kept.
 */
function stripBracketChunks(s: string): string {
  return s.replace(/[([{][^)\]}]*[)\]}]/g, (m) => (keepWordRe.test(m) ? m : " "));
}

// A trailing segment that's just a Camelot key ("6A"), a BPM ("128" / "128 bpm"), or a BPM range
// ("100-124") — record pools append these; they're pure noise for song identity.
const keyBpmChunkRe = /^\s*(\d{1,2}[ab]|\d{2,3}(\s*bpm)?|\d{2,3}\s*-\s*\d{2,3}(\s*bpm)?)\s*$/i;

/** Drop trailing " - <edit / key / bpm descriptor>" segments, e.g. " - First Edit", " - 6A", " - 128". */
function stripTrailingEditSegments(s: string): string {
  const segs = s.split(/\s[-–—]\s/);
  return segs.length > 1
    ? segs.filter((seg, i) => i === 0 || !(isEditChunk(seg) || keyBpmChunkRe.test(seg))).join(" - ")
    : s;
}

/** Collapse featured credits + punctuation to a bare word sequence. */
function tidy(s: string): string {
  return s
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ") // "feat X" and everything after
    .replace(/^\s*the\s+/i, " ") // leading "The "
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Reduce a title to its base song identity (matches the reference matcher, plus bare-word edits). */
export function normalizeTitle(title: string): string {
  let s = (title ?? "").toLowerCase();
  s = stripBracketChunks(s);
  s = stripTrailingEditSegments(s);
  // Remove any remaining BARE edit-marker words (e.g. "Blessings Remix"), unless a keep-marker is present.
  s = s.replace(editWordRe, (m) => (keepWordRe.test(s) && keepWordRe.test(m) ? m : " "));
  return tidy(s);
}

/**
 * Looser identity: strip bracket chunks + trailing segments but KEEP bare edit words. Used only as
 * a fallback when the aggressive normalize empties the title — i.e. a song literally titled with an
 * edit word ("Remix", "Instrumental"). Without this, "Remix (Clean)" and "Remix (MMP Intro Edit)"
 * both collapse to "" under the aggressive rule, so the empty-fallback kept their full raw titles
 * and they never de-duplicated. Keeping the bare word yields "remix" for both → one song.
 */
export function looseTitle(title: string): string {
  return tidy(stripTrailingEditSegments(stripBracketChunks((title ?? "").toLowerCase())));
}

/** Primary artist (drop featured/collab credits) for grouping. */
export function primaryArtist(artist: string): string {
  return (artist ?? "")
    .toLowerCase()
    .split(/\s(?:feat\.?|ft\.?|featuring|&|,|\bx\b|\bvs\.?\b|with)\s/)[0]
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Memoise per Track object — the pool is stable across live-loop passes, and songKey runs
// several regexes, so caching turns a ~200ms/pass cost into a one-time computation.
const keyCache = new WeakMap<Track, string>();

/** Base song title (edit markers stripped), with empty-safe fallbacks. */
export function baseTitle(t: Track): string {
  // Aggressive first; if the title is all edit words it empties, so keep the bare word ("Remix");
  // if even that empties, fall back to the raw title so we never over-merge unrelated songs.
  return (
    normalizeTitle(t.title) ||
    looseTitle(t.title) ||
    (t.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  );
}

/** Stable identity for "the same song", used to collapse versions. */
export function songKey(t: Track): string {
  const cached = keyCache.get(t);
  if (cached !== undefined) return cached;
  const key = `${primaryArtist(t.artist)}|${baseTitle(t)}`;
  keyCache.set(t, key);
  return key;
}

/**
 * True if two primary-artist strings name the same act, tolerating tagging noise. Record pools
 * tag the same artist inconsistently — "Waka Flocka Flame" vs "Waka Flocka", or a dropped/added
 * featured credit — so an exact string match misses real duplicates. We treat them as the same act
 * when one's word-set is contained in the other's (every word of the shorter name appears in the
 * longer). "waka flocka" ⊆ "waka flocka flame" → same; "lil baby" vs "lil durk" → different.
 */
export function sameArtist(a: string, b: string): boolean {
  const ta = primaryArtist(a).split(" ").filter(Boolean);
  const tb = primaryArtist(b).split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const bigSet = new Set(big);
  return small.every((w) => bigSet.has(w));
}

/** Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * True if two base titles are "the same song" title — tolerant of spelling variants
 * ("Daisy Dukes" ↔ "Dazzey Duks") and part-in-parens vs inline ("Whoomp" ↔ "Whoomp There It Is").
 * Only fuzzy on titles ≥6 chars — short titles ("Love" vs "Live") demand an exact match, since a
 * one-edit difference there is usually a different song. Callers gate this on same artist first, so
 * a loose match here means "same act, near-identical title" = the same record.
 */
export function titleSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 6) return false; // too short to fuzzy-match safely
  if (a.includes(b) || b.includes(a)) return true; // one is contained in the other
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.62;
}

/** True if two tracks are the same underlying song (same primary act + near-identical title). */
export function sameSong(a: Track, b: Track): boolean {
  return sameArtist(a.artist, b.artist) && titleSimilar(baseTitle(a), baseTitle(b));
}

/**
 * Collapse a scored list to one entry per song, keeping the first (best) of each group.
 * Input must already be sorted best-first. Generic over anything carrying a Track.
 *
 * Matching is fuzzy on the artist (see `sameArtist`) so differently-tagged copies of one song
 * collapse. We bucket by base title first, then only compare artists within a title bucket, so
 * the pass stays effectively linear (title buckets are tiny) instead of O(n²).
 */
export function collapseVersions<T extends { track: Track }>(sortedItems: T[]): T[] {
  // Two cheap bucketed passes cover the two ways one song shows up twice:
  //  1) same base title, differently-tagged artist ("Waka Flocka Flame" vs "Waka Flocka")
  //  2) same artist, spelling / part-in-parens title variants ("Daisy Dukes" vs "Dazzey Duks",
  //     "Whoomp There It Is" vs "Whoomp!")
  // A single exact bucket key can't catch both (the variants differ on different fields), so we run
  // both. Buckets stay small, so each pass is effectively linear.
  const byTitle = new Map<string, T[]>();
  const pass1: T[] = [];
  for (const item of sortedItems) {
    const title = baseTitle(item.track);
    const bucket = byTitle.get(title);
    if (bucket) {
      if (bucket.some((k) => sameArtist(k.track.artist, item.track.artist))) continue;
      bucket.push(item);
    } else {
      byTitle.set(title, [item]);
    }
    pass1.push(item);
  }

  const byArtist = new Map<string, Array<{ title: string }>>();
  const out: T[] = [];
  for (const item of pass1) {
    const ak = primaryArtist(item.track.artist);
    const title = baseTitle(item.track);
    const bucket = byArtist.get(ak);
    if (bucket) {
      if (bucket.some((k) => titleSimilar(k.title, title))) continue;
      bucket.push({ title });
    } else {
      byArtist.set(ak, [{ title }]);
    }
    out.push(item);
  }
  return out;
}

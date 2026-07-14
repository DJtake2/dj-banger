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

/** Reduce a title to its base song identity. */
export function normalizeTitle(title: string): string {
  let s = (title ?? "").toLowerCase();

  // Drop parenthetical / bracketed chunks that are pure edit markers, e.g. "(Intro - Dirty)".
  s = s.replace(/[([{][^)\]}]*[)\]}]/g, (m) => (isEditChunk(m) ? " " : m));

  // Drop trailing " - <edit descriptor>" segments, e.g. " - Kid Cut Up Kanye First Edit".
  const segs = s.split(/\s[-–—]\s/);
  if (segs.length > 1) {
    s = segs.filter((seg, i) => i === 0 || !isEditChunk(seg)).join(" - ");
  }

  // Remove any remaining bare edit-marker words (but not keep-markers).
  s = s.replace(editWordRe, (m) => (keepWordRe.test(s) && keepWordRe.test(m) ? m : " "));

  // Normalise punctuation/whitespace and common noise.
  s = s
    .replace(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return s;
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

/** Base song title (edit markers stripped), with an empty-safe fallback. */
export function baseTitle(t: Track): string {
  const title = normalizeTitle(t.title);
  // If title normalises to empty (all markers), fall back to raw title so we don't over-merge.
  return title || (t.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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

/** True if two tracks are the same underlying song (same base title + same primary act). */
export function sameSong(a: Track, b: Track): boolean {
  const ba = baseTitle(a);
  if (!ba || ba !== baseTitle(b)) return false;
  return sameArtist(a.artist, b.artist);
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
  const keptByTitle = new Map<string, T[]>();
  const out: T[] = [];
  for (const item of sortedItems) {
    const title = baseTitle(item.track);
    const bucket = keptByTitle.get(title);
    if (bucket) {
      if (bucket.some((k) => sameArtist(k.track.artist, item.track.artist))) continue;
      bucket.push(item);
    } else {
      keptByTitle.set(title, [item]);
    }
    out.push(item);
  }
  return out;
}

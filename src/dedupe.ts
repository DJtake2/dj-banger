/**
 * Version de-duplication.
 *
 * A DJ library is full of near-duplicates: Clean / Dirty / Intro / Acapella / Instrumental /
 * Extended Mix / Radio Edit of the *same* song. Left alone, the top suggestions become six
 * edits of one track. We collapse them by a normalised "song key" = primary artist + base
 * title, so the engine surfaces distinct songs.
 *
 * Design choice: markers that denote an EDIT of the same recording (clean/dirty/intro/edit/
 * extended/radio/…) are stripped. Markers that denote a genuinely DIFFERENT recording
 * (remix / bootleg / flip / vip / mashup / cover / live) are KEPT — a remix is a track a DJ
 * may legitimately want as a separate option, so it gets its own song key.
 */

import type { Track } from "./types.ts";

// Words that mark a same-recording edit. Stripped from the title.
const EDIT_MARKERS = [
  "clean", "dirty", "explicit", "intro", "outro", "acapella", "a cappella", "acap",
  "instrumental", "inst", "extended", "radio", "edit", "reedit", "re-edit", "redrum",
  "quick hit", "quickhit", "short", "snippet", "snip", "transition", "trans", "starter",
  "ending", "version", "ver", "mm edit", "mmedit", "dub edit", "club edit", "no tag", "notag",
  "hype", "loop", "extended mix", "radio edit", "main", "album version", "single version",
];
// Words that mark a DIFFERENT recording. Kept as part of identity.
const KEEP_MARKERS = ["remix", "bootleg", "flip", "vip", "mashup", "cover", "live", "refix"];

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

/** Stable identity for "the same song", used to collapse versions. */
export function songKey(t: Track): string {
  const cached = keyCache.get(t);
  if (cached !== undefined) return cached;
  const title = normalizeTitle(t.title);
  const artist = primaryArtist(t.artist);
  // If title normalises to empty (all markers), fall back to raw title so we don't over-merge.
  const safeTitle = title || (t.title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const key = `${artist}|${safeTitle}`;
  keyCache.set(t, key);
  return key;
}

/**
 * Collapse a scored list to one entry per song key, keeping the first (best) of each group.
 * Input must already be sorted best-first. Generic over anything carrying a Track.
 */
export function collapseVersions<T extends { track: Track }>(sortedItems: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of sortedItems) {
    const k = songKey(item.track);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

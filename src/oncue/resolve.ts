/**
 * Plan song → a file in the DJ's own library, for building tonight's crate.
 *
 * The CRM's Prep-matched file wins when it's still in the library. Otherwise the library is
 * searched by title (all the spellings titleKeys allows) with the artist agreeing; among several
 * versions a clean one is preferred (it's a wedding, usually), then the plainest title — the
 * original over the "(DJ X Remix) (Intro Edit)".
 */

import type { Track } from "../types.ts";
import { artistsOverlap, normPath, titleKeys, type PlanSongLike } from "./match.ts";

export interface LibraryIndex {
  byPath: Map<string, Track>;
  byTitle: Map<string, Track[]>;
}

export function buildLibraryIndex(pool: Track[]): LibraryIndex {
  const byPath = new Map<string, Track>();
  const byTitle = new Map<string, Track[]>();
  for (const t of pool) {
    byPath.set(normPath(t.absPath), t);
    for (const k of titleKeys(t.title, t.artist)) {
      const list = byTitle.get(k);
      if (list) list.push(t);
      else byTitle.set(k, [t]);
    }
  }
  return { byPath, byTitle };
}

const DIRTY_RE = /\b(dirty|explicit)\b/i;
const CLEAN_RE = /\bclean\b/i;

export function resolveSong(song: PlanSongLike, idx: LibraryIndex, opts: { preferClean?: boolean } = {}): { track: Track; how: "file" | "song" } | null {
  if (song.path) {
    const t = idx.byPath.get(normPath(song.path));
    if (t) return { track: t, how: "file" };
  }
  const seen = new Set<Track>();
  const cands: Track[] = [];
  for (const k of titleKeys(song.title, song.artist)) {
    for (const t of idx.byTitle.get(k) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!song.artist.trim() || artistsOverlap(t.artist, song.artist)) cands.push(t);
    }
  }
  if (!cands.length) return null;
  const preferClean = opts.preferClean ?? true;
  // Never dirty if a clean one exists; a "(Clean)" tag is a small plus; every extra
  // remix/edit bracket costs more than that, so the plain original beats the party break.
  const rank = (t: Track) => {
    const brackets = (t.title.match(/\([^)]*\)|\[[^\]]*\]/g) ?? []).filter((b) => !CLEAN_RE.test(b) && !DIRTY_RE.test(b)).length;
    const clean = preferClean ? (DIRTY_RE.test(t.title) ? 1000 : CLEAN_RE.test(t.title) ? -10 : 0) : 0;
    return clean + brackets * 15 + t.title.length;
  };
  cands.sort((a, b) => rank(a) - rank(b));
  return { track: cands[0], how: "song" };
}

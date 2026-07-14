/**
 * Shared types + helpers for streaming providers (Spotify, Apple Music, Tidal).
 * Each provider surfaces "beyond your library" discovery tracks and flags which you already own
 * (so owned tracks can borrow your library's key/BPM/energy).
 */

import type { Track } from "../types.ts";

export interface StreamingTrack {
  title: string;
  artist: string;
  /** Link out to the track on the source service (Apple/Tidal use `url`, Spotify uses spotifyUrl). */
  url?: string;
  spotifyUrl?: string;
  /** Album cover art URL (small), for the thumbnail. */
  image?: string;
  /** true if a same-title+artist track exists in the user's library. */
  owned: boolean;
  /** The matched library track (carries key/BPM/energy) when owned. */
  ownedTrack?: Track;
}

export interface Chart {
  name: string;
  tracks: StreamingTrack[];
}

export interface StreamingStatus {
  connected: boolean;
  provider: string;
  note?: string;
}

/** Loose key for matching a streaming track to a library track (ignore parens / punctuation). */
export function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildOwnedIndex(library: Track[]): Map<string, Track> {
  const idx = new Map<string, Track>();
  for (const t of library) idx.set(`${normalize(t.artist)}|${normalize(t.title)}`, t);
  return idx;
}

/** Primary artist name (drop features / collabs) for a search query. */
export function primaryArtist(artist: string): string {
  return (artist || "").split(/,|&|feat\.?|ft\.?/i)[0].trim();
}

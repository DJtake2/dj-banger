/**
 * Charts that need no account: Apple Music's US Top 50 (Apple's public marketing feed) and
 * Deezer's worldwide Top 50 (public API). Spotify closed its editorial playlists (Top 50 /
 * Viral 50) to apps like this in late 2024, so these are the dependable charts now.
 *
 * "Owned" uses On Cue's matcher (src/oncue) — title spellings, "feat." credits and version
 * tags all line up — and points at the version you'd play (clean first, plainest title).
 */

import type { Track } from "../types.ts";
import type { Chart, StreamingTrack } from "./common.ts";
import { buildLibraryIndex, resolveSong, type LibraryIndex } from "../oncue/resolve.ts";

export type ChartSource = "apple" | "deezer" | "spotify" | "tidal";
export type SourcedChart = Chart & { source: ChartSource };

const indexes = new WeakMap<Track[], LibraryIndex>();
function indexFor(library: Track[]): LibraryIndex {
  let idx = indexes.get(library);
  if (!idx) {
    idx = buildLibraryIndex(library);
    indexes.set(library, idx);
  }
  return idx;
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "follow" });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

/** Mark a chart entry as owned when the library has it. */
export function withOwnership(title: string, artist: string, library: Track[]): Pick<StreamingTrack, "owned" | "ownedTrack"> {
  const hit = resolveSong({ id: "", title, artist }, indexFor(library));
  return hit ? { owned: true, ownedTrack: hit.track } : { owned: false };
}

const bigArt = (u?: string) => (u ? u.replace("100x100bb", "300x300bb") : undefined);

export async function appleTopSongs(library: Track[], country = "us"): Promise<SourcedChart | null> {
  try {
    const d = await getJson(`https://rss.marketingtools.apple.com/api/v2/${country}/music/most-played/50/songs.json`);
    const tracks: StreamingTrack[] = (d.feed?.results ?? [])
      .filter((r: any) => r?.name && r?.artistName)
      .map((r: any) => ({ title: r.name, artist: r.artistName, url: r.url, image: bigArt(r.artworkUrl100), ...withOwnership(r.name, r.artistName, library) }));
    return tracks.length ? { name: `Apple Music · Top 50 – ${country.toUpperCase()}`, source: "apple", tracks } : null;
  } catch {
    return null;
  }
}

export async function deezerTopGlobal(library: Track[]): Promise<SourcedChart | null> {
  try {
    const d = await getJson("https://api.deezer.com/chart/0/tracks?limit=50");
    const tracks: StreamingTrack[] = (d.data ?? [])
      .filter((r: any) => r?.title && r?.artist?.name)
      .map((r: any) => ({ title: r.title, artist: r.artist.name, url: r.link, image: r.album?.cover_medium, ...withOwnership(r.title, r.artist.name, library) }));
    return tracks.length ? { name: "Deezer · Top 50 – Global", source: "deezer", tracks } : null;
  } catch {
    return null;
  }
}

/** Both public charts, in that order; whichever answered. */
export async function publicCharts(library: Track[]): Promise<SourcedChart[]> {
  const [apple, deezer] = await Promise.all([appleTopSongs(library), deezerTopGlobal(library)]);
  return [apple, deezer].filter((c): c is SourcedChart => !!c);
}

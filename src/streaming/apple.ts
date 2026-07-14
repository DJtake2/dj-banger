/**
 * Apple Music discovery — via Apple's PUBLIC, no-auth endpoints:
 *   - iTunes Search API  (https://itunes.apple.com/search) for by-artist discovery + lookup
 *   - Apple Marketing RSS (rss.applemarketingtools.com) for the current Top Songs chart
 * No developer account, no user login, no credentials. Same source we already use for album art.
 */

import type { Track } from "../types.ts";
import { normalize, buildOwnedIndex, primaryArtist, type StreamingTrack, type Chart, type StreamingStatus } from "./common.ts";

const ITUNES = "https://itunes.apple.com";
const bigArt = (u?: string) => (u ? u.replace("100x100bb", "300x300bb") : undefined);

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(6500) });
  if (!r.ok) throw new Error(`apple ${r.status}`);
  return r.json();
}

export function appleStatus(): StreamingStatus {
  return { connected: true, provider: "apple" }; // free — always available
}

/** Discovery for a seed: the seed artist's catalogue on Apple Music (top/popular songs). */
export async function appleRecommend(seed: { title: string; artist: string }, library: Track[]): Promise<StreamingTrack[]> {
  const artist = primaryArtist(seed.artist);
  if (!artist) return [];
  const owned = buildOwnedIndex(library);
  const seen = new Set<string>();
  const out: StreamingTrack[] = [];
  const seedKey = `${normalize(seed.artist)}|${normalize(seed.title)}`;
  try {
    const d = await getJson(`${ITUNES}/search?media=music&entity=song&limit=20&term=${encodeURIComponent(artist)}`);
    for (const r of d.results ?? []) {
      const title = r.trackName as string, art = r.artistName as string;
      if (!title || !art) continue;
      const key = `${normalize(art)}|${normalize(title)}`;
      if (key === seedKey || seen.has(key)) continue;
      seen.add(key);
      const ownedTrack = owned.get(key);
      out.push({ title, artist: art, url: r.trackViewUrl, image: bigArt(r.artworkUrl100), owned: !!ownedTrack, ownedTrack });
      if (out.length >= 12) break;
    }
  } catch { /* network / rate-limit — return what we have */ }
  return out;
}

/** Apple Music Top Songs (public marketing RSS). */
export async function appleCharts(library: Track[]): Promise<Chart[]> {
  const owned = buildOwnedIndex(library);
  try {
    const d = await getJson("https://rss.applemarketingtools.com/api/v2/us/music/most-played/30/songs.json");
    const tracks: StreamingTrack[] = (d.feed?.results ?? []).map((r: any) => {
      const key = `${normalize(r.artistName)}|${normalize(r.name)}`;
      const ownedTrack = owned.get(key);
      return { title: r.name, artist: r.artistName, url: r.url, image: bigArt(r.artworkUrl100), owned: !!ownedTrack, ownedTrack };
    });
    return tracks.length ? [{ name: "Apple Music · Top Songs", tracks }] : [];
  } catch {
    return [];
  }
}

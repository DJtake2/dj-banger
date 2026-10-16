/**
 * Streaming provider registry. The bridge talks to THIS module; it delegates to whichever
 * service is active (local / spotify / apple / tidal). Keeps the same function names the bridge
 * already imported so the wiring stays simple.
 */

import type { Track } from "../types.ts";
import type { StreamingTrack, Chart, StreamingStatus } from "./common.ts";
import * as spotify from "./spotify.ts";
import * as apple from "./apple.ts";
import * as tidal from "./tidal.ts";
import { publicCharts, type SourcedChart } from "./publicCharts.ts";

export type Service = "local" | "spotify" | "apple" | "tidal";
const SERVICES: Service[] = ["local", "spotify", "apple", "tidal"];

let active: Service = "spotify";

export function setActiveService(s: string): void {
  if (SERVICES.includes(s as Service)) active = s as Service;
}
export function getActiveService(): Service {
  return active;
}

export function streamingStatus(): StreamingStatus {
  switch (active) {
    case "local": return { connected: false, provider: "local", note: "Local library only" };
    case "apple": return apple.appleStatus();
    case "tidal": return tidal.tidalStatus();
    default: return spotify.streamingStatus();
  }
}

export async function streamingRecommend(seed: { title: string; artist: string; genre?: string }, library: Track[]): Promise<StreamingTrack[]> {
  switch (active) {
    case "local": return [];
    case "apple": return apple.appleRecommend(seed, library);
    case "tidal": return tidal.tidalRecommend(seed, library);
    default: return spotify.streamingRecommend(seed, library);
  }
}

/**
 * Charts for the Charts tab. The active service's own charts when it still has them, else the
 * public ones (Apple Music US Top 50 + Deezer global Top 50) — Spotify's editorial Top 50 /
 * Viral playlists are closed to apps like this since late 2024, so for most setups that's
 * the public pair. Works with no streaming account at all.
 */
export async function streamingCharts(library: Track[]): Promise<SourcedChart[]> {
  let own: SourcedChart[] = [];
  try {
    if (active === "spotify") own = (await spotify.spotifyCharts(library)).map((c: Chart) => ({ ...c, source: "spotify" as const }));
    else if (active === "tidal") own = (await tidal.tidalCharts()).map((c: Chart) => ({ ...c, source: "tidal" as const }));
  } catch { /* fall through to the public charts */ }
  return own.length ? own : publicCharts(library);
}

// Credential setters / validators are always available regardless of the active service.
export const setSpotifyCreds = spotify.setSpotifyCreds;
export const testSpotifyCreds = spotify.testSpotifyCreds;
export const setTidalCreds = tidal.setTidalCreds;
export const testTidalCreds = tidal.testTidalCreds;

/**
 * Streaming (Spotify) recommendations — the "beyond your library" section.
 *
 * ⚠️ Reality check (Nov 2024): Spotify removed the Recommendations and Audio-Features
 * endpoints for NEW apps. So for a new client we can't get true "recommendations" nor
 * key/BPM/energy from Spotify. What still works with the Client-Credentials flow (no user
 * login) is **Search** and **Artist top-tracks / related-artists**. So this module surfaces
 * *discovery* tracks (by the seed's artist + related artists) and flags which you already own
 * — genuinely useful, but without Spotify-provided key/BPM. If you have a grandfathered app
 * with recommendations access, that path is used automatically when available.
 *
 * Credentials (optional): set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET. Without them this
 * returns an empty, "not connected" result and the UI shows a Connect state.
 */

import type { Track } from "../types.ts";

// Credentials: env by default, overridable at runtime from the Settings panel.
let ID: string | undefined = process.env.SPOTIFY_CLIENT_ID;
let SECRET: string | undefined = process.env.SPOTIFY_CLIENT_SECRET;

/** Set Spotify credentials at runtime (from saved settings). Clears the cached token. */
export function setSpotifyCreds(id?: string, secret?: string): void {
  ID = id || undefined;
  SECRET = secret || undefined;
  token = null;
}

/** Validate a pair of credentials with a one-off token request (does not persist them). */
export async function testSpotifyCreds(id?: string, secret?: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!id || !secret) return { ok: false, error: "missing credentials" };
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + Buffer.from(`${id.trim()}:${secret.trim()}`).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, error: res.status === 400 || res.status === 401 ? "invalid client id/secret" : `spotify ${res.status}` };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

export interface StreamingTrack {
  title: string;
  artist: string;
  spotifyUrl?: string;
  /** true if a same-title+artist track exists in the user's library. */
  owned: boolean;
  /** The matched library track (carries key/BPM/energy) when owned — Spotify can't give a new
   *  app key/BPM, so we borrow them from your own library for tracks you already have. */
  ownedTrack?: Track;
}

export function streamingStatus(): { connected: boolean; provider: string; note?: string } {
  if (!ID || !SECRET) {
    return { connected: false, provider: "spotify", note: "Set SPOTIFY_CLIENT_ID/SECRET to enable" };
  }
  return { connected: true, provider: "spotify" };
}

// ---- token (client-credentials) -------------------------------------------
let token: { value: string; exp: number } | null = null;
async function getToken(): Promise<string | null> {
  if (!ID || !SECRET) return null;
  const now = Date.now();
  if (token && token.exp > now + 5000) return token.value;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${ID}:${SECRET}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`spotify token ${res.status}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: now + j.expires_in * 1000 };
  return token.value;
}

async function api(path: string, tok: string): Promise<any> {
  const res = await fetch("https://api.spotify.com/v1" + path, {
    headers: { authorization: "Bearer " + tok },
  });
  if (res.status === 401) {
    token = null;
    throw new Error("spotify 401");
  }
  if (!res.ok) throw new Error(`spotify ${res.status} on ${path}`);
  return res.json();
}

// ---- ownership matching against the local library --------------------------
function normalize(s: string): string {
  return s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function buildOwnedIndex(library: Track[]): Map<string, Track> {
  const idx = new Map<string, Track>();
  for (const t of library) {
    idx.set(`${normalize(t.artist)}|${normalize(t.title)}`, t);
  }
  return idx;
}

// Public Spotify-owned chart playlists (fetchable with client-credentials).
const CHART_PLAYLISTS = [
  { name: "Top 50 – USA", id: "37i9dQZEVXbLRQDuF5jeBp" },
  { name: "Top 50 – Global", id: "37i9dQZEVXbMDoHDwVN2tF" },
  { name: "Viral 50 – Global", id: "37i9dQZEVXbLiRSasKsNU9" },
];

export interface Chart {
  name: string;
  tracks: StreamingTrack[];
}

/** Fetch Spotify's editorial charts (Top 50 / Viral). [] when not connected. */
export async function spotifyCharts(library: Track[]): Promise<Chart[]> {
  const tok = await getToken();
  if (!tok) return [];
  const owned = buildOwnedIndex(library);
  const out: Chart[] = [];
  for (const chart of CHART_PLAYLISTS) {
    try {
      const data = await api(
        `/playlists/${chart.id}/tracks?limit=50&fields=${encodeURIComponent("items(track(name,artists(name),external_urls))")}`,
        tok,
      );
      const tracks: StreamingTrack[] = [];
      const seen = new Set<string>();
      for (const it of data?.items ?? []) {
        const tr = it?.track;
        if (!tr?.name) continue;
        const primary = (tr.artists?.[0]?.name as string) ?? "";
        const key = `${normalize(primary)}|${normalize(tr.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ownedTrack = owned.get(key);
        tracks.push({ title: tr.name, artist: primary, spotifyUrl: tr.external_urls?.spotify, owned: !!ownedTrack, ownedTrack });
      }
      if (tracks.length) out.push({ name: chart.name, tracks });
    } catch {
      /* a chart may be unavailable to the API — skip it */
    }
  }
  return out;
}

/**
 * Discovery tracks for a seed. Returns [] (not connected) when no creds.
 * Uses artist search → artist top-tracks + related-artists' top-tracks.
 */
export async function streamingRecommend(seed: { title: string; artist: string }, library: Track[]): Promise<StreamingTrack[]> {
  const tok = await getToken();
  if (!tok) return []; // not connected

  const owned = buildOwnedIndex(library);
  const out: StreamingTrack[] = [];
  const seenKey = new Set<string>();

  const artistName = (seed.artist || "").split(/,|&|feat\.?|ft\.?/i)[0].trim();
  if (!artistName) return [];

  // 1) find the primary artist
  const search = await api(`/search?type=artist&limit=1&q=${encodeURIComponent(artistName)}`, tok);
  const artist = search?.artists?.items?.[0];
  if (!artist) return [];

  const artistIds = [artist.id];
  // 2) related artists (may be restricted → guard)
  try {
    const rel = await api(`/artists/${artist.id}/related-artists`, tok);
    for (const a of (rel?.artists ?? []).slice(0, 4)) artistIds.push(a.id);
  } catch {
    /* related-artists may be unavailable; continue with just the seed artist */
  }

  // 3) top tracks per artist
  for (const aid of artistIds) {
    let top;
    try {
      top = await api(`/artists/${aid}/top-tracks?market=US`, tok);
    } catch {
      continue;
    }
    for (const tr of (top?.tracks ?? []).slice(0, 5)) {
      const title = tr.name as string;
      const primary = (tr.artists?.[0]?.name as string) ?? "";
      const key = `${normalize(primary)}|${normalize(title)}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      const ownedTrack = owned.get(key);
      out.push({
        title,
        artist: primary,
        spotifyUrl: tr.external_urls?.spotify,
        owned: !!ownedTrack,
        ownedTrack,
      });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

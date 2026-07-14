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
  /** Album cover art URL from Spotify (small size), for the "song pictures" thumbnail. */
  image?: string;
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
        `/playlists/${chart.id}/tracks?limit=50&fields=${encodeURIComponent("items(track(name,artists(name),external_urls,album(images)))")}`,
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
        const imgs = tr.album?.images ?? [];
        tracks.push({ title: tr.name, artist: primary, spotifyUrl: tr.external_urls?.spotify, image: (imgs[imgs.length - 1] ?? imgs[0])?.url, owned: !!ownedTrack, ownedTrack });
      }
      if (tracks.length) out.push({ name: chart.name, tracks });
    } catch {
      /* a chart may be unavailable to the API — skip it */
    }
  }
  return out;
}

/** A raw Spotify track item reduced to what we care about. */
interface Cand {
  title: string;
  primary: string;
  key: string;       // normalized artist|title identity
  artistKey: string; // normalized primary artist, for per-artist capping
  url?: string;
  image?: string;
  /** Priority tier: lower = surfaced first. 0 = related/genre (variety), 1 = seed artist. */
  tier: number;
}

/** Genre tags that carry no useful search signal (pool/label noise), so we skip genre search. */
const NOISE_GENRE = new Set(["", "other", "misc", "unknown", "club", "clean", "dirty", "explicit", "n/a", "none"]);

/** Run one Spotify track search (new apps are capped at limit=10). Returns raw items, never throws. */
async function searchTracks(term: string, tok: string): Promise<any[]> {
  try {
    const d = await api(`/search?type=track&limit=10&q=${encodeURIComponent(term)}`, tok);
    return d?.tracks?.items ?? [];
  } catch {
    return [];
  }
}

/**
 * Discovery tracks for a seed. Returns [] (not connected) when no creds.
 *
 * ⚠️ Spotify locked down top-tracks, related-artists AND recommendations for new apps (all 403/404
 * now) — only catalog **Search** works with client-credentials. A naive search on the seed's own
 * artist just returns that one artist's catalog ("same artist, different song"). To get real
 * versatility we build a small artist graph from what Search gives us:
 *   1. Search the seed artist — this yields their tracks AND the artists they collaborate with.
 *   2. Search each of those collaborators — musically-adjacent but DIFFERENT artists.
 *   3. Optionally search the seed's genre — other artists in the same lane.
 * We then cap how many tracks any single artist (especially the seed's own) can contribute and
 * interleave the artists, so the list is a spread of related acts rather than one artist repeated.
 */
export async function streamingRecommend(
  seed: { title: string; artist: string; genre?: string },
  library: Track[],
): Promise<StreamingTrack[]> {
  const tok = await getToken();
  if (!tok) return []; // not connected

  const artistName = (seed.artist || "").split(/,|&|feat\.?|ft\.?/i)[0].trim();
  if (!artistName) return [];
  const seedKey = `${normalize(seed.artist)}|${normalize(seed.title)}`;
  const seedArtistKey = normalize(artistName);

  // 1. Seed-artist search → seed tracks + the collaborators to branch out to. Rank collaborators
  // by how often they co-appear across the seed's results: a genuine frequent collaborator beats a
  // one-off credit (e.g. an event/label entity like "NFL" tagged on a single track).
  const seedItems = await searchTracks(artistName, tok);
  const nb = new Map<string, { name: string; count: number }>();
  for (const tr of seedItems) {
    for (const a of (tr.artists ?? []).slice(0, 4) as Array<{ name?: string }>) {
      const name = (a?.name || "").trim();
      const ak = normalize(name);
      if (!name || ak === seedArtistKey) continue;
      const cur = nb.get(ak);
      if (cur) cur.count++;
      else nb.set(ak, { name, count: 1 });
    }
  }
  const neighbors = [...nb.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([ak, v]) => ({ artistKey: ak, name: v.name }));

  // 2. + 3. Branch out to collaborators and (if meaningful) the seed's genre, in parallel.
  const genre = (seed.genre || "").toLowerCase().split(/[|/,]/)[0].trim();
  const genreTerm = genre && !NOISE_GENRE.has(genre) ? genre : null;
  const branchTerms = [
    ...neighbors.map((n) => ({ term: n.name, artistKey: n.artistKey })), // artist branch
    ...(genreTerm ? [{ term: genreTerm, artistKey: null as string | null }] : []), // genre branch
  ];
  const branchResults = await Promise.all(branchTerms.map((b) => searchTracks(b.term, tok)));

  // Collect candidates: seed-artist tracks in tier 1, everything else (variety) in tier 0.
  const cands: Cand[] = [];
  const seenKey = new Set<string>();
  // For an ARTIST branch, `mustCredit` = that artist's key: keep only tracks they're actually
  // credited on, so a generic title-match (searching "NFL" → NFL theme songs) is discarded. A
  // genre branch passes null → keep everything (that's the point, broad lane variety).
  const collect = (items: any[], tier: number, mustCredit: string | null) => {
    for (const tr of items) {
      const title = tr?.name as string;
      const primary = (tr?.artists?.[0]?.name as string) ?? "";
      if (!title || !primary) continue;
      if (mustCredit && !(tr.artists ?? []).some((a: { name?: string }) => normalize(a?.name || "") === mustCredit)) continue;
      const key = `${normalize(primary)}|${normalize(title)}`;
      if (key === seedKey || seenKey.has(key)) continue;
      seenKey.add(key);
      const imgs = tr.album?.images ?? [];
      cands.push({
        title,
        primary,
        key,
        artistKey: normalize(primary),
        url: tr.external_urls?.spotify,
        image: (imgs[imgs.length - 1] ?? imgs[0])?.url,
        tier: tier,
      });
    }
  };
  collect(seedItems, 1, null);
  branchResults.forEach((items, i) => collect(items, 0, branchTerms[i].artistKey));

  // Bucket by artist so we can interleave and cap. Variety (tier 0) artists come before the seed
  // artist, and each artist contributes at most PER_ARTIST_CAP tracks.
  const PER_ARTIST_CAP = 2;
  const buckets = new Map<string, Cand[]>();
  for (const c of cands) {
    const b = buckets.get(c.artistKey);
    if (b) b.push(c);
    else buckets.set(c.artistKey, [c]);
  }
  const orderedArtists = [...buckets.keys()].sort((a, b) => {
    const ta = buckets.get(a)![0].tier;
    const tb = buckets.get(b)![0].tier;
    return ta - tb; // tier 0 (variety) first, seed artist (tier 1) last
  });

  // Round-robin across artists → alternate acts instead of grouping them.
  const owned = buildOwnedIndex(library);
  const out: StreamingTrack[] = [];
  let took = true;
  for (let round = 0; round < PER_ARTIST_CAP && took && out.length < 12; round++) {
    took = false;
    for (const ak of orderedArtists) {
      if (out.length >= 12) break;
      const c = buckets.get(ak)![round];
      if (!c) continue;
      took = true;
      const ownedTrack = owned.get(c.key);
      out.push({
        title: c.title,
        artist: c.primary,
        spotifyUrl: c.url,
        image: c.image,
        owned: !!ownedTrack,
        ownedTrack,
      });
    }
  }
  return out;
}

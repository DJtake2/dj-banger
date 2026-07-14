/**
 * Tidal discovery — via the official Tidal developer API (openapi.tidal.com), client-credentials
 * flow (no user login). Requires a free Tidal developer app (developer.tidal.com) → client id +
 * secret, entered in Settings like Spotify. Catalogue search only (no personalized recs).
 *
 * NOTE: Tidal's v2 API is JSON:API-shaped; the parse below is best-effort and may need a tweak
 * once tested against a real app's credentials.
 */

import type { Track } from "../types.ts";
import { normalize, buildOwnedIndex, primaryArtist, type StreamingTrack, type Chart, type StreamingStatus } from "./common.ts";

let ID: string | undefined = process.env.TIDAL_CLIENT_ID;
let SECRET: string | undefined = process.env.TIDAL_CLIENT_SECRET;
let token: { value: string; exp: number } | null = null;

export function setTidalCreds(id?: string, secret?: string): void {
  ID = id || undefined;
  SECRET = secret || undefined;
  token = null;
}

export function tidalStatus(): StreamingStatus {
  return ID && SECRET
    ? { connected: true, provider: "tidal" }
    : { connected: false, provider: "tidal", note: "Add TIDAL developer app credentials" };
}

function authRequest(id: string, secret: string): Promise<Response> {
  return fetch("https://auth.tidal.com/v1/oauth2/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(6500),
  });
}

export async function testTidalCreds(id?: string, secret?: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!id || !secret) return { ok: false, error: "missing credentials" };
  try {
    const r = await authRequest(id.trim(), secret.trim());
    return r.ok ? { ok: true } : { ok: false, status: r.status, error: "invalid TIDAL client id/secret" };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

async function getToken(): Promise<string | null> {
  if (!ID || !SECRET) return null;
  if (token && token.exp > Date.now() + 5000) return token.value;
  const r = await authRequest(ID, SECRET);
  if (!r.ok) throw new Error(`tidal token ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

export async function tidalRecommend(seed: { title: string; artist: string }, library: Track[]): Promise<StreamingTrack[]> {
  const tok = await getToken();
  if (!tok) return [];
  const artist = primaryArtist(seed.artist);
  if (!artist) return [];
  const owned = buildOwnedIndex(library);
  try {
    const r = await fetch(
      `https://openapi.tidal.com/v2/searchResults/${encodeURIComponent(artist)}?countryCode=US&include=tracks,artists`,
      { headers: { authorization: "Bearer " + tok, accept: "application/vnd.api+json" }, signal: AbortSignal.timeout(6500) },
    );
    if (!r.ok) return [];
    const d = await r.json();
    const included: any[] = d.included ?? [];
    const artistsById = new Map<string, string>();
    for (const it of included) if (it.type === "artists") artistsById.set(it.id, it.attributes?.name);
    const seen = new Set<string>();
    const out: StreamingTrack[] = [];
    const seedKey = `${normalize(seed.artist)}|${normalize(seed.title)}`;
    for (const it of included) {
      if (it.type !== "tracks") continue;
      const title = it.attributes?.title ?? it.attributes?.name; // JSON:API field name varies
      if (!title) continue;
      const aid = it.relationships?.artists?.data?.[0]?.id;
      const art = (aid && artistsById.get(aid)) || it.attributes?.artistName || artist;
      const key = `${normalize(art)}|${normalize(title)}`;
      if (key === seedKey || seen.has(key)) continue;
      seen.add(key);
      const ownedTrack = owned.get(key);
      out.push({ title, artist: art, url: it.attributes?.externalLinks?.[0]?.href, owned: !!ownedTrack, ownedTrack });
      if (out.length >= 12) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function tidalCharts(): Promise<Chart[]> {
  return []; // Tidal charts need editorial-playlist access — not wired yet
}

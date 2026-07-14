/**
 * Artist affinity — "which artists are closely related?" — built from two library-local signals,
 * no cloud / API / subscription:
 *   1. CO-PLAY: how often the DJ mixes two artists near each other (Serato History).
 *   2. COLLABORATION: artists that appear together on a track ("A feat. B", "A x B") in the
 *      library — a precise "related artist" edge that works even for artists never yet mixed.
 * This is what lets a genre-less track still surface closely-related artists.
 */

import { parseSession, sessionsDir, type NowPlaying } from "./serato/history.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ArtistAffinity {
  /** 0..1 relatedness for two artists (0.5 = neutral/unknown, →1 = strongly related). */
  score(a?: string, b?: string): number;
  /** Number of artists with at least one edge (for logging). */
  size: number;
}

const norm = (s?: string) => (s ?? "").toLowerCase().trim();

// Split a track's artist credit into individual artists (feat./&/x/vs/with/,). Used to link
// collaborators. "x" only splits when space-padded so it doesn't break names like "Malcolm X".
const CONNECTOR_RE = /\s*[,/+&]\s*|\s+(?:feat\.?|ft\.?|featuring|with|presents|pres\.?|vs\.?|versus|b2b|x)\s+/i;
export function splitArtists(s?: string): string[] {
  const parts = norm(s).split(CONNECTOR_RE).map((a) => a.trim()).filter((a) => a.length > 1);
  return [...new Set(parts)];
}

/** An empty index: every pair is neutral. Used before the scan finishes. */
export const EMPTY_AFFINITY: ArtistAffinity = { score: () => 0.5, size: 0 };

const COLLAB_WEIGHT = 2.5; // a collaboration is a strong "related" signal

/**
 * Build the artist graph from play-history sessions + the library's collaboration credits.
 * Edges are normalized per-artist so a prolific artist doesn't dominate.
 */
export function buildArtistAffinity(
  sessionEntries: NowPlaying[][],
  library: { artist?: string }[] = [],
  window = 6,
): ArtistAffinity {
  const edges = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string, w: number) => {
    let m = edges.get(a);
    if (!m) { m = new Map(); edges.set(a, m); }
    m.set(b, (m.get(b) ?? 0) + w);
  };

  // 1. co-play proximity from history
  for (const entries of sessionEntries) {
    const artists = entries.map((e) => norm(e.artist)).filter(Boolean);
    for (let i = 0; i < artists.length; i++) {
      for (let j = i + 1; j <= i + window && j < artists.length; j++) {
        const a = artists[i], b = artists[j];
        if (a === b) continue;
        const w = 1 - (j - i - 1) / window; // adjacent → 1.0, edge of window → ~0
        bump(a, b, w); bump(b, a, w);
      }
    }
  }

  // 2. collaboration edges from the library (artists sharing a track)
  for (const t of library) {
    const arts = splitArtists(t.artist);
    if (arts.length < 2) continue;
    for (let i = 0; i < arts.length; i++) {
      for (let j = i + 1; j < arts.length; j++) {
        bump(arts[i], arts[j], COLLAB_WEIGHT); bump(arts[j], arts[i], COLLAB_WEIGHT);
      }
    }
  }

  // Per-artist max, for normalization → strongest partner scores ~1.
  const maxOut = new Map<string, number>();
  for (const [a, m] of edges) {
    let mx = 0;
    for (const w of m.values()) if (w > mx) mx = w;
    maxOut.set(a, mx || 1);
  }

  return {
    size: edges.size,
    score(a?: string, b?: string): number {
      const na = norm(a), nb = norm(b);
      if (!na || !nb || na === nb) return 0.5; // same-artist handled by sameArtistPenalty
      const w = edges.get(na)?.get(nb);
      if (!w) return 0.5; // unrelated → neutral (don't penalize, just don't boost)
      const strength = Math.min(1, w / (maxOut.get(na) ?? 1));
      return 0.5 + 0.5 * strength; // 0.5 neutral floor, up to 1.0 for the tightest pairing
    },
  };
}

/** Back-compat: history-only build. */
export const buildArtistAffinityFromSessions = (sessions: NowPlaying[][], window = 6) =>
  buildArtistAffinity(sessions, [], window);

/** Read every Serato History session + fold in library collaborations. */
export async function loadArtistAffinity(library: { artist?: string }[] = [], seratoDir?: string, window = 6): Promise<ArtistAffinity> {
  const dir = sessionsDir(seratoDir);
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".session")); } catch { /* no history */ }
  const sessions: NowPlaying[][] = [];
  for (const f of files) {
    try { sessions.push(await parseSession(join(dir, f))); } catch { /* skip unreadable */ }
  }
  return buildArtistAffinity(sessions, library, window);
}

/**
 * Deezer artist-similarity — the "cultural association" signal.
 *
 * The reference Banger Button brain leads with WHO an artist sits next to (Camila Cabello →
 * Taylor Swift / Dua Lipa / Selena Gomez), not with harmonic key. Deezer's public
 * `/artist/{id}/related` reproduces that neighborhood for free (no API key), and `nb_fan` gives a
 * popularity proxy. We warm the seed artist's related set on demand, cache it to disk, and expose a
 * synchronous `score()` the engine's artistAffinity can blend in.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { primaryArtist } from "./dedupe.ts";

const norm = (a?: string): string => primaryArtist(a ?? "");

export class DeezerSimilarity {
  /** primary-artist key -> set of related primary-artist keys. */
  related = new Map<string, Set<string>>();
  /** primary-artist key -> Deezer fan count (popularity proxy). */
  fans = new Map<string, number>();
  private inflight = new Map<string, Promise<boolean>>();
  private path = "";

  /** Load a persisted cache (from disk or a bundled seed). Merges — never clobbers what's loaded. */
  async load(path: string): Promise<this> {
    this.path = path;
    try {
      const j = JSON.parse(await readFile(path, "utf8")) as Record<string, { related: string[]; fans?: number }>;
      for (const [k, v] of Object.entries(j)) {
        if (!this.related.has(k)) this.related.set(k, new Set(v.related));
        if (v.fans != null) this.fans.set(k, v.fans);
      }
    } catch {
      /* no cache yet */
    }
    return this;
  }

  async save(): Promise<void> {
    if (!this.path) return;
    try {
      const o: Record<string, { related: string[]; fans: number }> = {};
      for (const [k, set] of this.related) o[k] = { related: [...set], fans: this.fans.get(k) ?? 0 };
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(o));
    } catch {
      /* best effort */
    }
  }

  get size(): number {
    return this.related.size;
  }

  /** True once we've resolved (successfully or not) this artist's neighborhood. */
  knows(artist?: string): boolean {
    return this.related.has(norm(artist));
  }

  /**
   * Synchronous affinity 0..1 for the scorer: 1 for the same act, ~0.92 when the candidate is a
   * Deezer-related artist of the seed, else 0 (= "no signal", so the engine falls back to its
   * play-history affinity). Returns 0 when the seed artist hasn't been warmed yet.
   */
  score(seedArtist?: string, candArtist?: string): number {
    const s = norm(seedArtist);
    const c = norm(candArtist);
    if (!s || !c) return 0;
    const rel = this.related.get(s);
    if (!rel) return 0;
    if (s === c) return 1;
    return rel.has(c) ? 0.92 : 0;
  }

  /**
   * Fetch + cache the seed artist's related set. Deduplicates concurrent warms, negatively caches
   * misses (empty set) so we don't re-hit Deezer every pass. Returns true if new data was added.
   */
  async warm(artist?: string): Promise<boolean> {
    const key = norm(artist);
    if (!key || this.related.has(key)) return false;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const s = (await fetch(`https://api.deezer.com/search/artist?q=${encodeURIComponent(key)}&limit=1`).then((r) => r.json())) as {
          data?: Array<{ id?: number; nb_fan?: number }>;
        };
        const a = s?.data?.[0];
        if (a?.id) {
          const rel = (await fetch(`https://api.deezer.com/artist/${a.id}/related?limit=25`).then((r) => r.json())) as {
            data?: Array<{ name?: string }>;
          };
          this.related.set(key, new Set((rel?.data ?? []).map((x) => norm(x.name)).filter(Boolean)));
          this.fans.set(key, a.nb_fan ?? 0);
        } else {
          this.related.set(key, new Set()); // negative cache
        }
        return true;
      } catch {
        this.related.set(key, new Set()); // negative cache on error too
        return false;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

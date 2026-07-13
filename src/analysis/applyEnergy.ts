/**
 * Glue between the energy cache and the engine's Track model.
 *  - applyCachedEnergy: upgrade tracks in place with real audio energy where we have it.
 *  - analyzeLibrary:    fill the cache by running ffmpeg over uncached tracks (bounded pool).
 */

import { existsSync } from "node:fs";
import type { Track } from "../types.ts";
import { analyzeFile, energyFromFeatures } from "./analyze.ts";
import { EnergyStore } from "./energyStore.ts";

/** Overwrite proxy energy with real audio energy for any track present in the store. */
export function applyCachedEnergy(tracks: Track[], store: EnergyStore): number {
  let applied = 0;
  for (const t of tracks) {
    const f = store.peek(t.absPath);
    if (!f) continue;
    t.energy = energyFromFeatures(f, t.bpm);
    if (t.raw) t.raw.energySource = "audio";
    applied++;
  }
  return applied;
}

export interface AnalyzeProgress {
  done: number;
  total: number;
  path: string;
  ok: boolean;
}

export interface AnalyzeResult {
  analyzed: number;
  failed: number;
  skippedCached: number;
  missing: number;
}

/**
 * Analyze tracks that aren't already cached, with a bounded concurrency pool.
 * Saves the cache incrementally so a long run is crash-safe / resumable.
 */
export async function analyzeLibrary(
  tracks: Track[],
  store: EnergyStore,
  opts: {
    concurrency?: number;
    limit?: number;
    onProgress?: (p: AnalyzeProgress) => void;
    saveEvery?: number;
  } = {},
): Promise<AnalyzeResult> {
  const concurrency = opts.concurrency ?? 8;
  const saveEvery = opts.saveEvery ?? 100;
  const res: AnalyzeResult = { analyzed: 0, failed: 0, skippedCached: 0, missing: 0 };

  // Build the work list: uncached, existing files.
  const work: Track[] = [];
  for (const t of tracks) {
    if (opts.limit && work.length >= opts.limit) break;
    if (await store.get(t.absPath)) {
      res.skippedCached++;
      continue;
    }
    if (!existsSync(t.absPath)) {
      res.missing++;
      continue;
    }
    work.push(t);
  }

  const total = work.length;
  let done = 0;
  let sinceSave = 0;
  let idx = 0;

  async function worker() {
    while (idx < work.length) {
      const t = work[idx++];
      const f = await analyzeFile(t.absPath);
      done++;
      if (f) {
        await store.set(t.absPath, f);
        res.analyzed++;
        if (++sinceSave >= saveEvery) {
          sinceSave = 0;
          await store.save();
        }
      } else {
        res.failed++;
      }
      opts.onProgress?.({ done, total, path: t.absPath, ok: !!f });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, worker));
  await store.save();
  return res;
}

/**
 * Persistent cache of audio-analysed energy features.
 *
 * Analysis is the slow part (~0.1–0.35s/track via ffmpeg), so we do it once and remember it.
 * Cache lives in the PROJECT dir (~/dj-banger/.cache/energy.json) — never inside Serato.
 * Keyed by absolute path; validated by file size + mtime so a re-encode/re-tag re-analyses.
 *
 * We store the raw features (not the final 1..10) so energy can be recomputed if BPM changes
 * or the mapping is tuned, without re-running ffmpeg.
 */

import { readFile, writeFile, mkdir, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioFeatures } from "./analyze.ts";

export interface CacheEntry extends AudioFeatures {
  size: number;
  mtimeMs: number;
}

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_PATH = join(PROJECT_ROOT, ".cache", "energy.json");

export class EnergyStore {
  private map = new Map<string, CacheEntry>();
  private dirty = false;
  private path: string;

  constructor(path = CACHE_PATH) {
    this.path = path;
  }

  async load(): Promise<this> {
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, CacheEntry>;
        this.map = new Map(Object.entries(raw));
      } catch {
        /* corrupt cache → start fresh */
      }
    }
    return this;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(dirname(this.path), { recursive: true });
    const obj = Object.fromEntries(this.map);
    const tmp = this.path + ".tmp";
    await writeFile(tmp, JSON.stringify(obj));
    await rename(tmp, this.path);
    this.dirty = false;
  }

  /** Fresh cached features for a file, or null if absent/stale. */
  async get(absPath: string): Promise<AudioFeatures | null> {
    const e = this.map.get(absPath);
    if (!e) return null;
    try {
      const s = await stat(absPath);
      if (s.size !== e.size || Math.abs(s.mtimeMs - e.mtimeMs) > 1) return null; // stale
    } catch {
      return null; // file gone
    }
    return e;
  }

  /** Synchronous lookup without freshness check (for hot paths after a load). */
  peek(absPath: string): AudioFeatures | null {
    return this.map.get(absPath) ?? null;
  }

  async set(absPath: string, f: AudioFeatures): Promise<void> {
    let size = 0;
    let mtimeMs = 0;
    try {
      const s = await stat(absPath);
      size = s.size;
      mtimeMs = s.mtimeMs;
    } catch {
      /* ignore */
    }
    this.map.set(absPath, { ...f, size, mtimeMs });
    this.dirty = true;
  }

  get size(): number {
    return this.map.size;
  }
}

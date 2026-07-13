/**
 * Phase 2 — the live loop.
 *
 * Load the library once, then watch Serato's History for track changes. On every new
 * now-playing track, run the engine and (optionally) publish a "Banger Suggestions" crate.
 *
 * Detection uses fs.watch on the Sessions dir (FSEvents on macOS → ~ms latency) with a slow
 * poll as a safety net. All the heavy work (library load) happens once at startup; each loop
 * iteration only parses the tiny newest session file + scores the in-memory pool.
 */

import { watch } from "node:fs";
import type { Track, Suggestion, EngineConfig } from "./types.ts";
import { loadLibrary, defaultSeratoDir } from "./serato/library.ts";
import { getNowPlaying, sessionsDir, type NowPlaying } from "./serato/history.ts";
import { recommend } from "./engine.ts";
import { writeSuggestionsCrate } from "./serato/crateWriter.ts";
import { EnergyStore } from "./analysis/energyStore.ts";
import { applyCachedEnergy } from "./analysis/applyEnergy.ts";
import { analyzeFile, energyFromFeatures } from "./analysis/analyze.ts";

export interface LiveEvent {
  nowPlaying: NowPlaying;
  /** The matched library track (full metadata), if the played file is in the library. */
  seed?: Track;
  suggestions: Suggestion[];
  /** ms from detecting the change to suggestions ready (excludes Serato's own write delay). */
  computeMs: number;
  cratePath?: string;
}

export interface LiveOptions {
  seratoDir?: string;
  /** Engine tuning passed through to recommend(). */
  config?: Partial<EngineConfig>;
  /** Also publish a Serato crate each change. Default true. */
  writeCrate?: boolean;
  crateName?: string;
  /** Debounce for rapid successive writes (ms). Default 75. The loop is idempotent
   *  (dedupes by track id), so a short debounce is safe — an early fire that reads the
   *  same last entry is a harmless no-op, and the real change fires another event. */
  debounceMs?: number;
  /** Safety-net poll interval (ms). Default 2000. */
  pollMs?: number;
  /** Analyze the currently-playing track's real energy on the fly (~0.3s). Default true. */
  analyzeSeedLive?: boolean;
  /** Optional candidate filter (energy/genre etc.). Read fresh each pass so it can change. */
  candidateFilter?: (t: Track) => boolean;
  /** Called on every new track. */
  onEvent: (e: LiveEvent) => void;
  /** Optional logger. */
  log?: (msg: string) => void;
}

export interface LiveHandle {
  stop: () => void;
  /** Force a re-evaluation now (e.g. for a manual refresh). Deduped: same track = no-op. */
  poke: () => Promise<void>;
  /** Recompute for the current track even if it hasn't changed (e.g. after a config change). */
  rerun: () => Promise<void>;
  /** Number of tracks loaded. */
  librarySize: number;
  /** Warm-up engine timing measured at startup (ms over the full pool). */
  warmupMs: number;
  /** The loaded library, for manual-seed / prep-mode features. */
  pool: Track[];
}

/** Start the live loop. Resolves once the library is loaded and watching has begun. */
export async function startLiveLoop(opts: LiveOptions): Promise<LiveHandle> {
  const seratoDir = opts.seratoDir ?? defaultSeratoDir();
  const writeCrate = opts.writeCrate ?? true;
  const debounceMs = opts.debounceMs ?? 75;
  const pollMs = opts.pollMs ?? 2000;
  const analyzeSeedLive = opts.analyzeSeedLive ?? true;
  const log = opts.log ?? (() => {});

  log(`Loading library from ${seratoDir} …`);
  const t0 = Date.now();
  const pool = await loadLibrary(seratoDir);
  const byId = new Map<string, Track>();
  for (const t of pool) byId.set(t.id, t);
  log(`Loaded ${pool.length} tracks in ${Date.now() - t0}ms`);

  // Upgrade proxy energy with any real audio-analysed energy we've cached before.
  const store = await new EnergyStore().load();
  const upgraded = applyCachedEnergy(pool, store);
  log(`Real audio energy for ${upgraded}/${pool.length} tracks (cache: ${store.size})`);

  // Warm-up: measure a real engine pass so we can report loop compute cost.
  const warmSeed = pool.find((t) => t.key && t.bpm) ?? pool[0];
  const w0 = performance.now();
  recommend({ seed: warmSeed }, pool, opts.config);
  const warmupMs = performance.now() - w0;
  log(`Engine warm-up: ${warmupMs.toFixed(1)}ms over ${pool.length} tracks`);

  let lastSeedId: string | null = null;
  let running = false;
  let pending = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  async function evaluate() {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const np = await getNowPlaying(seratoDir);
      if (!np) return;
      if (np.id === lastSeedId) return; // same track, nothing to do
      lastSeedId = np.id;

      const seed = byId.get(np.id) ?? nowPlayingToTrack(np);

      // Ensure the currently-playing track has REAL energy (analyze once, cache forever).
      if (analyzeSeedLive && seed.raw?.energySource !== "audio") {
        const cached = store.peek(seed.absPath);
        const feats = cached ?? (await analyzeFile(seed.absPath));
        if (feats) {
          seed.energy = energyFromFeatures(feats, seed.bpm);
          if (seed.raw) seed.raw.energySource = "audio";
          if (!cached) {
            await store.set(seed.absPath, feats);
            void store.save();
          }
        }
      }

      const c0 = performance.now();
      const cands = opts.candidateFilter ? pool.filter(opts.candidateFilter) : pool;
      const suggestions = recommend({ seed }, cands, opts.config);
      const computeMs = performance.now() - c0;

      let cratePath: string | undefined;
      if (writeCrate) {
        try {
          cratePath = await writeSuggestionsCrate(
            suggestions.map((s) => s.track),
            { seratoDir, name: opts.crateName },
          );
        } catch (e) {
          log(`crate write failed: ${(e as Error).message}`);
        }
      }

      opts.onEvent({ nowPlaying: np, seed: byId.get(np.id), suggestions, computeMs, cratePath });
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void evaluate();
      }
    }
  }

  function schedule() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void evaluate(), debounceMs);
  }

  // Watch the Sessions dir for writes.
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(sessionsDir(seratoDir), { persistent: true }, () => schedule());
  } catch (e) {
    log(`fs.watch unavailable (${(e as Error).message}); relying on polling`);
  }

  // Safety-net poll (also covers new session files / missed events).
  const poll = setInterval(() => void evaluate(), pollMs);

  // Evaluate once immediately so we show a suggestion for whatever's already loaded.
  await evaluate();

  return {
    stop() {
      watcher?.close();
      clearInterval(poll);
      if (debounceTimer) clearTimeout(debounceTimer);
    },
    poke: evaluate,
    rerun() {
      lastSeedId = null; // clear the dedupe so the same track recomputes
      return evaluate();
    },
    librarySize: pool.length,
    warmupMs,
    pool,
  };
}

/** Fallback: build a minimal Track from history metadata when the file isn't in the library. */
function nowPlayingToTrack(np: NowPlaying): Track {
  return {
    id: np.id,
    absPath: np.absPath,
    title: np.title ?? np.absPath.split("/").pop() ?? np.id,
    artist: np.artist ?? "",
    genre: np.genre,
  };
}

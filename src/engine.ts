/**
 * The recommendation engine — the "Banger Button" core.
 *
 * Pure and deterministic: given a seed track + a candidate pool + config, it returns a
 * ranked, explained list of what to play next. No I/O, no Serato specifics. This is the
 * piece you'd reuse unchanged behind any DJ software.
 */

import type { Track, EngineConfig, Suggestion, MixContext } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { keyCompatibility, keyRelation } from "./camelot.ts";
import { songKey, collapseVersions } from "./dedupe.ts";

/** Score BPM proximity 0..1, honouring tolerance and optional half/double-time. */
export function bpmScore(seedBpm: number | undefined, candBpm: number | undefined, cfg: EngineConfig): {
  score: number;
  effectiveDiff: number | null;
  note: string;
} {
  if (!seedBpm || !candBpm) return { score: 0.3, effectiveDiff: null, note: "BPM unknown" };

  // Consider the candidate at 1x, and (optionally) 2x / 0.5x so 140 can mix with 70.
  const variants: Array<{ bpm: number; label: string }> = [{ bpm: candBpm, label: "" }];
  if (cfg.allowHalfDouble) {
    variants.push({ bpm: candBpm * 2, label: " (2x)" }, { bpm: candBpm / 2, label: " (½x)" });
  }

  let best = { score: 0, diff: Infinity, note: "" };
  const tolAbs = (cfg.bpmTolerancePct / 100) * seedBpm;
  for (const v of variants) {
    const diff = v.bpm - seedBpm;
    const abs = Math.abs(diff);
    // Linear falloff: 0 diff => 1.0, at tolerance => ~0.5, beyond => decays toward 0.
    const s = 1 / (1 + Math.pow(abs / Math.max(tolAbs, 1), 2));
    if (s > best.score) {
      const sign = diff > 0 ? "+" : "";
      best = { score: s, diff: abs, note: `${sign}${diff.toFixed(1)} BPM${v.label}` };
    }
  }
  return { score: best.score, effectiveDiff: best.diff, note: best.note };
}

/** Score energy match 0..1, biased by the DJ's chosen trajectory. */
export function energyScore(seedE: number | undefined, candE: number | undefined, cfg: EngineConfig): {
  score: number;
  note: string;
} {
  if (seedE == null || candE == null) return { score: 0.4, note: "Energy unknown" };
  const delta = candE - seedE;

  // Base: closeness. A delta of 0 is 1.0, each step away costs ~0.18.
  let score = Math.max(0, 1 - Math.abs(delta) * 0.18);

  // Trajectory bias: reward moves in the intended direction, softly.
  if (cfg.energyDirection === "build" && delta > 0) score = Math.min(1, score + 0.12 * Math.min(delta, 2));
  if (cfg.energyDirection === "cool" && delta < 0) score = Math.min(1, score + 0.12 * Math.min(-delta, 2));
  // Penalise wrong-direction jumps when a direction is set.
  if (cfg.energyDirection === "build" && delta < -1) score *= 0.7;
  if (cfg.energyDirection === "cool" && delta > 1) score *= 0.7;

  const sign = delta > 0 ? "+" : "";
  const note = delta === 0 ? "Same energy" : `Energy ${sign}${delta}`;
  return { score, note };
}

/** Genre affinity 0..1 — exact match, shared token, or unrelated. */
export function genreScore(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0.5;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  const ta = new Set(na.split(/[\s/&,-]+/).filter(Boolean));
  const tb = nb.split(/[\s/&,-]+/).filter(Boolean);
  return tb.some((t) => ta.has(t)) ? 0.75 : 0.35;
}

/**
 * Rank the pool against the seed. Returns the top `cfg.limit` suggestions, each with a
 * per-dimension breakdown and short human reasons.
 */
export function recommend(
  ctx: MixContext,
  pool: Track[],
  config: Partial<EngineConfig> = {},
): Suggestion[] {
  const cfg: EngineConfig = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_CONFIG.weights, ...config.weights } };
  const { seed } = ctx;
  const played = ctx.playedIds ?? new Set<string>();
  const wsum = cfg.weights.key + cfg.weights.bpm + cfg.weights.energy + cfg.weights.genre || 1;
  const seedSong = cfg.excludeSeedVersions ? songKey(seed) : null;

  const out: Suggestion[] = [];
  for (const t of pool) {
    if (t.id === seed.id) continue;
    if (played.has(t.id)) continue;
    if (ctx.candidatePoolIds && !ctx.candidatePoolIds.has(t.id)) continue;
    // Skip other edits of the song that's already playing.
    if (seedSong && songKey(t) === seedSong) continue;

    const kScore = keyCompatibility(seed.key, t.key);
    const b = bpmScore(seed.bpm, t.bpm, cfg);
    const e = energyScore(seed.energy, t.energy, cfg);
    const gScore = genreScore(seed.genre, t.genre);

    let score =
      (cfg.weights.key * kScore +
        cfg.weights.bpm * b.score +
        cfg.weights.energy * e.score +
        cfg.weights.genre * gScore) /
      wsum;

    // Soft penalty for repeating the seed's artist (avoid three Drake tracks in a row).
    if (cfg.sameArtistPenalty > 0 && t.artist && seed.artist && t.artist.toLowerCase() === seed.artist.toLowerCase()) {
      score *= 1 - cfg.sameArtistPenalty;
    }

    const reasons = [keyRelation(seed.key, t.key), b.note, e.note];
    if (gScore === 1 && t.genre) reasons.push(t.genre);

    out.push({
      track: t,
      score,
      breakdown: { key: kScore, bpm: b.score, energy: e.score, genre: gScore },
      reasons,
    });
  }

  out.sort((x, y) => y.score - x.score);
  const ranked = cfg.dedupeVersions ? collapseVersions(out) : out;
  return ranked.slice(0, cfg.limit);
}

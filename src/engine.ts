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
import { sameSong } from "./dedupe.ts";

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

  // The trajectory decides what "good energy" means, strongly enough to visibly reorder picks:
  //   flat  → closest energy wins    build → higher energy wins    cool → lower energy wins
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  let score: number;
  if (cfg.energyDirection === "build") score = clamp01(0.5 + 0.25 * delta);      // +2 → 1.0, −2 → 0
  else if (cfg.energyDirection === "cool") score = clamp01(0.5 - 0.25 * delta);  // −2 → 1.0, +2 → 0
  else score = Math.max(0, 1 - Math.abs(delta) * 0.18);                          // flat: closeness

  const sign = delta > 0 ? "+" : "";
  const note = delta === 0 ? "Same energy" : `Energy ${sign}${delta}`;
  return { score, note };
}

// Families of genres DJs treat as adjacent. Two genres in the same cluster are "closely
// related" even when they share no word (e.g. "Hip Hop" ↔ "Rap", "House" ↔ "Techno").
const GENRE_CLUSTERS: string[][] = [
  ["hip hop", "hiphop", "rap", "trap", "drill", "grime"],
  ["r&b", "rnb", "r and b", "soul", "neo soul", "funk"],
  ["house", "tech house", "deep house", "progressive house", "electro house", "future house", "bass house", "afro house"],
  ["techno", "minimal", "tech", "electro"],
  ["trance", "psytrance", "hardstyle"],
  ["dubstep", "riddim", "bass", "drum and bass", "dnb", "d&b", "jungle", "breaks"],
  ["edm", "dance", "big room", "future bass", "electropop"],
  ["pop", "dance pop", "indie pop"],
  ["reggaeton", "latin", "dembow", "moombahton", "salsa", "bachata", "regional mexican", "mexican",
    "corrido", "corridos", "corridos tumbados", "sierreño", "sierreno", "banda", "cumbia", "merengue",
    "mariachi", "ranchera", "norteño", "norteno", "vallenato", "bolero", "tejano", "latin pop",
    "latin trap", "urbano", "urbano latino", "flamenco", "español", "espanol", "spanish"],
  ["afrobeats", "afrobeat", "amapiano"],
  ["disco", "nu-disco", "nu disco", "boogie"],
  ["reggae", "dancehall", "soca"],
];
const GENRE_CLUSTER_OF = new Map<string, number>();
GENRE_CLUSTERS.forEach((c, i) => c.forEach((g) => GENRE_CLUSTER_OF.set(g, i)));

/** Genre affinity 0..1 — exact match, same family, shared word, or unrelated. */
export function genreScore(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0.5; // unknown genre → neutral, never penalised
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  // Same curated family (handles sub-genres and synonyms across different words).
  const ca = GENRE_CLUSTER_OF.get(na);
  const cb = GENRE_CLUSTER_OF.get(nb);
  if (ca != null && ca === cb) return 0.85;
  // Shared word (e.g. "Deep House" ↔ "Bass House" both have "house").
  const ta = new Set(na.split(/[\s/&,-]+/).filter(Boolean));
  const tb = nb.split(/[\s/&,-]+/).filter(Boolean);
  if (tb.some((t) => ta.has(t))) return 0.8;
  return 0.3; // different style → soft down-rank
}

// Spanish/Latin detection — from genre tags OR Spanish orthography (ñ, ¿¡, accented vowels). Lets a
// Spanish song keep suggesting Spanish music even when genre tags are missing or inconsistent, while
// still allowing variety across Latin sub-genres. Extensible to other locales later.
const LATIN_GENRE_RE = /regg?aeton|latin|bachata|salsa|merengue|cumbia|banda|corrido|mexican|dembow|mariachi|ranchera|norte|vallenato|bolero|tejano|urbano|flamenco|espa|spanish|sierre/i;
const SPANISH_ORTHO_RE = /[ñ¿¡]/i;
export function trackLocale(t: { genre?: string; title?: string; artist?: string }): string {
  if (LATIN_GENRE_RE.test(t.genre || "")) return "es";
  if (SPANISH_ORTHO_RE.test(`${t.title || ""} ${t.artist || ""}`)) return "es";
  return "";
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
  // When the seed has NO genre tag, we can't score genre — shift that weight onto artist affinity
  // (closely-related artists) so a genre-less track still gets a strongly-related next pick.
  const w = { ...cfg.weights };
  if (!seed.genre) { w.artist += w.genre; w.genre = 0; }
  const wsum = w.key + w.bpm + w.energy + w.genre + w.artist || 1;
  const seedLocale = trackLocale(seed); // e.g. "es" → keep suggesting same-language music

  const out: Suggestion[] = [];
  for (const t of pool) {
    if (t.id === seed.id) continue;
    if (played.has(t.id)) continue;
    if (ctx.candidatePoolIds && !ctx.candidatePoolIds.has(t.id)) continue;
    // Skip other edits of the song that's already playing.
    if (cfg.excludeSeedVersions && sameSong(seed, t)) continue;

    const kScore = keyCompatibility(seed.key, t.key);
    const b = bpmScore(seed.bpm, t.bpm, cfg);
    const e = energyScore(seed.energy, t.energy, cfg);
    let gScore = genreScore(seed.genre, t.genre);
    // Same-language boost: a Spanish seed should keep surfacing Spanish music (across Latin
    // sub-genres) even when genre tags differ. Only boosts a match — never penalizes unknowns.
    if (seedLocale && trackLocale(t) === seedLocale) gScore = Math.max(gScore, 0.9);
    // Artist affinity: do the seed's and candidate's artists get mixed together? Neutral (0.5)
    // when no scorer is wired or the pair has never been played near each other.
    const aScore = cfg.artistAffinity ? cfg.artistAffinity(seed.artist, t.artist) : 0.5;

    let score =
      (w.key * kScore +
        w.bpm * b.score +
        w.energy * e.score +
        w.genre * gScore +
        w.artist * aScore) /
      wsum;

    // "Stay in the lane" — the reference app strongly favors the same genre-family / language, so
    // a related pick leads even over a key/BPM-perfect track from a different style. gScore already
    // folds in genre-family + Spanish-locale; a strongly-related ARTIST also counts as in-lane.
    // Multiplier: in-lane → up to ×1.30, off-lane (different style) → down to ~×0.55.
    const lane = Math.max(gScore, aScore >= 0.75 ? aScore : 0);
    score *= 0.55 + 0.75 * lane;

    // World popularity (Deezer global rank, 0..1) — a big factor, like the reference API: a
    // crowd-pleasing hit outranks a deep cut when both fit. Neutral (no effect) when unknown.
    const pop = typeof t.popularity === "number" ? t.popularity : 0.5;
    score *= 0.78 + 0.44 * pop; // pop 1 → ×1.22, unknown → ×1.0, obscure → ×0.78

    // Soft penalty for repeating the seed's artist (avoid three Drake tracks in a row).
    if (cfg.sameArtistPenalty > 0 && t.artist && seed.artist && t.artist.toLowerCase() === seed.artist.toLowerCase()) {
      score *= 1 - cfg.sameArtistPenalty;
    }

    const reasons = [keyRelation(seed.key, t.key), b.note, e.note];
    if (gScore >= 0.8 && t.genre) reasons.push(t.genre);
    // Flag a strong artist connection (you regularly mix these two together).
    if (aScore >= 0.7 && t.artist && seed.artist && t.artist.toLowerCase() !== seed.artist.toLowerCase()) {
      reasons.push(`Pairs with ${seed.artist}`);
    }

    out.push({
      track: t,
      score,
      breakdown: { key: kScore, bpm: b.score, energy: e.score, genre: gScore, artist: aScore },
      reasons,
    });
  }

  out.sort((x, y) => y.score - x.score);
  // Collapse duplicates + apply the quality floor + cap, all in ONE best-first pass that STOPS as
  // soon as it has `limit` distinct picks. Deduping the full scored pool (70k) with fuzzy title
  // matching was O(n²) per artist and cost seconds; we only ever show `limit`, so we never need to
  // look past the top handful of distinct songs. Sorted desc → once a score drops below the floor,
  // everything after it does too, so we break.
  const floor = out.length ? out[0].score * cfg.minScoreRatio : 0;
  const kept: Suggestion[] = [];
  for (const item of out) {
    if (item.score < floor) break;
    if (cfg.dedupeVersions && kept.some((k) => sameSong(k.track, item.track))) continue;
    kept.push(item);
    if (kept.length >= cfg.limit) break;
  }
  return kept;
}

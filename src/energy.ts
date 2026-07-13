/**
 * Energy derivation.
 *
 * Serato has NO native energy field. In practice energy 1..10 lives in tags written by
 * other tools — this is the single biggest data-quality question for a Banger Button clone:
 *   - Mixed In Key writes "Energy 7" (or "7A - Energy 8 ...") into the COMMENT.
 *   - Lexicon can write an "Energy" value into a comment/grouping field.
 *   - Some DJs put a bare "8" in the grouping column.
 *
 * We try to read a real value first; only if nothing is found do we fall back to a rough
 * proxy from BPM + genre so the engine still has *something* to rank on. `derived` tells the
 * caller which happened, so the UI can show "estimated" vs "tagged" energy.
 */

export interface EnergyResult {
  value: number; // 1..10
  derived: boolean; // true = proxy/estimate, false = read from a tag
  source: string; // where it came from, for debugging
}

const ENERGY_PATTERNS: RegExp[] = [
  /energy\s*[:=]?\s*(\d{1,2})/i, // "Energy 7", "energy: 8"
  /\bE(\d{1,2})\b/, // "E8"
  /-\s*Energy\s*(\d{1,2})/i, // MIK "8A - Energy 7 - ..."
];

/** Try to read a tagged energy value from free-text fields (comment, grouping, ...). */
export function readTaggedEnergy(fields: Array<string | undefined>): EnergyResult | null {
  for (const f of fields) {
    if (!f) continue;
    for (const re of ENERGY_PATTERNS) {
      const m = re.exec(f);
      if (m) {
        const v = clamp(Number(m[1]), 1, 10);
        if (v >= 1 && v <= 10) return { value: v, derived: false, source: `tag:"${m[0]}"` };
      }
    }
    // Bare standalone number 1..10 in a short grouping field like "8".
    const bare = /^\s*(\d{1,2})\s*$/.exec(f);
    if (bare) {
      const v = Number(bare[1]);
      if (v >= 1 && v <= 10) return { value: v, derived: false, source: "tag:bare" };
    }
  }
  return null;
}

/**
 * Rough proxy energy when nothing is tagged. NOT a real analysis — just a monotonic-ish
 * mapping so faster/harder genres rank hotter than slow ones. Clearly flagged as derived.
 * (The "real" upgrade path is offline audio analysis — see OPTIONS.md.)
 */
export function proxyEnergy(bpm: number | undefined, genre: string | undefined): EnergyResult {
  let e = 5;
  if (bpm) {
    // Map ~70..150 BPM onto ~3..9.
    e = clamp(Math.round(3 + ((bpm - 70) / 80) * 6), 1, 10);
  }
  const g = (genre ?? "").toLowerCase();
  if (/(hard|techno|dubstep|drum|trap|bass|festival|electro)/.test(g)) e = clamp(e + 1, 1, 10);
  if (/(ambient|chill|lofi|lo-fi|down|ballad|soul|r&b|rnb|acoustic)/.test(g)) e = clamp(e - 1, 1, 10);
  return { value: e, derived: true, source: "proxy:bpm+genre" };
}

/** Full resolution: tagged first, proxy fallback. */
export function resolveEnergy(
  fields: Array<string | undefined>,
  bpm: number | undefined,
  genre: string | undefined,
): EnergyResult {
  return readTaggedEnergy(fields) ?? proxyEnergy(bpm, genre);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

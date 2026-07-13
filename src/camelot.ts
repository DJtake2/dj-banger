/**
 * Key parsing + Camelot-wheel harmonic compatibility.
 *
 * Serato stores whatever the tagging tool wrote into `tkey`. In the wild that's one of:
 *   - Camelot:      "8A", "12B"
 *   - Open Key:     "1m", "8d"     (Mixed In Key notation; d=major, m=minor)
 *   - Musical:      "Am", "F#m", "Cmaj", "Gbmin", "C#", "F"
 * We normalise all of them to a CanonicalKey, then score pairs on the Camelot wheel.
 */

import type { CanonicalKey } from "./types.ts";

// Pitch classes: C=0 .. B=11
const NOTE_TO_PC: Record<string, number> = {
  C: 0, "C#": 1, DB: 1, D: 2, "D#": 3, EB: 3, E: 4, FB: 4,
  F: 5, "F#": 6, GB: 6, G: 7, "G#": 8, AB: 8, A: 9, "A#": 10, BB: 10, B: 11, CB: 11,
};

// Camelot number for a given pitch class, per mode (from the standard wheel).
const MINOR_PC_TO_NUM: Record<number, number> = {
  9: 8, 4: 9, 11: 10, 6: 11, 1: 12, 8: 1, 3: 2, 10: 3, 5: 4, 0: 5, 7: 6, 2: 7,
};
const MAJOR_PC_TO_NUM: Record<number, number> = {
  11: 1, 6: 2, 1: 3, 8: 4, 3: 5, 10: 6, 5: 7, 0: 8, 7: 9, 2: 10, 9: 11, 4: 12,
};

// Reverse maps for building a canonical key from a Camelot code.
const NUM_TO_MINOR_PC: Record<number, number> = invert(MINOR_PC_TO_NUM);
const NUM_TO_MAJOR_PC: Record<number, number> = invert(MAJOR_PC_TO_NUM);

const PC_TO_LABEL = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function invert(m: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(m)) out[v] = Number(k);
  return out;
}

function build(pitchClass: number, mode: "major" | "minor"): CanonicalKey {
  const camelotNumber = mode === "minor" ? MINOR_PC_TO_NUM[pitchClass] : MAJOR_PC_TO_NUM[pitchClass];
  const camelotLetter = mode === "minor" ? "A" : "B";
  const label = PC_TO_LABEL[pitchClass] + (mode === "minor" ? "m" : "");
  return { pitchClass, mode, camelotNumber, camelotLetter, camelot: `${camelotNumber}${camelotLetter}`, label };
}

function fromCamelot(num: number, letter: "A" | "B"): CanonicalKey {
  const mode = letter === "A" ? "minor" : "major";
  const pc = letter === "A" ? NUM_TO_MINOR_PC[num] : NUM_TO_MAJOR_PC[num];
  return build(pc, mode);
}

/**
 * Parse an arbitrary key string into a CanonicalKey, or null if unrecognisable.
 * Order matters: Camelot (digit+A/B) → Open Key (digit+d/m) → musical note.
 */
export function parseKey(raw: string | undefined | null): CanonicalKey | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // 1) Camelot: "8A", "12 B", "08a"
  let m = /^(\d{1,2})\s*([ABab])$/.exec(s);
  if (m) {
    const num = Number(m[1]);
    if (num >= 1 && num <= 12) return fromCamelot(num, m[2].toUpperCase() as "A" | "B");
  }

  // 2) Open Key (Mixed In Key): "1m".."12m" minor, "1d".."12d" major.
  //    OpenKey n  <->  Camelot ((n + 6) % 12) + 1, same A/B via d=B, m=A.
  m = /^(\d{1,2})\s*([dmDM])$/.exec(s);
  if (m) {
    const ok = Number(m[1]);
    if (ok >= 1 && ok <= 12) {
      const camNum = ((ok + 6) % 12) + 1;
      const letter = m[2].toLowerCase() === "d" ? "B" : "A";
      return fromCamelot(camNum, letter);
    }
  }

  // 3) Musical: note + optional accidental + optional quality.
  m = /^([A-Ga-g])\s*([#b♯♭]?)\s*(maj(?:or)?|min(?:or)?|m|M|-|\+)?$/.exec(s);
  if (m) {
    let note = m[1].toUpperCase();
    const acc = m[2].replace("♯", "#").replace("♭", "b");
    if (acc) note += acc.toUpperCase() === "#" ? "#" : "B"; // "Bb" -> key "BB"
    const pc = NOTE_TO_PC[note];
    if (pc === undefined) return null;
    const q = (m[3] ?? "").toLowerCase();
    // default to major when no quality given (standard convention)
    const mode: "major" | "minor" = q === "m" || q.startsWith("min") || q === "-" ? "minor" : "major";
    return build(pc, mode);
  }

  return null;
}

/**
 * Harmonic compatibility of two keys, 0..1, based on Camelot-wheel relationships.
 * 1.00 same key · 0.90 ±1 same letter (adjacent) · 0.85 relative maj/min
 * 0.70 +2 same letter (energy boost) · 0.55 diagonal · else falls off.
 */
export function keyCompatibility(a: CanonicalKey | undefined, b: CanonicalKey | undefined): number {
  if (!a || !b) return 0.3; // unknown key: neutral-low, don't hard-exclude
  if (a.camelot === b.camelot) return 1.0;

  const sameLetter = a.camelotLetter === b.camelotLetter;
  const dNum = circularDist(a.camelotNumber, b.camelotNumber, 12);

  // Relative major/minor: same number, different letter.
  if (a.camelotNumber === b.camelotNumber && !sameLetter) return 0.85;

  if (sameLetter) {
    if (dNum === 1) return 0.9;   // adjacent hour — the bread-and-butter mix
    if (dNum === 2) return 0.7;   // "energy boost" (+2 semitones-ish jump)
    if (dNum === 7 % 12) return 0.6;
  } else {
    // Diagonal moves (one hour + switch letter) are usable, weaker.
    if (dNum === 1) return 0.55;
  }
  // Everything else: dissonant. Small non-zero so BPM/energy can still surface it.
  return 0.15;
}

function circularDist(a: number, b: number, mod: number): number {
  const d = Math.abs(a - b) % mod;
  return Math.min(d, mod - d);
}

/** Short human label for the key relationship, for the "why this?" explainer. */
export function keyRelation(a: CanonicalKey | undefined, b: CanonicalKey | undefined): string {
  if (!a || !b) return "Key unknown";
  if (a.camelot === b.camelot) return `Perfect key (${b.camelot})`;
  if (a.camelotNumber === b.camelotNumber) return `Relative ${b.mode} (${b.camelot})`;
  const sameLetter = a.camelotLetter === b.camelotLetter;
  const dNum = circularDist(a.camelotNumber, b.camelotNumber, 12);
  if (sameLetter && dNum === 1) return `Adjacent key (${b.camelot})`;
  if (sameLetter && dNum === 2) return `Energy boost (${b.camelot})`;
  return `Key ${b.camelot}`;
}

export { fromCamelot };

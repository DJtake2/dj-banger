/**
 * Real, audio-derived energy via ffmpeg.
 *
 * Serato has no energy field and the user's library has ~0% tagged, so we measure it from the
 * audio itself: EBU R128 integrated loudness (LUFS) + loudness range + peak/RMS (→ crest /
 * dynamics). Combined with BPM this is a genuine "how hyped is this track" estimate — far
 * better than the BPM-only proxy — and it runs fully offline (~0.1–0.35s/track).
 *
 * Calibrated against the user's own library:
 *   Give It Up (128bpm, club)  ≈ -8..-11 LUFS  → hot
 *   Blessings  (60bpm, hip-hop)≈ -9.9  LUFS    → mid
 *   Theraflu   (80bpm, R&B)    ≈ -14.4 LUFS    → low
 *
 * (Upgrade path: add spectral centroid / onset-rate for a fuller MIR energy — see OPTIONS §5.)
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface AudioFeatures {
  lufs: number; // integrated loudness (EBU R128), e.g. -9.9
  lra: number; // loudness range (LU)
  rmsDb: number; // overall RMS level (dB)
  peakDb: number; // overall peak level (dB)
  crest: number; // peakDb - rmsDb (low = compressed/loud, high = dynamic)
}

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function num(re: RegExp, text: string): number | null {
  const m = re.exec(text);
  return m ? parseFloat(m[1]) : null;
}

/** Parse ffmpeg's ebur128 + astats summary from stderr text. Exposed for testing. */
export function parseFfmpegStats(stderr: string): AudioFeatures | null {
  // The Summary block prints these once at the end (indented, no leading "t:").
  const lufs = num(/Integrated loudness:[\s\S]*?I:\s*(-?[\d.]+)\s*LUFS/i, stderr);
  const lra = num(/Loudness range:[\s\S]*?LRA:\s*(-?[\d.]+)\s*LU/i, stderr);
  const rmsDb = num(/RMS level dB:\s*(-?[\d.]+)/i, stderr);
  const peakDb = num(/Peak level dB:\s*(-?[\d.]+)/i, stderr);
  if (lufs == null && rmsDb == null) return null;
  const rms = rmsDb ?? lufs ?? -12;
  const peak = peakDb ?? 0;
  return {
    lufs: lufs ?? rms,
    lra: lra ?? 0,
    rmsDb: rms,
    peakDb: peak,
    crest: peak - rms,
  };
}

/** Run ffmpeg on a file and return its audio features, or null if unavailable/unreadable. */
export function analyzeFile(absPath: string): Promise<AudioFeatures | null> {
  if (!existsSync(absPath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = [
      "-hide_banner", "-nostats", "-i", absPath,
      "-af", "ebur128,astats=metadata=0:measure_perchannel=none",
      "-f", "null", "-",
    ];
    const proc = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", () => resolve(null)); // ffmpeg missing
    proc.on("close", () => resolve(parseFfmpegStats(err)));
  });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map audio features (+ optional BPM) to energy 1..10.
 * Loudness dominates, tempo modulates, dynamics (crest) nudges: compressed/loud → hotter.
 */
export function energyFromFeatures(f: AudioFeatures, bpm?: number): number {
  // Loudness: -16 LUFS (quiet/dynamic) → 0, -6 LUFS (hot master) → 1.
  const loud = clamp((f.lufs + 16) / 10, 0, 1);
  // Punch: crest 14dB (dynamic) → 0, 4dB (squashed/loud) → 1.
  const punch = clamp((14 - f.crest) / 10, 0, 1);
  // Tempo: 65bpm → 0, 140bpm → 1 (only if known).
  const tempo = bpm ? clamp((bpm - 65) / 75, 0, 1) : null;

  let value: number;
  if (tempo == null) {
    value = 0.75 * loud + 0.25 * punch;
  } else {
    value = 0.5 * loud + 0.35 * tempo + 0.15 * punch;
  }
  return clamp(Math.round(1 + value * 9), 1, 10);
}

/** Convenience: analyze a file straight to an energy value (or null). */
export async function energyForFile(absPath: string, bpm?: number): Promise<number | null> {
  const f = await analyzeFile(absPath);
  return f ? energyFromFeatures(f, bpm) : null;
}

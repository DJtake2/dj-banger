/**
 * Core domain types for the recommendation engine.
 * These are intentionally decoupled from Serato — the engine only ever sees `Track`,
 * so a rekordbox/Traktor/VirtualDJ loader could feed the exact same engine later.
 */

/** A parsed, engine-ready track. All the fields the scorer actually cares about. */
export interface Track {
  /** Stable unique id. For Serato this is the volume-relative file path. */
  id: string;
  /** Absolute filesystem path (best effort), for drag-and-drop / playback. */
  absPath: string;
  title: string;
  artist: string;
  album?: string;
  genre?: string;
  /** Beats per minute, if known. */
  bpm?: number;
  /** Canonical musical key, or undefined if unparseable. */
  key?: CanonicalKey;
  /** Energy 1..10 if we could derive it, else undefined. */
  energy?: number;
  /** Track length in seconds, if known. */
  lengthSec?: number;
  year?: number;
  /** Raw source fields kept for debugging / future features. */
  raw?: Record<string, string | number>;
}

/** Musical key reduced to pitch-class (0=C..11=B) + mode. */
export interface CanonicalKey {
  /** 0..11, C=0. */
  pitchClass: number;
  mode: "major" | "minor";
  /** Camelot number 1..12 (A=minor, B=major). */
  camelotNumber: number;
  camelotLetter: "A" | "B";
  /** e.g. "8A", "12B". */
  camelot: string;
  /** Human label, e.g. "Am", "C", "F#m". */
  label: string;
}

/** Tunable weights + tolerances for the scorer. */
export interface EngineConfig {
  weights: {
    key: number;
    bpm: number;
    energy: number;
    genre: number;
  };
  /** Max BPM difference (percent of seed BPM) still considered mixable. Default 6. */
  bpmTolerancePct: number;
  /** Allow half/double-time matches (e.g. 140 <-> 70). Default true. */
  allowHalfDouble: boolean;
  /** Preferred energy trajectory across the set. */
  energyDirection: "flat" | "build" | "cool";
  /** Penalise repeating the same artist within this many suggestions worth of history. */
  sameArtistPenalty: number;
  /** Collapse near-duplicate versions (Clean/Dirty/Intro/Extended…) to one per song. Default true. */
  dedupeVersions: boolean;
  /** Exclude other edits of the seed's own song from suggestions. Default true. */
  excludeSeedVersions: boolean;
  /** How many suggestions to return. */
  limit: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  weights: { key: 0.4, bpm: 0.3, energy: 0.2, genre: 0.1 },
  bpmTolerancePct: 6,
  allowHalfDouble: true,
  energyDirection: "flat",
  sameArtistPenalty: 0.15,
  dedupeVersions: true,
  excludeSeedVersions: true,
  limit: 12,
};

/** One scored candidate returned to the UI. */
export interface Suggestion {
  track: Track;
  /** 0..1 overall. */
  score: number;
  /** Per-dimension 0..1 sub-scores, for the "why this?" explainer. */
  breakdown: {
    key: number;
    bpm: number;
    energy: number;
    genre: number;
  };
  /** Short human reasons, e.g. ["Perfect key (8A)", "+2 BPM", "Energy +1"]. */
  reasons: string[];
}

/** State the engine needs about the live set (what's playing, what's been played). */
export interface MixContext {
  /** The track currently playing / just dropped — the seed. */
  seed: Track;
  /** ids of tracks already played this session (excluded + inform artist penalty). */
  playedIds?: Set<string>;
  /** Optional: restrict candidates to this id set (e.g. a specific crate). */
  candidatePoolIds?: Set<string>;
}

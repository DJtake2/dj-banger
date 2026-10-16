/**
 * When this DJ last played each track, and how often — from Serato's History sessions. Powers
 * Missing Gems ("tracks you own that fit, ones you haven't played in a long time") and keeps
 * tonight's plays out of suggestions. Only entries Serato counted as PLAYED count; a track that
 * was merely loaded and swapped away doesn't.
 */
import type { NowPlaying } from "./serato/history.ts";

export interface PlayIndex {
  /** Unix seconds of the most recent play, or undefined if never played. */
  last(id: string): number | undefined;
  count(id: string): number;
  /** A play seen live (keeps the index current without re-reading history). */
  record(id: string, at: number): void;
  /** Ids played since `sinceSec`. */
  playedSince(sinceSec: number): Set<string>;
  size: number;
}

export function buildPlayIndex(sessions: NowPlaying[][]): PlayIndex {
  const last = new Map<string, number>();
  const count = new Map<string, number>();
  const record = (id: string, at: number) => {
    if (!id) return;
    if (at > (last.get(id) ?? 0)) last.set(id, at);
    count.set(id, (count.get(id) ?? 0) + 1);
  };
  for (const entries of sessions) for (const e of entries) if (e.played !== false && e.startTime) record(e.id, e.startTime);
  return {
    last: (id) => last.get(id),
    count: (id) => count.get(id) ?? 0,
    record,
    playedSince(sinceSec) {
      const out = new Set<string>();
      for (const [id, at] of last) if (at >= sinceSec) out.add(id);
      return out;
    },
    get size() { return last.size; },
  };
}

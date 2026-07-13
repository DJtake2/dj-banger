/**
 * Phase 3 tests: version de-dupe + audio energy (parsing/mapping, no ffmpeg needed).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle, primaryArtist, songKey, collapseVersions } from "../src/dedupe.ts";
import { parseFfmpegStats, energyFromFeatures } from "../src/analysis/analyze.ts";
import { recommend } from "../src/engine.ts";
import { parseKey } from "../src/camelot.ts";
import type { Track } from "../src/types.ts";

// ---- title normalisation ----------------------------------------------------
test("normalizeTitle strips edit markers", () => {
  const base = normalizeTitle("Blessings");
  assert.equal(normalizeTitle("Blessings (Intro - Dirty)"), base);
  assert.equal(normalizeTitle("Blessings (Clean)"), base);
  assert.equal(normalizeTitle("Blessings (Extended Mix)"), base);
  assert.equal(normalizeTitle("Blessings - Quick Hit Edit"), base);
});

test("normalizeTitle keeps remix/bootleg as distinct identity", () => {
  assert.notEqual(normalizeTitle("Blessings Remix"), normalizeTitle("Blessings"));
  assert.notEqual(normalizeTitle("Song (Joel Corry Bootleg)"), normalizeTitle("Song"));
});

test("primaryArtist drops features/collabs", () => {
  assert.equal(primaryArtist("Big Sean ft. Drake"), primaryArtist("Big Sean ft. Drake & Kanye West"));
  assert.equal(primaryArtist("Calvin Harris & Dua Lipa"), "calvin harris");
});

test("songKey groups versions, separates remixes", () => {
  const mk = (title: string, artist = "Big Sean ft. Drake"): Track => ({ id: title, absPath: "/" + title, title, artist });
  const k1 = songKey(mk("Blessings (Intro - Dirty)"));
  const k2 = songKey(mk("Blessings (Clean)"));
  const k3 = songKey(mk("Blessings Remix (Dirty)", "Big Sean ft. Drake & Kanye West"));
  assert.equal(k1, k2); // same song, different edits
  assert.notEqual(k1, k3); // remix is its own thing
});

test("collapseVersions keeps best (first) per song", () => {
  const mk = (id: string, title: string): { track: Track; score: number } => ({
    track: { id, absPath: "/" + id, title, artist: "A" },
    score: 1,
  });
  const items = [mk("a1", "Song (Clean)"), mk("a2", "Song (Dirty)"), mk("b", "Other")];
  const kept = collapseVersions(items);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].track.id, "a1"); // first of the group survives
});

// ---- engine de-dupe end to end ---------------------------------------------
test("recommend de-dupes versions and excludes the seed's own song", () => {
  const mk = (id: string, title: string, key = "8A", bpm = 128): Track => ({
    id, absPath: "/" + id, title, artist: "A", key: parseKey(key) ?? undefined, bpm, energy: 6,
  });
  const seed = mk("seed", "Blessings (Intro - Dirty)");
  const pool = [
    mk("v1", "Nightcall (Clean)"),
    mk("v2", "Nightcall (Dirty)"), // dup of v1 → collapsed
    mk("v3", "Nightcall (Extended Mix)"), // dup → collapsed
    mk("other", "Midnight City"),
    mk("seedver", "Blessings (Clean)"), // same song as seed → excluded
  ];
  const res = recommend({ seed }, pool);
  const ids = res.map((r) => r.track.id);
  assert.ok(!ids.includes("seedver"), "seed's own other edit excluded");
  // only one Nightcall survives
  assert.equal(ids.filter((i) => ["v1", "v2", "v3"].includes(i)).length, 1);
  assert.ok(ids.includes("other"));
});

test("recommend dedupeVersions:false leaves versions in", () => {
  const mk = (id: string, title: string): Track => ({
    id, absPath: "/" + id, title, artist: "A", key: parseKey("8A")!, bpm: 128, energy: 6,
  });
  const seed = mk("seed", "Seed Song");
  const pool = [mk("v1", "Nightcall (Clean)"), mk("v2", "Nightcall (Dirty)")];
  const res = recommend({ seed }, pool, { dedupeVersions: false, excludeSeedVersions: false });
  assert.equal(res.length, 2);
});

// ---- audio energy -----------------------------------------------------------
const SAMPLE_FFMPEG_OUTPUT = `
[Parsed_ebur128_0 @ 0x0] Summary:

  Integrated loudness:
    I:          -9.9 LUFS
    Threshold:  -20.0 LUFS

  Loudness range:
    LRA:         6.9 LU

[Parsed_astats_0 @ 0x0] Peak level dB: 1.249460
[Parsed_astats_0 @ 0x0] RMS level dB: -10.506196
`;

test("parseFfmpegStats extracts loudness/rms/peak", () => {
  const f = parseFfmpegStats(SAMPLE_FFMPEG_OUTPUT);
  assert.ok(f);
  assert.equal(f!.lufs, -9.9);
  assert.equal(f!.lra, 6.9);
  assert.ok(Math.abs(f!.rmsDb - -10.51) < 0.1);
  assert.ok(Math.abs(f!.peakDb - 1.25) < 0.1);
  assert.ok(f!.crest > 11 && f!.crest < 12); // 1.25 - (-10.5)
});

test("parseFfmpegStats returns null on garbage", () => {
  assert.equal(parseFfmpegStats("no audio stats here"), null);
});

test("energyFromFeatures: louder+faster => hotter, ordering sane", () => {
  const hot = energyFromFeatures({ lufs: -7, lra: 3, rmsDb: -8, peakDb: 0, crest: 8 }, 128);
  const mid = energyFromFeatures({ lufs: -9.9, lra: 6.9, rmsDb: -10.5, peakDb: 1.2, crest: 11.7 }, 60);
  const low = energyFromFeatures({ lufs: -14.4, lra: 7, rmsDb: -15, peakDb: -1, crest: 14 }, 80);
  assert.ok(hot > mid, `hot(${hot}) > mid(${mid})`);
  assert.ok(mid >= low, `mid(${mid}) >= low(${low})`);
  assert.ok(hot >= 1 && hot <= 10 && low >= 1 && low <= 10);
});

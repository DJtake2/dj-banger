/**
 * Pure unit tests — no Serato, no disk. Run: npm test  (node --test)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseKey, keyCompatibility } from "../src/camelot.ts";
import { readTaggedEnergy, proxyEnergy } from "../src/energy.ts";
import { bpmScore, energyScore, recommend } from "../src/engine.ts";
import { DEFAULT_CONFIG, type Track } from "../src/types.ts";

// ---- key parsing ------------------------------------------------------------
test("parseKey: camelot", () => {
  assert.equal(parseKey("8A")?.camelot, "8A");
  assert.equal(parseKey("12B")?.camelot, "12B");
  assert.equal(parseKey("08a")?.camelot, "8A");
});

test("parseKey: musical notation maps to correct camelot", () => {
  assert.equal(parseKey("Am")?.camelot, "8A"); // A minor = 8A
  assert.equal(parseKey("C")?.camelot, "8B"); // C major = 8B
  assert.equal(parseKey("F#m")?.camelot, "11A");
  assert.equal(parseKey("Gbm")?.camelot, "11A"); // enharmonic with F#m
  assert.equal(parseKey("Bbmaj")?.camelot, "6B");
  assert.equal(parseKey("Cmin")?.camelot, "5A");
});

test("parseKey: open key notation (Mixed In Key)", () => {
  assert.equal(parseKey("1d")?.camelot, "8B"); // OpenKey 1d = Camelot 8B
  assert.equal(parseKey("1m")?.camelot, "8A");
  assert.equal(parseKey("6d")?.camelot, "1B");
});

test("parseKey: junk returns null", () => {
  assert.equal(parseKey("banana"), null);
  assert.equal(parseKey(""), null);
  assert.equal(parseKey(undefined), null);
});

// ---- key compatibility ------------------------------------------------------
test("keyCompatibility: harmonic relationships ranked correctly", () => {
  const a = parseKey("8A")!;
  assert.equal(keyCompatibility(a, parseKey("8A")!), 1.0); // same
  assert.equal(keyCompatibility(a, parseKey("9A")!), 0.9); // adjacent
  assert.equal(keyCompatibility(a, parseKey("7A")!), 0.9); // adjacent other way
  assert.equal(keyCompatibility(a, parseKey("8B")!), 0.85); // relative major
  assert.ok(keyCompatibility(a, parseKey("2A")!) < 0.3); // clash (tritone-ish)
});

// ---- bpm --------------------------------------------------------------------
test("bpmScore: closer is better; half/double recognised", () => {
  const exact = bpmScore(128, 128, DEFAULT_CONFIG).score;
  const near = bpmScore(128, 130, DEFAULT_CONFIG).score;
  const far = bpmScore(128, 145, DEFAULT_CONFIG).score;
  assert.ok(exact > near && near > far);

  const dbl = bpmScore(140, 70, DEFAULT_CONFIG); // 70 at 2x = 140
  assert.ok(dbl.score > 0.9, `expected half/double match, got ${dbl.score}`);
  assert.match(dbl.note, /2x/);
});

// ---- energy -----------------------------------------------------------------
test("readTaggedEnergy: pulls energy from comments", () => {
  assert.equal(readTaggedEnergy(["Energy 7"])?.value, 7);
  assert.equal(readTaggedEnergy(["8A - Energy 9 - Mixed In Key"])?.value, 9);
  assert.equal(readTaggedEnergy(["E5"])?.value, 5);
  assert.equal(readTaggedEnergy(["8"])?.value, 8); // bare grouping value
  assert.equal(readTaggedEnergy(["just a note"]), null);
});

test("proxyEnergy: monotonic-ish in BPM, flagged derived", () => {
  const slow = proxyEnergy(80, undefined);
  const fast = proxyEnergy(140, undefined);
  assert.ok(fast.value > slow.value);
  assert.equal(fast.derived, true);
});

test("energyScore: build direction rewards going up", () => {
  const up = energyScore(5, 7, { ...DEFAULT_CONFIG, energyDirection: "build" }).score;
  const down = energyScore(5, 3, { ...DEFAULT_CONFIG, energyDirection: "build" }).score;
  assert.ok(up > down);
});

// ---- end-to-end ranking -----------------------------------------------------
function mk(id: string, key: string, bpm: number, energy: number, artist = "x"): Track {
  return { id, absPath: "/" + id, title: id, artist, bpm, energy, key: parseKey(key) ?? undefined };
}

test("recommend: perfect harmonic+tempo match ranks first", () => {
  const seed = mk("seed", "8A", 128, 6);
  const pool = [
    mk("clash", "2A", 128, 6), // key clash
    mk("perfect", "8A", 128, 6), // ideal
    mk("adjacent", "9A", 129, 6), // strong
    mk("wrongtempo", "8A", 150, 6), // right key, off tempo
  ];
  const res = recommend({ seed }, pool, { minScoreRatio: 0 }); // test pure ranking, keep all picks
  assert.equal(res[0].track.id, "perfect");
  assert.equal(res[res.length - 1].track.id, "clash");
});

test("recommend: excludes seed and played tracks", () => {
  const seed = mk("seed", "8A", 128, 6);
  const pool = [seed, mk("a", "8A", 128, 6), mk("b", "9A", 128, 6)];
  const res = recommend({ seed, playedIds: new Set(["a"]) }, pool);
  const ids = res.map((r) => r.track.id);
  assert.ok(!ids.includes("seed"));
  assert.ok(!ids.includes("a"));
  assert.ok(ids.includes("b"));
});

test("recommend: same-artist penalty applies", () => {
  const seed = mk("seed", "8A", 128, 6, "Drake");
  const sameArtist = mk("same", "8A", 128, 6, "Drake");
  const other = mk("other", "8A", 128, 6, "Other");
  const res = recommend({ seed }, [sameArtist, other]);
  assert.equal(res[0].track.id, "other"); // penalty pushes same-artist down
});

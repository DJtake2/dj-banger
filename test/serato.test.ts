/**
 * Serato I/O tests: crate write round-trips through the reader, history path normalisation,
 * and (if a real Serato library is present) a live smoke test of now-playing detection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCrate } from "../src/serato/crateWriter.ts";
import { parseRecords, crateTrackPaths } from "../src/serato/parser.ts";
import { normalizeHistoryPath, getNowPlaying, newestSession, getDecks } from "../src/serato/history.ts";
import { defaultSeratoDir } from "../src/serato/library.ts";

// --- minimal Serato session encoder, for the getDecks ordering test ------------
function encodeField(fid: number, value: string | number): Buffer {
  const payload = typeof value === "number"
    ? (() => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return b; })()
    : Buffer.from(value, "utf16le").swap16(); // utf-16be
  const head = Buffer.alloc(8);
  head.writeUInt32BE(fid, 0);
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}
function encodeEntry(fields: Record<number, string | number>): Buffer {
  const adat = Buffer.concat(Object.entries(fields).map(([f, v]) => encodeField(Number(f), v)));
  const wrap = (tag: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(tag, 0, "latin1");
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  return wrap("oent", wrap("adat", adat));
}

test("encodeCrate round-trips through parseRecords", () => {
  const paths = [
    "Users/dj/Music/Track One.mp3",
    "Users/dj/Music/Track Two (Clean).mp3",
    "Users/dj/Downloads/Ünïcodé Tráck.mp3",
  ];
  const buf = encodeCrate(paths);
  const recs = parseRecords(buf);
  // version header present
  assert.equal(recs[0].tag, "vrsn");
  assert.match(recs[0].text ?? "", /Serato ScratchLive Crate/);
  // all track paths survive the write→read cycle
  assert.deepEqual(crateTrackPaths(recs), paths);
});

test("encodeCrate strips leading slash to volume-relative", () => {
  const buf = encodeCrate(["/Users/dj/Music/A.mp3"]);
  assert.deepEqual(crateTrackPaths(parseRecords(buf)), ["Users/dj/Music/A.mp3"]);
});

test("normalizeHistoryPath drops one leading slash", () => {
  assert.equal(normalizeHistoryPath("/Users/dj/x.mp3"), "Users/dj/x.mp3");
  assert.equal(normalizeHistoryPath("Users/dj/x.mp3"), "Users/dj/x.mp3");
});

// Regression: Serato re-writes finished entries in place, so file byte-order puts a stale track
// last. getDecks must pick the currently-loaded track by play start time (field 28) / still-playing
// (no field 29), not by file order — otherwise the launch shows the wrong now-playing until a new
// track is loaded.
test("getDecks picks now-playing by start time, not file order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "banger-hist-"));
  const sessions = join(dir, "History", "Sessions");
  await mkdir(sessions, { recursive: true });
  const buf = Buffer.concat([
    // deck 1's CURRENT track (still playing), but written earlier in the file
    encodeEntry({ 2: "/m/current.mp3", 6: "Current", 7: "A", 31: 1, 28: 300 }),
    // deck 2's current track (still playing)
    encodeEntry({ 2: "/m/deck2.mp3", 6: "Deck2", 7: "B", 31: 2, 28: 250 }),
    // deck 1's STALE finished track, re-written last (latest in file, older start, has end time)
    encodeEntry({ 2: "/m/stale.mp3", 6: "Stale", 7: "A", 31: 1, 28: 100, 29: 150 }),
  ]);
  await writeFile(join(sessions, "1.session"), buf);

  const state = await getDecks(dir);
  assert.equal(state.decks[1].title, "Current", "deck 1 = latest-started, not last-in-file");
  assert.equal(state.decks[2].title, "Deck2");
  assert.equal(state.activeDeck, 1, "active = most-recently-started overall (300 > 250)");
});

// Integration smoke test — only runs on a machine with a real Serato library.
const hasSerato = existsSync(defaultSeratoDir());
test("live: getNowPlaying returns a plausible track", { skip: !hasSerato }, async () => {
  const session = await newestSession();
  if (!session) return; // no sessions yet — nothing to assert
  const np = await getNowPlaying();
  assert.ok(np, "expected a now-playing entry");
  assert.ok(np!.absPath.length > 0);
  assert.equal(normalizeHistoryPath(np!.absPath), np!.id);
});

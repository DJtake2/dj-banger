/**
 * Serato I/O tests: crate write round-trips through the reader, history path normalisation,
 * and (if a real Serato library is present) a live smoke test of now-playing detection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { encodeCrate } from "../src/serato/crateWriter.ts";
import { parseRecords, crateTrackPaths } from "../src/serato/parser.ts";
import { normalizeHistoryPath, getNowPlaying, newestSession } from "../src/serato/history.ts";
import { defaultSeratoDir } from "../src/serato/library.ts";

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

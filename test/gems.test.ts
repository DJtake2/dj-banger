/**
 * Missing Gems: the vibe modes, the familiarity target, and "not played in ages".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseKey } from "../src/camelot.ts";
import { recommend } from "../src/engine.ts";
import { buildPlayIndex } from "../src/playIndex.ts";
import type { Track } from "../src/types.ts";

const tk = (id: string, genre: string, extra: Partial<Track> = {}): Track => ({
  id, absPath: `/m/${id}.mp3`, title: id, artist: `Artist ${id}`, genre, bpm: 100, key: parseKey("8A")!, energy: 6, ...extra,
});
const seed = tk("seed", "Hip Hop", { year: 2018 });
const pool = [
  tk("rap1", "Rap"), tk("rap2", "Hip Hop"), tk("rap3", "Trap"),
  tk("disco1", "Disco", { year: 1979 }), tk("house1", "House"), tk("pop1", "Pop", { popularity: 0.95 }),
];
const ids = (xs: { track: Track }[]) => xs.map((x) => x.track.id);
const cfg = { minScoreRatio: 0, limit: 6 };

test("same vibe stays in the lane; switch it up leaves it", () => {
  const same = ids(recommend({ seed }, pool, cfg));
  assert.ok(["rap1", "rap2", "rap3"].includes(same[0]), `same vibe leads in-lane, got ${same}`);
  const sw = ids(recommend({ seed }, pool, { ...cfg, vibe: "switch" }));
  assert.ok(!["rap1", "rap2", "rap3"].includes(sw[0]), `switch it up leads with another style, got ${sw}`);
});

test("curveball: other era, other style, and the room knows it", () => {
  const cb = ids(recommend({ seed }, pool, { ...cfg, vibe: "curveball" }));
  assert.ok(["disco1", "pop1"].includes(cb[0]), `got ${cb}`);
});

test("familiarity: deep cuts vs hits", () => {
  const p = [tk("hit", "Hip Hop", { popularity: 0.95 }), tk("deep", "Hip Hop", { popularity: 0.05 })];
  assert.equal(ids(recommend({ seed }, p, { ...cfg, familiarity: 1 }))[0], "hit");
  assert.equal(ids(recommend({ seed }, p, { ...cfg, familiarity: 0 }))[0], "deep");
});

test("gems: unplayed-in-ages beats played last week, with a reason", () => {
  const now = 2_000_000_000;
  const idx = buildPlayIndex([[
    { id: "recent", absPath: "", startTime: now - 3 * 86400, played: true, sessionFile: "", entryIndex: 0 },
    { id: "old", absPath: "", startTime: now - 800 * 86400, played: true, sessionFile: "", entryIndex: 1 },
    { id: "loadedOnly", absPath: "", startTime: now - 3 * 86400, played: false, sessionFile: "", entryIndex: 2 },
  ]]);
  assert.equal(idx.last("loadedOnly"), undefined, "a load that never played doesn't count");
  const p = [tk("recent", "Hip Hop"), tk("old", "Hip Hop")];
  const out = recommend({ seed }, p, { ...cfg, gems: true, lastPlayed: (t) => idx.last(t.id), nowSec: now });
  assert.equal(out[0].track.id, "old");
  assert.ok(out[0].reasons.includes("Not played in 2y"));
  assert.deepEqual([...idx.playedSince(now - 7 * 86400)], ["recent"]);
});

test("tonight's plays are skipped", () => {
  const out = ids(recommend({ seed, playedIds: new Set(["rap1"]) }, pool, cfg));
  assert.ok(!out.includes("rap1"));
});

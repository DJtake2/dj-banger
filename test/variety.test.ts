/**
 * Suggestions: related but different — one pick per artist, none by the artist on now,
 * no instrumentals for a vocal seed — and hits lead (world popularity or the DJ's own plays).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseKey } from "../src/camelot.ts";
import { recommend, popularityOf } from "../src/engine.ts";
import type { Track } from "../src/types.ts";

const tk = (id: string, artist: string, extra: Partial<Track> = {}): Track => ({
  id, absPath: `/m/${id}.mp3`, title: id, artist, genre: "R&B", bpm: 100, key: parseKey("8A")!, energy: 6, popularity: 0.8, ...extra,
});
const seed = tk("Everything", "Ella Mai Ft. John Legend");
const cfg = { minScoreRatio: 0, limit: 10 };
const artists = (out: { track: Track }[]) => out.map((s) => s.track.artist);

test("one pick per artist, counting feat./&/x credits", () => {
  const pool = [
    tk("Human Nature", "Michael Jackson"), tk("Scream", "Michael Jackson & Janet Jackson"), tk("In The Closet", "Michael Jackson"),
    tk("Un-Break My Heart", "Toni Braxton"), tk("Too Close", "Next"), tk("Doo Wop", "Lauryn Hill"),
  ];
  const out = recommend({ seed }, pool, cfg);
  assert.equal(artists(out).filter((a) => /michael jackson/i.test(a)).length, 1, artists(out).join(", "));
  assert.equal(out.length, 4);
});

test("the artist on now (or a featured artist) is left out — unless nothing else fits", () => {
  const pool = [tk("Boo'd Up", "Ella Mai"), tk("All of Me", "John Legend"), tk("Un-Break My Heart", "Toni Braxton")];
  assert.equal(artists(recommend({ seed }, pool, cfg))[0], "Toni Braxton", "someone else leads; Ella Mai / John Legend only back-fill a short list");
  const only = recommend({ seed }, [tk("Boo'd Up", "Ella Mai")], { ...cfg, minResults: 4 });
  assert.equal(only.length, 1, "a short list still gets the backfill");
  const many = recommend({ seed }, [tk("Boo'd Up", "Ella Mai"), ...["a", "b", "c", "d"].map((x) => tk(x, `Artist ${x}`))], cfg);
  assert.ok(!artists(many).includes("Ella Mai"), "with enough others, the seed's artist stays out");
});

test("no instrumentals or acapellas after a vocal track", () => {
  const pool = [tk("Man Down (Inst)", "Rihanna"), tk("Cabin Fever Instrumental", "Wiz Khalifa"), tk("Acapella - Hello", "Adele"), tk("Love", "Keyshia Cole")];
  assert.deepEqual(artists(recommend({ seed }, pool, cfg)), ["Keyshia Cole"]);
  const instSeed = tk("Beat (Instrumental)", "Producer");
  assert.ok(recommend({ seed: instSeed }, pool, cfg).length >= 3, "an instrumental seed can get instrumentals");
});

test("hits lead; the DJ's own plays count as popular", () => {
  const pool = [tk("deep", "A", { popularity: 0.1 }), tk("hit", "B", { popularity: 0.95 }), tk("crowd", "C", { popularity: undefined })];
  assert.equal(recommend({ seed }, pool, cfg)[0].track.id, "hit");
  const plays = (t: Track) => (t.id === "crowd" ? 12 : 0);
  assert.equal(popularityOf(pool[2], plays), 1, "played 8+ times → a hit");
  assert.equal(popularityOf(pool[2]), undefined);
  assert.equal(popularityOf(pool[0], () => 1), 0.55, "the higher of world and crowd");
});

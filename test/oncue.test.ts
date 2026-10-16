/**
 * On Cue: plan matching, the loaded-vs-played flag, must-play tick-off, do-not-play alerts and
 * what gets reported to the CRM — against a fake Serato history and a fake CRM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { titleCore, matchSong, findSong, noteFragments, matchNote } from "../src/oncue/match.ts";
import { OnCue, confirmedPlay, type Plan, type OnCueSnapshot } from "../src/oncue/onCue.ts";
import { getDecks, readRecentEntries } from "../src/serato/history.ts";

// --- session encoder (same shape as serato.test.ts) ---
function field(fid: number, v: string | number): Buffer {
  const p = typeof v === "number" ? (() => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; })() : Buffer.from(v, "utf16le").swap16();
  const h = Buffer.alloc(8); h.writeUInt32BE(fid, 0); h.writeUInt32BE(p.length, 4);
  return Buffer.concat([h, p]);
}
function entry(f: Record<number, string | number>): Buffer {
  const wrap = (tag: string, body: Buffer) => { const h = Buffer.alloc(8); h.write(tag, 0, "latin1"); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); };
  return wrap("oent", wrap("adat", Buffer.concat(Object.entries(f).map(([k, v]) => field(Number(k), v)))));
}
async function seratoWith(entries: Buffer[]) {
  const dir = await mkdtemp(join(tmpdir(), "oncue-"));
  await mkdir(join(dir, "History", "Sessions"), { recursive: true });
  await writeFile(join(dir, "History", "Sessions", "1.session"), Buffer.concat(entries));
  return dir;
}

test("titleCore drops the version noise DJ pools add", () => {
  assert.equal(titleCore("Mr. Brightside (Clean)"), "mr brightside");
  assert.equal(titleCore("A Bar Song {Tipsy} (Clean)"), "a bar song");
  assert.equal(titleCore("DTMF [Max Wallin' Remix] (MM Edit)"), "dtmf");
  assert.equal(titleCore("September - Remastered 2011"), "september");
  assert.equal(titleCore("C’est la vie"), "cest la vie");
  assert.equal(titleCore("Señorita feat. Camila Cabello"), "senorita");
});

test("a song matches by file first, then by title + artist — never by artist alone", () => {
  const song = { id: "s1", title: "Don't Stop Believin'", artist: "Journey", path: "/Users/dj/Music/Journey - DSB.mp3" };
  assert.equal(matchSong({ title: "whatever", artist: "", absPath: "/users/dj/music/journey - dsb.mp3" }, song), "file");
  assert.equal(matchSong({ title: "Don't Stop Believin' (Intro - Clean)", artist: "Journey" }, song), "song");
  assert.equal(matchSong({ title: "Separate Ways", artist: "Journey" }, song), null, "same artist, different song");
  assert.equal(matchSong({ title: "Don't Stop Believin'", artist: "Glee Cast" }, song), null, "a cover isn't the same song");
  assert.equal(matchSong({ title: "Somebody That I Used to Know", artist: "Gotye feat. Kimbra" }, { id: "x", title: "Somebody That I Used To Know (feat. Kimbra)", artist: "Gotye" }), "song");
  assert.equal(matchSong({ title: "Hey Ya!", artist: "The OutKast" }, { id: "x", title: "Hey Ya", artist: "OutKast" }), "song");
  assert.equal(matchSong({ title: "September", artist: "Earth Wind and Fire" }, { id: "x", title: "September", artist: "Earth, Wind & Fire" }), "song", "band names with commas / &");
  assert.equal(matchSong({ title: "V.I.C. - Wobble", artist: "V.I.C." }, { id: "x", title: "Wobble", artist: "V.I.C." }), "song", "DJ-pool 'Artist - Title' titles");
  assert.equal(matchSong({ title: "The Isley Brothers - Shout", artist: "The Isley Brothers" }, { id: "x", title: "Shout", artist: "Isley Brothers" }), "song");
  assert.equal(matchSong({ title: "Signed, Sealed, Delivered I'm Yours", artist: "Stevie Wonder" }, { id: "x", title: "Signed, Sealed, Delivered (I'm Yours)", artist: "Stevie Wonder" }), "song", "a bracket that is part of the title");
  assert.equal(matchSong({ title: "Cupid Shuffle (Dj Rukus 85-144-72 Transition) (QuickHitter) (Clean)", artist: "Cupid" }, { id: "x", title: "Cupid Shuffle", artist: "Cupid" }), "song");
  assert.equal(matchSong({ title: "Perfect Duet - DJ Mike D Mix Remix", artist: "Ed Sheeran & Beyonce" }, { id: "x", title: "Perfect", artist: "Ed Sheeran" }), null, "Perfect Duet isn't Perfect");
  const both = [{ id: "a", title: "Happy", artist: "Pharrell Williams" }, { id: "b", title: "x", artist: "y", path: "/m/happy.mp3" }];
  assert.equal(findSong({ title: "Happy", artist: "Pharrell Williams", absPath: "/m/happy.mp3" }, both)?.song.id, "b", "file match wins");
});

test("free-text do-not-play notes only match whole titles", () => {
  const frags = noteFragments(["No Cha Cha Slide, no Macarena please; nothing by Nickelback", "Cotton Eye Joe - Rednex"]);
  assert.ok(frags.includes("Cha Cha Slide"));
  assert.equal(matchNote({ title: "Cha Cha Slide (Clean)", artist: "DJ Casper" }, frags), "Cha Cha Slide");
  assert.equal(matchNote({ title: "Cotton Eye Joe", artist: "Rednex" }, frags), "Cotton Eye Joe - Rednex");
  assert.equal(matchNote({ title: "Macarena", artist: "Los del Rio" }, frags), null, "one-word titles are too risky from free text");
  assert.equal(matchNote({ title: "Slide", artist: "Goo Goo Dolls" }, frags), null);
});

test("played = still flagged AND a minute on the deck (finished or not) — Serato 3 flags a fresh load as played", () => {
  const now = 10_000;
  assert.equal(confirmedPlay({ played: true, startTime: now - 5 }, now), false, "just loaded (Serato already says 1)");
  assert.equal(confirmedPlay({ played: true, startTime: now - 75 }, now), true, "on the deck over a minute");
  assert.equal(confirmedPlay({ played: true, startTime: now - 300, endTime: now - 290 }, now), false, "swapped out after 10s");
  assert.equal(confirmedPlay({ played: true, startTime: now - 300, endTime: now - 259 }, now), false, "41s load-and-swap (seen live on Serato 3.3.5)");
  assert.equal(confirmedPlay({ played: true, startTime: now - 300, endTime: now - 60 }, now), true);
  assert.equal(confirmedPlay({ played: false, startTime: now - 300, endTime: now - 60 }, now), false, "Serato rewrote it as never played");
});

test("Serato's played flag is read; tonight's history is read across sessions", async () => {
  const dir = await seratoWith([
    entry({ 2: "/m/a.mp3", 6: "A Bar Song {Tipsy} (Clean)", 7: "Shaboozey", 31: 1, 28: 1000, 29: 1078, 45: 78, 50: 0 }),
    entry({ 2: "/m/b.mp3", 6: "Dancing Queen", 7: "ABBA", 31: 1, 28: 1078, 50: 1 }),
    entry({ 2: "/m/c.mp3", 6: "Cha Cha Slide", 7: "DJ Casper", 31: 2, 28: 1100, 50: 0 }),
  ]);
  const st = await getDecks(dir);
  assert.equal(st.decks[1].title, "Dancing Queen");
  assert.equal(st.decks[1].played, true);
  assert.equal(st.decks[2].played, false, "loaded, not yet played");
  const all = await readRecentEntries(900, dir);
  assert.equal(all.length, 3);
  assert.equal(all[0].played, false);
  assert.equal(all[0].playSeconds, 78);
});

// --- On Cue against a fake CRM ---
const plan = (date: string): Plan => ({
  generatedAt: "2026-10-17T20:00:00.000Z",
  event: { id: "ev1", name: "Sam & Alex", date, venue: "The Barn", startTime: "5:00 PM", endTime: "11:00 PM", hasPlan: true, today: true, arrival: null, djNotes: null },
  libraryDir: "/m",
  sections: [
    { id: "fd", name: "First Dance", group: "Special Dances", time: "7:00 PM", at: null, doNotPlay: false, notes: null, description: null, answers: [],
      songs: [{ id: "s-fd", title: "Perfect", artist: "Ed Sheeran", isrc: null, mustPlay: true, flagged: false, notes: null, addedBy: null, path: "/m/perfect.mp3", playedAt: null }] },
    { id: "od", name: "Open Dancing", group: "Dancing", time: null, at: null, doNotPlay: false, notes: null, description: null, answers: [],
      songs: [
        { id: "s-dq", title: "Dancing Queen", artist: "ABBA", isrc: null, mustPlay: true, flagged: false, notes: null, addedBy: null, path: null, playedAt: null },
        { id: "s-dq2", title: "Dancing Queen", artist: "ABBA", isrc: null, mustPlay: false, flagged: false, notes: null, addedBy: "Guest", path: null, playedAt: null },
        { id: "s-sep", title: "September", artist: "Earth, Wind & Fire", isrc: null, mustPlay: false, flagged: false, notes: null, addedBy: null, path: null, playedAt: null },
        { id: "s-mb", title: "Mr. Brightside", artist: "The Killers", isrc: null, mustPlay: false, flagged: false, notes: null, addedBy: null, path: null, playedAt: "2026-10-17T21:00:00.000Z" },
      ] },
    { id: "dnp", name: "Do Not Play", group: "Do Not Play", time: null, at: null, doNotPlay: true, notes: null, description: null, answers: [],
      songs: [{ id: "s-cc", title: "Cha Cha Slide", artist: "DJ Casper", isrc: null, mustPlay: false, flagged: false, notes: null, addedBy: null, path: null, playedAt: null }] },
  ],
  doNotPlay: { songs: [], notes: ["no Cotton Eye Joe"] },
});

function fakeCrm(p: Plan) {
  const posts: Record<string, unknown>[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer oc1.k.s") return json({ error: "Unauthorized" }, 401);
    if (u.endsWith("/api/oncue/events")) return json({ events: [p.event] });
    if (u.endsWith("/api/oncue/events/ev1")) return json(p);
    if (u.endsWith("/now-playing")) { posts.push(JSON.parse(String(init?.body))); return json({ ok: true }); }
    return json({ error: "nope" }, 404);
  }) as typeof fetch;
  return { f, posts };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("On Cue: picks today's event, ticks must-plays on PLAY, alerts on a LOADED do-not-play, reports to the CRM", async () => {
  const now = new Date(); // real clock: the fake history file is written now
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  // History: the first dance already went out before On Cue opened.
  const T = Math.floor(now.getTime() / 1000);
  const seratoDir = await seratoWith([
    entry({ 2: "/m/perfect.mp3", 6: "Perfect", 7: "Ed Sheeran", 31: 1, 28: T - 3600, 29: T - 3400, 50: 1 }),
    // Loaded for a moment and swapped — Serato rewrote it to 0: not played.
    entry({ 2: "/m/sep.mp3", 6: "September", 7: "Earth, Wind & Fire", 31: 2, 28: T - 3000, 29: T - 2990, 50: 0 }),
  ]);
  const { f, posts } = fakeCrm(plan(day));
  let snap: OnCueSnapshot | null = null;
  const oc = new OnCue({}, { cacheDir: await mkdtemp(join(tmpdir(), "oncue-cache-")), seratoDir, fetch: f, now: () => now, onChange: (s) => (snap = s) });
  await oc.configure({ crmUrl: "https://crm.example.com/", key: "oc1.k.s" });
  oc.stop();
  assert.equal(snap!.eventId, "ev1", "today's event chosen on its own");
  assert.equal(oc.refreshDelayMs, 5 * 60 * 1000, "event day: re-read the plan every 5 minutes");
  assert.ok(snap!.played["s-fd"], "first dance ticked from tonight's history");
  assert.equal(snap!.played["s-sep"], undefined, "a 10-second load isn't a play");
  assert.ok(snap!.played["s-mb"], "a play the CRM already knew about stays ticked");
  assert.deepEqual(snap!.mustPlay, { total: 2, played: 1 });

  const t = Math.floor(now.getTime() / 1000);
  const np = (deck: number, title: string, artist: string, played: boolean, start: number) =>
    ({ id: `m/${title}`, absPath: `/m/${title}.mp3`, title, artist, deck, played, startTime: start, sessionFile: "", entryIndex: 0 });

  // Cha Cha Slide just LOADED on deck 2 (Serato already flags it played) → alert + reported as a loaded DNP.
  oc.onDecks({ decks: { 1: np(1, "Dancing Queen", "ABBA", true, t - 2), 2: np(2, "Cha Cha Slide (Clean)", "DJ Casper", true, t - 1) }, activeDeck: 2, sessionFile: null, sessionMtime: null });
  await tick();
  assert.equal(snap!.alert?.dnp, "Cha Cha Slide — DJ Casper");
  assert.equal(snap!.alert?.played, false);
  assert.equal(snap!.played["s-dq"], undefined, "two seconds on the deck isn't played");
  assert.deepEqual(posts.at(-1), { title: "Cha Cha Slide (Clean)", artist: "DJ Casper", deck: 2, played: false, dnp: "Cha Cha Slide — DJ Casper" });
  assert.ok(posts.some((p) => p.songId === "s-fd" && p.markOnly === true), "a play found in tonight's history is stamped on the plan");

  // Swapped out; Dancing Queen has now been on air for a minute and a half → ticked + stamped.
  oc.onDecks({ decks: { 1: np(1, "Mr. Brightside", "The Killers", true, t - 400), 2: np(2, "Dancing Queen", "ABBA", true, t - 90) }, activeDeck: 2, sessionFile: null, sessionMtime: null });
  await tick();
  assert.equal(snap!.alert, null, "alert cleared once the do-not-play left the deck");
  assert.ok(snap!.played["s-dq"]);
  assert.deepEqual(snap!.mustPlay, { total: 2, played: 2 });
  assert.ok(snap!.played["s-dq2"], "a second copy of the same song is ticked too");
  assert.equal(snap!.decks.find((d) => d.deck === 2)?.mustPlay, true, "the deck shows the must-play copy");
  assert.ok(posts.some((p) => p.songId === "s-dq" && p.played === true && p.markOnly === true));
  assert.ok(!posts.some((p) => p.songId === "s-mb"), "already stamped in the CRM — not sent again");
  const n = posts.length;

  // Same state again → nothing new sent.
  oc.onDecks({ decks: { 1: np(1, "Mr. Brightside", "The Killers", true, t - 400), 2: np(2, "Dancing Queen", "ABBA", true, t - 90) }, activeDeck: 2, sessionFile: null, sessionMtime: null });
  await tick();
  assert.equal(posts.length, n);

  // Free-text note match.
  oc.onDecks({ decks: { 1: np(1, "Cotton Eye Joe", "Rednex", true, t) }, activeDeck: 1, sessionFile: null, sessionMtime: null });
  await tick();
  assert.equal(snap!.alert?.how, "note");

  // Manual un-tick sticks, and the CRM stamp is taken back.
  oc.toggle("s-dq", false);
  await tick();
  assert.equal(snap!.played["s-dq"], undefined);
  assert.ok(posts.some((p) => p.songId === "s-dq" && p.played === false && p.markOnly === true));
  assert.ok(oc.dnpFilter()({ title: "Cha Cha Slide", artist: "DJ Casper" }));
  assert.ok(!oc.dnpFilter()({ title: "Dancing Queen", artist: "ABBA" }));
});

test("On Cue: offline uses the cached plan; nothing is reported on other days", async () => {
  const now = new Date("2026-10-10T19:30:00");
  const cacheDir = await mkdtemp(join(tmpdir(), "oncue-cache-"));
  const seratoDir = await seratoWith([]);
  const { f, posts } = fakeCrm(plan("2026-10-17"));
  const a = new OnCue({}, { cacheDir, seratoDir, fetch: f, now: () => now, onChange: () => {} });
  await a.configure({ crmUrl: "https://crm.example.com", key: "oc1.k.s" });
  await a.select("ev1");
  a.stop();
  a.onDecks({ decks: { 1: { id: "x", absPath: "/m/x.mp3", title: "Dancing Queen", artist: "ABBA", deck: 1, played: true, startTime: Math.floor(now.getTime() / 1000) - 120, sessionFile: "", entryIndex: 0 } }, activeDeck: 1, sessionFile: null, sessionMtime: null });
  await tick();
  assert.equal(posts.length, 0, "a week early: tick locally, don't touch the CRM");

  // A week early: no 5-minute polling — the CRM's database stays asleep.
  assert.equal(a.refreshDelayMs, 30 * 60 * 1000);
  const calls = { n: 0 };
  const counting = (async (u: string, i?: RequestInit) => { calls.n++; return f(u, i); }) as typeof fetch;
  const idle = new OnCue({ eventId: "ev1" }, { cacheDir, seratoDir, fetch: counting, now: () => now, onChange: () => {} });
  await idle.configure({ crmUrl: "https://crm.example.com", key: "oc1.k.s" });
  const afterStart = calls.n;
  await idle.wake();
  await idle.wake();
  idle.stop();
  assert.equal(calls.n, afterStart, "same day, not event day: a wake-up makes no CRM call");

  const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  let snap: OnCueSnapshot | null = null;
  const b = new OnCue({ eventId: "ev1" }, { cacheDir, seratoDir, fetch: down, now: () => now, onChange: (s) => (snap = s) });
  await b.configure({ crmUrl: "https://crm.example.com", key: "oc1.k.s" });
  b.stop();
  assert.equal(snap!.offline, true);
  assert.equal(snap!.plan?.event.name, "Sam & Alex");
});

test("On Cue: a bad key says so", async () => {
  const { f } = fakeCrm(plan("2026-10-17"));
  let snap: OnCueSnapshot | null = null;
  const oc = new OnCue({}, { cacheDir: await mkdtemp(join(tmpdir(), "oncue-cache-")), seratoDir: await seratoWith([]), fetch: f, onChange: (s) => (snap = s) });
  await oc.configure({ crmUrl: "https://crm.example.com", key: "wrong" });
  oc.stop();
  assert.match(snap!.error ?? "", /didn't accept/);
});

test("On Cue: a new day re-reads the event list once (picks up that day's gig)", async () => {
  let now = new Date("2026-10-15T15:00:00");
  const { f } = fakeCrm(plan("2026-10-16"));
  const urls: string[] = [];
  const counting = (async (u: string, i?: RequestInit) => { urls.push(String(u)); return f(u, i); }) as typeof fetch;
  const oc = new OnCue({}, { cacheDir: await mkdtemp(join(tmpdir(), "oncue-cache-")), seratoDir: await seratoWith([]), fetch: counting, now: () => now, onChange: () => {} });
  await oc.configure({ crmUrl: "https://crm.example.com", key: "oc1.k.s" });
  const n = urls.length;
  await oc.wake();
  assert.equal(urls.length, n, "same day: nothing");
  now = new Date("2026-10-16T09:00:00");
  await oc.wake();
  oc.stop();
  assert.ok(urls.slice(n).some((u) => u.endsWith("/api/oncue/events")), "new day: the event list again");
});

test("On Cue: a remembered event that isn't in the list is dropped; the next gig with a plan is picked", async () => {
  const now = new Date("2026-10-15T15:00:00");
  const p = plan("2026-10-17");
  p.event.today = false; // two days out: the "next gig" path, not "tonight"
  const { f } = fakeCrm(p);
  let snap: OnCueSnapshot | null = null;
  const oc = new OnCue({ eventId: "old-test-event" }, { cacheDir: await mkdtemp(join(tmpdir(), "oncue-cache-")), seratoDir: await seratoWith([]), fetch: f, now: () => now, onChange: (s) => (snap = s) });
  await oc.configure({ crmUrl: "https://crm.example.com", key: "oc1.k.s" });
  oc.stop();
  assert.equal(snap!.eventId, "ev1");
  assert.equal(snap!.plan?.event.name, "Sam & Alex");
  assert.equal(snap!.error, null);
});

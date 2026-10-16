/**
 * Event crates: names, neworder.pref ordering, backups, our-own-subcrates-only, and resolving
 * plan songs to library files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeCrateName, updateNeworder, writeEventCrates } from "../src/serato/eventCrate.ts";
import { parseRecords, crateTrackPaths } from "../src/serato/parser.ts";
import { buildLibraryIndex, resolveSong } from "../src/oncue/resolve.ts";
import type { Track } from "../src/types.ts";

const u16 = (s: string) => Buffer.from(s, "utf16le").swap16();
const fromU16 = (b: Buffer) => Buffer.from(b).swap16().toString("utf16le");

test("crate names can't nest or escape the folder", () => {
  assert.equal(sanitizeCrateName("Sam & Alex / Wedding: 10%%17"), "Sam & Alex Wedding 10 17");
  assert.equal(sanitizeCrateName("   "), "Event");
});

test("neworder: this event goes to the top, its old auto-subcrates go, hand-made ones stay", () => {
  const before = "[begin record]\n[crate]Stems\n[crate]Sam%%01 Old Section\n[crate]Sam%%My extras\n[crate]Sam\n[crate]Other\n[end record]\n";
  const after = updateNeworder(before, "Sam", ["Sam", "Sam%%01 First Dance"], ["Sam%%My extras"]);
  assert.equal(after, "[begin record]\n[crate]Sam\n[crate]Sam%%01 First Dance\n[crate]Stems\n[crate]Sam%%My extras\n[crate]Other\n[end record]\n");
});

test("writeEventCrates: parent + numbered sections, backup first, stale auto-subcrates removed", async () => {
  const serato = await mkdtemp(join(tmpdir(), "crate-"));
  const sub = join(serato, "Subcrates");
  await mkdir(sub);
  await writeFile(join(sub, "Sam & Alex.crate"), Buffer.from("old"));
  await writeFile(join(sub, "Sam & Alex%%03 Renamed Away.crate"), Buffer.from("stale"));
  await writeFile(join(sub, "Sam & Alex%%Hand made.crate"), Buffer.from("mine"));
  await writeFile(join(serato, "neworder.pref"), u16("[begin record]\n[crate]Stems\n[crate]Sam & Alex\n[crate]Sam & Alex%%03 Renamed Away\n[end record]\n"));
  const backupRoot = join(serato, "backups");
  const r = await writeEventCrates("Sam & Alex", [
    { name: "First Dance", paths: ["/m/perfect.mp3"] },
    { name: "Empty", paths: [] },
    { name: "Open Dancing", paths: ["/m/dq.mp3", "/m/perfect.mp3"] },
  ], { seratoDir: serato, backupRoot, now: new Date("2026-10-17T20:00:00Z") });

  assert.deepEqual(r.crates, ["Sam & Alex", "Sam & Alex%%01 First Dance", "Sam & Alex%%02 Open Dancing"]);
  assert.equal(r.tracks, 2);
  const files = (await readdir(sub)).sort();
  assert.deepEqual(files, ["Sam & Alex%%01 First Dance.crate", "Sam & Alex%%02 Open Dancing.crate", "Sam & Alex%%Hand made.crate", "Sam & Alex.crate"]);
  assert.deepEqual(crateTrackPaths(parseRecords(await readFile(join(sub, "Sam & Alex.crate")))), ["m/perfect.mp3", "m/dq.mp3"]);
  // backups
  const b = join(r.backupDir);
  assert.ok(existsSync(join(b, "Sam & Alex.crate")));
  assert.ok(existsSync(join(b, "Sam & Alex%%03 Renamed Away.crate")));
  assert.ok(existsSync(join(b, "neworder.pref")));
  assert.equal(fromU16(await readFile(join(serato, "neworder.pref"))), "[begin record]\n[crate]Sam & Alex\n[crate]Sam & Alex%%01 First Dance\n[crate]Sam & Alex%%02 Open Dancing\n[crate]Stems\n[end record]\n");
});

test("resolveSong: Prep's file first, else the clean, plainest version by the right artist", () => {
  const t = (title: string, artist: string, path: string): Track => ({ id: path.slice(1), absPath: path, title, artist });
  const pool = [
    t("Mr. Brightside (Dirty)", "The Killers", "/m/mb-dirty.mp3"),
    t("Mr. Brightside (DJ X Remix) (Clean)", "The Killers", "/m/mb-remix.mp3"),
    t("Mr. Brightside (Clean)", "The Killers", "/m/mb-clean.mp3"),
    t("Mr. Brightside", "Some Cover Band", "/m/mb-cover.mp3"),
    t("V.I.C. - Wobble", "V.I.C.", "/m/wobble.mp3"),
    t("V.I.C. - Wobble [Dj Allan Party Break] (Clean)", "V.I.C.", "/m/wobble-break.mp3"),
  ];
  const idx = buildLibraryIndex(pool);
  assert.equal(resolveSong({ id: "a", title: "Mr. Brightside", artist: "The Killers" }, idx)?.track.absPath, "/m/mb-clean.mp3");
  assert.equal(resolveSong({ id: "a", title: "Mr. Brightside", artist: "The Killers", path: "/m/mb-remix.mp3" }, idx)?.how, "file");
  assert.equal(resolveSong({ id: "b", title: "Wobble", artist: "V.I.C." }, idx)?.track.absPath, "/m/wobble.mp3");
  assert.equal(resolveSong({ id: "c", title: "Somebody Else", artist: "The 1975" }, idx), null);
});

/**
 * Load a Serato library from disk into engine-ready `Track`s.
 * Maps Serato's tag soup onto our clean domain model and derives key + energy.
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import type { Track } from "../types.ts";
import { parseKey } from "../camelot.ts";
import { resolveEnergy } from "../energy.ts";
import { parseRecords, fieldsOf, crateTrackPaths } from "./parser.ts";

/** Default macOS Serato library location. */
export function defaultSeratoDir(): string {
  return join(homedir(), "Music", "_Serato_");
}

// Serato paths are volume-relative with no leading slash ("Users/dj/track.mp3").
// On macOS the volume root is "/", so the absolute path is just "/" + stored path.
function toAbs(volumeRelative: string): string {
  const p = volumeRelative.startsWith("/") ? volumeRelative : "/" + volumeRelative;
  return p.split("/").join(sep);
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// "04:10.20" (mm:ss.cc) -> seconds
function lenToSec(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

/** Parse the main `database V2` into Tracks. */
export async function loadLibrary(seratoDir = defaultSeratoDir()): Promise<Track[]> {
  const dbPath = join(seratoDir, "database V2");
  const buf = await readFile(dbPath);
  const records = parseRecords(buf);

  const tracks: Track[] = [];
  for (const r of records) {
    if (r.tag !== "otrk") continue;
    const f = fieldsOf(r);
    const path = str(f["pfil"]);
    if (!path) continue;

    const bpm = num(f["tbpm"]);
    const genre = str(f["tgen"]);
    const comment = str(f["tcom"]);
    const grouping = str(f["tgrp"]);
    const key = parseKey(str(f["tkey"]) ?? str(f["tky "]) ?? null);
    const energy = resolveEnergy([comment, grouping], bpm, genre);

    tracks.push({
      id: path,
      absPath: toAbs(path),
      title: str(f["tsng"]) ?? path.split("/").pop() ?? path,
      artist: str(f["tart"]) ?? "",
      album: str(f["talb"]),
      genre,
      bpm,
      key: key ?? undefined,
      energy: energy.value,
      lengthSec: lenToSec(f["tlen"]),
      year: num(f["tyr"]) ?? num(f["tyer"]),
      raw: {
        energySource: energy.source,
        ...(comment ? { comment } : {}),
        ...(grouping ? { grouping } : {}),
        ...(f["tkey"] ? { rawKey: String(f["tkey"]) } : {}),
      },
    });
  }
  return tracks;
}

export interface Crate {
  name: string;
  file: string;
  paths: string[];
}

/** List crates (flattened) with their member track paths, from the Subcrates dir. */
export async function loadCrates(seratoDir = defaultSeratoDir()): Promise<Crate[]> {
  const dir = join(seratoDir, "Subcrates");
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith(".crate"));
  const crates: Crate[] = [];
  for (const file of files) {
    try {
      const buf = await readFile(join(dir, file));
      const paths = crateTrackPaths(parseRecords(buf));
      // Filename encodes nesting with "%%"; the crate name is the last segment.
      const name = file.replace(/\.crate$/, "").split("%%").join(" › ");
      crates.push({ name, file, paths });
    } catch {
      // skip unreadable crate
    }
  }
  return crates;
}

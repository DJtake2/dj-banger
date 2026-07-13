/**
 * Serato .crate WRITER — the inverse of parser.ts. Used to publish suggestions back into
 * Serato as a dedicated crate the DJ can load from.
 *
 * Format verified against a real crate:
 *   vrsn  "1.0/Serato ScratchLive Crate"
 *   osrt  → tvcn(column) + brev(bool)         (sort spec)
 *   ovct  → tvcn(column) + tvcw(width text)   (repeated, column layout)
 *   otrk  → ptrk(volume-relative path)        (repeated, one per track)
 *
 * SAFETY: this only ever writes ONE dedicated file (default "Banger Suggestions.crate").
 * It never touches database V2 or any existing crate. Writes atomically (temp + rename).
 */

import { writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { defaultSeratoDir } from "./library.ts";
import type { Track } from "../types.ts";

const CRATE_VERSION = "1.0/Serato ScratchLive Crate";
const DEFAULT_COLUMNS = ["song", "artist", "bpm", "key", "genre", "length"];

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/** Encode one record: [4-ascii tag][u32 len][payload]. */
function record(tag: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(tag, "latin1"), u32(payload.length), payload]);
}

/** Text record (UTF-16 BE, no trailing null — matching Serato's own files). */
function textRecord(tag: string, value: string): Buffer {
  const payload = Buffer.from(value, "utf16le").swap16(); // → UTF-16 BE
  return record(tag, payload);
}

function boolRecord(tag: string, value: boolean): Buffer {
  return record(tag, Buffer.from([value ? 1 : 0]));
}

/** Serialize a full crate from a list of volume-relative track paths. */
export function encodeCrate(paths: string[], columns: string[] = DEFAULT_COLUMNS): Buffer {
  const parts: Buffer[] = [];
  parts.push(textRecord("vrsn", CRATE_VERSION));
  // sort spec: by bpm ascending (harmless default)
  parts.push(record("osrt", Buffer.concat([textRecord("tvcn", "bpm"), boolRecord("brev", false)])));
  // column layout
  for (const col of columns) {
    parts.push(record("ovct", Buffer.concat([textRecord("tvcn", col), textRecord("tvcw", "0")])));
  }
  // tracks
  for (const p of paths) {
    const rel = p.startsWith("/") ? p.slice(1) : p; // crates store volume-relative paths
    parts.push(record("otrk", textRecord("ptrk", rel)));
  }
  return Buffer.concat(parts);
}

export interface WriteCrateOptions {
  seratoDir?: string;
  /** Crate name shown in Serato (no ".crate"). */
  name?: string;
}

/**
 * Write (atomically) a suggestions crate into Serato's Subcrates folder.
 * Returns the path written. Serato picks up new crates on its next library rescan / restart.
 */
export async function writeSuggestionsCrate(
  tracks: Track[],
  opts: WriteCrateOptions = {},
): Promise<string> {
  const seratoDir = opts.seratoDir ?? defaultSeratoDir();
  const name = opts.name ?? "Banger Suggestions";
  const dir = join(seratoDir, "Subcrates");
  await mkdir(dir, { recursive: true });

  const buf = encodeCrate(tracks.map((t) => t.id));
  const finalPath = join(dir, `${name}.crate`);
  const tmpPath = join(dir, `.${name}.crate.tmp`);
  await writeFile(tmpPath, buf);
  await rename(tmpPath, finalPath); // atomic swap
  return finalPath;
}

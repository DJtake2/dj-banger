/**
 * Now-playing detection via Serato's History session files.
 *
 * Serato writes every played track to ~/Music/_Serato_/History/Sessions/<n>.session as it
 * plays. Format is the tag envelope ([4-ascii tag][u32 BE len][payload]) at the top level:
 *   vrsn, then repeated `oent` (one played entry). Each `oent` holds a single `adat` blob.
 *
 * BUT `adat`'s payload uses a DIFFERENT inner encoding: numeric field IDs, not ASCII tags —
 *   [u32 field-id][u32 length][payload]
 * Verified against a real session. The fields we care about:
 *   2 = absolute file path · 6 = title · 7 = artist · 8 = album · 9 = genre
 *
 * The LAST `oent` in the most-recently-modified session file is "now playing".
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultSeratoDir } from "./library.ts";

const utf16be = new TextDecoder("utf-16be");

export interface NowPlaying {
  /** Volume-relative path (leading slash stripped) — matches library Track.id. */
  id: string;
  /** Absolute path as Serato recorded it. */
  absPath: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  /** Serato deck this was played on (adat field 31): 1, 2, 3, 4. */
  deck?: number;
  /** Which session file + entry index it came from. */
  sessionFile: string;
  entryIndex: number;
}

/** Serato history absolute path -> library-relative id (strip one leading slash). */
export function normalizeHistoryPath(abs: string): string {
  return abs.startsWith("/") ? abs.slice(1) : abs;
}

/** Decode adat's numeric-TLV payload into a field-id -> value map. */
function parseAdat(buf: Buffer): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  let off = 0;
  while (off + 8 <= buf.length) {
    const fid = buf.readUInt32BE(off);
    const len = buf.readUInt32BE(off + 4);
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.set(fid, buf.subarray(start, end));
    off = end;
  }
  return out;
}

function fieldStr(m: Map<number, Buffer>, id: number): string | undefined {
  const b = m.get(id);
  if (!b) return undefined;
  const s = utf16be.decode(b).replace(/\0+$/, "");
  return s.length ? s : undefined;
}

function fieldInt(m: Map<number, Buffer>, id: number): number | undefined {
  const b = m.get(id);
  if (!b || b.length === 0) return undefined;
  return b.length >= 4 ? b.readUInt32BE(0) : b.readUIntBE(0, b.length);
}

/** Path to the Sessions directory. */
export function sessionsDir(seratoDir = defaultSeratoDir()): string {
  return join(seratoDir, "History", "Sessions");
}

/** Find the most-recently-modified .session file. */
export async function newestSession(seratoDir = defaultSeratoDir()): Promise<string | null> {
  const dir = sessionsDir(seratoDir);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".session"));
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const f of files) {
    try {
      const s = await stat(join(dir, f));
      const mt = s.mtimeMs;
      if (!best || mt > best.mtime) best = { file: join(dir, f), mtime: mt };
    } catch {
      /* skip */
    }
  }
  return best?.file ?? null;
}

/** Parse a single session file's entries (oldest → newest). */
export async function parseSession(sessionPath: string): Promise<NowPlaying[]> {
  const buf = await readFile(sessionPath);
  return parseSessionEntries(buf);
}

/**
 * Walk a session buffer's `oent`→`adat` entries.
 * We don't reuse parseRecords here because it doesn't descend into `adat` (an "a-star" raw
 * payload with a numeric-TLV encoding), so this does a purpose-built two-level pass.
 */
function parseSessionEntries(buf: Buffer): NowPlaying[] {
  const entries: NowPlaying[] = [];
  let off = 0;
  let idx = 0;
  while (off + 8 <= buf.length) {
    const tag = buf.toString("latin1", off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    const start = off + 8;
    const end = start + len;
    if (end > buf.length) break;
    if (tag === "oent") {
      // scan children for adat
      let co = start;
      while (co + 8 <= end) {
        const ctag = buf.toString("latin1", co, co + 4);
        const clen = buf.readUInt32BE(co + 4);
        const cstart = co + 8;
        const cend = cstart + clen;
        if (cend > end) break;
        if (ctag === "adat") {
          const fields = parseAdat(buf.subarray(cstart, cend));
          const abs = fieldStr(fields, 2);
          if (abs) {
            entries.push({
              id: normalizeHistoryPath(abs),
              absPath: abs,
              title: fieldStr(fields, 6),
              artist: fieldStr(fields, 7),
              album: fieldStr(fields, 8),
              genre: fieldStr(fields, 9),
              deck: fieldInt(fields, 31),
              sessionFile: "",
              entryIndex: idx,
            });
          }
        }
        co = cend;
      }
      idx++;
    }
    off = end;
  }
  return entries;
}

/** The current now-playing track: last entry of the newest session, or null. */
export async function getNowPlaying(seratoDir = defaultSeratoDir()): Promise<NowPlaying | null> {
  const session = await newestSession(seratoDir);
  if (!session) return null;
  const buf = await readFile(session);
  const entries = parseSessionEntries(buf);
  if (!entries.length) return null;
  const last = entries[entries.length - 1];
  last.sessionFile = session;
  return last;
}

export interface DeckState {
  /** Deck -> its most-recent track. */
  decks: Record<number, NowPlaying>;
  /** The deck of the overall-most-recent entry (the "active"/incoming deck). */
  activeDeck: number | null;
  sessionFile: string | null;
}

/**
 * Current per-deck state: the latest track on each deck (Serato logs each play with its deck
 * in adat field 31). Entries without a deck number fall back to deck 1.
 */
export async function getDecks(seratoDir = defaultSeratoDir()): Promise<DeckState> {
  const session = await newestSession(seratoDir);
  if (!session) return { decks: {}, activeDeck: null, sessionFile: null };
  const buf = await readFile(session);
  const entries = parseSessionEntries(buf);
  const decks: Record<number, NowPlaying> = {};
  let activeDeck: number | null = null;
  // entries are oldest→newest; last write per deck wins, last overall = active.
  for (const e of entries) {
    const d = e.deck && e.deck >= 1 && e.deck <= 4 ? e.deck : 1;
    e.sessionFile = session;
    decks[d] = e;
    activeDeck = d;
  }
  return { decks, activeDeck, sessionFile: session };
}

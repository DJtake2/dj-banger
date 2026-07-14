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
import { homedir } from "node:os";
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
  /** Unix time (s) the track started playing (adat field 28). */
  startTime?: number;
  /** Unix time (s) the track stopped (adat field 29). Absent while it's still playing. */
  endTime?: number;
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
              startTime: fieldInt(fields, 28),
              endTime: fieldInt(fields, 29),
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
  /** Last-modified time (ms) of the session file — used to tell a live set from a stale one. */
  sessionMtime: number | null;
}

/**
 * Order two entries by recency. Serato does NOT keep the file in play order — it re-writes older
 * entries in place (updating their "last modified" field) long after they played, so file byte
 * order (entryIndex) puts stale re-written tracks last and would report the wrong now-playing.
 * The play START time (field 28) is the reliable clock: the largest start time is the most
 * recently loaded track. An entry with no END time (field 29) is still playing, so it always
 * outranks a finished one. Returns true if `a` is newer/more-current than `b`.
 */
function isMoreCurrent(a: NowPlaying, b: NowPlaying): boolean {
  const aPlaying = a.endTime == null;
  const bPlaying = b.endTime == null;
  if (aPlaying !== bPlaying) return aPlaying; // a still playing, b finished → a wins
  const as = a.startTime ?? 0;
  const bs = b.startTime ?? 0;
  if (as !== bs) return as > bs;
  return a.entryIndex > b.entryIndex; // no timestamps → fall back to file order
}

/** A resolved per-deck snapshot from one source, tagged with its freshest play time. */
interface DeckSource {
  decks: Record<number, NowPlaying>;
  /** Max play start time (unix seconds) across the decks — used to arbitrate sources by recency. */
  maxTs: number;
  file: string | null;
  /** File mtime (ms) of the source, for the cheap freshness gate. */
  mtime: number | null;
}

/** macOS path to Serato 4's SQLite library (`master.sqlite`). */
function v4DatabasePath(): string {
  return join(homedir(), "Library", "Application Support", "Serato", "Library", "master.sqlite");
}

/**
 * Read now-playing per deck from Serato 4's `master.sqlite` (denormalized `history_entry` table).
 * Mirrors the reference app's `_getV4LastPlayedTracks`. Uses Node's built-in `node:sqlite`
 * (read-only) so there's no native dependency. Returns empty decks on ANY failure (locked DB,
 * missing table, older Node) so the caller falls back to the legacy `.session` reader.
 */
async function readV4Decks(): Promise<DeckSource> {
  const dbPath = v4DatabasePath();
  const empty: DeckSource = { decks: {}, maxTs: 0, file: dbPath, mtime: null };
  let db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] }; close: () => void } | null = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true }) as unknown as typeof db;
    const sess = db!.prepare("SELECT id FROM history_session ORDER BY start_time DESC LIMIT 1").get() as { id: number } | undefined;
    if (!sess) return empty;
    const rows = db!.prepare(
      `SELECT portable_id, name, artist, key, bpm, deck, start_time FROM history_entry
       WHERE session_id = ? AND deck IS NOT NULL AND deck != '' ORDER BY start_time DESC`,
    ).all(sess.id) as Array<{ portable_id?: string; name?: string; artist?: string; key?: string; bpm?: number; deck?: string; start_time?: number }>;
    const decks: Record<number, NowPlaying> = {};
    let maxTs = 0;
    for (const r of rows) {
      let d = parseInt(String(r.deck), 10);
      if (isNaN(d)) d = 1; // Serato 4 (Windows) has emitted non-numeric decks — surface on deck 1
      if (d < 1 || d > 4) continue;
      const ts = Number(r.start_time) || 0;
      if (ts > maxTs) maxTs = ts;
      if (decks[d]) continue; // rows are start_time DESC → first per deck is the most recent
      const abs = r.portable_id ? `/${r.portable_id}` : ""; // portable_id is volume-relative
      decks[d] = {
        id: normalizeHistoryPath(abs),
        absPath: abs,
        title: r.name ?? "",
        artist: r.artist ?? "",
        deck: d,
        startTime: ts,
        sessionFile: dbPath,
        entryIndex: 0,
      };
    }
    return { decks, maxTs, file: dbPath, mtime: null };
  } catch {
    return empty;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Read now-playing per deck from the legacy `.session` files. Scans the few most-recent sessions
 * and uses the first that actually contains plays — on launch Serato often creates a fresh empty
 * session (newest mtime) with no plays yet (reference: `_getLegacyLastPlayedTracks`). Within a
 * session, each deck's current track is the one with the latest play start time (see `isMoreCurrent`).
 */
async function readLegacyDecks(seratoDir: string): Promise<DeckSource> {
  const dir = sessionsDir(seratoDir);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".session"));
  } catch {
    return { decks: {}, maxTs: 0, file: null, mtime: null };
  }
  const stated: Array<{ file: string; mtime: number }> = [];
  for (const f of files) {
    try {
      const s = await stat(join(dir, f));
      stated.push({ file: join(dir, f), mtime: s.mtimeMs });
    } catch { /* skip */ }
  }
  stated.sort((a, b) => b.mtime - a.mtime); // newest first
  for (let i = 0; i < Math.min(stated.length, 5); i++) {
    const buf = await readFile(stated[i].file);
    const entries = parseSessionEntries(buf);
    if (!entries.length) continue;
    const decks: Record<number, NowPlaying> = {};
    let maxTs = 0;
    for (const e of entries) {
      const d = e.deck && e.deck >= 1 && e.deck <= 4 ? e.deck : 1;
      e.sessionFile = stated[i].file;
      if (!decks[d] || isMoreCurrent(e, decks[d])) decks[d] = e;
      if ((e.startTime ?? 0) > maxTs) maxTs = e.startTime ?? 0;
    }
    return { decks, maxTs, file: stated[i].file, mtime: stated[i].mtime };
  }
  return { decks: {}, maxTs: 0, file: stated[0]?.file ?? null, mtime: stated[0]?.mtime ?? null };
}

/**
 * Current per-deck state: the track currently loaded on each deck. Reads BOTH Serato sources and
 * arbitrates by play recency — the reference app's key technique (`getLastPlayedTracks`): a leftover
 * Serato-4 `master.sqlite` whose stale session would otherwise "pin the decks forever" loses to the
 * fresher live `.session`, and vice-versa on a real Serato-4 install. Within a source, selection is
 * by play start time, not file order (Serato re-writes finished entries in place). `sessionMtime` is
 * reported as the latest PLAY time so a previous set (old plays) reads as stale on launch.
 */
export async function getDecks(seratoDir = defaultSeratoDir()): Promise<DeckState> {
  const legacy = await readLegacyDecks(seratoDir);

  // Only pay for the (large, possibly locked) master.sqlite read when it could plausibly be the
  // fresher source — i.e. its file was touched around/after the legacy session. On a Serato-3 rig
  // the V4 DB is old (or absent), so this stat gate skips it entirely.
  let chosen = legacy;
  try {
    const dbPath = v4DatabasePath();
    const vMtime = await stat(dbPath).then((s) => s.mtimeMs).catch(() => null);
    if (vMtime != null && (legacy.mtime == null || vMtime >= legacy.mtime - 5 * 60 * 1000)) {
      const v4 = await readV4Decks();
      if (v4.maxTs > legacy.maxTs) chosen = { ...v4, mtime: vMtime };
    }
  } catch { /* V4 unavailable → keep legacy */ }

  let activeDeck: number | null = null;
  let activeEntry: NowPlaying | null = null;
  for (const [d, e] of Object.entries(chosen.decks)) {
    if (!activeEntry || isMoreCurrent(e, activeEntry)) {
      activeEntry = e;
      activeDeck = Number(d);
    }
  }
  // Freshness is the latest play time (more truthful than file mtime, which Serato bumps on
  // re-writes). Fall back to file mtime when no play timestamp is present.
  const sessionMtime = chosen.maxTs > 0 ? chosen.maxTs * 1000 : chosen.mtime;
  return { decks: chosen.decks, activeDeck, sessionFile: chosen.file, sessionMtime };
}

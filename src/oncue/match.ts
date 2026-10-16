/**
 * On Cue — matching what Serato has on a deck against the client's plan.
 *
 * Two ways a deck track can be a plan song:
 *   1. The same FILE: the CRM's Prep mode already matched the song to a file in the library,
 *      so the plan carries its absolute path. Exact, version-specific.
 *   2. The same SONG: title and artist agree once the version noise is stripped — "(Clean)",
 *      "(Intro)", "[Remix]", "feat. X", "- Radio Edit". Deliberately version-agnostic: a couple
 *      who don't want "Cha Cha Slide" don't want the clean intro edit either.
 *
 * Unlike the free-text Do-Not-Play list (src/dnp.ts, substring both ways), this never matches
 * on artist alone or on a fragment, so "Journey" on the list can't flag every Journey track.
 */

import { splitArtists } from "../affinity.ts";

export interface PlanSongLike {
  id: string;
  title: string;
  artist: string;
  /** Absolute path of the Prep-matched file on this Mac, if any. */
  path?: string | null;
}

export interface DeckTrackLike {
  title?: string;
  artist?: string;
  absPath?: string;
}

/** A path compared the way macOS compares them: Unicode-normalised, case-insensitive. */
export function normPath(p?: string | null): string {
  return (p ?? "").normalize("NFC").toLowerCase().replace(/^\/+/, "").replace(/\/+/g, "/");
}

const strip = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ");

/** The song's title without the version noise DJ pools hang on it. */
export function titleCore(title?: string): string {
  let t = strip(title ?? "");
  t = t.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " "); // (Clean) [Remix] {Tipsy}
  t = t.replace(/\s+(feat|ft|featuring)\.?\s.*$/, " "); // trailing "feat. X"
  t = t.replace(/\s+-\s+.*$/, " "); // " - Radio Edit", " - Remastered 2011"
  return t.replace(/[^a-z0-9]+/g, " ").trim();
}

// A bracket holding any of these is a version tag ("(Clean)", "[Kleine Mike Remix]"); any other
// bracket may be part of the real title ("(I'm Yours)", "(Love Theme)").
const VERSION_RE = /\b(clean|dirty|explicit|super clean|intro|outro|edit|remix|mix|mixshow|rmx|extended|radio|short|version|ver|remaster(ed)?|original|acapella|a cappella|instrumental|hype|loop|transition|quickhitter|bootleg|mashup|redrum|vip|live|feat|ft|featuring|bpm|\d{2,3}\s*-\s*\d{2,3})\b/;

/**
 * Every reasonable spelling of a title to compare on: without any brackets, with the
 * non-version brackets kept, and — for DJ-pool files titled "Artist - Title" — the part after
 * the artist.
 */
export function titleKeys(title?: string, artist?: string): Set<string> {
  const keys = new Set<string>();
  const raw = title ?? "";
  const add = (t: string) => {
    const a = titleCore(t);
    if (a) keys.add(a);
    const kept = strip(t)
      .replace(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g, (m, a1, a2, a3) => (VERSION_RE.test(a1 ?? a2 ?? a3 ?? "") ? " " : ` ${a1 ?? a2 ?? a3} `))
      .replace(/\s+(feat|ft|featuring)\.?\s.*$/, " ")
      .replace(/\s+-\s+.*$/, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (kept) keys.add(kept);
  };
  add(raw);
  const dash = raw.split(/\s+[-–—]\s+/);
  if (dash.length >= 2 && artistsOverlap(dash[0], artist)) add(dash.slice(1).join(" - "));
  return keys;
}

const shareKey = (a: Set<string>, b: Set<string>) => [...a].some((k) => b.has(k));

/** Individual artists, normalised the same way as titles. */
export function artistSet(artist?: string): Set<string> {
  return new Set(splitArtists(strip(artist ?? "")).map((a) => a.replace(/[^a-z0-9]+/g, " ").trim()).filter(Boolean));
}

/** "the killers" ≈ "killers". */
const bare = (a: string) => a.replace(/^the\s+/, "");

export function artistsOverlap(a?: string, b?: string): boolean {
  const A = [...artistSet(a)].map(bare);
  const B = new Set([...artistSet(b)].map(bare));
  return A.some((x) => B.has(x));
}

export type MatchHow = "file" | "song";

/** Is this deck track that plan song? */
export function matchSong(track: DeckTrackLike, song: PlanSongLike): MatchHow | null {
  if (song.path && track.absPath && normPath(song.path) === normPath(track.absPath)) return "file";
  const tk = titleKeys(track.title, track.artist);
  const sk = titleKeys(song.title, song.artist);
  if (!tk.size || !sk.size || !shareKey(tk, sk)) return null;
  // Same title: the artists must agree too, unless the plan has none (a song typed by hand).
  if (!song.artist.trim()) return "song";
  return artistsOverlap(track.artist, song.artist) ? "song" : null;
}

/** The first plan song this track is, preferring an exact file match over a title match. */
export function findSong<S extends PlanSongLike>(track: DeckTrackLike, songs: S[]): { song: S; how: MatchHow } | null {
  let byTitle: { song: S; how: MatchHow } | null = null;
  for (const song of songs) {
    const how = matchSong(track, song);
    if (how === "file") return { song, how };
    if (how && !byTitle) byTitle = { song, how };
  }
  return byTitle;
}

/**
 * Do-not-play written as free text in an answer ("No Cha Cha Slide, no Macarena please").
 * Split into fragments and match a fragment only when it IS the track's title (or
 * "Artist - Title"), never a substring — free text is too loose for anything else.
 */
export function noteFragments(notes: string[]): string[] {
  return notes
    .flatMap((n) => n.split(/[\n,;•·]+|\s+(?:and|or)\s+(?=no\b)/i))
    .map((f) => f.replace(/^\s*(?:-|\*|\d+[.)])?\s*(?:no|not|never|please don'?t play|don'?t play)\s+/i, "").replace(/\bplease\b/gi, "").trim())
    .filter((f) => f.length >= 3);
}

export function matchNote(track: DeckTrackLike, fragments: string[]): string | null {
  const keys = titleKeys(track.title, track.artist);
  if (!keys.size) return null;
  const isTitle = (t: string) => keys.has(titleCore(t));
  for (const f of fragments) {
    const dash = f.split(/\s+[-–—]\s+|\s+by\s+/i);
    if (dash.length === 2) {
      const [a, b] = dash;
      if ((isTitle(b) && artistsOverlap(a, track.artist)) || (isTitle(a) && artistsOverlap(b, track.artist))) return f;
    }
    if (isTitle(f) && titleCore(f).split(" ").length >= 2) return f; // one-word titles are too risky
  }
  return null;
}

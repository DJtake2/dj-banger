/**
 * Do-Not-Play matching — ported to match the reference app's semantics exactly.
 *
 * The DJ keeps a free-text list, one entry per line. An entry can be a bare artist or title,
 * or an "Artist - Title" pair. Matching is case-insensitive and bidirectional-substring, so
 * "Cotton Eye Joe" matches a track titled "Cotton Eye Joe (Remix)" and vice-versa.
 */

export interface TrackLike {
  artist?: string;
  title?: string;
}

export function parseDoNotPlay(text: string | undefined): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const norm = (v?: string) => (v ?? "").toLowerCase().trim();
const fieldsMatch = (field: string, entry: string) =>
  !!field && !!entry && (field.includes(entry) || entry.includes(field));

/** Return the matching DNP entry (for display) or null. Mirrors checkDoNotPlayMatch. */
export function matchDoNotPlay(entries: string[], track: TrackLike): string | null {
  if (!entries.length) return null;
  const artist = norm(track.artist);
  const title = norm(track.title);
  const combined = `${artist} ${title}`.trim();

  for (const entry of entries) {
    const e = norm(entry);
    if (!e) continue;
    if (fieldsMatch(artist, e)) return entry;
    if (fieldsMatch(title, e)) return entry;
    if (fieldsMatch(combined, e)) return entry;
    if (entry.includes(" - ")) {
      const [listArtist, listTitle] = entry.split(" - ").map(norm);
      if (listArtist && artist && fieldsMatch(artist, listArtist)) return entry;
      if (listTitle && title && fieldsMatch(title, listTitle)) return entry;
      if (listArtist && listTitle && combined.includes(`${listArtist} ${listTitle}`)) return entry;
    }
  }
  return null;
}

export const isDoNotPlay = (entries: string[], track: TrackLike): boolean =>
  matchDoNotPlay(entries, track) !== null;
